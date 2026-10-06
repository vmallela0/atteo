// Board tabs follow the ARIA keyboard pattern: one tab stop, arrow/Home/End navigation in visual order, and named
// tabpanels. The task editor's free-text fields also have names that do not disappear when their placeholders do.
// Usage: BASE=http://localhost:8787 [ADMIN_KEY=…] node test/browser/tab-keyboard.mjs
import { chromium } from "playwright-core";
import { stable, until } from "./lib/wait.mjs";

const BASE = (process.env.BASE || "http://localhost:8787").replace(/\/$/, "");
const KEY = process.env.ADMIN_KEY || "ci-admin-key";
const ops = async (path, body) =>
  (await fetch(`${BASE}/api/ops/${path}`, { method: "POST", headers: { "x-admin-key": KEY, "content-type": "application/json" }, body: JSON.stringify(body) })).json();
const run = Date.now().toString(36).slice(-5);
const DEV = `td${run}`, EVERY = `te${run}`;
await ops("users", { name: DEV, email: `${DEV}@example.com`, verified: "true", display: { mode: "developer" } });
await ops("users", { name: EVERY, email: `${EVERY}@example.com`, verified: "true", display: { mode: "everyday" } });
const board = (await ops("boards", { user: DEV, title: `Tab keys ${run}` })).board.id;
await ops("members", { board, user: EVERY });
const cookies = {};
for (const user of [DEV, EVERY]) cookies[user] = (await ops("sessions", { user })).cookie;
await fetch(`${BASE}/api/boards/${board}/entries`, {
  method: "POST",
  headers: { cookie: cookies[DEV].split(";")[0], "content-type": "application/json" },
  body: JSON.stringify({ type: "task", text: `Keyboard task ${run}` }),
});

let fails = 0;
const check = (ok, message) => {
  console.log(`${ok ? "✓" : "✗"} ${message}`);
  if (!ok) fails++;
};
const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const errors = [];
async function open(user) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const [name, ...value] = cookies[user].split(";")[0].split("=");
  await context.addCookies([{ name, value: value.join("="), url: BASE }]);
  // A fresh browser has no saved Display settings, so the page starts in its default layout and applies the account's
  // mode (Everyday hides Log and reorders the tabs) once /api/me/profile answers. Under load that lands after the first
  // key press, which then walks the wrong layout: wait for that sync ('atteo-mode') before pressing anything.
  await context.addInitScript(() => document.addEventListener("atteo-mode", () => { window.__atteoMode = true }));
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${BASE}/b/${board}`);
  await page.locator("#board-tabs").waitFor();
  await until(() => page.evaluate(() => window.__atteoMode === true), 15000);
  return { context, page };
}
const selected = (page) => page.locator('#board-tabs [aria-selected="true"]');
// The selected tab's id once it's the one expected (or whatever it is after a few seconds), so a slow frame isn't a failure.
const selectedIs = async (page, id) => (await until(async () => (await selected(page).getAttribute("id")) === id, 5000), await selected(page).getAttribute("id"));

let A = await open(DEV);
check(
  (await selected(A.page).getAttribute("id")) === "tab-conv" && (await A.page.locator('#board-tabs [tabindex="0"]').count()) === 1,
  "the selected board tab is the tablist's only tab stop",
);
check(
  await A.page.locator('[role="tabpanel"]').evaluateAll((panels) => panels.every((panel) => panel.getAttribute("aria-labelledby") && document.getElementById(panel.getAttribute("aria-labelledby")))),
  "every board panel is named by its tab",
);
await A.page.locator("#tab-conv").focus();
await A.page.keyboard.press("ArrowRight");
check((await selected(A.page).getAttribute("id")) === "tab-log" && (await A.page.evaluate(() => document.activeElement?.id)) === "tab-log", "Right Arrow focuses and opens the next tab");
await A.page.keyboard.press("End");
check((await selected(A.page).getAttribute("id")) === "tab-tasks" && (await A.page.locator("#panel-tasks").isVisible()), "End focuses and opens the last tab");
await A.page.keyboard.press("ArrowLeft");
check((await selectedIs(A.page, "tab-docs")) === "tab-docs", "Left Arrow moves to the previous tab");
await A.page.keyboard.press("Home");
check((await selectedIs(A.page, "tab-conv")) === "tab-conv", "Home returns to the first tab");
await A.page.locator("#tab-tasks").click();
const card = A.page.locator(".kcard").first();
await card.waitFor();
// Each visit to Tasks reloads the board's tasks and redraws the columns; a card focused before the redraw is replaced, and
// Enter then lands nowhere. Wait for the columns to stop changing, then press Enter on the card that's focused now.
await stable(() => A.page.locator("#kanban").innerHTML(), 10000, 150);
await until(async () => { await card.focus(); return A.page.evaluate(() => !!document.activeElement?.classList.contains("kcard")); }, 5000);
await A.page.keyboard.press("Enter");
await A.page.locator("#task-dlg[open]").waitFor({ timeout: 10000 });
check(
  (await A.page.locator("#td-body").getAttribute("aria-label")) === "Task details" && (await A.page.locator("#td-sum").getAttribute("aria-label")) === "Change summary",
  "task details and change summary keep accessible names after typing",
);
await A.context.close();

A = await open(EVERY);
check((await A.page.locator('#board-tabs [tabindex="0"]:visible').count()) === 1, "Everyday mode also has one visible tab stop");
await A.page.locator("#tab-conv").focus();
await A.page.keyboard.press("ArrowRight");
check((await selectedIs(A.page, "tab-tasks")) === "tab-tasks", "Everyday arrows follow visual order and skip the hidden Log tab");
await A.page.keyboard.press("ArrowRight");
check((await selectedIs(A.page, "tab-docs")) === "tab-docs", "Everyday arrows continue to the next visible tab");
await A.context.close();

check(errors.length === 0, `no page errors (${errors.join(" | ")})`);
await browser.close();
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
