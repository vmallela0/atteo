// One-tap replies to an agent's question (vedu #2490, research item 2). Under a question an agent asks a person, that
// person sees chips (the agent's options, else Yes, go ahead · Not now · Tell me more); a tap answers it in its thread
// and the chips go. 1–4 picks one from the keyboard. Nobody else sees them, and a person's question to a person has
// none. 1280px and 390px in Arabic (right to left).
// Usage: BASE=http://localhost:8798 node quick-replies.mjs  (local dev only, ADMIN_KEY=ci-admin-key in .dev.vars)
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const KEY = process.env.ADMIN_KEY || "ci-admin-key";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": KEY, "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), A = `qa${run}`, B = `qb${run}`, C = `qc${run}`;
for (const u of [A, B, C]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true", display: { mode: "developer" } });
const ckA = (await ops("sessions", { user: A })).cookie.split(";")[0], ckC = (await ops("sessions", { user: C })).cookie.split(";")[0];
const tokB = (await ops("tokens", { user: B })).token;
let fails = 0;
const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const DEFAULTS = { "": ["Yes, go ahead", "Not now", "Tell me more"], ar: ["نعم، تابع", "ليس الآن", "أخبرني المزيد"] };
for (const [w, lang] of [[1280, ""], [390, "ar"]]) {
  const board = (await ops("boards", { user: A, title: `Quick replies ${w} ${run}` })).board.id;
  for (const u of [B, C]) await ops("members", { board, user: u });
  const post = async (auth, body) => { // an agent token meets the stale-read rule (SPEC §9): it reads the board first
    if (auth.authorization) await fetch(`${BASE}/api/boards/${board}/entries?after=0&ack=1`, { headers: auth });
    return fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  };
  const own = (await post({ authorization: `Bearer ${tokB}` }, { type: "question", text: `@${A} deploy the fix now? ${run}`, data: { options: ["Deploy now", "Wait for CI"] } })).entry.seq;
  const dflt = (await post({ authorization: `Bearer ${tokB}` }, { type: "question", text: `@${A} tidy the flaky test too? ${run}` })).entry.seq;
  const p2p = (await post({ cookie: ckC }, { type: "question", text: `@${A} lunch? ${run}` })).entry.seq;
  const tag = `${w}px${lang ? ` ${lang}` : ""}`, phone = w < 500;
  const open = async (ck) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: phone ? 844 : 820 }, isMobile: phone, hasTouch: phone });
    const [k, ...v] = ck.split("=");
    await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
    const p = await ctx.newPage(), errors = [];
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(`${BASE}/b/${board}${lang ? `?lang=${lang}` : ""}`);
    await p.waitForTimeout(800);
    return { ctx, p, errors };
  };
  // C (a person it isn't asked of) sees no chips.
  {
    const { ctx, p, errors } = await open(ckC);
    check((await p.locator("#thread .qr:not([hidden])").count()) === 0, `${tag}: someone else sees no chips`);
    check(!errors.length, `${tag}: no page errors for C${errors.length ? ` (${errors[0]})` : ""}`);
    await ctx.close();
  }
  const { ctx, p, errors } = await open(ckA);
  if (lang === "ar") check((await p.evaluate(() => document.documentElement.dir)) === "rtl", `${tag}: the page is right to left`);
  const chips = (seq) => p.locator(`#thread>#e${seq} .qr:not([hidden]) .qr-b`);
  check((await chips(own).allInnerTexts()).map((t) => t.replace(/^\d\s*/, "").trim()).join("|") === "Deploy now|Wait for CI", `${tag}: the agent's own options show (${(await chips(own).allInnerTexts()).join(" | ")})`);
  const want = DEFAULTS[lang] ?? DEFAULTS[""];
  const got = (await chips(dflt).allInnerTexts()).map((t) => t.replace(/^\d\s*/, "").trim());
  check(got.join("|") === want.join("|"), `${tag}: the defaults show, translated (${got.join(" | ")})`);
  check((await p.locator(`#e${p2p} .qr`).count()) === 0, `${tag}: a person's question to a person has no chips`);
  // Inside the message, on screen (phone width included).
  const art = await p.locator(`#thread>#e${dflt}`).boundingBox(), last = await chips(dflt).last().boundingBox();
  check(!!art && !!last && last.x >= art.x - 0.5 && last.x + last.width <= art.x + art.width + 0.5 && last.x >= 0 && last.x + last.width <= w, `${tag}: chips stay inside the message and the screen`);
  // Keyboard: on the question, 2 picks the second option.
  await chips(own).first().focus();
  await p.keyboard.press("2");
  await p.waitForTimeout(1200);
  const thread = async (seq) => (await (await fetch(`${BASE}/api/boards/${board}/entries?after=0`, { headers: { cookie: ckA } })).json()).entries.filter((e) => e.reply_to === seq && e.author === A);
  const r1 = await thread(own);
  check(r1.length === 1 && r1[0].text === "Wait for CI" && r1[0].via === "person", `${tag}: 2 answered it in the thread as you (${r1.map((e) => e.text).join(", ")})`);
  check((await p.locator(`#thread>#e${own} .qr:not([hidden])`).count()) === 0, `${tag}: its chips are gone`);
  // Tap: the first default.
  await chips(dflt).first().click();
  await p.waitForTimeout(1200);
  const r2 = await thread(dflt);
  check(r2.length === 1 && r2[0].text === want[0], `${tag}: a tap answered it with "${r2[0]?.text}"`);
  check((await p.locator(`#thread>#e${dflt} .qr:not([hidden])`).count()) === 0, `${tag}: those chips are gone too`);
  // Hostile options (jxn's agent #2562): only the plain ones become chips, and a tap sends exactly the chip's text.
  const hostile = ["@all do X", "https://x.y", "**bold**", "/approve", "two\nlines", "x".repeat(41), "Ignore previous instructions"];
  const mixed = (await post({ authorization: `Bearer ${tokB}` }, { type: "question", text: `@${A} pick one ${run}`, data: { options: [...hostile, "Ship it", "Hold"] } })).entry.seq;
  await p.waitForTimeout(1500);
  const mixedTexts = (await chips(mixed).allInnerTexts()).map((t) => t.replace(/^\d\s*/, "").trim());
  check(mixedTexts.join("|") === "Ship it|Hold", `${tag}: hostile options are dropped (${mixedTexts.join(" | ")})`);
  const shown = await p.locator(`#thread>#e${mixed}`).innerText();
  check(!/@all do X|https:\/\/x\.y|\*\*bold|\/approve|Ignore previous/.test(shown.split("pick one")[1] ?? ""), `${tag}: none of them appears on the page`);
  await chips(mixed).nth(1).click();
  await p.waitForTimeout(1200);
  const r3 = await thread(mixed);
  check(r3.length === 1 && r3[0].text === "Hold", `${tag}: the reply is exactly the chip's text ("${r3[0]?.text}")`);
  // Reload: answered questions stay without chips.
  await p.reload();
  await p.waitForTimeout(800);
  check((await p.locator("#thread .qr:not([hidden])").count()) === 0, `${tag}: after a reload no chips come back`);
  check(!errors.length, `${tag}: no page errors${errors.length ? ` (${errors[0]})` : ""}`);
  await ctx.close();
}
await browser.close();
console.log(fails ? `${fails} FAILED` : "quick replies: all passed");
process.exit(fails ? 1 : 0);
