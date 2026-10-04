// Approve and deny from the keyboard (#1426, Conductor notes #1276): on the Approvals page J/K picks a request, Enter
// approves, Backspace denies; in a chat the approval card in the message picked with J/K (or the focused card) takes
// Enter / Backspace; in the Inbox J/K moves between your waiting cards. Never a global key: nothing happens with no card
// picked, or while typing (the note box, the composer). High risk asks first (cancel keeps it waiting). Someone else's
// approval never reacts. No page errors.
// Usage: BASE=http://localhost:8787 [ADMIN_KEY=…] node kbd-approve.mjs
import { chromium } from "playwright-core";
const BASE = (process.env.BASE || "http://localhost:8787").replace(/\/$/, "");
let KEY = process.env.ADMIN_KEY;
// (the gate runs against 8787, whose ADMIN_KEY is ci-admin-key)
KEY ||= "ci-admin-key";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": KEY, "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-5), P = `ka${run}`, Q = `kb${run}`;
for (const u of [P, Q]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true" });
const board = (await ops("boards", { user: P, title: `Keys ${run}` })).board.id;
await ops("members", { board, user: Q });
const ck = (await ops("sessions", { user: P })).cookie, tokP = (await ops("tokens", { user: P })).token, tokQ = (await ops("tokens", { user: Q })).token;
async function mcpSession(tok) {
  const init = await fetch(`${BASE}/mcp?board=${board}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "1" } } }) });
  const sid = init.headers.get("mcp-session-id");
  return async (name, args = {}) => (await (await fetch(`${BASE}/mcp?board=${board}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": sid, authorization: `Bearer ${tok}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }) })).json()).result.content[0].text;
}
const agentP = await mcpSession(tokP), agentQ = await mcpSession(tokQ);
const ask = async (agent, title, risk = "low") => { await agent("read"); return (await agent("request_approval", { title, details: `do ${title}`, risk, wait_seconds: 0 })).match(/(ap_[A-Za-z0-9_-]+)/)[1]; };
const status = async (id) => (await (await fetch(`${BASE}/api/approvals/${id}`, { headers: { cookie: ck.split(";")[0] } })).json()).approval?.status;
let fails = 0;
const check = (ok, m) => { console.log(`${ok ? "✓" : "✗"} ${m}`); if (!ok) fails++; };
const until = async (f, ms = 6000) => { const t = Date.now(); for (;;) { const v = await f(); if (v || Date.now() - t > ms) return v; await new Promise((r) => setTimeout(r, 150)); } };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const errors = [];
const open = async (path) => {
  const ctx = await b.newContext({ viewport: { width: 1300, height: 900 } });
  const [k, ...v] = ck.split(";")[0].split("=");
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(BASE + path);
  await p.waitForTimeout(500);
  return { ctx, p };
};

// 1. The Approvals page.
// The high-risk one first and one more after the others, so whichever order the page lists them, the first two picked are low risk.
const a3 = await ask(agentP, `Drop the old table ${run}`, "high"), a1 = await ask(agentP, `Deploy staging ${run}`), a2 = await ask(agentP, `Send the invoice ${run}`), a4 = await ask(agentP, `Rotate a key ${run}`);
let A = await open("/approvals");
check(await A.p.locator(".ap-keys").isVisible(), "the page says J/K, ↵, ⌫");
await A.p.keyboard.press("Enter");
await A.p.keyboard.press("Backspace");
await A.p.waitForTimeout(400);
check([await status(a1), await status(a2), await status(a3), await status(a4)].every((s) => s === "pending"), "nothing happens with no request picked (never a global key)");
// Order on the page: newest first? Find which card J picks.
await A.p.keyboard.press("j");
const first = await A.p.locator(".approval.sel").getAttribute("id");
if (first === a3) throw new Error("the page lists oldest first: reorder this check");
check(!!first && (await A.p.evaluate(() => document.activeElement?.classList.contains("approval"))), `J picks a request and focuses it (${first})`);
// Typing a note never approves: Enter there submits the form as before? It must not trigger our keys; Backspace edits text.
await A.p.locator(`#${first} input[name=note]`).fill("ok");
await A.p.locator(`#${first} input[name=note]`).press("Backspace");
check((await A.p.locator(`#${first} input[name=note]`).inputValue()) === "o" && (await status(first)) === "pending", "Backspace in the note edits the note");
await A.p.locator(`#${first}`).focus();
await A.p.keyboard.press("Enter");
check(await until(async () => (await status(first)) === "approved" && "ok"), "Enter approves the picked request");
const settled = async (n) => until(async () => { try { return (await A.p.evaluate(() => document.readyState === "complete" && document.querySelectorAll(".approval").length)) === n && "ok"; } catch { return false; } }, 8000);
await settled(3); // the page reloads after a decision
await A.p.keyboard.press("j");
const second = await A.p.locator(".approval.sel").getAttribute("id");
await A.p.keyboard.press("Backspace");
check(await until(async () => (await status(second)) === "rejected" && "ok"), "Backspace denies the picked request");
await settled(2);
// High risk: Enter asks first; cancel keeps it waiting, OK approves.
const cards = await A.p.locator(".approval").evaluateAll((cs) => cs.map((c) => c.id));
let i = cards.indexOf(a3);
for (let n = 0; n <= i; n++) await A.p.keyboard.press("j");
check((await A.p.locator(".approval.sel").getAttribute("id")) === a3, "J/K reaches the high-risk one");
let asked = "";
A.p.once("dialog", async (d) => { asked = d.message(); await d.dismiss(); });
await A.p.keyboard.press("Enter");
await A.p.waitForTimeout(500);
check(asked.includes("high risk") && (await status(a3)) === "pending", `high risk asks first; cancel keeps it waiting (${asked})`);
A.p.once("dialog", (d) => d.accept());
await A.p.keyboard.press("Enter");
check(await until(async () => (await status(a3)) === "approved" && "ok"), "…OK approves it");
await A.ctx.close();

// 2. In the chat: the approval card in the message picked with J/K.
const a5 = await ask(agentP, `Merge the branch ${run}`);
const a6 = await ask(agentQ, `Someone else's ${run}`); // asked of Q: never reacts for P
A = await open(`/b/${board}`);
const seqOf = async (id) => A.p.locator(`.apc[data-apc="${id}"]`).evaluate((c) => +c.closest(".entry").dataset.seq);
const s5 = await seqOf(a5), s6 = await seqOf(a6);
check((await A.p.locator(`.apc[data-apc="${a5}"]`).getAttribute("tabindex")) === "0" && (await A.p.locator(`.apc[data-apc="${a6}"]`).getAttribute("tabindex")) === null, "your waiting card is focusable; someone else's isn't");
// Pick Q's approval message with J/K, press Enter: nothing for P (it opens the entry as before, never decides).
const pick = async (seq) => { for (let n = 0; n < 40; n++) { await A.p.keyboard.press("j"); if ((await A.p.locator("#thread>.entry.sel").getAttribute("data-seq")) === String(seq)) return true; } return false; };
await A.p.locator("body").click({ position: { x: 5, y: 300 } });
check(await pick(s6), "J reaches someone else's approval");
await A.p.keyboard.press("Backspace");
await A.p.waitForTimeout(300);
check((await (await fetch(`${BASE}/api/approvals/${a6}`, { headers: { authorization: `Bearer ${tokQ}` } })).json()).approval?.status === "pending", "Backspace on someone else's approval does nothing");
await A.p.keyboard.press("k");
for (let n = 0; n < 40 && (await A.p.locator("#thread>.entry.sel").getAttribute("data-seq")) !== String(s5); n++) await A.p.keyboard.press("k");
check((await A.p.locator("#thread>.entry.sel").getAttribute("data-seq")) === String(s5), "K picks your approval's message");
check(await A.p.locator(`.apc[data-apc="${a5}"] .apc-kbd`).isVisible(), "…which shows ↵ approve · ⌫ deny");
// Typing in the composer never decides.
await A.p.locator("#composer-text").focus();
await A.p.keyboard.type("hi");
await A.p.keyboard.press("Backspace");
check((await A.p.locator("#composer-text").inputValue()) === "h" && (await status(a5)) === "pending", "typing in the composer never decides");
await A.p.locator("#composer-text").fill("");
await A.p.locator(`.apc[data-apc="${a5}"]`).focus();
await A.p.keyboard.press("Backspace");
check(await until(async () => (await status(a5)) === "rejected" && "ok"), "Backspace on the focused card denies it");
check(await until(async () => (await A.p.locator(`.apc[data-apc="${a5}"]`).getAttribute("class")).includes("st-rejected") && "ok", 3000), "…and the card says Denied");
const a7 = await ask(agentP, `Tag the release ${run}`);
await until(async () => (await A.p.locator(`.apc[data-apc="${a7}"]`).count()) > 0 && "ok");
const s7 = await seqOf(a7);
await A.p.locator("body").click({ position: { x: 5, y: 300 } });
check(await pick(s7), "J picks the new approval's message");
await A.p.keyboard.press("Enter");
check(await until(async () => (await status(a7)) === "approved" && "ok"), "Enter approves it (instead of opening the entry)");
check(!(await A.p.locator("dialog[open]").count()), "…and no entry dialog opened");
await A.ctx.close();

// 3. The Inbox: J/K moves between your waiting cards.
const a8 = await ask(agentP, `Pay the bill ${run}`);
A = await open("/inbox");
const inboxHas = await A.p.locator(`.apc[data-apc="${a8}"]`).count();
if (inboxHas) {
  await A.p.keyboard.press("j");
  check((await A.p.locator(".apc.kbd-sel").getAttribute("data-apc")) === a8 || (await A.p.locator(".apc.kbd-sel").count()) === 1, "J picks a waiting card in the Inbox");
  const picked = await A.p.locator(".apc.kbd-sel").getAttribute("data-apc");
  await A.p.keyboard.press("Enter");
  check(await until(async () => (await status(picked)) === "approved" && "ok"), "Enter approves it");
} else check(false, "the Inbox shows the approval card");
await A.ctx.close();
check(errors.length === 0, `no page errors (${errors.join(" | ")})`);
await b.close();
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
