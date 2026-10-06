// vedu #4791: a frozen task is parked for the far future. On the Tasks tab it sits in its own last column, folded and
// muted with a count; opening the column shows it; the tab's open count leaves it out; Unfreeze on its card brings it back.
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), A = `fz${run}`;
await ops("users", { name: A, email: `${A}@example.com`, verified: "true" });
const tok = (await ops("tokens", { user: A })).token;
const board = (await ops("boards", { user: A, title: "Frozen tasks" })).board.id;
const mcp = async (name, args) => (await (await fetch(`${BASE}/mcp?board=${board}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tok}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json()).result?.content?.[0]?.text ?? "";
let fails = 0; const check = (ok, m) => { console.log(`${ok ? "✓" : "✗"} ${m}`); if (!ok) fails++; };
await mcp("read", {});
const live = Number((await mcp("task", { action: "create", title: `Ship the beta ${run}` })).match(/#(\d+)/)[1]);
const later = Number((await mcp("task", { action: "create", title: `Rewrite the docs someday ${run}` })).match(/#(\d+)/)[1]);
await mcp("task", { action: "update", seq: later, status: "frozen" });
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const ck = (await ops("sessions", { user: A })).cookie; const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
const [k, ...v] = ck.split(";")[0].split("="); await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
const p = await ctx.newPage(); const errors = []; p.on("pageerror", (e) => errors.push(e.message));
await p.goto(`${BASE}/b/${board}`); await p.locator("#board-tabs button").nth(3).click();
const col = p.locator('#kanban .kcol[data-status="frozen"]');
await col.waitFor({ timeout: 8000 }).catch(() => {});
check(await p.evaluate(() => [...document.querySelectorAll("#kanban .kcol")].pop()?.dataset.status === "frozen"), "Frozen is the last column");
check(/Frozen\s*1/.test(await col.locator("h3").innerText()) && !(await col.locator(`.kcard[data-seq="${later}"]`).isVisible()), "…folded, with its count");
check((await p.locator("#task-count").innerText()).trim() === "1", `the tab counts only open work (${await p.locator("#task-count").innerText()})`);
await col.locator(".kfz").click();
check(await col.locator(`.kcard[data-seq="${later}"]`).isVisible() && (await col.locator(".kfz").getAttribute("aria-expanded")) === "true", "opening the column shows the frozen task");
await p.locator("#kanban").screenshot({ path: `${SHOTS_DIR}/task-frozen.png` });
// Its card in the chat offers Unfreeze, which puts it back in To do.
await p.locator("#board-tabs button").first().click();
const card = p.locator(`[data-task="${later}"]`);
await card.locator('[data-tk="reopen"]').waitFor({ timeout: 8000 }).catch(() => {});
check((await card.locator('[data-tk="reopen"]').innerText()) === "Unfreeze", "a frozen task's card says Unfreeze");
await card.locator('[data-tk="reopen"]').click();
let status = "";
for (let i = 0; i < 40 && status !== "todo"; i++) { status = /\[(\w+)\]/.exec(await mcp("task", { action: "get", seq: later }))?.[1] ?? ""; if (status !== "todo") await p.waitForTimeout(150); }
check(status === "todo", `Unfreeze puts it back in to-do (${status})`);
check(errors.length === 0, `no page errors ${errors.join(" | ")}`);
void live;
await b.close(); console.log(fails ? `${fails} FAILED` : "all frozen-task checks passed"); process.exit(fails ? 1 : 0);
