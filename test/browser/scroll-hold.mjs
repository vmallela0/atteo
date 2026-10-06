// Scrolled up, you stay where you are (jxn #4864/#4879/#4881): on a long, live board (agents posting, someone typing),
// a reader who scrolls back through history with a trackpad isn't pulled to the bottom, and can keep going up to #1.
// Usage: BASE=http://localhost:8787 node scroll-hold.mjs  (local dev only, ADMIN_KEY=ci-admin-key in .dev.vars)
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const KEY = process.env.ADMIN_KEY || "ci-admin-key";
const HOLD = +(process.env.HOLD_MS || 12000);
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": KEY, "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), A = `sh${run}`, B = `si${run}`, C = `sj${run}`;
for (const u of [A, B, C]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true", display: { mode: "developer", compact: "others" } }); // one-line rows, as jxn reads
const board = (await ops("boards", { user: A, title: `Scroll hold ${run}` })).board.id;
for (const u of [B, C]) await ops("members", { board, user: u });
const tokB = (await ops("tokens", { user: B })).token;
const ckC = (await ops("sessions", { user: C })).cookie.split(";")[0];
const mcp = async (name, args) => (await (await fetch(`${BASE}/mcp?board=${board}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tokB}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json());
const person = async (text) => fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { cookie: ckC, origin: BASE, "content-type": "application/json" }, body: JSON.stringify({ type: "note", text }) });
const typing = () => fetch(`${BASE}/api/boards/${board}/typing`, { method: "POST", headers: { cookie: ckC, origin: BASE } }).catch(() => {});
await mcp("read", {});
for (let i = 0; i < 260; i++) {
  const long = i % 7 === 0 ? "\n\n" + "A longer agent update with several lines of detail. ".repeat(6) : "";
  if (i % 3 === 0) await person(`person message ${i} about the plan`);
  else await mcp("post", { type: "note", text: `agent message ${i}, a few words so it takes a line${long}` });
}

let fails = 0;
const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
for (const [w, h] of [[1280, 800], [390, 844]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: w < 500 });
  const ck = (await ops("sessions", { user: A })).cookie, [k, ...v] = ck.split(";")[0].split("=");
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage(), errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${BASE}/b/${board}`);
  await p.waitForTimeout(1200);
  console.log(`  (${w}px: compact=${await p.evaluate(() => document.documentElement.dataset.compact || "-")}, entries on page ${await p.evaluate(() => document.querySelectorAll("#thread>.entry").length)})`);
  const st = () => p.evaluate(() => { const s = document.getElementById("thread-scroll"); return { top: Math.round(s.scrollTop), gap: Math.round(s.scrollHeight - s.scrollTop - s.clientHeight) }; });
  // A trackpad: many small wheel steps over time, well back into history.
  await p.mouse.move(w / 2, h / 2);
  for (let i = 0; i < 40; i++) { await p.mouse.wheel(0, -120); await p.waitForTimeout(30); }
  await p.waitForTimeout(900);
  const held = await st();
  check(held.gap > 1500, `${w}px: scrolled well up (gap ${held.gap}px)`);
  // Hold still while the board is live: agents post, someone types.
  let worst = 0, yank = null;
  const t0 = Date.now();
  let n = 0;
  while (Date.now() - t0 < HOLD) {
    if (n % 4 === 0) await mcp("post", { type: "note", text: `live agent update ${w}-${n}` });
    await typing();
    await p.waitForTimeout(500);
    const s = await st();
    const moved = Math.abs(s.top - held.top);
    if (moved > worst) worst = moved;
    if (!yank && s.gap < 200) yank = s;
    n++;
  }
  check(!yank && worst < 40, `${w}px: holding mid-history on a live board, the view stays put (moved ≤ ${worst}px${yank ? `, yanked to gap ${yank.gap}` : ""})`);
  // Keep going up: the trackpad reaches the first message.
  let first = 0;
  for (let i = 0; i < 400; i++) {
    await p.mouse.wheel(0, -400);
    await p.waitForTimeout(25);
    if (i % 20 === 19) { first = await p.evaluate(() => +(document.querySelector("#thread>.entry,#thread>.ghost")?.dataset.seq || 0)); const s = await st(); if (first === 1 && s.top < 5) break; await p.waitForTimeout(400); }
  }
  first = await p.evaluate(() => +(document.querySelector("#thread>.entry,#thread>.ghost")?.dataset.seq || 0));
  const top = (await st()).top;
  check(first === 1 && top < 5, `${w}px: scrolling up reaches the first message (first #${first}, scrollTop ${top})`);
  check(!errors.length, `${w}px: no page errors ${errors.join(" | ")}`);
  await ctx.close();
}
await browser.close();
console.log(fails ? `${fails} FAILED` : "scroll-hold: all passed");
process.exit(fails ? 1 : 0);
