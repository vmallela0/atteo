// vedu #4791: a frozen task is parked for the far future. On the Tasks tab it sits in its own last column, folded and
// muted with a count; opening the column shows it; the tab's open count leaves it out; Unfreeze on its card brings it back.
// #6434: folded, it fits inside the board and a click anywhere on it opens it; open, it's as wide as the others, stays
// open through live updates, takes dropped cards (freeze) and gives them back (unfreeze); on a phone it's scrolled to.
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
// A move re-renders the whole board several times (its own reload, then the socket's task and entry signals each reload
// it). A drag that starts during one of those loses its card mid-drag and Chromium's drag sticks, so drags wait until
// no task list is loading and the board has been quiet for 500 ms (under load the last reload can land seconds later).
let loading = 0; const isList = (r) => r.method() === "GET" && /^\/api\/boards\/[^/]+\/tasks$/.test(new URL(r.url()).pathname);
p.on("request", (r) => { if (isList(r)) loading++; }); for (const ev of ["requestfinished", "requestfailed"]) p.on(ev, (r) => { if (isList(r)) loading--; });
const settled = async () => { await p.evaluate(() => { window.__kbAt = Date.now(); new MutationObserver(() => { window.__kbAt = Date.now(); }).observe(document.getElementById("kanban"), { childList: true, subtree: true }); });
  for (let i = 0; i < 200; i++) { if (!loading && (await p.evaluate(() => Date.now() - window.__kbAt)) >= 500) return; await p.waitForTimeout(50); } };
await p.goto(`${BASE}/b/${board}`); await p.locator("#board-tabs button").nth(3).click();
const col = p.locator('#kanban .kcol[data-status="frozen"]');
await col.waitFor({ timeout: 8000 }).catch(() => {});
check(await p.evaluate(() => [...document.querySelectorAll("#kanban .kcol")].pop()?.dataset.status === "frozen"), "Frozen is the last column");
check(/Frozen\s*1/.test(await col.locator("h3").innerText()) && !(await col.locator(`.kcard[data-seq="${later}"]`).isVisible()), "…folded, with its count");
check((await p.locator("#task-count").innerText()).trim() === "1", `the tab counts only open work (${await p.locator("#task-count").innerText()})`);
const geo = () => p.evaluate(() => { const kb = document.getElementById("kanban"), r = (s) => kb.querySelector(s).getBoundingClientRect();
  return { kbR: kb.getBoundingClientRect().right, over: kb.scrollWidth - kb.clientWidth, fz: r('.kcol[data-status="frozen"]'), todo: r('.kcol[data-status="todo"]') }; });
let g = await geo();
check(g.over <= 0 && g.fz.right <= g.kbR + 0.5 && g.fz.right <= 1280 && g.fz.width >= 100, `folded, it fits inside the board (right ${g.fz.right}/${g.kbR}, overflow ${g.over})`);
await col.click({ position: { x: 30, y: 80 } }); // the column's empty body, not its label
check(await col.locator(`.kcard[data-seq="${later}"]`).isVisible() && (await col.locator(".kfz").getAttribute("aria-expanded")) === "true", "a click on the column opens it and shows the frozen task");
g = await geo();
check(Math.abs(g.fz.width - g.todo.width) < 2 && g.over <= 0 && g.fz.right <= g.kbR + 0.5, `open, it's a column like the others (${g.fz.width} vs ${g.todo.width})`);
await p.locator("#kanban").screenshot({ path: `${SHOTS_DIR}/task-frozen.png` });
await mcp("task", { action: "create", title: `Live update ${run}` });
await p.locator("#kanban .kcard", { hasText: `Live update ${run}` }).waitFor({ timeout: 8000 }).catch(() => {});
check((await col.locator(".kfz").getAttribute("aria-expanded")) === "true" && (await col.locator(`.kcard[data-seq="${later}"]`).isVisible()), "it stays open through a live update");
const statusOf = async (seq, want) => { let s = ""; for (let i = 0; i < 40 && s !== want; i++) { s = /\[(\w+)\]/.exec(await mcp("task", { action: "get", seq }))?.[1] ?? ""; if (s !== want) await p.waitForTimeout(150); } return s; };
await settled(); await p.locator(`#kanban .kcard[data-seq="${live}"]`).dragTo(col);
check((await statusOf(live, "frozen")) === "frozen", "dropping a card on Frozen freezes it");
await col.locator(`.kcard[data-seq="${live}"]`).waitFor({ timeout: 8000 }).catch(() => {});
await settled(); await col.locator(`.kcard[data-seq="${live}"]`).dragTo(p.locator('#kanban .kcol[data-status="todo"]'));
check((await statusOf(live, "todo")) === "todo", "dragging it back to To do unfreezes it");
// A phone: the board scrolls sideways to it, and it still opens.
const ph = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await ph.addCookies([{ name: k, value: v.join("="), url: BASE }]);
const pp = await ph.newPage(); pp.on("pageerror", (e) => errors.push(e.message));
await pp.goto(`${BASE}/b/${board}`); await pp.locator("#board-tabs button").nth(3).click();
const pcol = pp.locator('#kanban .kcol[data-status="frozen"]'); await pcol.waitFor({ timeout: 8000 }).catch(() => {});
await pcol.scrollIntoViewIfNeeded(); await pcol.locator(".kfz").tap();
const pr = await pcol.boundingBox();
check(await pcol.locator(`.kcard[data-seq="${later}"]`).isVisible() && pr.x >= 0 && pr.x + pr.width <= 390 + 0.5, `on a phone it scrolls into view and opens (${Math.round(pr.x)}..${Math.round(pr.x + pr.width)})`);
await pp.waitForTimeout(250); await pp.screenshot({ path: `${SHOTS_DIR}/task-frozen-phone.png` }); await ph.close();
// Its card in the chat offers Unfreeze, which puts it back in To do.
await p.locator("#board-tabs button").first().click();
const card = p.locator(`[data-task="${later}"]`);
await card.locator('[data-tk="reopen"]').waitFor({ timeout: 8000 }).catch(() => {});
check((await card.locator('[data-tk="reopen"]').innerText()) === "Unfreeze", "a frozen task's card says Unfreeze");
await card.locator('[data-tk="reopen"]').click();
const status = await statusOf(later, "todo");
check(status === "todo", `Unfreeze puts it back in to-do (${status})`);
check(errors.length === 0, `no page errors ${errors.join(" | ")}`);
await b.close(); console.log(fails ? `${fails} FAILED` : "all frozen-task checks passed"); process.exit(fails ? 1 : 0);
