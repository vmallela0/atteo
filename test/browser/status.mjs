// Status card (#1289): "/status" in the composer posts a ```status block with a plain-text snapshot (what agents read);
// the web draws it as a live card (last 3 commits from change cards on main, then running / next / waiting tasks),
// falls back to the snapshot when the data can't be had; desktop light + phone dark.
// Usage: BASE=http://localhost:8787 node status.mjs  (local dev only, ADMIN_KEY=ci-admin-key in .dev.vars)
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const ADMIN = process.env.ADMIN_KEY || "ci-admin-key";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": ADMIN, "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), P = `st${run}`;
await ops("users", { name: P, email: `${P}@example.com`, verified: "true" });
const board = (await ops("boards", { user: P, title: `Status ${run}` })).board.id;
const ck = (await ops("sessions", { user: P })).cookie, tok = (await ops("tokens", { user: P })).token;
const mcp = async (name, args) => (await (await fetch(`${BASE}/mcp?board=${board}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json()).result.content[0].text;
const post = async (a) => { await mcp("read", {}); return +(await mcp("post", a)).match(/#(\d+)/)[1]; };
const card = (branch, commits) => ({ repo: "acme/app", branch, base: "main", ci: "passing", commits, files: [{ path: "src/a.ts", added: 1, removed: 0 }] });

await post({ type: "change", text: "Older on main", card: card("main", [{ sha: "aaa1111aa", title: "Third on main" }]) });
await post({ type: "change", text: "A feature branch", card: card(`feat/x-${run}`, [{ sha: "fff9999ff", title: "Branch only commit" }]) });
await post({ type: "change", text: "Newest on main", card: card("main", [{ sha: "ccc3333cc", title: "Newest on main" }, { sha: "bbb2222bb", title: "Second on main" }]) });
const tNextHigh = await post({ type: "task", text: "Next high one" });
const tNext = await post({ type: "task", text: "Next plain one" });
const tRun = await post({ type: "task", text: "Running one" });
const tWait = await post({ type: "task", text: "Waiting one" });
const tDone = await post({ type: "task", text: "Done one" });
await mcp("task", { action: "update", seq: tNextHigh, priority: "high" });
await mcp("task", { action: "claim", seq: tRun, minutes: 30 });
await mcp("task", { action: "update", seq: tWait, status: "blocked" });
await mcp("task", { action: "update", seq: tDone, status: "done" });

let fails = 0;
const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
async function open({ w = 1200, scheme = "light", route } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, colorScheme: scheme, isMobile: w < 500 });
  const [k, ...v] = ck.split(";")[0].split("=");
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  if (route) await ctx.route(route[0], route[1]);
  const p = await ctx.newPage(), errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${BASE}/b/${board}`);
  await p.waitForTimeout(800);
  return { ctx, p, errors };
}
const cardOf = (p, seq) => p.evaluate((s) => {
  const f = document.querySelector(`#e${s} figure.st`);
  if (!f) return null;
  const lists = [...f.querySelectorAll(".st-live .st-l")];
  return {
    state: f.dataset.status,
    commits: lists[0] ? [...lists[0].querySelectorAll(".st-sha")].map((x) => x.textContent) : [],
    queue: lists[1] ? [...lists[1].querySelectorAll("li")].map((li) => li.querySelector(".st-p").textContent + ":" + (li.querySelector(".st-x a")?.textContent ?? "")) : [],
    snapOpen: !!f.querySelector("details.st-was[open]"), snapThere: !!f.querySelector("details.st-was .st-snap"),
    snapText: f.querySelector(".st-snap")?.textContent ?? "", snapShown: (f.querySelector(".st-snap")?.getBoundingClientRect().height ?? 0) > 0,
    right: f.getBoundingClientRect().right, thread: document.getElementById("thread")?.getBoundingClientRect().right ?? 0, pageW: document.documentElement.scrollWidth,
  };
}, seq);

// 1. "/status" from the composer posts the snapshot; the card draws live.
let sStatus;
{
  const { ctx, p, errors } = await open();
  await p.click("#composer-text");
  await p.keyboard.type("/sta");
  check(await p.locator('#slash-menu [data-cmd="status"]').isVisible(), `"/sta" offers /status in the slash menu`);
  await p.keyboard.press("Enter");
  check((await p.inputValue("#composer-text")) === "/status ", "Enter picks it");
  await p.keyboard.press("Enter");
  await p.waitForFunction(() => document.querySelector("figure.st"), null, { timeout: 15000 }).catch(() => {});
  sStatus = await p.evaluate(() => +document.querySelector("figure.st")?.closest("[id^=e]")?.id.slice(1) || 0);
  check(sStatus > 0, `the status card is posted (#${sStatus})`);
  await p.waitForSelector(`#e${sStatus} figure.st[data-status="live"]`, { timeout: 10000 }).catch(() => {});
  const c = await cardOf(p, sStatus);
  check(c?.state === "live" && c.commits.join() === "ccc3333,bbb2222,aaa1111", `last 3 commits come from main's change cards, newest first (${c?.commits})`);
  check(JSON.stringify(c?.queue) === JSON.stringify(["Running:Running one", "Next:Next high one", "Next:Next plain one", "Waiting:Waiting one"]), `queue: running, next (high first), waiting; done left out (${JSON.stringify(c?.queue)})`);
  check(c?.snapThere && !c.snapOpen, `the snapshot sits under a closed "As posted"`);
  check(c?.right <= c?.thread + 1 && c?.pageW <= 1200, "inside the conversation");
  await p.locator(`#e${sStatus} figure.st`).screenshot({ path: `${SHOTS_DIR}/status-1200-light.png` }).catch(() => {});
  check(!errors.length, `1200px light: no page errors ${errors.join(" | ")}`);
  await ctx.close();
}

// 2. Agents read plain text: the snapshot, with the same facts.
{
  const got = await mcp("get", { seq: sStatus });
  check(/```status/.test(got) && /Last 3 commits/.test(got) && /ccc3333 Newest on main/.test(got) && new RegExp(`#${tRun} Running one`).test(got) && /Waiting\n\s*- #\d+ Waiting one/.test(got) && !/Done one/.test(got),
    `an agent reading the board gets the snapshot as text`);
}

// 3. Live: the card follows the tasks; the snapshot stays what it was. Phone, dark.
await mcp("task", { action: "update", seq: tNext, status: "done" });
{
  const { ctx, p, errors } = await open({ w: 390, scheme: "dark" });
  await p.locator(`#e${sStatus}`).scrollIntoViewIfNeeded();
  await p.waitForSelector(`#e${sStatus} figure.st[data-status="live"]`, { timeout: 10000 }).catch(() => {});
  const c = await cardOf(p, sStatus);
  check(c?.queue && !c.queue.some((q) => /Next plain one/.test(q)) && /Next plain one/.test(c.snapText), `live: a task finished since shows gone, "As posted" still has it`);
  check(c?.pageW <= 390 && c?.right <= c?.thread + 1, `390px dark: no sideways scroll, card inside the conversation (page ${c?.pageW}px)`);
  await p.locator(`#e${sStatus} figure.st`).screenshot({ path: `${SHOTS_DIR}/status-390-dark.png` }).catch(() => {});
  check(!errors.length, `390px dark: no page errors ${errors.join(" | ")}`);
  await ctx.close();
}

// 4. No data (the tasks API fails): the snapshot shows as text.
{
  const { ctx, p, errors } = await open({ route: [/\/api\/boards\/[^/]+\/tasks$/, (r) => r.fulfill({ status: 500, body: "{}" })] });
  await p.locator(`#e${sStatus}`).scrollIntoViewIfNeeded();
  await p.waitForSelector(`#e${sStatus} figure.st[data-status="text"]`, { timeout: 10000 }).catch(() => {});
  const c = await cardOf(p, sStatus);
  check(c?.state === "text" && c.snapShown && /Running one/.test(c.snapText), `the data can't be had: the snapshot shows as text (${c?.state})`);
  check(!errors.length, `fallback: no page errors ${errors.join(" | ")}`);
  await ctx.close();
}

await browser.close();
console.log(fails ? `${fails} FAILED` : "status: all passed");
process.exit(fails ? 1 : 0);
