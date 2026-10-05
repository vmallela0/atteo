// Everyday Ask (#1273 part 4, #1360): /ask is voice first. Tap the mic, the words show as you talk, tap again (or say
// "send it") and it goes to your assistant's chat (made on first use); the answer shows on the page and is read aloud.
// Type instead (and the fallback where the browser has no speech recognition); suggestions from your chats and friends.
// Speech recognition and synthesis are stubbed in the page (headless Chromium has neither). Desktop and phone, light
// and dark, no page errors.
// Usage: BASE=http://localhost:8787 [ADMIN_KEY=…] node everyday-ask.mjs
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE = (process.env.BASE || "http://localhost:8787").replace(/\/$/, "");
let KEY = process.env.ADMIN_KEY;
// (the gate runs against 8787, whose ADMIN_KEY is ci-admin-key)
KEY ||= "ci-admin-key";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": KEY, "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-5), P = `ak${run}`, F = `af${run}`;
for (const u of [P, F]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true" });
const trip = (await ops("boards", { user: P, title: `Field trip ${run}` })).board.id;
await ops("boards", { user: P, title: `Corner Studio ${run}` });
const ck = (await ops("sessions", { user: P })).cookie, tok = (await ops("tokens", { user: P })).token;
const ckF = (await ops("sessions", { user: F })).cookie;
// A friend: request and accept, which makes the direct chat.
const as = (c, method, path, body) => fetch(`${BASE}${path}`, { method, headers: { cookie: c.split(";")[0], "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
await as(ck, "POST", "/api/friends/request", { user: F, note: "hi" });
await as(ckF, "POST", `/api/friends/${P}/accept`);
await as(ck, "POST", `/api/direct/${F}`);
let fails = 0;
const check = (ok, m) => { console.log(`${ok ? "✓" : "✗"} ${m}`); if (!ok) fails++; };
const until = async (f, ms = 8000) => { const t = Date.now(); for (;;) { const v = await f(); if (v || Date.now() - t > ms) return v; await new Promise((r) => setTimeout(r, 150)); } };
const entries = async (b) => (await (await fetch(`${BASE}/api/boards/${b}/entries?after=0`, { headers: { authorization: `Bearer ${tok}` } })).json()).entries;
const agentReply = async (b, seq, text) => {
  const auth = { authorization: `Bearer ${tok}` };
  await fetch(`${BASE}/api/boards/${b}/entries?after=0&ack=1`, { headers: auth }); // agent-token posts must acknowledge what the page just wrote
  return (await fetch(`${BASE}/api/boards/${b}/entries`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ reply_to: seq, text }) })).json();
};

// Fake speech: recognition driven by window.__say(text, final); synthesis records what it would say.
const STUBS = `(() => {
  window.__spoken = [];
  class FakeSR { constructor(){ window.__rec = this; } start(){ setTimeout(()=>this.onstart&&this.onstart(),10) } stop(){ setTimeout(()=>this.onend&&this.onend(),10) } abort(){ this.stop() } }
  window.SpeechRecognition = FakeSR; window.webkitSpeechRecognition = FakeSR;
  window.__say = (t, fin) => { const r = window.__rec; const res = [[{ transcript: t }]]; res[0].isFinal = !!fin; r.onresult && r.onresult({ resultIndex: 0, results: res }) };
  const syn = { speak: (u) => window.__spoken.push(u.text), cancel(){}, speaking:false, pending:false, getVoices: () => [] };
  Object.defineProperty(window, 'speechSynthesis', { value: syn, configurable: true });
})();`;
const NO_SR = `(() => { delete window.SpeechRecognition; delete window.webkitSpeechRecognition; Object.defineProperty(window,'webkitSpeechRecognition',{value:undefined}); Object.defineProperty(window,'SpeechRecognition',{value:undefined}); })();`;

const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const [k, ...v] = ck.split(";")[0].split("=");
const errors = [];
const open = async (init, w = 1300, h = 900, scheme = "light") => {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, colorScheme: scheme });
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  await ctx.addInitScript(init);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${BASE}/ask`);
  return { ctx, p };
};
const said = (p) => p.locator("#ask-said").textContent();
const status = (p) => p.locator("#ask-status").textContent();

// 1. Voice: tap, talk (interim then final), tap again: it goes to your assistant's chat, made on first use.
const A = await open(STUBS);
check((await A.p.content()).includes("let CHAT=null"), "no assistant chat yet");
const sugg = await A.p.locator("[data-ask]").evaluateAll((bs) => bs.map((x) => x.dataset.ask));
check(sugg.includes(`Find a time to talk with ${F} next week`) && sugg.some((s) => s.startsWith("What did I miss in ")) && sugg.length === 4, `suggestions from your chats and friends (${sugg.join(" | ")})`);
check(await A.p.locator("#ask-type").isHidden() && (await status(A.p)).includes("Tap the circle"), "voice first: the mic, no text box");
await A.p.locator("#ask-mic").click();
await until(async () => (await A.p.locator("#ask").getAttribute("class")).includes("listening") && "ok", 2000);
check((await A.p.locator("#ask-mic").getAttribute("aria-pressed")) === "true" && (await status(A.p)).startsWith("Listening"), "tapping the mic listens");
await A.p.evaluate(() => window.__say("Plan dinners", false));
check((await said(A.p)) === "Plan dinners" && (await A.p.locator("#ask-said .mid").count()) === 1, "words show as you say them (still faint)");
await A.p.evaluate(() => window.__say("Plan dinners for the week", true));
check((await said(A.p)) === "Plan dinners for the week" && (await A.p.locator("#ask-said .mid").count()) === 0, "…and firm once final");
await A.p.locator("#ask-mic").click();
const chat = await until(async () => ((await A.p.locator("#ask-open").getAttribute("href")) || "").match(/b_[a-z0-9]+/)?.[0]);
check(!!chat, `the assistant chat is made on first use (${chat})`);
const e1 = await until(async () => (await entries(chat))?.find((e) => e.text === "Plan dinners for the week"));
check(e1 && e1.via === "person" && e1.author === P, "tapping again sends it to your assistant's chat, as you");
check(await until(async () => (await status(A.p)).startsWith("Sent") && "ok", 3000), `status: ${await status(A.p)}`);
// The assistant answers: it shows on the page and is read aloud.
await agentReply(chat, e1.seq, "Done: Mon tacos, Tue pasta, Wed stir-fry. Sam's assistant agreed.");
check(await until(async () => (await A.p.locator("#ask-answer").isVisible()) && (await A.p.locator("#ask-tx").textContent()).startsWith("Done: Mon tacos") && "ok", 30000), "the answer shows on the page");
check(await until(async () => (await A.p.evaluate(() => window.__spoken)).some((t) => t.startsWith("Done: Mon tacos")) && "ok", 3000), "…and is read aloud");
check((await A.p.locator("#ask-open").getAttribute("href")) === `/b/${chat}`, "Open the chat links to it");
await A.p.locator("#ask-replay").click();
check((await A.p.evaluate(() => window.__spoken.length)) >= 2, "Read again reads it again");
// "send it" at the end sends without a tap.
await A.p.locator("#ask-mic").click();
await A.p.waitForTimeout(50);
await A.p.evaluate(() => window.__say("What did I miss send it", true));
check(await until(async () => (await entries(chat)).some((e) => e.text === "What did I miss") && "ok"), "saying “send it” sends (without the words)");
// A suggestion sends itself.
await A.p.locator("[data-ask]").first().click();
check(await until(async () => (await entries(chat)).some((e) => e.text === sugg[0]) && "ok"), "a suggestion sends itself");
// Type instead.
await A.p.locator("#ask-mode").click();
check(await A.p.locator("#ask-type").isVisible() && await A.p.locator("#ask-mic").isHidden() && (await A.p.locator("#ask-mode").textContent()).includes("Use your voice"), "Type instead swaps the mic for a box");
await A.p.locator("#ask-text").fill("Split the cabin bill");
await A.p.keyboard.press("Enter");
check(await until(async () => (await entries(chat)).some((e) => e.text === "Split the cabin bill") && "ok"), "typing and Enter sends");
await A.p.locator("#ask-mode").click();
check(await A.p.locator("#ask-mic").isVisible() && (await status(A.p)).startsWith("Sent"), `Use your voice brings the mic back, still waiting for the answer (${await status(A.p)})`);
await A.p.screenshot({ path: `${SHOTS_DIR}/ask-desktop.png` });
await A.ctx.close();

// 2. No speech recognition in this browser: typing from the start, and it says why.
const B = await open(NO_SR, 390, 844, "dark");
check(await B.p.locator("#ask-type").isVisible() && await B.p.locator("#ask-mic").isHidden() && await B.p.locator("#ask-mode").isHidden(), "no voice in this browser: the text box, no mic");
check((await status(B.p)).includes("isn’t available"), `…and it says so (${await status(B.p)})`);
const over = await B.p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
check(over <= 1, `phone: no sideways scroll (${over}px)`);
const bg = await B.p.evaluate(() => getComputedStyle(document.body).backgroundColor);
check(!/255, 255, 255/.test(bg), `dark theme (${bg})`);
await B.p.screenshot({ path: `${SHOTS_DIR}/ask-phone-dark.png`, fullPage: true });
await B.ctx.close();
const C = await open(STUBS, 390, 844, "light");
await C.p.screenshot({ path: `${SHOTS_DIR}/ask-phone-light.png`, fullPage: true });
const overC = await C.p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
check(overC <= 1, `phone with voice: no sideways scroll (${overC}px)`);
await C.ctx.close();

// 3. Signed out: sent to sign in.
const r = await fetch(`${BASE}/ask`, { redirect: "manual" });
check((r.status === 302 || r.status === 303) && (r.headers.get("location") || "").includes("/auth/login"), `signed out: sign in first (${r.status} ${r.headers.get("location")})`);
check(errors.length === 0, `no page errors (${errors.join(" | ")})`);
await b.close();
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
