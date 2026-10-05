// Browser check (#1010): approval cards. Inbox: Approve / Deny in place. Conversation: the card's buttons show only for
// the person asked, deciding updates it, and a live "approval" event updates everyone's copy.
import { SHOTS_DIR } from "../lib/shots.mjs";
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { BASE, CHROME, ops, ctxFor } from "./fixture.mjs";
const OUT = `${SHOTS_DIR}/approvals/`; mkdirSync(OUT, { recursive: true });
let fails = 0; const check = (ok, m) => { console.log(`${ok ? "✓" : "✗"} ${m}`); if (!ok) fails++; };
const run = Date.now().toString(36).slice(-4), A = `ana${run}`, B = `ben${run}`;
for (const u of [A, B]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true" });
const tok = (await ops("tokens", { user: A })).token;
const board = (await ops("boards", { user: A, title: "Deploy pipeline" })).board.id; await ops("members", { board, user: B });
const mcp = async (name, args) => { const r = await (await fetch(`${BASE}/mcp?board=${board}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tok}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json(); return r.result?.content?.[0]?.text ?? JSON.stringify(r); };
// With a tool (a permission hook) the request stays off the board; without one it's work on the board and posts a card.
const ask = async (title, command, risk, onBoard = false) => (await mcp("request_approval", { title, ...(onBoard ? {} : { tool: "Bash" }), command, risk, wait_seconds: 0, details: "" })).match(/ap_[A-Za-z0-9_-]+/)?.[0];
const ckA = (await ops("sessions", { user: A })).cookie, ckB = (await ops("sessions", { user: B })).cookie;
const get = async (id) => (await (await fetch(`${BASE}/api/approvals/${id}`, { headers: { cookie: ckA } })).json()).approval;
const b = await chromium.launch({ executablePath: CHROME });
// Each width asks its own approvals, so the widths run side by side (Inbox ones, then conversation ones).
const label = (loc, text) => loc.locator(".apc-lbl", { hasText: text }).waitFor({ timeout: 8000 }).catch(() => {});
await Promise.all([[390, "light"], [320, "dark"], [1280, "dark"]].map(([w, scheme]) => inbox(w, scheme)));
async function inbox(w, scheme) {
  const tag = `${w} ${scheme}`;
  const ap1 = await ask(`Deploy to staging ${w}${scheme}`, "wrangler deploy --env staging && curl -fsS https://staging.example.com/health", "high");
  const ap2 = await ask(`Delete old build artifacts ${w}${scheme}`, "rm -rf dist/old-builds", "medium");
  check(ap1 && ap2, `${tag}: two approvals asked (${ap1}, ${ap2})`);
  const ctx = await ctxFor(b, ckA, w, scheme, 900); const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
  await p.goto(`${BASE}/inbox`);
  const c1 = p.locator(`.apc[data-apc="${ap1}"]`), c2 = p.locator(`.apc[data-apc="${ap2}"]`);
  await c2.waitFor({ timeout: 8000 }).catch(() => {});
  check(await c1.isVisible() && await c2.isVisible(), `${tag}: both show as cards in the Inbox`);
  check((await c1.locator(".apc-cmd").innerText()).includes("wrangler deploy --env staging"), `${tag}: the card shows the exact command`);
  check((await c1.locator(".apc-lbl").innerText()) === "Waiting on you" && await c1.locator('[data-apc-do="approve"]').isVisible(), `${tag}: "Waiting on you" with Approve / Deny`);
  const m = await p.evaluate((id) => { const c = document.querySelector(`.apc[data-apc="${id}"]`), r = c.getBoundingClientRect(), t = c.querySelector(".tk").getBoundingClientRect(), bs = [...c.querySelectorAll("[data-apc-do]")].map((x) => x.getBoundingClientRect()); const g = c.closest("li").querySelector(".grow").getBoundingClientRect(); return { r: r.right, W: innerWidth, doc: document.documentElement.scrollWidth, same: bs.every((x) => Math.abs(x.top - bs[0].top) < 2 && x.right <= t.right + 1 && x.left >= t.left), dl: Math.round(t.left - g.left), dr: Math.round(t.right - g.right) }; }, ap1);
  check(m.doc <= m.W && m.same, `${tag}: the card fits and its buttons sit on one line inside it`);
  check(Math.abs(m.dl) <= 1, `${tag}: the card lines up with the text above it (${m.dl}px, right ${m.dr}px)`);
  await p.screenshot({ path: `${OUT}inbox-${w}-${scheme}.png`, fullPage: true });
  await c1.locator('[data-apc-do="approve"]').click(); await label(c1, "Approved");
  check((await c1.locator(".apc-lbl").innerText()) === "Approved" && !(await c1.locator("[data-apc-do]").count()), `${tag}: Approve: the card reads Approved, buttons gone`);
  check((await get(ap1))?.status === "approved", `${tag}: …and the agent sees approved`);
  await c2.locator('[data-apc-do="reject"]').click(); await label(c2, "Denied");
  check((await c2.locator(".apc-lbl").innerText()) === "Denied", `${tag}: Deny: the card reads Denied`);
  check((await get(ap2))?.status === "rejected", `${tag}: …and the agent sees denied`);
  await p.reload(); await p.locator(`.apc[data-apc="${ap1}"]`).waitFor({ timeout: 8000 }).catch(() => {});
  check((await p.locator(`.apc[data-apc="${ap1}"] .apc-lbl`).innerText()) === "Approved" && !(await p.locator(`.apc[data-apc="${ap1}"] [data-apc-do]`).count()), `${tag}: after a reload it still reads Approved`);
  await p.screenshot({ path: `${OUT}inbox-decided-${w}-${scheme}.png` });
  check(!errs.length, `${tag}: no page errors ${errs.join(" | ")}`);
  await ctx.close();
}
// Conversation: request_approval on the board posts an approval entry. The person asked gets Approve / Deny; others see
// the card without them, and it updates live on their page when it's decided.
await Promise.all([[390, "light"], [320, "dark"], [1280, "dark"]].map(([w, scheme]) => conversation(w, scheme)));
async function conversation(w, scheme) {
  const tag = `conversation ${w} ${scheme}`;
  const ap = await ask(`Push the hotfix ${w}${scheme}`, "git push origin hotfix:main", "high", true);
  const open = async (ck) => { const ctx = await ctxFor(b, ck, w, scheme, 800); const p = await ctx.newPage(); p.errs = []; p.on("pageerror", (e) => p.errs.push(e.message)); await p.goto(`${BASE}/b/${board}`); await p.waitForTimeout(600); return [ctx, p]; };
  const [cA, pA] = await open(ckA), [cB, pB] = await open(ckB);
  const cardA = pA.locator(`.apc[data-apc="${ap}"]`), cardB = pB.locator(`.apc[data-apc="${ap}"]`);
  check(await cardA.isVisible() && await cardB.isVisible(), `${tag}: the approval shows as a card in the conversation`);
  check((await cardA.locator(".apc-cmd").innerText()).includes("git push origin hotfix:main"), `${tag}: …with the exact command`);
  check((await cardA.locator(".apc-lbl").innerText()) === "Waiting on you" && await cardA.locator('[data-apc-do="approve"]').isVisible(), `${tag}: the person asked: "Waiting on you", Approve / Deny`);
  check((await cardB.locator(".apc-lbl").innerText()) === `Waiting on ${A}` && !(await cardB.locator('[data-apc-do="approve"]').isVisible()), `${tag}: someone else: "Waiting on ${A}", no buttons`);
  const m = await pA.evaluate((id) => { const c = document.querySelector(`.apc[data-apc="${id}"]`); c.scrollIntoView({ block: "center" }); const r = c.getBoundingClientRect(), g = c.closest(".grow").getBoundingClientRect(); return { inside: r.left >= g.left - 1 && r.right <= g.right + 1, doc: document.documentElement.scrollWidth, W: innerWidth }; }, ap);
  check(m.inside && m.doc <= m.W, `${tag}: the card sits inside its message, no sideways scroll`);
  await pA.waitForTimeout(200); await pA.screenshot({ path: `${OUT}conv-asked-${w}-${scheme}.png` });
  await pB.evaluate((id) => document.querySelector(`.apc[data-apc="${id}"]`).scrollIntoView({ block: "center" }), ap); await pB.screenshot({ path: `${OUT}conv-other-${w}-${scheme}.png` });
  await cardA.locator('[data-apc-do="approve"]').click(); await label(cardA, "Approved");
  check((await cardA.locator(".apc-lbl").innerText()) === "Approved" && (await get(ap))?.status === "approved", `${tag}: Approve in place: Approved, and the agent sees it`);
  await label(cardB, "Approved");
  check((await cardB.locator(".apc-lbl").innerText()) === "Approved", `${tag}: …and the other person's card turns Approved live`);
  await pA.reload(); await pA.locator(`.apc[data-apc="${ap}"]`).waitFor({ timeout: 8000 }).catch(() => {});
  check((await pA.locator(`.apc[data-apc="${ap}"] .apc-lbl`).innerText()) === "Approved" && !(await pA.locator(`.apc[data-apc="${ap}"] [data-apc-do]`).count()), `${tag}: after a reload it reads Approved, no buttons`);
  check(!pA.errs.length && !pB.errs.length, `${tag}: no page errors ${[...pA.errs, ...pB.errs].join(" | ")}`);
  await cA.close(); await cB.close();
}
await b.close(); console.log(fails ? `${fails} FAILED` : "all approval checks passed"); process.exit(fails ? 1 : 0);
