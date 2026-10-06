// Accessibility (Atteo board #1909, #2106): axe-core on the board page, Account, and Ask — English and zh-Hans at 1280 and 390px.
// Scans today's privacy and forward controls (not the global sidebar). Serious and critical violations fail.
// Also (#2018) code blocks' syntax colours. Also (#1965) the whole page content of For you, Inbox, Approvals, People and the welcome page.
// Overlays (#2106): Talk to Atteo live and Standing by, Invite an agent, HTML preview, Forward — en and zh-Hans at 1280 and 390px.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
// A dev dependency: without it this check can't run, which run.mjs reports as a skip with the fix (not a Node crash).
let axePath;
try { axePath = require.resolve("axe-core/axe.min.js"); } catch { console.log("SKIP: axe-core isn't installed: run npm ci"); process.exit(3); }
const AXE = readFileSync(axePath, "utf8");
const BASE = (process.env.BASE || "http://localhost:8787").replace(/\/$/, "");
const KEY = process.env.ADMIN_KEY || "ci-admin-key";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": KEY, "content-type": "application/json" }, body: JSON.stringify(b) })).json();

// Each language at 1280 and 390px in light; English at 1280px in dark too (#1965: dark has its own colours).
const RUNS = [["en", "", 1280, 820, false, "light"], ["en", "", 390, 844, true, "light"], ["en", "", 1280, 820, false, "dark"], ["zh-Hans", "?lang=zh-Hans", 1280, 820, false, "light"], ["zh-Hans", "?lang=zh-Hans", 390, 844, true, "light"]];
const overlayRun = (lang, w) => (lang === "en" || lang === "zh-Hans") && (w === 1280 || w === 390);
// Regions with today's controls: Talk to Atteo, the composer's mic, Just mine, forward selection, voice picker/allowance, Ask.
const INCLUDES = [
  [".topbar"],
  [".composer"],
  ["#po-note"],
  [".thread .badge.po.own"],
  ["#sel-float"],
  ["#fwd-dlg"],
  ["dialog.talk"],
  ["#invite-agent"],
  [".pv-dlg"],
  ["#dp-form"],
  ["#voice-allow"],
  ["#ask"],
  [".thread .code-b"], // syntax colours (#2018)
];

const FAKES = `(() => {
  window.__spoken = [];
  class FSR { start() { setTimeout(() => this.onend && this.onend(), 20); } stop() {} abort() { this.stop(); } }
  window.SpeechRecognition = FSR; window.webkitSpeechRecognition = FSR;
  window.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
  Object.defineProperty(window, "speechSynthesis", { value: { getVoices() { return [{ name: "Basic", lang: "en-US", default: true }]; }, speak(u) { if (u.text.trim()) window.__spoken.push(u.text); setTimeout(() => u.onend && u.onend(), 50); }, cancel() {}, speaking: false, pending: false }, configurable: true });
  navigator.permissions.query = async () => ({ state: "granted" });
  const AC = window.AudioContext; window.AudioContext = class extends AC { createOscillator() { return super.createOscillator(); } };
})();`;

const FAKE_WS = `(()=>{const Real=window.WebSocket;window.__talk={sent:[],opened:0,all:[]};
  window.WebSocket=function(url,protocols){if(!String(url).startsWith('wss://api.x.ai'))return new Real(url,protocols);
    const ws={url,protocols,readyState:0,send(m){window.__talk.sent.push(JSON.parse(m))},close(){if(this.readyState===3)return;this.readyState=3;setTimeout(()=>this.onclose&&this.onclose({}),0)}};
    window.__talk.ws=ws;window.__talk.all.push(ws);window.__talk.opened++;window.__talk.emit=e=>{if(ws.onmessage)ws.onmessage({data:JSON.stringify(e)})};setTimeout(()=>{ws.readyState=1;ws.onopen&&ws.onopen({})},50);return ws};
  Object.assign(window.WebSocket,{CONNECTING:0,OPEN:1,CLOSING:2,CLOSED:3});})()`;

const TTS = { enabled: true, used_chars: 20_000, budget_chars: 150_000, voices: ["eve", "ara", "leo", "rex", "sal"], voice_default: "eve" };
const VOICE = { enabled: true, minutes_used: 12, minutes_budget: 60 };

// The five runs go side by side, each in its own context; each one's lines print when it's done, in RUNS order.
let fails = 0;
const logger = () => { const lines = []; const log = (m) => lines.push(m); return { lines, log, check: (ok, m) => { log(`${ok ? "✓" : "✗"} ${m}`); if (!ok) fails++; } }; };

