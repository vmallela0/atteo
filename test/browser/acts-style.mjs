// A message's hover toolbar reads as one row of buttons (jxn #4140/#4141): every text action (Reply, Unsend, Remind me,
// Purge, …) has the same font, weight, size and height, and they sit centred on one line. BASE, ADMIN_KEY, PW_CHROME.
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": process.env.ADMIN_KEY || "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), P = `as${run}`;
await ops("users", { name: P, email: `${P}@example.com`, verified: "true", display: { mode: "developer" } });
const board = (await ops("boards", { user: P, title: `Acts ${run}` })).board.id;
const ck = (await ops("sessions", { user: P })).cookie.split(";")[0];
const seq = (await (await fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { "content-type": "application/json", cookie: ck }, body: JSON.stringify({ text: `a note to act on ${run}` }) })).json()).entry?.seq;
let fails = 0; const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
const [k, ...v] = ck.split("="); await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
const p = await ctx.newPage(), errors = []; p.on("pageerror", (e) => errors.push(e.message));
await p.goto(`${BASE}/b/${board}`);
await p.locator(`#e${seq}`).hover();
await p.waitForFunction((s) => getComputedStyle(document.querySelector(`#e${s} .acts`)).opacity === "1", seq, { timeout: 5000 }).catch(() => {});
const items = await p.evaluate((s) => [...document.querySelectorAll(`#e${s} .acts > button, #e${s} .acts > details > summary`)].filter((x) => x.offsetParent && x.textContent.trim() && !/^[^\w]+$/u.test(x.textContent.trim()))
  .map((x) => { const c = getComputedStyle(x), r = x.getBoundingClientRect(); return { t: x.textContent.trim(), font: c.fontFamily.split(",")[0], w: c.fontWeight, size: c.fontSize, h: Math.round(r.height), mid: Math.round(r.top + r.height / 2) }; }), seq);
const same = (k) => new Set(items.map((x) => x[k])).size === 1;
const midOk = Math.max(...items.map((x) => x.mid)) - Math.min(...items.map((x) => x.mid)) <= 1;
check(items.length >= 3 && items.some((x) => x.t === "Remind me") && same("font") && same("w") && same("size") && same("h") && midOk, `the toolbar's text actions share font, weight, size and height, centred on one line (${JSON.stringify(items)})`);
await p.locator(`#e${seq} .acts .remind-menu summary`).click();
check(await p.locator(`#e${seq} .acts .remind-menu[open] [data-remind-message="hour"]`).isVisible(), "Remind me still opens its menu");
check(!errors.length, `no page errors ${errors.join(" | ")}`);
await b.close(); console.log(fails ? `${fails} FAILED` : "toolbar style: all passed"); process.exit(fails ? 1 : 0);
