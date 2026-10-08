// The web's weight budget (coordinator #2144 item 1, claude #2148): what a board, For you and Inbox cost to load, by
// kind, against the baseline in web-budget.json beside this file. Fails when any number grows more than 10% over it
// (with a little slack for tiny numbers: 2 KB, or 2 requests), and says which page and which asset grew.
// Counted per page, everything it loads in its first 2.5 s (the page, then what it fetches; live sockets aren't):
//   html       the document's own markup (the page minus its inline <script> and <style>)
//   inline_js  inline <script> bytes · inline_css  inline <style> bytes
//   js, css, img, data   files the page loads from this server (scripts, stylesheets, images, fetch/XHR answers)
//   fonts      font files (Google Fonts today); skipped when they can't be reached (offline CI)
//   requests   how many requests the page makes
// Bytes are decoded sizes (what the browser has to parse), not compressed transfer sizes.
// UPDATE=1 writes today's numbers as the new baseline (commit it with the change that made the page heavier).
// "limits" in web-budget.json pins a hard cap for one page's asset instead of the 10% rule (board js: measured + 1 KB,
// so growth shows up at once). UPDATE=1 keeps them; raise one by hand, on purpose, in the change that needs it.
// BASE, ADMIN_KEY, PW_CHROME.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const FILE = new URL("./web-budget.json", import.meta.url);
const GROW = 0.1, SLACK = { bytes: 2048, requests: 2 };
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": process.env.ADMIN_KEY || "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), P = `wb${run}`, V = `wv${run}`;
for (const u of [P, V]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true", display: { mode: "developer" } });
const board = (await ops("boards", { user: P, title: `Budget ${run}` })).board.id; await ops("members", { board, user: V });
const ckP = (await ops("sessions", { user: P })).cookie, ckV = (await ops("sessions", { user: V })).cookie;
// A board with a little of everything a real one has: plain notes, a question for you, a reply, a task, a code block.
const post = (ck, body) => fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { "content-type": "application/json", cookie: ck }, body: JSON.stringify(body) }).then((r) => r.json());
const q = await post(ckV, { type: "question", text: `@${P} can you check the staging port before the deploy?` });
await post(ckP, { text: "Yes: 8443, and the health check is green.", reply_to: q.entry?.seq });
await post(ckV, { type: "task", text: "Ship the release notes\n- [ ] draft\n- [ ] review" });
await post(ckV, { text: "The config:\n```ts\nexport const port = 8443;\nexport function ok(s: number) { return s === 200; }\n```" });
await Promise.all([0, 1, 2, 3, 4, 5].map((i) => post(i % 2 ? ckP : ckV, { text: `Note ${i + 1}: the build passed, the docs are up to date, and nothing is waiting on review.` })));

const kinds = ["html", "inline_js", "inline_css", "js", "css", "img", "data", "fonts", "requests"];
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
async function measure(path) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 860 } });
  const [k, ...v] = ckP.split(";")[0].split("="); await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage(), errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  const m = Object.fromEntries(kinds.map((x) => [x, 0])), seen = [];
  let fontFail = 0;
  p.on("requestfailed", (r) => { if (r.resourceType() === "font" || /fonts\.(googleapis|gstatic)\.com/.test(r.url())) fontFail++; });
  p.on("response", async (r) => {
    const req = r.request(), t = req.resourceType(), url = r.url();
    if (t === "websocket" || url.startsWith("data:") || url.startsWith("blob:")) return;
    m.requests++;
    const job = (async () => {
      let n = 0;
      try { n = (await r.body()).length; } catch { return; } // redirects and aborted loads have no body
      if (t === "document" && url.startsWith(BASE)) {
        const html = (await r.body()).toString("utf8");
        const sum = (re) => [...html.matchAll(re)].reduce((a, x) => a + Buffer.byteLength(x[1]), 0);
        const js = sum(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g), css = sum(/<style[^>]*>([\s\S]*?)<\/style>/g);
        m.inline_js += js; m.inline_css += css; m.html += n - js - css;
      } else if (t === "font") m.fonts += n;
      else if (!url.startsWith(BASE)) return; // other servers' files (Google's font CSS): counted as requests only
      else if (t === "script") m.js += n;
      else if (t === "stylesheet") m.css += n;
      else if (t === "image") m.img += n;
      else m.data += n;
    })();
    seen.push(job);
  });
  await p.goto(`${BASE}${path}`, { waitUntil: "load" });
  await p.evaluate(() => document.querySelector(".code-b")?.scrollIntoView({ block: "center" })); // code colours load once a block is on screen
  await p.waitForTimeout(2500);
  await Promise.all(seen);
  await ctx.close();
  return { m, errors, fontsOffline: fontFail > 0 && m.fonts === 0 };
}

const pages = { board: `/b/${board}`, "for-you": "/for-you", inbox: "/inbox" };
const now = {}, notes = [];
let fails = 0; const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
// The three pages load side by side, each in its own context, each with its own 2.5 s window.
const measured = await Promise.all(Object.values(pages).map(measure));
for (const [i, name] of Object.keys(pages).entries()) {
  const r = measured[i];
  now[name] = r.m;
  if (r.fontsOffline) notes.push(name);
  check(!r.errors.length, `${name}: loads without page errors ${r.errors.join(" | ")}`);
  console.log(`  ${name}: ${kinds.map((x) => `${x} ${x === "requests" ? r.m[x] : kb(r.m[x])}`).join(" · ")}`);
}
await b.close();

const old = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {}, limits = old.limits ?? {};
if (process.env.UPDATE === "1") {
  writeFileSync(FILE, JSON.stringify({ note: "test/browser/web-budget.mjs: bytes (decoded) and request counts per page. UPDATE=1 node web-budget.mjs rewrites it.", ...(old.limits ? { limits } : {}), pages: now }, null, 1) + "\n");
  console.log(`wrote the baseline: ${FILE.pathname}`);
  process.exit(fails ? 1 : 0);
}
check(existsSync(FILE), `a baseline exists (${FILE.pathname}); make one with UPDATE=1`);
if (existsSync(FILE)) {
  const base = old.pages;
  for (const [name, m] of Object.entries(now)) for (const x of kinds) {
    const was = base?.[name]?.[x];
    if (was == null) { check(false, `${name}: no baseline for ${x}; run with UPDATE=1`); continue; }
    if (x === "fonts" && notes.includes(name)) { console.log(`· ${name}: fonts weren't reachable, so they're not compared`); continue; }
    const req = x === "requests", pin = limits[name]?.[x], v = m[x];
    const cap = pin ?? Math.max(Math.round(was * (1 + GROW)), was + (req ? SLACK.requests : SLACK.bytes));
    const show = (n) => (req ? String(n) : kb(n));
    const pct = was ? Math.round(((v - was) / was) * 100) : 100;
    check(v <= cap, v <= cap ? `${name} ${x}: ${show(v)} (baseline ${show(was)}, ${pct >= 0 ? "+" : ""}${pct}%)` : `${name}: ${x} grew ${pct}%: ${show(was)} → ${show(v)}, over the budget of ${show(cap)}. ${pin != null ? `That's a pinned limit: if it's meant to, raise limits.${name}.${x} in web-budget.json by hand, with the change.` : "If it's meant to, UPDATE=1 rewrites web-budget.json; commit it with the change."}`);
  }
}
console.log(fails ? `${fails} FAILED` : "web budget: all passed (within 10% of the baseline, or under a pinned limit)");
process.exit(fails ? 1 : 0);