async function axeScan({ log, check }, page, label, include = INCLUDES) {
  const results = await page.evaluate(
    async (inc) => await axe.run({ include: inc }, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } }),
    include,
  );
  const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  if (bad.length) {
    for (const v of bad) {
      const why = (n) => { const d = n.any?.[0]?.data; return d && d.fgColor ? `${d.fgColor} on ${d.bgColor}, ${d.contrastRatio}:1` : n.failureSummary?.split("\n")[1]?.trim() || ""; };
      const nodes = v.nodes.slice(0, 4).map((n) => `${n.html.slice(0, 90)} (${why(n)})`).join("; ");
      log(`  [${v.impact}] ${v.id}: ${v.help} — ${nodes}`);
    }
  }
  check(bad.length === 0, `${label}: ${bad.length ? bad.map((v) => v.id).join(", ") : "no serious/critical axe violations"}`);
}

const emit = (p, e) => p.evaluate((ev) => window.__talk.emit(ev), e);

const run = Date.now().toString(36).slice(-4), P = `a11y${run}`, V = `av${run}`;
for (const u of [P, V]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true", display: { voice_turns: "quick", xai_ok: true } }); // server turn detection, as the talk scans expect
const board = (await ops("boards", { user: P, title: `A11y ${run}` })).board.id;
await ops("boards", { user: P, title: `Fwd dst ${run}` }); // a second board for the forward picker
await ops("members", { board, user: V });
const ck = (await ops("sessions", { user: P })).cookie;
const tok = (await ops("tokens", { user: P })).token;
const mcp = async (name, args) => (await (await fetch(`${BASE}/mcp?board=${board}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json()).result.content[0].text;
await mcp("read", {});
const fwdSeq = +(await mcp("post", { type: "note", text: `Forward pick ${run}` })).match(/#(\d+)/)[1];
await mcp("post", { type: "note", text: `Public note ${run}` });
await fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { cookie: ck.split(";")[0], "content-type": "application/json" }, body: JSON.stringify({ type: "note", text: `Private lane ${run}`, own: true }) });
await mcp("post", { type: "note", text: `@${P} voice bar ${run}` });
// Code blocks, so the syntax colours are scanned (#2018): every kind of token, light and dark.
await mcp("post", { type: "note", text: "Code\n\n```ts\n// note\nexport function f(ms = 250): Promise<void> { return g(\"x\", true) }\n```\n\n```html\n<a href=\"x\">hi</a> &amp;\n```\n\n```diff\n@@ -1 +1 @@\n-old\n+new\n```" });
const htmlArtifact = `<!doctype html><html><head><title>t ${run}</title></head><body><h1>Preview ${run}</h1><button type="button">Tap</button></body></html>`;
await mcp("post", { type: "artifact", text: "HTML mockup", artifact_name: `mock-${run}.html`, artifact_content: htmlArtifact });
// For the page scans: an approval from P's agent, a mention from V, and a friend request from a third person.
await mcp("request_approval", { title: `Send the deck ${run}`, details: "deck.pdf to the team", risk: "medium", wait_seconds: 0 });
const tokV = (await ops("tokens", { user: V })).token;
await fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { authorization: `Bearer ${tokV}`, "content-type": "application/json" }, body: JSON.stringify({ type: "question", text: `@${P} can you look at this? ${run}` }) });
const F = `af${run}`;
await ops("users", { name: F, email: `${F}@example.com`, verified: "true" });
const ckF = (await ops("sessions", { user: F })).cookie.split(";")[0];
await fetch(`${BASE}/api/friends/request`, { method: "POST", headers: { cookie: ckF, "content-type": "application/json" }, body: JSON.stringify({ user: P }) });
const PAGES = ["/for-you", "/inbox", "/approvals", "/people", "/welcome"];

const browser = await chromium.launch({
  executablePath: process.env.PW_CHROME || undefined,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});
const [k, ...v] = ck.split(";")[0].split("=");

const outs = await Promise.all(RUNS.map(async ([lang, qs, w, h, phone, scheme]) => {
  const L = logger(), { check } = L;
  {
    // Reduced motion: no transition is mid-way when axe measures colours (the Talk sheet's flaked in parallel runs).
    const mkCtx = async () => { const ctx = await browser.newContext({ colorScheme: scheme, reducedMotion: "reduce", viewport: { width: w, height: h }, ...(phone ? { hasTouch: true, isMobile: true } : {}) });
    await ctx.grantPermissions(["microphone"]);
    await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
    await ctx.addInitScript(FAKES);
    await ctx.addInitScript(FAKE_WS);
    await ctx.addInitScript(AXE);
    await ctx.route("**/api/app/tts/status", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(TTS) }));
    await ctx.route("**/api/app/voice/status", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(VOICE) }));
    await ctx.route("**/api/app/tts", (r) => r.fulfill({ status: 200, contentType: "audio/mpeg", body: Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0]) }));
    await ctx.route("**/api/app/voice/**", async (route) => {
      const req = route.request();
      return route.continue({ headers: { ...req.headers(), "x-dev-fake-voice": "1" } });
    });
    return ctx; };
    const ctx = await mkCtx();
    const p = await ctx.newPage();
    const tag = `${lang} ${w}px${scheme === "dark" ? " dark" : ""}`;
    // The other pages scan in a context of their own (a background tab would be throttled), alongside the board's overlays.
    const L2 = logger();
    const pages = (async () => {
      const c2 = await mkCtx(), q = await c2.newPage();
      // Account: voice picker and allowance.
      await q.goto(`${BASE}/me${qs}`);
      await q.waitForTimeout(900);
      await axeScan(L2, q, `account ${tag}`);

      // Ask.
      await q.goto(`${BASE}/ask${qs}`);
      await q.waitForTimeout(900);
      await axeScan(L2, q, `ask ${tag}`);

      // For you, Inbox, Approvals, People, welcome: the whole page content (not the sidebar).
      for (const path of PAGES) {
        await q.goto(`${BASE}${path}${qs}`);
        await q.waitForTimeout(700);
        await axeScan(L2, q, `${path} ${tag}`, [["#app .content"]]);
      }
      await c2.close();
    })();
    const tap = async (sel) => { if (phone) await p.locator(sel).tap(); else await p.locator(sel).click(); };

    // Board: privacy controls, overlays, forward selection.
    await p.goto(`${BASE}/b/${board}${qs}`);
    await p.waitForTimeout(900);
    await tap("#po-btn");
    await tap('[data-po="own"]');
    await p.waitForTimeout(200);
    await p.evaluate(() => document.querySelector(".thread .code-b")?.scrollIntoView({ block: "center" }));
    await p.locator('.thread .code-b code[data-hl="on"]').first().waitFor({ timeout: 8000 }).catch(() => {});
    await axeScan(L, p, `board ${tag}`);

    if (overlayRun(lang, w)) {
      // Talk to Atteo: live (listening) and Standing by after a quiet turn.
      await p.evaluate(() => { window.__talkNapMs = 800; });
      await tap('[data-talk]');
      await p.waitForFunction(() => /Listening/.test(document.getElementById("talk-st")?.textContent || ""), { timeout: 8000 }).catch(() => {});
      check(/Listening/.test(await p.locator("#talk-st").innerText()), `talk live ${tag}: listening`);
      await axeScan(L, p, `talk live ${tag}`, [["dialog.talk"]]);
      await emit(p, { type: "input_audio_buffer.speech_started" }); await p.waitForTimeout(80);
      await emit(p, { type: "input_audio_buffer.speech_stopped" });
      await emit(p, { type: "conversation.item.input_audio_transcription.completed", transcript: `hello ${run}` });
      await emit(p, { type: "response.created", response: { id: "r1" } });
      await emit(p, { type: "response.output_audio_transcript.done", response_id: "r1", transcript: "Hi there." });
      await emit(p, { type: "response.done", response: { id: "r1" } });
      await p.waitForFunction(() => /Standing by/.test(document.getElementById("talk-st")?.textContent || ""), null, { timeout: 8000 }).catch(() => {});
      check(/Standing by/.test(await p.locator("#talk-st").innerText()), `talk standby ${tag}: standing by`);
      await axeScan(L, p, `talk standby ${tag}`, [["dialog.talk"]]);
      await p.keyboard.press("Escape");
      await p.waitForTimeout(200);

      // Forward: multi-select then the dialog (not a programmatic showModal).
      if (phone) await p.evaluate((s) => document.querySelector(`#e${s} [data-select]`)?.click(), fwdSeq);
      else { await p.locator(`#e${fwdSeq}`).hover(); await tap(`#e${fwdSeq} [data-select]`); }
      await p.waitForTimeout(200);
      await tap("#sel-fwd");
      await p.waitForTimeout(400);
      await axeScan(L, p, `forward ${tag}`, [["#fwd-dlg"]]);
      await p.keyboard.press("Escape");
      await p.waitForTimeout(200);

      // Invite an agent (a phone's header has no member stack, jxn #4860: the rail's "Invite an agent" opens it).
      if (phone) { await tap("#info-btn"); await p.waitForTimeout(300); await tap('#board-info [data-open="invite-agent"]'); } else await tap(".av-add");
      await p.waitForTimeout(400);
      await axeScan(L, p, `invite agent ${tag}`, [["#invite-agent"]]);
      await p.keyboard.press("Escape");
      await p.waitForTimeout(200);
      if (phone) { await p.keyboard.press("Escape"); await p.waitForTimeout(300); } // …and the rail closes too

      // HTML preview overlay.
      await tap(`[data-preview-file="mock-${run}.html"]`);
      await p.waitForTimeout(800);
      await axeScan(L, p, `html preview ${tag}`, [[".pv-dlg"]]);
      await p.keyboard.press("Escape");
      await p.waitForTimeout(200);
    }

    await pages;
    await ctx.close();
    return [...L.lines, ...L2.lines];
  }
}));
for (const lines of outs) for (const l of lines) console.log(l);

await browser.close();
console.log(fails ? `${fails} FAILED` : "a11y: all passed");
process.exit(fails ? 1 : 0);
