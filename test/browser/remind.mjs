// Browser check for local reminders; run with BASE=http://localhost:8704 node test/browser/remind.mjs.
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8704";
const ADMIN = process.env.ADMIN_KEY || "ci-admin-key";
const ops = async (name, body) => {
  const r = await fetch(`${BASE}/api/ops/${name}`, { method: "POST", headers: { "x-admin-key": ADMIN, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${name}: ${r.status} ${await r.text()}`);
  return r.json();
};
const run = Date.now().toString(36).slice(-5), A = `ra${run}`, B = `rb${run}`;
for (const u of [A, B]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true" });
const cookie = (await ops("sessions", { user: B })).cookie.split(";")[0];
const board = (await ops("boards", { user: A, title: `Reminder browser ${run}` })).board.id;
await ops("members", { board, user: B });
const cA = (await ops("sessions", { user: A })).cookie.split(";")[0];
const posted = await fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { cookie: cA, "content-type": "application/json" }, body: JSON.stringify({ type: "note", text: `Please review this @${B}` }) });
if (!posted.ok) throw new Error(`post: ${posted.status}`);
const browser = await chromium.launch({ headless: true, executablePath: process.env.PW_CHROME || undefined });
try {
  const context = await browser.newContext();
  await context.addCookies([{ name: cookie.split("=")[0], value: cookie.slice(cookie.indexOf("=") + 1), url: BASE }]);
  const page = await context.newPage();
  await page.goto(`${BASE}/inbox`);
  const item = page.locator(".inbox-item", { hasText: "Please review this" }).first();
  await item.waitFor();
  await item.locator("summary", { hasText: "Remind me" }).click();
  await item.locator('[data-remind="hour"]').click();
  await item.waitFor({ state: "detached" });
  const count = await page.evaluate(async () => (await (await fetch("/api/inbox/count")).json()).unread);
  const reminders = await page.evaluate(async () => (await (await fetch("/api/inbox")).json()).items);
  if (reminders.some((x) => x.excerpt.includes("Please review this"))) throw new Error("snoozed item remained in inbox");
  const before = count;
  await ops("cron", { now: Date.now() + 3600_000 + 1000 });
  const after = await page.evaluate(async () => (await (await fetch("/api/inbox/count")).json()).unread);
  if (after <= before) throw new Error("cron did not restore unread count");
  await page.reload();
  await page.locator(".inbox-item", { hasText: "Please review this" }).waitFor();
  console.log("remind browser check passed");
} finally { await browser.close(); }
