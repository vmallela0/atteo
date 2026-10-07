// Your own agent by its display name: typing "@The" offers "The Thinker @you's agent" and inserts the canonical token.
// Its named sessions ("@you/opus-z") stay in the menu after a live refresh. One width.
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": process.env.ADMIN_KEY || "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-5), A = `nn${run}`;
await ops("users", { name: A, email: `${A}@example.com`, verified: "true", display: { mode: "developer" } });
const ck = (await ops("sessions", { user: A })).cookie.split(";")[0];
await fetch(`${BASE}/api/me/profile`, { method: "POST", headers: { cookie: ck, "content-type": "application/json" }, body: JSON.stringify({ agent_name: "The Thinker" }) });
const board = (await ops("boards", { user: A, title: `Nickname ${run}` })).board.id;
// A named agent session on the board, as a helper would have.
const tok = (await ops("tokens", { user: A })).token, AH = { authorization: `Bearer ${tok}`, "content-type": "application/json" };
const sess = await (await fetch(`${BASE}/api/sessions`, { method: "POST", headers: AH, body: JSON.stringify({ name: "opus-z", client: "Claude Code" }) })).json();
const sid = sess.id ?? sess.session?.id;
await fetch(`${BASE}/api/sessions/${sid}/boards`, { method: "POST", headers: { ...AH, "x-agent-soup-session": sid }, body: JSON.stringify({ board }) });
let fails = 0;
const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
const [k, ...v] = ck.split("="); await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
const p = await ctx.newPage(); const errors = []; p.on("pageerror", (e) => errors.push(e.message));
await p.goto(`${BASE}/b/${board}`); await p.waitForSelector("#composer-text");
await p.click("#composer-text"); await p.keyboard.type("@The");
const opt = p.locator("#mention-menu [role=option]", { hasText: "The Thinker" });
await opt.first().waitFor({ timeout: 5000 }).catch(() => {});
const t = await opt.first().innerText().catch(() => "");
check(/The Thinker/.test(t) && /your agent/.test(t), `"@The" offers your agent by its nickname (${t.replace(/\s+/g, " ")})`);
await p.keyboard.press("Enter");
check((await p.inputValue("#composer-text")) === `@${A}'s agent `, `picking it inserts the agent's canonical address`);
await p.keyboard.type(`check this ${run}`); await p.keyboard.press("Enter");
let m = null;
for (let i = 0; i < 50 && !m; i++) { const e = (await (await fetch(`${BASE}/api/boards/${board}/entries?after=0`, { headers: { cookie: ck } })).json()).entries?.find((x) => x.text.includes(`check this ${run}`)); m = e?.mentions ?? null; if (!m) await p.waitForTimeout(100); }
check(JSON.stringify(m) === JSON.stringify([{ user: A, agent: true }]), `the post mentions your agent (${JSON.stringify(m)})`);
// After the agents list refreshes live, "you's agent" and the named session are both still offered.
await p.evaluate(() => window.agentsRefresh && window.agentsRefresh());
await p.waitForFunction(() => window.AGENTS !== undefined, null, { timeout: 5000 }).catch(() => {});
await p.click("#composer-text"); await p.keyboard.type(`@${A}`);
const rows = async () => (await p.locator("#mention-menu [role=option]").allInnerTexts()).map((x) => x.replace(/\s+/g, " "));
await p.locator("#mention-menu [role=option]").first().waitFor({ timeout: 5000 }).catch(() => {});
const r = await rows();
check(r.some((x) => x.includes(`${A}'s agent`)), `"@${A}" still offers "${A}'s agent" beside the nickname (${r.join(" | ")})`);
check(r.some((x) => x.includes("opus-z")), `and the named session ${A}/opus-z after the live refresh (${r.join(" | ")})`);
check(!errors.length, `no page errors ${errors.join(" | ")}`);
await b.close();
console.log(fails ? `${fails} FAILED` : "mention nickname: all passed");
process.exit(fails ? 1 : 0);
