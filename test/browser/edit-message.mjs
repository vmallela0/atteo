import { chromium } from "playwright-core";

const BASE = process.env.BASE || "http://localhost:8702";
const run = Date.now().toString(36).slice(-6);
const user = `e2e-edit-${run}`;
const ops = async (path, body) => {
  const r = await fetch(`${BASE}/api/ops/${path}`, { method: "POST", headers: { "x-admin-key": "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json();
};
await ops("users", { name: user, email: `${user}@example.com`, verified: "true" });
const board = (await ops("boards", { user, title: "Edit message browser check" })).board.id;
const cookie = (await ops("sessions", { user })).cookie;
const post = await fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ type: "note", text: "Before edit" }) });
if (!post.ok) throw new Error(`post: ${post.status}`);
const seq = (await post.json()).entry.seq;
const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
try {
  const context = await browser.newContext();
  const [name, ...parts] = cookie.split(";")[0].split("=");
  await context.addCookies([{ name, value: parts.join("="), url: BASE }]);
  const page = await context.newPage();
  await page.goto(`${BASE}/b/${board}`);
  const row = page.locator(`#e${seq}`);
  await row.locator('[data-edit]').click({ force: true });
  const box = row.locator('[data-edit-box]');
  if (await box.inputValue() !== "Before edit") throw new Error("inline editor did not load original text");
  await box.fill("After edit");
  await row.getByRole("button", { name: "Cancel" }).click();
  if (await row.locator('[data-edit-box]').count()) throw new Error("Cancel left editor open");
  await row.locator('[data-edit]').click({ force: true });
  await row.locator('[data-edit-box]').fill("After edit");
  await row.getByRole("button", { name: "Save" }).click();
  await page.waitForLoadState("load");
  await row.locator('[data-history]').waitFor();
  // "edited" reads with the time ("1m ago · edited", jxn #4287): right after it on the same line, text, not a pill.
  const ed = await row.evaluate((r) => { const e = r.querySelector(".meta [data-history]"), t = r.querySelector(".meta .when"), er = e.getBoundingClientRect(), tr = t.getBoundingClientRect(), c = getComputedStyle(e);
    return { after: e.previousElementSibling === t, gap: Math.round(er.left - tr.right), line: Math.abs((er.top + er.bottom) / 2 - (tr.top + tr.bottom) / 2) < 2, border: c.borderTopWidth };
  });
  if (!ed.after || ed.gap > 8 || !ed.line || ed.border !== "0px") throw new Error(`"edited" isn't with the time: ${JSON.stringify(ed)}`);
  if (!(await row.locator('.body').innerText()).includes("After edit")) throw new Error("saved text missing");
  await row.locator('[data-history]').click();
  if (!(await row.locator('[data-version-list]').innerText()).includes("Before edit")) throw new Error("history missing");
  console.log("✓ edit, cancel, save, edited label, and history");
} finally {
  await browser.close();
}
console.log("edit-message: all passed"); // run.mjs reads the last line
