// Repo join requests are owner decisions in For you and Inbox, with one tap on each page.
import { chromium } from "playwright-core";

const BASE = process.env.BASE || "http://localhost:8787";
const ADMIN_KEY = process.env.ADMIN_KEY || "ci-admin-key";
const run = Date.now().toString(36).slice(-5);
const owner = `rjo${run}`, first = `rja${run}`, second = `rjb${run}`;
const ops = async (path, body) => {
  const r = await fetch(`${BASE}/api/ops/${path}`, { method: "POST", headers: { "x-admin-key": ADMIN_KEY, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`ops ${path}: ${r.status}`);
  return r.json();
};
const post = async (token, path, body) => {
  const r = await fetch(`${BASE}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json();
};
let passed = 0, failed = 0;
const check = (yes, why) => { console.log(`${yes ? "✓" : "✗"} ${why}`); if (yes) passed++; else failed++; };

for (const user of [owner, first, second]) await ops("users", { name: user, email: `${user}@example.com`, verified: "true" });
const tokens = {};
for (const user of [owner, first, second]) tokens[user] = (await ops("tokens", { user })).token;
const cookie = (await ops("sessions", { user: owner, verified: "true" })).cookie;
const repo = `example/repo-${run}`;
const made = await post(tokens[owner], "/api/repos/init", { repo });
for (const user of [first, second]) await post(tokens[user], "/api/repos/init", { repo, board: made.board });

const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const [name, ...value] = cookie.split(";")[0].split("=");
await context.addCookies([{ name, value: value.join("="), url: BASE }]);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto(`${BASE}/for-you`);
  const card = page.locator(`.fy-join:has-text("${first}")`);
  check(await card.count() === 1 && await card.locator('[data-fy-join="let-in"]').isVisible(), "For you shows a one-tap Let in request");
  await card.locator('[data-fy-join="let-in"]').click();
  await card.waitFor({ state: "detached" });
  const allowed = await fetch(`${BASE}/api/boards/${made.board}`, { headers: { authorization: `Bearer ${tokens[first]}` } });
  check(allowed.status === 200, "Let in grants membership");
  await page.goto(`${BASE}/inbox`);
  const row = page.locator(`.inbox-item:has-text("${second}")`);
  check(await row.count() === 1 && await row.locator('[data-join-decision="decline"]').isVisible(), "Inbox shows a one-tap Decline request");
  await row.locator('[data-join-decision="decline"]').click();
  await row.locator('[data-repo-join]').waitFor({ state: "detached" });
  const denied = await fetch(`${BASE}/api/boards/${made.board}`, { headers: { authorization: `Bearer ${tokens[second]}` } });
  check(denied.status === 404, "Decline leaves the requester outside");
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
} finally {
  await context.close();
  await browser.close();
}
console.log(failed ? `${failed} FAILED` : `${passed} repo join checks passed`);
process.exit(failed ? 1 : 0);
