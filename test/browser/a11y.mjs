// Accessibility (Atteo board #1909): axe-core on the board page, Account, and Ask — English and zh-Hans at 1280 and 390px.
// Scans today's voice, privacy, and forward controls (not the global sidebar). Serious and critical violations fail.
// Also (#1965) the whole page content of For you, Inbox, Approvals, People and the welcome page, seeded with an
// approval, a mention and a friend request so their cards and buttons are on screen.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const AXE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const BASE = (process.env.BASE || "http://localhost:8787").replace(/\/$/, "");
const KEY = process.env.ADMIN_KEY || "ci-admin-key";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": KEY, "content-type": "application/json" }, body: JSON.stringify(b) })).json();

// Each language at 1280 and 390px in light; English at 1280px in dark too (#1965: dark has its own colours).
const RUNS = [["en", "", 1280, 820, false, "light"], ["en", "", 390, 844, true, "light"], ["en", "", 1280, 820, false, "dark"], ["zh-Hans", "?lang=zh-Hans", 1280, 820, false, "light"], ["zh-Hans", "?lang=zh-Hans", 390, 844, true, "light"]];
// Regions with today's controls: Talk to Atteo, voice/read-aloud, Just mine, forward selection, voice picker/allowance, Ask.
const INCLUDES = [
  [".topbar"],
  [".composer"],
  ["#po-note"],
  [".thread .badge.po.own"],
  ["#voice-pill"],
  ["#sel-float"],
  ["#fwd-dlg"],
  ["dialog.talk"],
  ["#dp-form"],
  ["#voice-allow"],
  ["#ask"],
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

const TTS = { enabled: true, used_chars: 20_000, budget_chars: 150_000, voices: ["eve", "ara", "leo", "rex", "sal"], voice_default: "eve" };
const VOICE = { enabled: true, minutes_used: 12, minutes_budget: 60 };

let fails = 0;
const check = (ok, m) => { console.log(`${ok ? "✓" : "✗"} ${m}`); if (!ok) fails++; };

async function axeScan(page, label, include = INCLUDES) {
  const results = await page.evaluate(
    async (inc) => await axe.run({ include: inc }, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } }),
    include,
  );
  const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  if (bad.length) {
    for (const v of bad) {
      const why = (n) => { const d = n.any?.[0]?.data; return d && d.fgColor ? `${d.fgColor} on ${d.bgColor}, ${d.contrastRatio}:1` : n.failureSummary?.split("\n")[1]?.trim() || ""; };
      const nodes = v.nodes.slice(0, 4).map((n) => `${n.html.slice(0, 90)} (${why(n)})`).join("; ");
      console.log(`  [${v.impact}] ${v.id}: ${v.help} — ${nodes}`);
    }
  }
  check(bad.length === 0, `${label}: ${bad.length ? bad.map((v) => v.id).join(", ") : "no serious/critical axe violations"}`);
}

const run = Date.now().toString(36).slice(-4), P = `a11y${run}`, V = `av${run}`;
for (const u of [P, V]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true" });
const board = (await ops("boards", { user: P, title: `A11y ${run}` })).board.id;
await ops("members", { board, user: V });
const ck = (await ops("sessions", { user: P })).cookie;
const tok = (await ops("tokens", { user: P })).token;
const mcp = async (name, args) => (await (await fetch(`${BASE}/mcp?board=${board}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json()).result.content[0].text;
await mcp("read", {});
await mcp("post", { type: "note", text: `Public note ${run}` });
await fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { cookie: ck.split(";")[0], "content-type": "application/json" }, body: JSON.stringify({ type: "note", text: `Private lane ${run}`, own: true }) });
await mcp("post", { type: "note", text: `@${P} voice bar ${run}` });
// For the page scans: an approval from P's agent, a mention from V, and a friend request from a third person.
await mcp("request_approval", { title: `Send the deck ${run}`, details: "deck.pdf to the team", risk: "medium", wait_seconds: 0 });
const tokV = (await ops("tokens", { user: V })).token;
await fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { authorization: `Bearer ${tokV}`, "content-type": "application/json" }, body: JSON.stringify({ type: "question", text: `@${P} can you look at this? ${run}` }) });
const F = `af${run}`;
await ops("users", { name: F, email: `${F}@example.com`, verified: "true" });
const ckF = (await ops("sessions", { user: F })).cookie.split(";")[0];
await fetch(`${BASE}/api/friends/request`, { method: "POST", headers: { cookie: ckF, "content-type": "application/json" }, body: JSON.stringify({ user: P }) });
const PAGES = ["/for-you", "/inbox", "/approvals", "/people", "/welcome"];

const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const [k, ...v] = ck.split(";")[0].split("=");

for (const [lang, qs, w, h, phone, scheme] of RUNS) {
  {
    const ctx = await browser.newContext({ colorScheme: scheme, viewport: { width: w, height: h }, ...(phone ? { hasTouch: true, isMobile: true } : {}) });
    await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
    await ctx.addInitScript(FAKES);
    await ctx.addInitScript(AXE);
    await ctx.route("**/api/app/tts/status", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(TTS) }));
    await ctx.route("**/api/app/voice/status", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(VOICE) }));
    await ctx.route("**/api/app/tts", (r) => r.fulfill({ status: 200, contentType: "audio/mpeg", body: Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0]) }));
    await ctx.route("**/api/app/voice/session", (r) => r.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ fallback: "device" }) }));
    const p = await ctx.newPage();
    const tag = `${lang} ${w}px${scheme === "dark" ? " dark" : ""}`;
    const tap = async (sel) => { if (phone) await p.locator(sel).tap(); else await p.locator(sel).click(); };

    // Board: Talk to Atteo, voice/read-aloud, Just mine composer, voice pill, forward dialog.
    await p.goto(`${BASE}/b/${board}${qs}`);
    await p.waitForTimeout(900);
    await tap("#po-btn");
    await tap('[data-po="own"]');
    await p.waitForTimeout(200);
    await tap("#aloud-btn");
    await p.locator("#voice-pill").waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
    await p.waitForTimeout(200);
    await axeScan(p, `board ${tag}`);
    await tap('[data-talk]');
    await p.waitForTimeout(400);
    await axeScan(p, `board talk ${tag}`);
    await p.keyboard.press("Escape");
    await p.waitForTimeout(200);
    await p.evaluate(() => { const d = document.getElementById("fwd-dlg"); if (d?.open) d.close(); });
    await p.evaluate(() => { document.getElementById("fwd-send")?.removeAttribute("disabled"); document.getElementById("fwd-dlg")?.showModal(); });
    await p.waitForTimeout(200);
    await axeScan(p, `board forward ${tag}`);
    await p.evaluate(() => document.getElementById("fwd-dlg")?.close());

    // Account: voice picker and allowance.
    await p.goto(`${BASE}/me${qs}`);
    await p.waitForTimeout(900);
    await axeScan(p, `account ${tag}`);

    // Ask.
    await p.goto(`${BASE}/ask${qs}`);
    await p.waitForTimeout(900);
    await axeScan(p, `ask ${tag}`);

    // For you, Inbox, Approvals, People, welcome: the whole page content (not the sidebar).
    for (const path of PAGES) {
      await p.goto(`${BASE}${path}${qs}`);
      await p.waitForTimeout(700);
      await axeScan(p, `${path} ${tag}`, [["#app .content"]]);
    }

    await ctx.close();
  }
}

await browser.close();
console.log(fails ? `${fails} FAILED` : "a11y: all passed");
process.exit(fails ? 1 : 0);
