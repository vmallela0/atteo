// Browser check (#674): on phones the topbar keeps the board's name visible, even with "Connect an agent" showing.
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const OUT = `${SHOTS_DIR}/`;
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), A = `hp${run}`, B = `hq${run}`;
for (const u of [A, B]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true" });
const title = `Launch plan ${run}`;
const board = (await ops("boards", { user: A, title })).board.id;
let fails = 0; const check = (ok, m) => { console.log(`${ok ? "✓" : "✗"} ${m}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
for (const [w, scheme] of [[320, "dark"], [360, "light"], [390, "dark"], [390, "light"], [1280, "dark"]]) {
  const phone = w < 500;
  const ctx = await b.newContext({ viewport: { width: w, height: 700 }, isMobile: phone, hasTouch: phone, deviceScaleFactor: 2, colorScheme: scheme });
  const ck = (await ops("sessions", { user: A })).cookie; const [k, ...v] = ck.split(";")[0].split("=");
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage(); const errors = []; p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${BASE}/b/${board}`); await p.waitForTimeout(600);
  // Desktop boards have one header row (jxn #4860): "Boards /" and the name lead the board's own header; phones keep the top bar.
  const m = await p.evaluate((phone) => {
    const cur = document.querySelector(phone ? ".topbar .crumbs .cur" : "#board-title"), r = cur.getBoundingClientRect(), con = document.querySelector('.actions [data-open="connect"]');
    const parent = document.querySelector(phone ? ".topbar .crumbs a" : "a.bp-crumb");
    return { curW: Math.round(r.width), curText: cur.textContent, parentShown: !!(parent && parent.getBoundingClientRect().width), connect: con ? con.innerText.trim() : null, connectName: con?.getAttribute("aria-label"), doc: document.documentElement.scrollWidth, W: innerWidth };
  }, phone);
  console.log(`-- ${w}px ${scheme}: ${JSON.stringify(m)}`);
  check(m.connect === (w <= 640 ? "Connect" : "Connect an agent"), `the connect button reads "${m.connect}"`);
  check(m.connectName === "Connect an agent", "…and is still named \"Connect an agent\" for screen readers");
  check(m.parentShown === !phone, `the "Boards /" crumb ${phone ? "is hidden" : "shows"}`);
  check(m.curW >= (w >= 360 ? 60 : 40), `the board name has room (${m.curW}px)`);
  check(m.doc <= m.W, `page no wider than the screen (${m.doc} ≤ ${m.W})`);
  await p.locator(phone ? ".topbar" : ".bp-head").screenshot({ path: `${OUT}header-${w}-${scheme}.png` });
  // the button still opens the connect dialog
  await p.click('.actions [data-open="connect"]'); await p.waitForTimeout(300);
  check(await p.evaluate(() => !!document.querySelector("dialog[open]")), "Connect opens its dialog");
  check(errors.length === 0, `no page errors ${errors.join(" | ")}`);
  await ctx.close();
}
// the People page on a phone: just the person's name
{ const ctx = await b.newContext({ viewport: { width: 390, height: 700 }, isMobile: true, hasTouch: true });
  const ck = (await ops("sessions", { user: A })).cookie; const [k, ...v] = ck.split(";")[0].split("=");
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage(); await p.goto(`${BASE}/u/${B}`); await p.waitForTimeout(500);
  const t = await p.evaluate(() => document.querySelector(".topbar .crumbs").innerText.trim());
  check(t === B, `profile topbar on a phone reads "${t}"`); await ctx.close(); }
await b.close(); console.log(fails ? `${fails} FAILED` : "all header-phone checks passed"); process.exit(fails ? 1 : 0);
