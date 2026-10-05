// Notification volume (vedu #2490): Board info → Notifications sets your level for that board, Account → Notifications
// sets quiet hours; both save, survive a reload, and fit a phone. Arabic lays them out right to left.
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), A = `nl${run}`;
await ops("users", { name: A, email: `${A}@example.com`, verified: "true" });
const board = (await ops("boards", { user: A, title: `Notify ${run}` })).board.id;
const ck = (await ops("sessions", { user: A })).cookie;
let fails = 0;
const check = (ok, m) => { console.log(`${ok ? "✓" : "✗"} ${m}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, timezoneId: "America/Los_Angeles" });
const [k, ...v] = ck.split(";")[0].split("=");
await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
const p = await ctx.newPage();
const errors = [];
p.on("pageerror", (e) => errors.push(e.message));
const api = async (path) => (await p.request.get(`${BASE}${path}`)).json();

// Board info → Notifications
await p.goto(`${BASE}/b/${board}`);
await p.waitForSelector("#ns-side", { state: "attached" });
if (!(await p.locator("#ns-side").isVisible())) await p.locator("#info-btn").click();
await p.waitForSelector("#ns-side", { state: "visible" });
check(await p.locator("#ns-level-needs_me").isChecked(), "Board info: Needs me is the default");
await p.waitForFunction(() => /9:00|09:00/.test(document.getElementById("ns-side-hint").textContent));
check(/approvals/i.test(await p.locator("#ns-side-hint").textContent()), `the hint says what interrupts, with the digest times: "${await p.locator("#ns-side-hint").textContent()}"`);
await p.locator('label[for="ns-level-off"]').click();
await p.waitForFunction(async (bd) => (await (await fetch(`/api/boards/${bd}/notify`)).json()).level === "off", board, { timeout: 5000 }).catch(() => {});
check((await api(`/api/boards/${board}/notify`)).level === "off", "Off saves to the account");
check(/Inbox/.test(await p.locator("#ns-side-hint").textContent()), "Off's hint: still in your Inbox");
await p.reload();
await p.waitForSelector("#ns-side", { state: "attached" });
if (!(await p.locator("#ns-side").isVisible())) await p.locator("#info-btn").click();
await p.waitForFunction(() => document.getElementById("ns-level-off").checked, null, { timeout: 5000 }).catch(() => {});
check(await p.locator("#ns-level-off").isChecked(), "after a reload, Off is still chosen");
await p.locator('label[for="ns-level-everything"]').click();
await p.waitForTimeout(400);
check((await api(`/api/boards/${board}/notify`)).level === "everything", "Everything saves");

// Account → Notifications: quiet hours, in this browser's time zone
await p.goto(`${BASE}/me`);
await p.waitForSelector("#ns-form");
await p.waitForFunction(() => document.getElementById("ns-hint").textContent.length > 0);
check(!(await p.locator("#ns-quiet").isChecked()), "Account: quiet hours are off by default");
await p.locator("#ns-start").fill("21:30");
await p.locator("#ns-quiet").check();
await p.waitForTimeout(500);
const me = await api(`/api/me/notify`);
check(me.quiet.on === true && me.quiet.start === "21:30" && me.quiet.end === "07:00" && me.quiet.tz === "America/Los_Angeles", `saved with the browser's zone: ${JSON.stringify(me.quiet)}`);
await p.reload();
await p.waitForFunction(() => document.getElementById("ns-quiet").checked, null, { timeout: 5000 }).catch(() => {});
check(await p.locator("#ns-quiet").isChecked() && (await p.locator("#ns-start").inputValue()) === "21:30", "after a reload, quiet hours show as saved");

// A phone, and Arabic (right to left)
await p.setViewportSize({ width: 390, height: 844 });
await p.goto(`${BASE}/me`);
await p.waitForSelector("#ns-form");
check(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "390px: Account doesn't overflow sideways");
await p.screenshot({ path: `${SHOTS_DIR}/notify-me-390.png` }).catch(() => {});
await p.goto(`${BASE}/b/${board}?lang=ar`);
await p.waitForSelector("#ns-side", { state: "attached" });
check((await p.evaluate(() => document.documentElement.dir)) === "rtl" && (await p.locator("#ns-side-h").textContent()) === "الإشعارات", "Arabic: right to left, translated");
check(!errors.length, `no page errors ${errors.join(" | ")}`);
await b.close();
console.log(fails ? `${fails} FAILED` : "all notify-levels checks passed");
process.exit(fails ? 1 : 0);
