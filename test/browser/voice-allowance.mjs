// Read-aloud and talking allowance shown plainly (#1629, caps #1592): Account → Advanced has one "Voice this month" line;
// operators see "No limit (operator)". The status routes are stubbed (normal, low, out, operator). The composer's
// read-aloud button is gone (#2083): reading messages for you lives in Talk to Atteo, and its device-voice fallback when
// read-aloud runs out is in call-nap.mjs.
// Usage: BASE=http://localhost:8787 node voice-allowance.mjs  (local dev only, ADMIN_KEY=ci-admin-key in .dev.vars)
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const KEY = process.env.ADMIN_KEY || "ci-admin-key";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": KEY, "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), P = `va${run}`, V = `vv${run}`;
for (const u of [P, V]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true" });
const board = (await ops("boards", { user: P, title: `Voice allowance ${run}` })).board.id;
await ops("members", { board, user: V });
const ckP = (await ops("sessions", { user: P })).cookie;

let fails = 0;
const check = (ok, m) => { console.log(`${ok ? "✓" : "✗"} ${m}`); if (!ok) fails++; };
const FAKES = () => {
  window.__spoken = [];
  window.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
  Object.defineProperty(window, "speechSynthesis", { value: { getVoices() { return [{ name: "Basic", lang: "en-US", default: true }]; }, speak(u) { if (String(u.text).trim()) window.__spoken.push(u.text); setTimeout(() => { u.onstart && u.onstart(); setTimeout(() => u.onend && u.onend(), 50); }, 20); }, cancel() {}, resume() {}, speaking: false, pending: false } });
  window.Audio = class { constructor(src) { this.src = src; } play() { setTimeout(() => this.onended && this.onended(), 100); return Promise.resolve(); } pause() {} };
};
const TTS = {
  normal: { enabled: true, used_chars: 20_000, budget_chars: 150_000 }, // 130k left ≈ 2 h 10 m
  low: { enabled: true, used_chars: 141_000, budget_chars: 150_000 }, // 9 min
  out: { enabled: true, used_chars: 150_000, budget_chars: 150_000 },
  operator: { enabled: true, used_chars: 5_000, budget_chars: Number.MAX_SAFE_INTEGER },
};
const VOICE = {
  normal: { enabled: true, minutes_used: 12, minutes_budget: 60 },
  low: { enabled: true, minutes_used: 55, minutes_budget: 60 },
  out: { enabled: true, minutes_used: 60, minutes_budget: 60 },
  operator: { enabled: true, minutes_used: 3, minutes_budget: 100000 },
};
const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || process.env.CHROME || `${process.env.HOME}/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome` });
const errors = [];
async function ctxFor(state, tts = (r) => r.fulfill({ status: 200, contentType: "audio/mpeg", body: Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0]) }), w = 1100) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 800 } });
  const [k, ...v] = ckP.split(";")[0].split("=");
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  await ctx.addInitScript(FAKES);
  await ctx.route("**/api/app/tts/status", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(TTS[state]) }));
  await ctx.route("**/api/app/voice/status", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(VOICE[state]) }));
  await ctx.route("**/api/app/tts", tts);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  return { ctx, p };
}
const account = async (p) => { await p.goto(`${BASE}/me`); await p.waitForTimeout(800); return (await p.locator("#voice-allow").isVisible()) ? (await p.locator("#voice-allow").innerText()).replace(/\s+/g, " ") : ""; };

// Normal, low, operator, out: Account says used and left.
for (const [state, acct] of [
  ["normal", ["Read aloud: ~20 m used, ~2 h 10 m left this month", "Talking: 12 m of 1 h used, 48 m left this month"]],
  ["low", ["~9 m left this month (running low)", "Talking: 55 m of 1 h used, 5 m left this month"]],
  ["operator", ["No limit (operator)"]],
  ["out", ["Read aloud: ~2 h 30 m used, none left, so it uses the device voice", "Talking: 1 h of 1 h used, none left"]],
]) {
  const { ctx, p } = await ctxFor(state);
  const a = await account(p);
  check(acct.every((x) => a.includes(x)), `${state}: Account → Advanced says ${acct.map((x) => JSON.stringify(x)).join(" and ")} (${JSON.stringify(a)})`);
  await ctx.close();
}
// A phone sees the same line in Account.
{
  const { ctx, p } = await ctxFor("normal", undefined, 390);
  const a = await account(p);
  check(a.includes("Read aloud: ~20 m used") && (await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth)), `390px: the Account line fits (${JSON.stringify(a)})`);
  await ctx.close();
}
check(errors.length === 0, `no page errors ${errors.join(" | ")}`);
await browser.close();
console.log(fails ? `${fails} FAILED` : "voice-allowance: all passed");
process.exit(fails ? 1 : 0);
