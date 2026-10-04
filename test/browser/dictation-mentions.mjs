// Spoken mentions (jxn #1731, task #1736): dictating "at agents", "at vedu", "at vedu's agent", "at my agent" or an agent's
// name ("at jarvis") puts real @mentions in the box, matched by sound against the board's members ("at vito" → @vedu), while
// "meet at noon", "look at this" and unknown names stay as said. SpeechRecognition is faked: the check feeds it results.
// Uses fixed member names (vedu, maya) so they can be spoken; on a local dev server they're reused if they exist.
// Usage: BASE=http://localhost:8787 node dictation-mentions.mjs  (local dev only, ADMIN_KEY=ci-admin-key in .dev.vars)
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const KEY = process.env.ADMIN_KEY || "ci-admin-key";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": KEY, "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), P = `dm${run}`;
await ops("users", { name: P, email: `${P}@example.com`, verified: "true", display: { mode: "developer" } });
for (const u of ["vedu", "maya", "ann"]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true" });
const board = (await ops("boards", { user: P, title: `Spoken mentions ${run}` })).board.id;
for (const u of ["vedu", "maya", "ann"]) await ops("members", { board, user: u });
// maya calls her agent Jarvis
const ckM = (await ops("sessions", { user: "maya" })).cookie.split(";")[0];
await fetch(`${BASE}/api/me/profile`, { method: "POST", headers: { cookie: ckM, "content-type": "application/json" }, body: JSON.stringify({ agent_name: "Jarvis" }) });
const ck = (await ops("sessions", { user: P })).cookie, tok = (await ops("tokens", { user: P })).token;

const FAKE = () => {
  class SR { start() { window.__sr = this; this.results = []; } stop() { setTimeout(() => this.onend && this.onend(), 10); } abort() { setTimeout(() => this.onend && this.onend(), 10); } }
  window.SpeechRecognition = SR;
  window.__say = (text) => { const sr = window.__sr; const r = Object.assign([{ transcript: text }], { isFinal: true }); sr.results.push(r); sr.onresult({ resultIndex: sr.results.length - 1, results: sr.results }); };
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
await p.waitForTimeout(900);
const dictate = async (text) => {
  await p.fill("#composer-text", "");
  await p.click("#mic-btn");
  await p.evaluate((t) => window.__say(t), text);
  const v = await p.inputValue("#composer-text");
  await p.locator("#composer-text").press("Escape");
  return v;
};
for (const [said, want] of [
  ["at agents please look at the logs", "@agents please look at the logs"],
  ["ask at vedu about the deploy", "ask @vedu about the deploy"],
  ["at vito can you check", "@vedu can you check"],
  ["at vedu's agent run the tests", "@vedu's agent run the tests"],
  ["at vedus agent too", "@vedu's agent too"],
  ["at Maya and at jarvis", "@maya and @Jarvis"],
  ["at my agent remember this", `@${P}'s agent remember this`],
  ["at everyone standup in five", "@all standup in five"],
  ["meet at noon at the office", "meet at noon at the office"],
  ["look at this and at least that", "look at this and at least that"],
  ["at zebra is not a member", "at zebra is not a member"],
  // opus-d's false tags (#1753, #1755): 's only before agent/assistant; short handles match only by word or sound
  ["look at ann's draft", "look at ann's draft"],
  ["at and then we ship", "at and then we ship"],
  ["at ann can you review", "@ann can you review"],
  ["at ann's agent take it", "@ann's agent take it"],
]) {
  const got = await dictate(said);
  check(got === want, `"${said}" → ${JSON.stringify(got)}`);
}
// Sent, the mention reaches who it names.
await p.fill("#composer-text", "");
await p.click("#mic-btn");
await p.evaluate(() => window.__say("at vedu can you look send it"));
await p.waitForTimeout(1500);
const all = (await (await fetch(`${BASE}/api/boards/${board}/entries?after=0`, { headers: { authorization: `Bearer ${tok}` } })).json()).entries;
const sent = all.find((e) => e.text === "@vedu can you look");
check(!!sent && JSON.stringify(sent.mentions ?? []).includes("vedu"), `"send it" posts it with vedu mentioned (${JSON.stringify(sent && { text: sent.text, mentions: sent.mentions })})`);
check(!errors.length, `no page errors ${errors.join(" | ")}`);
await browser.close();
console.log(fails ? `${fails} FAILED` : "dictation-mentions: all passed");
process.exit(fails ? 1 : 0);
