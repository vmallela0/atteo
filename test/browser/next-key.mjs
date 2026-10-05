// N jumps to the next thing that needs you, on any board (#1464, Conductor notes #1276): approvals waiting on you first,
// then unread mentions etc., oldest first; it opens the message on its board (same board: just scrolls there) and marks
// that inbox item read; nothing waiting: a toast. Never while typing. Listed in the shortcuts (?). No page errors.
// Usage: BASE=http://localhost:8787 [ADMIN_KEY=…] node next-key.mjs
import { chromium } from "playwright-core";
const BASE = (process.env.BASE || "http://localhost:8787").replace(/\/$/, "");
let KEY = process.env.ADMIN_KEY;
// (the gate runs against 8787, whose ADMIN_KEY is ci-admin-key)
KEY ||= "ci-admin-key";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": KEY, "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-5), P = `np${run}`, Q = `nq${run}`;
for (const u of [P, Q]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true" });
const b1 = (await ops("boards", { user: P, title: `First ${run}` })).board.id, b2 = (await ops("boards", { user: P, title: `Second ${run}` })).board.id;
for (const b of [b1, b2]) await ops("members", { board: b, user: Q });
const ck = (await ops("sessions", { user: P })).cookie, tokP = (await ops("tokens", { user: P })).token, tokQ = (await ops("tokens", { user: Q })).token;
const post = async (tok, board, body) => (await (await fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify(body) })).json()).entry.seq;
async function askApproval(board, title) {
  const init = await fetch(`${BASE}/mcp?board=${board}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tokP}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "1" } } }) });
  const sid = init.headers.get("mcp-session-id");
  const call = async (name, args = {}) => (await (await fetch(`${BASE}/mcp?board=${board}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": sid, authorization: `Bearer ${tokP}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }) })).json()).result.content[0].text;
  await call("read");
  return (await call("request_approval", { title, details: "x", risk: "low", wait_seconds: 0 })).match(/(ap_[A-Za-z0-9_-]+)/)[1];
}
let fails = 0;
const check = (ok, m) => { console.log(`${ok ? "✓" : "✗"} ${m}`); if (!ok) fails++; };
const until = async (f, ms = 6000) => { const t = Date.now(); for (;;) { const v = await f(); if (v || Date.now() - t > ms) return v; await new Promise((r) => setTimeout(r, 150)); } };

const m1 = await post(tokQ, b1, { type: "question", text: `@${P} can you check the numbers?` }); // a mention of the person
const apId = await askApproval(b2, `Deploy ${run}`);
const apSeq = (await (await fetch(`${BASE}/api/boards/${b2}/entries?after=0`, { headers: { authorization: `Bearer ${tokP}` } })).json()).entries.find((e) => e.type === "approval" && e.approval?.id === apId).seq;

const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const ctx = await b.newContext({ viewport: { width: 1300, height: 900 } });
const [k, ...v] = ck.split(";")[0].split("=");
await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
const p = await ctx.newPage();
const errors = [];
p.on("pageerror", (e) => errors.push(e.message));
await p.goto(`${BASE}/`);
// The page script defines window.nextNeed when it runs: wait for that, not a timer, so the first N is never sent before the key handler exists.
await until(async () => (await p.evaluate(() => typeof window.nextNeed === "function")) && "ok");
const at = () => new URL(p.url()).pathname + new URL(p.url()).hash;
const pressN = async () => { await p.locator("body").click({ position: { x: 600, y: 20 } }).catch(() => {}); await p.keyboard.press("n"); };
await pressN();
check(await until(async () => at() === `/approvals#${apId}` && "ok"), `N opens the approval waiting on you first, on the Approvals page (${at()})`);
check(await until(() => p.locator(`#${apId}`).isVisible()), "…at the request");
await pressN();
check(await until(async () => at() === `/b/${b1}#e${m1}` && "ok"), `N again: the mention, on the other board (${at()})`);
const read = async () => (await (await fetch(`${BASE}/api/inbox`, { headers: { cookie: ck.split(";")[0] } })).json()).items.find((i) => i.board_id === b1 && i.seq === m1)?.read_at;
check(!!(await until(read)), "…and that inbox item is read");
// A new mention on the board you're on: N just scrolls there (no reload).
const m2 = await post(tokQ, b1, { type: "note", text: `@${P} and this one` });
await until(async () => (await p.locator(`#e${m2}`).count()) > 0 && "ok");
await p.evaluate(() => { window.__noReload = 1; });
// The approval (older, still waiting) comes first; then the new mention.
await pressN();
check(await until(async () => at() === `/approvals#${apId}` && "ok"), "still waiting: the approval comes first again");
// Approve it; now the new mention is the only one: from b2 it opens b1.
await fetch(`${BASE}/api/approvals/${apId}/approve`, { method: "POST", headers: { cookie: ck.split(";")[0], "content-type": "application/json" }, body: "{}" });
await pressN();
check(await until(async () => at() === `/b/${b1}#e${m2}` && "ok"), `then the newer mention (${at()})`);
// Same board: a third mention arrives while you're here; N scrolls without reloading.
const m3 = await post(tokQ, b1, { type: "note", text: `@${P} one more` });
await until(async () => (await p.locator(`#e${m3}`).count()) > 0 && "ok");
await p.evaluate(() => { window.__stay = 1; });
await pressN();
check(await until(async () => at() === `/b/${b1}#e${m3}` && "ok") && (await p.evaluate(() => window.__stay)) === 1, "same board: N scrolls to it, no reload");
// Nothing left: a toast.
await pressN();
check(await until(async () => ((await p.locator("#toast").textContent()) || "").includes("Nothing needs you") && "ok", 3000), `nothing waiting: a toast (${await p.locator("#toast").textContent()})`);
// Never while typing.
const m4 = await post(tokQ, b2, { type: "note", text: `@${P} typing test` });
await p.locator("#composer-text").focus();
await p.keyboard.type("n");
await p.waitForTimeout(500);
check(at().startsWith(`/b/${b1}`) && (await p.locator("#composer-text").inputValue()) === "n", "typing n in the composer doesn't jump");
await p.locator("#composer-text").fill("");
// Listed in the shortcuts.
await p.locator("body").click({ position: { x: 600, y: 20 } });
await p.keyboard.press("?");
check(((await p.locator("#shortcuts").textContent()) || "").includes("Next thing that needs you"), "the shortcuts list has N");
check(errors.length === 0, `no page errors (${errors.join(" | ")})`);
await b.close();
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
