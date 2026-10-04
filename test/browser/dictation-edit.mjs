// Dictation never brings back old words (jxn #1698, task #1704): with continuous recognition the mic used to keep writing
// "what was in the box when it started + everything heard" back into the box, so after you edited or sent, old transcripts
// reappeared. Now your typing starts it afresh from the box, and sending, Esc, "send it" or leaving a reply stop it and drop
// what it heard. SpeechRecognition is faked: the check feeds it results.
// Usage: BASE=http://localhost:8787 node dictation-edit.mjs  (local dev only, ADMIN_KEY=ci-admin-key in .dev.vars)
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const KEY = process.env.ADMIN_KEY || "ci-admin-key";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": KEY, "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), P = `dc${run}`;
await ops("users", { name: P, email: `${P}@example.com`, verified: "true", display: { mode: "developer" } });
const board = (await ops("boards", { user: P, title: `Dictation ${run}` })).board.id;
const ck = (await ops("sessions", { user: P })).cookie, tok = (await ops("tokens", { user: P })).token;
const mcp = async (name, args) => (await (await fetch(`${BASE}/mcp?board=${board}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json()).result.content[0].text;
await mcp("read", {});
const M = +(await mcp("post", { type: "note", text: "Something to reply to" })).match(/#(\d+)/)[1];
const entries = async () => (await (await fetch(`${BASE}/api/boards/${board}/entries?after=0`, { headers: { authorization: `Bearer ${tok}` } })).json()).entries.map((e) => e.text);

const FAKE = () => {
  // A fake recognizer: window.__say(text, final) adds a result (or updates the last interim one) and fires onresult.
  class SR {
    start() { window.__sr = this; this.results = []; this.live = true; window.__starts = (window.__starts || 0) + 1; }
    stop() { this.live = false; setTimeout(() => this.onend && this.onend(), 10); }
    abort() { this.live = false; this.aborted = true; setTimeout(() => this.onend && this.onend(), 10); }
  }
  window.SpeechRecognition = SR;
  window.__say = (text, final = true, sr = window.__sr) => {
    if (!sr) return;
    const last = sr.results[sr.results.length - 1];
    const r = Object.assign([{ transcript: text }], { isFinal: final });
    let idx;
    if (last && !last.isFinal) { idx = sr.results.length - 1; sr.results[idx] = r; } else { idx = sr.results.length; sr.results.push(r); }
    sr.onresult && sr.onresult({ resultIndex: idx, results: sr.results });
  };
};

let fails = 0;
const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || process.env.CHROME || undefined });
const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
const [k, ...v] = ck.split(";")[0].split("=");
await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
await ctx.addInitScript(FAKE);
const p = await ctx.newPage(), errors = [];
p.on("pageerror", (e) => errors.push(e.message));
await p.goto(`${BASE}/b/${board}`);
await p.waitForTimeout(800);
const box = () => p.inputValue("#composer-text");
const say = (t, final = true) => p.evaluate(([t, f]) => window.__say(t, f), [t, final]);
const listening = () => p.evaluate(() => document.getElementById("mic-btn").getAttribute("aria-pressed") === "true");
const oldSr = () => p.evaluate(() => { window.__old = window.__sr; });
const sayOld = (t) => p.evaluate((t) => window.__say(t, true, window.__old), t);

check(await p.locator("#mic-btn").isVisible(), "the mic shows (fake recognizer)");
// 1. Dictate, then edit mid-dictation: what you typed stays, and only new words are added after it.
await p.click("#mic-btn");
await say("hello", false);
await say("hello there");
check((await box()) === "hello there" && (await listening()), `dictation fills the box (${JSON.stringify(await box())})`);
await p.locator("#composer-text").press("End");
await p.keyboard.type(" EDITED");
await say(" and more", false);
check((await box()) === "hello there EDITED and more", `after you type, new words go after your edit (${JSON.stringify(await box())})`);
await say(" and more words");
await p.locator("#composer-text").press("Control+a");
await p.keyboard.press("Backspace");
await say("fresh", false);
check((await box()) === "fresh", `clearing the box while it listens: old words don't come back (${JSON.stringify(await box())})`);
await say("fresh start");
// 2. Send while listening: it posts, the mic stops, and nothing it hears afterwards comes back.
await oldSr();
await p.locator("form.composer button.primary").click();
await p.waitForTimeout(1200);
check((await entries()).includes("fresh start") && !(await listening()), `sending posts it and stops the mic (listening: ${await listening()})`);
await sayOld("late words after sending");
await p.waitForTimeout(200);
check((await box()) === "", `a late result after sending doesn't refill the box (${JSON.stringify(await box())})`);
// 3. Talking again starts from an empty box.
await p.click("#mic-btn");
await say("second message");
check((await box()) === "second message", `talking again starts clean (${JSON.stringify(await box())})`);
// 4. "send it": posts what came before it, and a last result can't bring it back.
await oldSr();
await say(" plus send it");
await p.waitForTimeout(1200);
const all = await entries();
check(all.includes("second message plus"), `"send it" posts what came before it (${JSON.stringify(all.slice(-2))})`);
await sayOld("one more late result");
await p.waitForTimeout(200);
check((await box()) === "" && !(await listening()), `after "send it" the box stays empty (${JSON.stringify(await box())})`);
// 5. Esc stops it and drops what it heard.
await p.click("#mic-btn");
await say("to be dropped");
await oldSr();
await p.locator("#composer-text").press("Escape");
await p.waitForTimeout(100);
await sayOld("still talking after Esc");
check(!(await listening()) && !(await box()).includes("still talking"), `Esc stops the mic; later words don't arrive (${JSON.stringify(await box())})`);
await p.fill("#composer-text", "");
// 6. Leaving a reply stops it too.
await p.evaluate((s) => document.querySelector(`#e${s} button[data-reply="${s}"]`).click(), M);
await p.click("#mic-btn");
await say("reply words");
await oldSr();
await p.evaluate(() => document.getElementById("reply-cancel").click());
await sayOld("after leaving the reply");
check(!(await listening()) && !(await box()).includes("after leaving the reply"), `cancelling the reply stops the mic (${JSON.stringify(await box())})`);
// 7. An encrypted board posts through its own submit handler (it stops the event): the mic still stops there.
{
  const eb = (await ops("boards", { user: P, title: `Dictation sealed ${run}`, encrypted: true })).board.id;
  const pe = await ctx.newPage();
  pe.on("pageerror", (e) => errors.push(e.message));
  await pe.goto(`${BASE}/b/${eb}`);
  await pe.waitForTimeout(1500);
  await pe.click("#mic-btn");
  await pe.evaluate(() => window.__say("sealed words"));
  await pe.evaluate(() => { window.__old = window.__sr; });
  await pe.locator("form.composer button.primary").click();
  await pe.waitForTimeout(2000);
  const on = await pe.evaluate(() => document.getElementById("mic-btn").getAttribute("aria-pressed") === "true");
  await pe.evaluate(() => window.__say("late on the sealed board", true, window.__old));
  await pe.waitForTimeout(200);
  const v = await pe.inputValue("#composer-text");
  const shown = await pe.locator('#thread .e2e-text:has-text("sealed words")').count();
  check(!on && v === "" && shown === 1, `encrypted board: it posts, the mic stops, and a late result doesn't refill the box (listening ${on}, box ${JSON.stringify(v)}, shown ${shown})`);
  await pe.close();
}
check(!errors.length, `no page errors ${errors.join(" | ")}`);
await browser.close();
console.log(fails ? `${fails} FAILED` : "dictation-edit: all passed");
process.exit(fails ? 1 : 0);
