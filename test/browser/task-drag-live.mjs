// A live update mid-drag on the Tasks tab (vedu #6564 follow-up, src/dragGate.ts): someone else's change reloads the
// board, and a reload used to replace the card being dragged, so the drop could be lost and Chromium's drag could stick.
// Now reloads wait for the drag to end (for a drop, until the move is saved), then run once: the dragged card stays put,
// the drop lands, no redraw after it shows the card in its old column, the other changes show up after, a
// cancelled drag also lets the reload run, and the board is still usable.
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), A = `dl${run}`;
await ops("users", { name: A, email: `${A}@example.com`, verified: "true" });
const tok = (await ops("tokens", { user: A })).token;
const board = (await ops("boards", { user: A, title: "Drag live" })).board.id;
const mcp = async (name, args) => (await (await fetch(`${BASE}/mcp?board=${board}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tok}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json()).result?.content?.[0]?.text ?? "";
let fails = 0; const check = (ok, m) => { console.log(`${ok ? "✓" : "✗"} ${m}`); if (!ok) fails++; };
const statusOf = async (seq, want) => { let s = ""; for (let i = 0; i < 40 && s !== want; i++) { s = /\[(\w+)\]/.exec(await mcp("task", { action: "get", seq }))?.[1] ?? ""; if (s !== want) await new Promise((r) => setTimeout(r, 150)); } return s; };
await mcp("read", {});
const moved = Number((await mcp("task", { action: "create", title: `Drag me ${run}` })).match(/#(\d+)/)[1]);
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const ck = (await ops("sessions", { user: A })).cookie; const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
const [k, ...v] = ck.split(";")[0].split("="); await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
const p = await ctx.newPage(); const errors = []; p.on("pageerror", (e) => errors.push(e.message));
// The board's own reloads of the task list, and the socket's signals.
let loads = 0, frames = 0;
p.on("request", (r) => { if (r.method() === "GET" && /^\/api\/boards\/[^/]+\/tasks$/.test(new URL(r.url()).pathname)) loads++; });
p.on("websocket", (ws) => ws.on("framereceived", (f) => { if (/"type":"(task|entry)"/.test(String(f.payload))) frames++; }));
await p.goto(`${BASE}/b/${board}`); await p.locator("#board-tabs button").nth(3).click();
const card = p.locator(`#kanban .kcard[data-seq="${moved}"]`), todo = p.locator('#kanban .kcol[data-status="todo"]'), doing = p.locator('#kanban .kcol[data-status="doing"]');
await card.waitFor({ timeout: 8000 });
await p.waitForTimeout(600); // the first load's late signals, if any
// Start a drag by hand: press on the card and move a little, so the browser's drag is on.
const from = await card.boundingBox(), to = await doing.boundingBox();
await p.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await p.mouse.down();
await p.mouse.move(from.x + from.width / 2 + 20, from.y + from.height / 2 + 10, { steps: 4 });
await p.evaluate(() => { window.__dragged = document.querySelector("#kanban .kcard.dragging"); });
check(await p.evaluate(() => !!window.__dragged), "the drag is on");
// Mid-drag: someone else adds a task (a live update), twice.
const f0 = frames, l0 = loads;
await mcp("task", { action: "create", title: `Live one ${run}` });
await mcp("task", { action: "create", title: `Live two ${run}` });
for (let i = 0; i < 100 && frames - f0 < 2; i++) await p.waitForTimeout(50);
await p.waitForTimeout(500); // time for a reload to have drawn, if one were going to
check(frames - f0 >= 2, `the live updates reached the page mid-drag (${frames - f0} signals)`);
check(loads === l0, `no reload while dragging (${loads - l0})`);
check(await p.evaluate(() => window.__dragged?.isConnected === true), "the dragged card is still on the board");
check(!(await p.locator("#kanban .kcard", { hasText: `Live one ${run}` }).count()), "the new tasks wait for the drag to end");
// Drop it on Doing.
await p.mouse.move(to.x + to.width / 2, to.y + 80, { steps: 6 });
await p.evaluate((seq) => { window.__back = false; new MutationObserver(() => { if (document.querySelector(`#kanban .kcol[data-status="todo"] .kcard[data-seq="${seq}"]`)) window.__back = true; }).observe(document.getElementById("kanban"), { childList: true, subtree: true }); }, moved);
await p.mouse.up();
check((await statusOf(moved, "doing")) === "doing", "the drop lands: the task is in Doing");
await p.locator("#kanban .kcard", { hasText: `Live two ${run}` }).waitFor({ timeout: 8000 }).catch(() => {});
check(await p.locator("#kanban .kcard", { hasText: `Live one ${run}` }).isVisible() && await p.locator("#kanban .kcard", { hasText: `Live two ${run}` }).isVisible(), "then the board reloads and shows them");
check(await doing.locator(`.kcard[data-seq="${moved}"]`).isVisible() && !(await p.evaluate(() => window.__back)), "and the moved card is in Doing (no redraw after the drop had it in To do)");
// A cancelled drag (Escape) also lets the queued reload run.
const c2 = p.locator("#kanban .kcard", { hasText: `Live one ${run}` }), b2 = await c2.boundingBox();
await p.mouse.move(b2.x + b2.width / 2, b2.y + b2.height / 2); await p.mouse.down();
await p.mouse.move(b2.x + b2.width / 2 + 20, b2.y + b2.height / 2 + 10, { steps: 4 });
await mcp("task", { action: "create", title: `Live three ${run}` });
await p.waitForTimeout(800);
await p.keyboard.press("Escape"); await p.mouse.up();
await p.locator("#kanban .kcard", { hasText: `Live three ${run}` }).waitFor({ timeout: 8000 }).catch(() => {});
check(await p.locator("#kanban .kcard", { hasText: `Live three ${run}` }).isVisible(), "a cancelled drag lets the waiting reload run");
// The page is still usable: the chat tab opens.
await p.locator("#board-tabs button").first().click();
check(!(await p.locator("#panel-tasks").isVisible()), "the board still answers clicks after the drags");
await p.locator("#board-tabs button").nth(3).click(); await p.locator("#kanban").screenshot({ path: `${SHOTS_DIR}/task-drag-live.png` });
check(errors.length === 0, `no page errors ${errors.join(" | ")}`);
await b.close(); console.log(fails ? `${fails} FAILED` : "all drag-live checks passed"); process.exit(fails ? 1 : 0);
