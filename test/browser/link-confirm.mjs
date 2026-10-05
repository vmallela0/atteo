// Leaving Atteo asks first (jxn #4173): a link in a message to another site opens "Open this link?" with the whole
// address; Cancel stays, Open opens it in a new tab; a link to this site goes straight through. BASE, ADMIN_KEY, PW_CHROME.
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": process.env.ADMIN_KEY || "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), P = `lc${run}`;
await ops("users", { name: P, email: `${P}@example.com`, verified: "true", display: { mode: "developer" } });
const board = (await ops("boards", { user: P, title: `Links ${run}` })).board.id;
const ck = (await ops("sessions", { user: P })).cookie.split(";")[0];
const EXT = `https://github.com/vmallela0/agent-soup/pull/${run}`;
const seq = (await (await fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { "content-type": "application/json", cookie: ck }, body: JSON.stringify({ text: `see ${EXT} and ${BASE}/guide` }) })).json()).entry?.seq;
let fails = 0; const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.route("https://github.com/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<title>gh</title>" }));
const [k, ...v] = ck.split("="); await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
const p = await ctx.newPage(), errors = []; p.on("pageerror", (e) => errors.push(e.message));
await p.goto(`${BASE}/b/${board}`);
const ext = p.locator(`#e${seq} .body a[href^="https://github.com"]`);
await ext.waitFor({ timeout: 8000 }).catch(() => {});
let popups = 0; ctx.on("page", () => popups++);
await ext.click();
const shown = await p.evaluate(() => ({ open: !!document.getElementById("leave")?.open, url: document.getElementById("leave-url")?.textContent, title: document.getElementById("leave-title")?.textContent, buttons: [...document.querySelectorAll("#leave .ft button")].map((b) => b.textContent) }));
check(shown.open && shown.url === EXT && shown.title === "Open this link?" && shown.buttons.join() === "Cancel,Open" && popups === 0, `a link to another site asks first, with the whole address (${JSON.stringify(shown)})`);
await p.locator("#leave [data-close]").last().click();
check(!(await p.evaluate(() => document.getElementById("leave").open)) && popups === 0, "Cancel stays here");
await ext.click();
const [tab] = await Promise.all([ctx.waitForEvent("page", { timeout: 5000 }).catch(() => null), p.locator("#leave-go").click()]);
check(!!tab && tab.url() === EXT && !(await p.evaluate(() => document.getElementById("leave").open)), `Open opens it in a new tab (${tab?.url()})`);
await tab?.close();
const own = p.locator(`#e${seq} .body a[href$="/guide"]`);
if (await own.count()) {
  const [t2] = await Promise.all([ctx.waitForEvent("page", { timeout: 5000 }).catch(() => null), own.click()]);
  check(!(await p.evaluate(() => !!document.getElementById("leave")?.open)) && !!t2, "a link to this site doesn't ask");
  await t2?.close();
}
check(!errors.length, `no page errors ${errors.join(" | ")}`);
await b.close(); console.log(fails ? `${fails} FAILED` : "link confirm: all passed"); process.exit(fails ? 1 : 0);
