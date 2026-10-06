// Closing tabs in the frame's strip (jxn #5055): each tab has an × that closes it, it stays closed after a reload, opening
// that board again brings its tab back, closing the tab you're on takes you to its neighbour, and Delete on a focused tab
// closes it. Remembered per browser. Light 1280. Usage: BASE=http://localhost:8787 node tabs-close.mjs
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": process.env.ADMIN_KEY || "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), A = `tc${run}`;
await ops("users", { name: A, email: `${A}@example.com`, verified: "true", display: { mode: "developer" } });
const ids = [];
for (const t of ["One", "Two", "Three", "Four"]) ids.push((await ops("boards", { user: A, title: `${t} ${run}` })).board.id);
const [one, two, three, four] = ids;
const ck = (await ops("sessions", { user: A })).cookie;
let fails = 0;
const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const ctx = await b.newContext({ viewport: { width: 1280, height: 820 } });
const [k, ...v] = ck.split(";")[0].split("="); await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
const p = await ctx.newPage(), errors = []; p.on("pageerror", (e) => errors.push(e.message));
const open = async (id) => { await p.goto(`${BASE}/b/${id}`); await p.locator("#composer-text").waitFor(); };
const shown = (id) => p.locator(`[data-tabw="${id}"]`).isVisible();
await open(one);
check(await shown(two) && await shown(three), "the strip shows the other boards' tabs");
// The × on Two's tab closes it, without opening Two.
await p.locator(`[data-tabw="${two}"]`).hover();
await p.locator(`[data-tab-close="${two}"]`).click();
check(!(await shown(two)) && new URL(p.url()).pathname === `/b/${one}`, "the × closes that tab and you stay where you are");
await open(one);
check(!(await shown(two)), "it stays closed after a reload");
// Opening Two again brings its tab back.
await open(two);
check(await shown(two), "opening the board again brings its tab back");
// Closing the tab you're on goes to a neighbouring tab.
await p.locator(`[data-tabw="${two}"]`).hover();
await p.locator(`[data-tab-close="${two}"]`).click();
await p.waitForURL((u) => !u.pathname.endsWith(two), { timeout: 5000 }).catch(() => {});
const at = new URL(p.url()).pathname;
check(at !== `/b/${two}` && /^\/b\//.test(at), `closing the tab you're on takes you to a neighbour (${at})`);
await p.locator("#composer-text").waitFor();
check(!(await shown(two)), "and that tab is gone");
// Keyboard: Delete on a focused tab closes it.
await p.locator(`[data-tabw="${four}"] .btab`).focus();
await p.keyboard.press("Delete");
check(!(await shown(four)), "Delete on a focused tab closes it");
check(!errors.length, `no page errors ${errors.join(" | ")}`);
await b.close();
console.log(fails ? `${fails} FAILED` : "tabs close: all passed");
process.exit(fails ? 1 : 0);
