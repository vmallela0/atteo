// A signed-in browser check that crawls every in-app link and button href it can see on For you, a board,
// Account, Approvals, and Inbox, and fails on any 404 or 500. Same shape as the other browser checks: it
// makes a user and a board through the operator API, signs in with the session cookie, and walks the page
// in Chromium. A link is anything with an `a[href]` or a `[data-href]` (a "button href" — the change card
// opens GitHub that way); only same-origin paths starting with `/` are crawled, so external cards and
// api/ endpoints are left alone.
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), A = `cr${run}`;
await ops("users", { name: A, email: `${A}@example.com`, verified: "true" });
const board = (await ops("boards", { user: A, title: `Crawl ${run}` })).board.id;
const ck = (await ops("sessions", { user: A })).cookie;
let fails = 0; const check = (ok, m) => { console.log(`${ok ? "✓" : "✗"} ${m}`); if (!ok) fails++ };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
const [k, ...v] = ck.split(";")[0].split("="); await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
const p = await ctx.newPage();
const errors = []; p.on("pageerror", e => errors.push(e.message));
const sources = ["/for-you", `/b/${board}`, "/me", "/approvals", "/inbox"];
const seen = new Set();
for (const src of sources) {
  const r = await p.goto(`${BASE}${src}`); await p.waitForTimeout(700);
  check(!!r && r.status() === 200, `${src} loads (got ${r?.status() ?? "no response"})`);
  const hrefs = await p.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll("a[href], [data-href]")) {
      const h = el.getAttribute("href") || el.getAttribute("data-href") || "";
      if (h) out.push(h);
    }
    return out;
  });
  for (const h of hrefs) {
    if (!h.startsWith("/")) continue;          // external (e.g. github) or fragment-only — not in-app
    if (h.startsWith("/api/")) continue;      // api endpoints aren't pages; some reject GET
    const path = h.split("#")[0];
    if (!path || path === "/") { seen.add("/"); continue; }
    seen.add(path);
  }
}
const sorted = [...seen].sort();
check(sorted.length > 0, `collected in-app links to crawl (found ${sorted.length})`);
const bad = [];
for (const path of sorted) {
  const res = await ctx.request.get(`${BASE}${path}`, { maxRedirects: 0 });
  const st = res.status();
  // 3xx redirects are fine (e.g. /agent -> /b/:id); only 404/500 (and 5xx) count as broken.
  if (st === 404 || st >= 500) { bad.push(`${path} -> ${st}`); check(false, `${path} returns ${st}`); }
  else check(true, `${path} returns ${st}`);
}
check(bad.length === 0, `no 404 or 500 among crawled links${bad.length ? ` (${bad.join(", ")})` : ""}`);
check(errors.length === 0, `no page errors ${errors.join(" | ")}`);
await b.close();
console.log(fails ? `${fails} FAILED` : "crawl: all passed");
process.exit(fails ? 1 : 0);
