// Browser check (#651): the composer bar stays one row on phones, Post on the right, nothing wider than the screen.
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const OUT = `${SHOTS_DIR}/`;
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), A = `cp${run}`;
await ops("users", { name: A, email: `${A}@example.com`, verified: "true" });
const board = (await ops("boards", { user: A, title: `Composer ${run}` })).board.id;
let fails = 0; const check = (ok, m) => { console.log(`${ok ? "✓" : "✗"} ${m}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
for (const [w, scheme] of [[320, "dark"], [360, "light"], [390, "dark"], [390, "light"], [430, "dark"], [800, "light"], [1280, "dark"]]) {
  const phone = w < 500;
  const ctx = await b.newContext({ viewport: { width: w, height: 800 }, isMobile: phone, hasTouch: phone, deviceScaleFactor: 2, colorScheme: scheme });
  const ck = (await ops("sessions", { user: A })).cookie; const [k, ...v] = ck.split(";")[0].split("=");
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage(); const errors = []; p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${BASE}/b/${board}`); await p.waitForTimeout(700);
  const m = await p.evaluate(() => {
    const bar = document.querySelector(".composer .bar"), br = bar.getBoundingClientRect(), pad = parseFloat(getComputedStyle(bar).paddingRight);
    const vis = [...bar.children].filter((e) => e.offsetParent && e.getBoundingClientRect().width > 0);
    const mids = vis.map((e) => { const r = e.getBoundingClientRect(); return r.top + r.height / 2; });
    const post = bar.querySelector(".btn.primary").getBoundingClientRect(), seg = bar.querySelector(".seg") || { scrollWidth: 0, clientWidth: 0 };
    return { rows: Math.max(...mids) - Math.min(...mids), postGap: Math.round(br.right - pad - post.right), segScroll: seg.scrollWidth - seg.clientWidth, doc: document.documentElement.scrollWidth, W: innerWidth, h: Math.round(br.height) };
  });
  console.log(`-- ${w}px ${scheme}: ${JSON.stringify(m)}`);
  check(m.rows < 2, `attach, @ and Post sit on one row (centres within ${m.rows.toFixed(1)}px)`);
  check(Math.abs(m.postGap) <= 1, `Post is at the right edge (${m.postGap}px off)`);
  check(m.doc <= m.W, `page no wider than the screen (${m.doc} ≤ ${m.W})`);
  check(m.h <= 60, `bar is one row tall (${m.h}px)`);
  check(!(await p.locator(".composer .seg").count()), "no type picker: people just write (jxn #928)");
  await p.click("#composer-text"); await p.keyboard.type(`hello from ${w}`); await p.click(".composer .btn.primary");
  await p.waitForFunction((t) => document.getElementById("thread").textContent.includes(t), `hello from ${w}`, { timeout: 5000 }).catch(() => {});
  check(await p.evaluate((t) => document.getElementById("thread").textContent.includes(t), `hello from ${w}`), "posting still works");
  await p.locator(".composer").screenshot({ path: `${OUT}composer-${w}-${scheme}.png` });
  check(errors.length === 0, `no page errors ${errors.join(" | ")}`);
  await ctx.close();
}
await b.close(); console.log(fails ? `${fails} FAILED` : "all composer-phone checks passed"); process.exit(fails ? 1 : 0);
