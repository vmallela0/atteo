// Board settings → Schedules (shared crons, vedu #1129): add, toggle and delete a schedule at 1280px and 390px, a
// viewer sees the list without write controls, another person's new schedule shows up live; no page errors and no
// sideways scroll. Usage: BASE=http://localhost:8787 node schedules.mjs
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), P = `sp${run}`, Q = `sq${run}`, V = `sv${run}`;
for (const u of [P, Q, V]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true" });
const board = (await ops("boards", { user: P, title: `Schedules ${run}` })).board.id;
await ops("members", { board, user: Q });
await ops("members", { board, user: V });
const ck = {};
for (const u of [P, Q, V]) ck[u] = (await ops("sessions", { user: u })).cookie;
await fetch(`${BASE}/api/boards/${board}/members/${V}`, { method: "POST", headers: { cookie: ck[P], "content-type": "application/json" }, body: JSON.stringify({ role: "viewer" }) });
const api = async (who) => (await (await fetch(`${BASE}/api/boards/${board}/schedules`, { headers: { cookie: ck[who] } })).json()).schedules;
let fails = 0;
const check = (ok, m) => { console.log(`${ok ? "✓" : "✗"} ${m}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const SHOTS = `${SHOTS_DIR}/`;

async function open(who, width, height, mobile) {
  const ctx = await b.newContext({ viewport: { width, height }, timezoneId: "America/Los_Angeles", ...(mobile ? { isMobile: true, hasTouch: true } : {}) });
  const [k, ...v] = ck[who].split(";")[0].split("=");
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("dialog", (d) => d.accept());
  await p.goto(`${BASE}/b/${board}`);
  await p.locator("#info-btn").waitFor({ timeout: 8000 }).catch(() => {});
  // People who can post have Invite / settings in the header; anyone (viewers too) has "Manage" by the members list.
  if (await p.locator('[data-open="invite"]:visible').count()) await p.locator('[data-open="invite"]:visible').first().click();
  else {
    await p.locator("#info-btn").click();
    await p.locator('.linkish[data-open="invite"]:visible').first().waitFor({ timeout: 5000 }).catch(() => {});
    await p.locator('.linkish[data-open="invite"]:visible').first().click();
  }
  await p.locator("#acc-schedules").waitFor({ state: "visible", timeout: 5000 });
  await p.waitForFunction(() => !/Loading/.test(document.getElementById("acc-schedules").innerText), null, { timeout: 8000 }).catch(() => {});
  return { ctx, p, errors };
}
// Until the server has the schedule on or off (and a beat for the row to follow), up to 8 s.
const enabledIs = async (title, on) => { for (let i = 0; i < 80; i++) { if ((await api(P)).find((x) => x.title === title)?.enabled === on) break; await new Promise((r) => setTimeout(r, 100)); } await new Promise((r) => setTimeout(r, 150)); };
const noSideways = (p) => p.evaluate(() => {
  const d = document.getElementById("invite"), bd = d.querySelector(".bd");
  return { page: document.documentElement.scrollWidth <= innerWidth, dlg: d.scrollWidth <= d.clientWidth + 1, bd: bd.scrollWidth <= bd.clientWidth + 1, w: innerWidth, sw: document.documentElement.scrollWidth };
});

for (const [width, height, mobile] of [[1280, 900, false], [390, 800, true]]) {
  const tag = `${width}px`;
  const { ctx, p, errors } = await open(P, width, height, mobile);
  const sec = p.locator("#acc-schedules");
  await sec.scrollIntoViewIfNeeded();
  check(!/Loading/.test(await sec.innerText()) && (width > 400 ? /No schedules yet/.test(await sec.innerText()) : true) && (await p.locator("#sch-new").isVisible()), `${tag}: the Schedules section is in board settings${width > 400 ? ", empty," : ""} with the add form`);
  check((await p.inputValue("#sch-tz")) === "America/Los_Angeles", `${tag}: the time zone defaults to the browser's (${await p.inputValue("#sch-tz")})`);
  const pressed = await p.$$eval(".sch-day", (xs) => xs.filter((x) => x.getAttribute("aria-pressed") === "true").map((x) => x.dataset.day).join());
  check(pressed === "mon,tue,wed,thu,fri", `${tag}: weekdays are picked by default (${pressed})`);
  // Add: weekdays plus Saturday, 07:30.
  const title = `Run the tests ${run} ${width}`;
  await p.fill("#sch-title", title);
  await p.fill("#sch-body", "- [ ] unit\n- [ ] e2e");
  await p.fill("#sch-at", "07:30");
  await p.locator('.sch-day[data-day="sat"]').click();
  await p.locator('#sch-new [type="submit"]').click();
  const row = p.locator(".sch-row", { hasText: title });
  await row.waitFor({ timeout: 5000 });
  const rt = await row.innerText();
  check(/Mon, Tue, Wed, Thu, Fri, Sat 07:30 America\/Los_Angeles/.test(rt) && /Next: /.test(rt) && /Not posted yet/.test(rt) && (await p.inputValue("#sch-title")) === "", `${tag}: adding shows it with its days, time, zone and next run (${rt.replace(/\s+/g, " ").slice(0, 140)})`);
  let s = (await api(P)).find((x) => x.title === title);
  check(s && s.enabled && s.at === "07:30" && s.tz === "America/Los_Angeles" && s.days.join() === "mon,tue,wed,thu,fri,sat" && s.body === "- [ ] unit\n- [ ] e2e", `${tag}: …and the server has it`);
  if (width === 1280) {
    // Another person adds one while the settings are open: it appears without a reload.
    await fetch(`${BASE}/api/boards/${board}/schedules`, { method: "POST", headers: { cookie: ck[Q], "content-type": "application/json" }, body: JSON.stringify({ title: `Standup ${run}`, at: "09:00", tz: "Europe/Berlin", days: "weekdays" }) });
    await p.locator(".sch-row", { hasText: `Standup ${run}` }).waitFor({ timeout: 5000 }).catch(() => {});
    const other = p.locator(".sch-row", { hasText: `Standup ${run}` });
    check((await other.count()) === 1 && /weekdays 09:00 Europe\/Berlin/.test(await other.innerText()) && /by sq/.test(await other.innerText()) && (await other.locator(".sch-tog").count()) === 1, `${tag}: another person's new schedule shows up live, and the board's creator (an owner) can switch it`);
  }
  await sec.screenshot({ path: `${SHOTS}schedules-${width}.png` });
  // Toggle off, then on.
  await row.locator(".sch-tog").click();
  await enabledIs(title, false);
  s = (await api(P)).find((x) => x.title === title);
  const offTxt = await p.locator(".sch-row", { hasText: title }).innerText();
  check(s.enabled === false && (await p.locator(".sch-row", { hasText: title }).locator(".sch-tog").getAttribute("aria-checked")) === "false" && /Off/.test(offTxt), `${tag}: the switch turns it off (row says Off)`);
  await p.locator(".sch-row", { hasText: title }).locator(".sch-tog").click();
  await enabledIs(title, true);
  s = (await api(P)).find((x) => x.title === title);
  check(s.enabled === true && /Next: /.test(await p.locator(".sch-row", { hasText: title }).innerText()), `${tag}: …and back on`);
  const g = await noSideways(p);
  check(g.page && g.dlg && g.bd, `${tag}: no sideways scroll (${JSON.stringify(g)})`);
  // Delete.
  await p.locator(".sch-row", { hasText: title }).locator('[data-sch-do="delete"]').click();
  await p.locator(".sch-row", { hasText: title }).waitFor({ state: "detached", timeout: 8000 }).catch(() => {});
  check((await p.locator(".sch-row", { hasText: title }).count()) === 0 && !(await api(P)).some((x) => x.title === title), `${tag}: Delete removes it`);
  check(!errors.length, `${tag}: no page errors ${errors.join(" | ")}`);
  await ctx.close();
}

// A viewer sees the schedules but none of the write controls.
{
  const { ctx, p, errors } = await open(V, 390, 800, true);
  await p.waitForTimeout(300);
  const t = await p.locator("#acc-schedules").innerText();
  check(new RegExp(`Standup ${run}`).test(t) && (await p.locator("#sch-new").count()) === 0 && (await p.locator("#acc-schedules .sch-tog, #acc-schedules [data-sch-do]").count()) === 0, "viewer: sees the list, no add form, no switch or delete");
  const g = await noSideways(p);
  check(g.page && g.dlg && g.bd, `viewer 390px: no sideways scroll (${JSON.stringify(g)})`);
  check(!errors.length, `viewer: no page errors ${errors.join(" | ")}`);
  await ctx.close();
}
await b.close();
console.log(fails ? `${fails} FAILED` : "schedules: all passed");
process.exit(fails ? 1 : 0);
