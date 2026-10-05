// A board's charter (GAPS P0 #1; vedu's side's draft #3334, finished in #3685): Board info shows the goal, the data
// classes, how long messages stay and a note per member. An owner edits it there; a member who isn't an owner reads it
// with no Edit. The goal renders as text, labels of any script are kept, a secret is refused in place, and a member's
// agent gets the charter in the board's summary. 1280 and 390 (no sideways scroll). BASE, ADMIN_KEY, PW_CHROME.
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": process.env.ADMIN_KEY || "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), O = `co${run}`, M = `cm${run}`;
for (const u of [O, M]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true" });
const board = (await ops("boards", { user: O, title: `Charter ${run}` })).board.id;
await ops("members", { board, user: M });
const ck = {}; for (const u of [O, M]) ck[u] = (await ops("sessions", { user: u })).cookie;
const tok = (await ops("tokens", { user: M })).token;

let fails = 0; const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const open = async (u, viewport, touch = false) => {
  const ctx = await b.newContext({ viewport, ...(touch ? { hasTouch: true, isMobile: true } : {}) }); const [k, ...v] = ck[u].split(";")[0].split("=");
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage(), errors = []; p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${BASE}/b/${board}`); await p.locator("#charter-side").waitFor({ state: "attached" });
  if (!(await p.locator("#charter-side").isVisible())) await p.locator("#info-btn").click();
  await p.locator("#charter-side").waitFor(); return { p, errors };
};

const D = await open(O, { width: 1280, height: 900 });
const side = D.p.locator("#charter-side");
check((await side.locator("#ch-goal").innerText()) === "No goal yet." && (await side.locator("#ch-keep").innerText()) === "Keep everything", "a new board: no goal, keeps everything");
// A secret in the goal is refused in place, and nothing is saved.
await side.locator("#ch-edit").click();
await side.locator("#ch-goal-in").fill("deploy with ghp_" + "a".repeat(36)); await side.locator("#ch-form [type=submit]").click();
await side.locator("#ch-err", { hasText: "Blocked" }).waitFor();
check((await side.locator("#ch-goal").innerText()) === "No goal yet.", "a secret in the goal is refused in the form");
const GOAL = `Ship <b>checkout</b> ${run}`;
await side.locator("#ch-goal-in").fill(GOAL);
await side.locator("#ch-classes-in").fill("internal, Customer PII, 内部");
await side.locator("#ch-days-in").fill("30");
await side.locator(`#ch-notes [data-ch-user="${M}"]`).fill("payments");
await side.locator("#ch-form [type=submit]").click();
await D.p.locator("#toast.show", { hasText: "Charter saved" }).waitFor();
check((await side.locator("#ch-goal").innerText()) === GOAL && (await side.locator("#ch-goal b").count()) === 0, "saved: the goal shows as text");
check((await side.locator("#ch-classes .badge").allInnerTexts()).join() === "internal,customer-pii,内部", "data classes: normalized, any script kept");
check((await side.locator("#ch-keep").innerText()) === "Keep messages 30 days" && (await side.locator(`#ch-members [data-user="${M}"]`).innerText()).includes("payments"), "retention and the member's note");
check(!(await side.locator("#ch-form").isVisible()), "the form closes");

// A member who isn't an owner: the same charter, no Edit; their agent reads it in the summary.
const R = await open(M, { width: 1280, height: 900 });
check((await R.p.locator("#ch-goal").innerText()) === GOAL && (await R.p.locator("#ch-edit").count()) === 0, "a member reads it, with no Edit");
const mcp = await (await fetch(`${BASE}/mcp?board=${board}`, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read", arguments: { summary: true } } }) })).json();
const text = mcp.result?.content?.[0]?.text ?? "";
check(text.includes(`Charter: goal: ${GOAL} · data classes: internal, customer-pii, 内部 (post nothing outside them) · messages are kept 30 days`), `their agent gets it in the summary (${text.split("\n").find((l) => l.startsWith("Charter")) ?? "no Charter line"})`);

const P = await open(O, { width: 390, height: 844 }, true);
check(await P.p.locator("#charter-side").isVisible() && (await P.p.evaluate(() => document.documentElement.scrollWidth <= innerWidth)), "phone: the charter shows, no sideways scroll");
check(!D.errors.length && !R.errors.length && !P.errors.length, `no page errors ${[...D.errors, ...R.errors, ...P.errors].join(" | ")}`);
await b.close(); console.log(fails ? `${fails} FAILED` : "charter: all passed"); process.exit(fails ? 1 : 0);
