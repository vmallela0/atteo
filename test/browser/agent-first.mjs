// Agent-first board (jxn #4730/#4731, items 3–5): the composer rests as one "Step in" control and opens when focused;
// a "Needs you" strip above the conversation lists your pending approvals and stalled agents (the page's only oxblood)
// and jumps to them; the agents panel marks a stalled session and gives your own sessions a Stop (read-only scope) and
// a Resume. Screenshots for the board thread: desktop light + dark and 390px.
// Usage: BASE=http://localhost:8787 [PERSIST=<wrangler --persist-to dir>] node agent-first.mjs  (local dev only)
import { d1Execute } from "./lib/d1.mjs";
import { until } from "./lib/wait.mjs";
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787", WT = process.env.WT || new URL("../../", import.meta.url).pathname;
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": process.env.ADMIN_KEY || "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const sql = (q) => d1Execute(`--command ${JSON.stringify(q)}`, { cwd: WT });
const run = Date.now().toString(36).slice(-4), A = `af${run}`, B = `ag${run}`;
for (const u of [A, B]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true", display: { mode: "developer" } });
const board = (await ops("boards", { user: A, title: `Agent-first ${run}` })).board.id;
await ops("members", { board, user: B });
const tokA = (await ops("tokens", { user: A })).token, ckA = (await ops("sessions", { user: A })).cookie, ckB = (await ops("sessions", { user: B })).cookie;
const api = (m, p, b, sid) => fetch(BASE + p, { method: m, headers: { authorization: `Bearer ${tokA}`, "content-type": "application/json", ...(sid ? { "x-atteo-session": sid } : {}) }, body: b ? JSON.stringify(b) : undefined }).then((r) => r.json());
const post = async (ck, text) => (await (await fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { "content-type": "application/json", cookie: ck }, body: JSON.stringify({ text }) })).json()).entry.seq;
// Two sessions of A's agent: "worker" takes a message and goes quiet (stalled), "scout" stays live with a status.
const worker = (await api("POST", "/api/sessions", { suggest: "worker", client: "Claude Code" })).session;
const scout = (await api("POST", "/api/sessions", { suggest: "scout", client: "Codex" })).session;
for (const s of [worker, scout]) await api("POST", `/api/sessions/${s.id}/boards`, { board }, s.id);
await post(ckB, `Kickoff: ship the launch checklist ${run}`);
const job = await post(ckB, `@${A}'s agent can you run the release gate ${run}?`);
await api("POST", `/api/boards/${board}/handle/${job}`, {}, worker.id);
await api("POST", `/api/sessions/${worker.id}`, { status: "Running the release gate" }, worker.id);
await api("POST", `/api/sessions/${scout.id}`, { status: "Reviewing the landing copy" }, scout.id);
// An approval A has to give (A's agent asks), through MCP like a real agent.
const mcp = async (name, args) => (await fetch(`${BASE}/mcp?board=${board}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tokA}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).text();
await mcp("read", {});
await mcp("request_approval", { title: `Deploy to production ${run}`, details: "npm run deploy -- --env production", risk: "high", wait_seconds: 0 });
await post(ckB, `Docs pass is done; next up is the changelog ${run}`);
let quiet = true;
try { await sql(`UPDATE agent_sessions SET last_seen = ${Date.now() - 10 * 60_000} WHERE id = '${worker.id}'`); } catch (e) { quiet = false; console.log(`  (stalled step skipped: set PERSIST to the server's --persist-to dir: ${String(e.message || e).split("\n")[0]})`); }

let fails = 0;
const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const errors = [];
const open = async (w, h, scheme) => {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, colorScheme: scheme });
  const [k, ...v] = ckA.split(";")[0].split("=");
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${BASE}/b/${board}`);
  return { ctx, p };
};

{ // Step in, the needs strip and the agents panel, on a desktop page.
  const { ctx, p } = await open(1280, 860, "light");
  const form = p.locator("form.composer"), stepIn = p.locator("form.composer .step-in");
  await until(async () => (await form.getAttribute("class"))?.includes("tucked"));
  check(await stepIn.isVisible() && /Step in/.test(await stepIn.innerText()), "the composer rests as one Step in control");
  check(!(await p.locator("#attach-btn").isVisible()) && !(await p.locator(".composer .post-btn").isVisible()), "…its toolbar folded away");
  await stepIn.click();
  check(!(await form.getAttribute("class")).includes("tucked") && (await p.evaluate(() => document.activeElement?.id)) === "composer-text", "Step in opens the composer and puts the cursor in it");
  const box = await p.locator("#composer-text").boundingBox(), postBtn = await p.locator("#attach-btn").isVisible();
  check(box.height >= 18 && box.width > 200 && postBtn, `…with the whole composer back (${Math.round(box.width)}×${Math.round(box.height)}, attach ${postBtn})`);
  await p.keyboard.type("draft");
  await p.locator(".bp-tabs").click({ position: { x: 5, y: 5 } });
  await p.waitForTimeout(400);
  check(!(await form.getAttribute("class")).includes("tucked"), "a composer with text in it stays open");
  await p.locator("#composer-text").fill("");
  await p.locator(".bp-tabs").click({ position: { x: 5, y: 5 } });
  await until(async () => (await form.getAttribute("class"))?.includes("tucked"));
  check((await form.getAttribute("class")).includes("tucked"), "emptied and left, it folds back to Step in");
  await p.locator("#composer-text").focus();
  check(!(await form.getAttribute("class")).includes("tucked"), "focusing the text box (a shortcut, a click) opens it too");
  await p.locator(".bp-tabs").click({ position: { x: 5, y: 5 } });

  const needs = p.locator("#needs");
  await until(async () => /Approve/.test(await needs.innerText().catch(() => "")));
  const items = await p.locator("#needs .needs-i").allInnerTexts();
  check(items.some((t) => t.startsWith("Approve") && t.includes(`Deploy to production ${run}`)), `Needs you lists the approval waiting on you (${items.join(" | ")})`);
  if (quiet) {
    await until(async () => (await p.locator("#needs .needs-i").allInnerTexts()).some((t) => t.startsWith("Stalled")));
    check((await p.locator("#needs .needs-i").allInnerTexts()).some((t) => t === `Stalled: ${A}/worker`), "…and the stalled agent");
  }
  const colors = await p.evaluate(() => { const i = document.querySelector("#needs .needs-i"), cs = getComputedStyle(i), probe = document.createElement("span"); probe.style.color = "var(--intervene)"; document.body.appendChild(probe); const want = getComputedStyle(probe).color; probe.remove(); return { bg: cs.backgroundColor, want }; });
  check(colors.bg === colors.want, `needs items are oxblood, the intervention colour (${colors.bg})`);
  const apr = p.locator("#needs .needs-i[data-needs-k=apr]");
  const seq = await apr.getAttribute("data-needs");
  await apr.click();
  await until(async () => p.evaluate(() => location.hash));
  check((await p.evaluate(() => location.hash)) === `#e${seq}`, "an item jumps to its message");

  // Agents panel: the stalled session is marked, your sessions have Stop; two taps stop, Resume gives it back.
  const row = (n) => p.locator(`#agents .ag-row[data-k="${A}/${n}"]`);
  await until(async () => (await row("scout").count()) === 1 && (await row("scout").locator("[data-ag-stop]").count()) === 1);
  check((await row("scout").locator(".ag-status").innerText()).includes("Reviewing the landing copy"), "the panel says what each agent is on");
  if (quiet) check((await row("worker").getAttribute("data-state")) === "stalled", "a quiet session that's on a message is marked stalled");
  const stop = row("scout").locator("[data-ag-stop]");
  await stop.click();
  check(/Stop it\?/.test(await stop.innerText()), "the first tap on Stop asks again");
  await stop.click();
  await until(async () => (await row("scout").locator("[data-ag-resume]").count()) === 1);
  const scope = async () => (await api("GET", `/api/sessions/${scout.id}`)).session?.scope;
  check((await scope()) === "read", "the second stops it: the session is read-only");
  await row("scout").locator("[data-ag-resume]").click();
  await until(async () => (await row("scout").locator("[data-ag-stop]").count()) === 1);
  check((await scope()) === "full", "Resume gives it full access back");
  await p.evaluate(() => { history.replaceState(null, "", location.pathname); window.scrollTo(0, 0); });
  await until(async () => !(await p.locator(".toast").isVisible().catch(() => false)), 6000);
  await p.screenshot({ path: `${SHOTS_DIR}/agent-first-desktop-light.png` });
  await ctx.close();
}
{ // Another person's page: no Stop on someone else's agents.
  const ctx = await b.newContext({ viewport: { width: 1280, height: 860 } });
  const [k, ...v] = ckB.split(";")[0].split("=");
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage();
  await p.goto(`${BASE}/b/${board}`);
  await until(async () => (await p.locator(`#agents .ag-row[data-k="${A}/scout"]`).count()) === 1);
  await p.waitForTimeout(1500);
  check((await p.locator("#agents [data-ag-stop]").count()) === 0, "no Stop on another person's agents");
  await ctx.close();
}
for (const [w, h, scheme, name] of [[1280, 860, "dark", "desktop-dark"], [390, 844, "light", "phone-light"]]) {
  const { ctx, p } = await open(w, h, scheme);
  await until(async () => /Approve/.test(await p.locator("#needs").innerText().catch(() => "")));
  if (w < 600) check(await p.locator("form.composer .step-in").isVisible(), "390px: Step in fits the phone layout");
  await p.waitForTimeout(400);
  await p.screenshot({ path: `${SHOTS_DIR}/agent-first-${name}.png` });
  await ctx.close();
}
check(errors.length === 0, `no page errors ${errors.join(" | ")}`);
await b.close();
console.log(fails ? `${fails} FAILED` : "all agent-first checks passed");
process.exit(fails ? 1 : 0);
