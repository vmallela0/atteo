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
// A choice made before the saved level arrives stays (the late answer used to tick the old level again).
let late;
const slow = new Promise((r) => (late = r));
await p.route(`**/api/boards/${board}/notify`, async (route) => { if (route.request().method() !== "GET") return route.continue(); const r = await route.fetch(); await new Promise((t) => setTimeout(t, 600)); await route.fulfill({ response: r }); late(); });
await p.reload();
await p.waitForSelector("#ns-side", { state: "attached" });
if (!(await p.locator("#ns-side").isVisible())) await p.locator("#info-btn").click();
await p.locator('label[for="ns-level-off"]').click();
await slow; await p.waitForTimeout(200);
await p.unroute(`**/api/boards/${board}/notify`);
check(await p.locator("#ns-level-off").isChecked() && /Inbox/.test(await p.locator("#ns-side-hint").textContent()), "picked before the saved level loads: Off stays chosen, with its hint");

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

// Same start and end (#2668): refused with the reason under the times, and nothing saved.
await p.locator("#ns-end").fill("21:30");
await p.locator("#ns-end").dispatchEvent("change");
await p.waitForTimeout(300);
check(await p.locator("#ns-err").isVisible() && /different start and end/.test(await p.locator("#ns-err").textContent()), "same start and end: the reason shows under the times");
check((await api(`/api/me/notify`)).quiet.end === "07:00", "and nothing was saved");
await p.locator("#ns-end").fill("06:00");
await p.locator("#ns-end").dispatchEvent("change");
await p.waitForTimeout(400);
check(!(await p.locator("#ns-err").isVisible()) && (await api(`/api/me/notify`)).quiet.end === "06:00", "a real window: the message goes and it saves");
await p.request.put(`${BASE}/api/me/notify`, { data: { quiet: { on: false } } });

// The digest (#2668): the server counts what waited for it, so one summary says how many, in the right number.
// Browser notifications are recorded instead of shown; the digest time is set to a minute ago.
const O = `nlo${run}`;
await ops("users", { name: O, email: `${O}@example.com`, verified: "true" });
await ops("members", { board, user: O });
const ock = (await ops("sessions", { user: O })).cookie.split(";")[0];
const postAs = (text) => fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { cookie: ock, "content-type": "application/json" }, body: JSON.stringify({ type: "note", text }) });
const hm = (t) => new Date(t).toLocaleTimeString("en-GB", { timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit" });
await p.request.put(`${BASE}/api/me/notify`, { data: { quiet: { tz: "America/Los_Angeles" } } });
await p.request.put(`${BASE}/api/boards/${board}/notify`, { data: { level: "needs_me" } });
// What's posted waits for the next digest: set it just ahead, and let the page's count ask a few minutes later (the dev
// clock), so that digest is the one due.
let devNow = 0;
const dueSoon = async () => {
  await p.request.put(`${BASE}/api/me/notify`, { data: { digest: [hm(Date.now() + 60_000)] } });
  devNow = Date.now() + 180_000;
};
await p.route("**/api/inbox/count*", (route) => route.continue({ headers: { ...route.request().headers(), ...(devNow ? { "x-dev-now": String(devNow) } : {}) } }));
await p.addInitScript(() => {
  window.__notes = [];
  window.Notification = class { constructor(t, o) { window.__notes.push({ t, b: (o && o.body) || "" }); } static get permission() { return "granted"; } static requestPermission() { return Promise.resolve("granted"); } };
  try { if (!sessionStorage.getItem("dg-primed")) { localStorage.setItem("inbox-dg-at", "1"); sessionStorage.setItem("dg-primed", "1"); } } catch {}
});
const digestNote = async () => {
  await p.goto(`${BASE}/me`);
  await p.waitForFunction(() => window.__notes && window.__notes.some((n) => /since the last digest/.test(n.t)), null, { timeout: 6000 }).catch(() => {});
  return p.evaluate(() => window.__notes.filter((n) => /since the last digest/.test(n.t)));
};
await postAs(`@all one thing ${run}`);
await dueSoon();
let notes = await digestNote();
check(notes.length === 1 && notes[0].t === "1 update since the last digest" && notes[0].b.includes(`Notify ${run}`), `one item: "${notes[0] && notes[0].t}" (${notes[0] && notes[0].b})`);
await p.reload();
await p.waitForTimeout(800);
check(!(await p.evaluate(() => window.__notes.some((n) => /since the last digest/.test(n.t)))), "shown once: a reload doesn't show it again");
// Several arrivals between polls all count (they were 1 per poll before).
for (const i of [2, 3, 4]) await postAs(`@all thing ${i} ${run}`);
await dueSoon();
await p.evaluate(() => { try { localStorage.setItem("inbox-dg-at", "1"); } catch {} });
notes = await digestNote();
check(notes.length === 1 && notes[0].t === "4 updates since the last digest", `four items, one poll: "${notes[0] && notes[0].t}"`);

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
