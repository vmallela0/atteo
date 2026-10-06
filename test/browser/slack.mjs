// The Slack bridge (vedu #5401, src/slack.ts) on a real local Worker against the stub Slack (DEV_FAKE_SLACK=1: no Slack,
// every call recorded at /slack/dev/calls). The owner connects a channel from the board's ⋯ menu (the stub skips Slack's
// consent screen), a teammate links their Slack account on the signed-in page, an agent's question shows in the channel,
// the teammate's Slack thread reply lands on the board as them, the approval DM goes to the owner only, a forged click
// is refused, the owner's Approve decides it, and the owner unlinks. Slack's requests are signed like Slack's.
import { createHmac } from "node:crypto";
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const SECRET = "dev-fake-slack-signing-secret"; // FAKE_SIGNING_SECRET in src/slackCore.ts
const TEAM = "T0FAKE";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": process.env.ADMIN_KEY || "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-5), A = `sa${run}`, B = `sb${run}`, UB = `UB${run.toUpperCase()}`;
for (const u of [A, B]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true" });
const board = (await ops("boards", { user: A, title: `Slack ${run}` })).board.id;
await ops("members", { board, user: B });
const token = (await ops("tokens", { user: A, label: "slack check" })).token;
let fails = 0;
const check = (ok, m) => { console.log(`${ok ? "✓" : "✗"} ${m}`); if (!ok) fails++; };
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn().catch(() => null); if (v) return v; await new Promise((r) => setTimeout(r, 200)); } return null; };

const slack = async (path, body, type) => {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = "v0=" + createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex");
  return fetch(`${BASE}/slack/${path}`, { method: "POST", headers: { "content-type": type, "x-slack-request-timestamp": ts, "x-slack-signature": sig }, body });
};
const event = (ev) => slack("events", JSON.stringify({ type: "event_callback", event_id: `Ev${run}${Math.random().toString(36).slice(2, 8)}`, team_id: TEAM, event: ev }), "application/json");
const command = (user, text, channel, response_url) => slack("commands", new URLSearchParams({ team_id: TEAM, user_id: user, user_name: user.toLowerCase(), channel_id: channel, text, response_url }).toString(), "application/x-www-form-urlencoded");
const click = (user, action, value, response_url) => slack("interactivity", "payload=" + encodeURIComponent(JSON.stringify({ type: "block_actions", trigger_id: `tr${Math.random()}`, team: { id: TEAM }, user: { id: user }, container: { type: "message" }, response_url, actions: [{ action_id: action, value }] })), "application/x-www-form-urlencoded");
const calls = async () => (await (await fetch(`${BASE}/slack/dev/calls?team=${TEAM}`)).json()).calls;
const api = async (path, init = {}) => (await fetch(`${BASE}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) } })).json();

// Unsigned requests are refused.
const forged = await fetch(`${BASE}/slack/events`, { method: "POST", headers: { "content-type": "application/json", "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)), "x-slack-signature": "v0=00" }, body: "{}" });
check(forged.status === 401, `a request without Slack's signature is refused (${forged.status})`);

const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const errors = [];
const open = async (user, path = `/b/${board}`) => {
  const ck = (await ops("sessions", { user })).cookie;
  const ctx = await b.newContext({ viewport: { width: 1200, height: 800 } });
  const [k, ...v] = ck.split(";")[0].split("=");
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(`${user}: ${e.message}`));
  await p.goto(BASE + path);
  return { ctx, p };
};

// The owner: ⋯ → Connect Slack → (the stub's consent) → pick a channel → who will read it → Connected.
const a = await open(A);
await a.p.locator(".actions .board-head-menu summary").click();
check(await a.p.locator("[data-slack-connect]").isVisible(), "the board's ⋯ offers Connect Slack to its owner");
await a.p.locator("[data-slack-connect]").click();
await a.p.waitForURL(/\/slack\/oauth/, { timeout: 8000 });
check(await until(async () => (await a.p.locator("h1").innerText()).includes("Which channel should follow")), "back from Slack, the channel picker shows");
const channel = await a.p.locator('input[name="channel"]:checked').getAttribute("value");
await a.p.click("button.btn.primary");
check(await until(async () => (await a.p.locator("h1").innerText()).includes("Who will read it?")), "a channel with more people than the board asks who will read it");
await a.p.click("button.btn.primary");
check(await until(async () => (await a.p.locator("h1").innerText()).trim() === "Connected"), `connected: ${channel}`);
await a.p.screenshot({ path: `${SHOTS_DIR}/slack-connected.png` });
check(await until(async () => (await calls()).some((c) => c.method === "chat.postMessage" && c.body.channel === channel && JSON.stringify(c.body).includes("now follows"))), "the channel gets its intro message");

// A teammate links their Slack account: /atteo → Connect → the signed-in page → Link.
const rb = `https://hooks.slack.com/t/${run}/b`;
await command(UB, "", channel, rb);
const linkUrl = await until(async () => JSON.stringify((await calls()).filter((c) => c.method === "response_url" && c.body.url === rb).at(-1)?.body ?? "").match(/\/slack\/link\/[0-9a-f]{36}/)?.[0]);
check(!!linkUrl, "an unlinked person's /atteo answers with a Connect button");
const bb = await open(B, linkUrl);
check((await bb.p.locator("h1").innerText()).includes(`to Atteo ${B}?`), "the link page asks before linking");
await bb.p.click("button.btn.primary");
check(await until(async () => (await bb.p.locator("h1").innerText()).trim() === "Linked") && bb.p.url().includes("/slack/link/done"), "and links once Slack confirms who signed in (Sign in with Slack)");

// The owner's agent asks the teammate: its own message in the channel, pinging them only through their linked id.
const q = await api(`/api/boards/${board}/entries`, { method: "POST", body: JSON.stringify({ type: "question", text: `@${B} which card processor do we keep (${run})? <!channel>` }) });
const qSeq = q.entry?.seq ?? q.seq;
const qCall = await until(async () => (await calls()).find((c) => c.method === "chat.postMessage" && c.body.channel === channel && JSON.stringify(c.body).includes(`which card processor do we keep (${run})`)));
check(!!qCall, "the agent's question shows in the channel");
check(qCall && JSON.stringify(qCall.body).includes(`cc <@${UB}>`) && !JSON.stringify(qCall.body).includes("<!channel>"), "with the teammate's ping, and the board text escaped");

// The teammate replies in its Slack thread: on the board as them, in reply to the question.
await event({ type: "message", channel, user: UB, text: "Keep Stripe &amp; ship it", ts: `${Math.floor(Date.now() / 1000)}.000300`, thread_ts: qCall?.answer?.ts });
const reply = await until(async () => (await api(`/api/boards/${board}/entries/${qSeq}`)).replies?.find((e) => e.author === B && e.text === "Keep Stripe & ship it"));
check(!!reply && reply.reply_to === qSeq && reply.via === "person", `the Slack reply is on the board as ${B}, in reply to #${qSeq}`);
check(!(await calls()).some((c) => c.method === "chat.postMessage" && c.body.channel === channel && JSON.stringify(c.body).includes("Keep Stripe")), "and isn't echoed back into the channel");

// The owner's agent asks the owner for approval: the channel sees the status, the owner alone gets the DM.
const rpc = await (await fetch(`${BASE}/mcp?board=${board}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "request_approval", arguments: { title: `Switch processor ${run}`, details: "Edits checkout.ts", risk: "medium", wait_seconds: 0 } } }) })).json();
check(!rpc.error && !rpc.result?.isError, "the agent's approval request is made");
const dm = await until(async () => (await calls()).find((c) => c.method === "chat.postMessage" && /^U/.test(c.body.channel) && JSON.stringify(c.body).includes(`Switch processor ${run}`)));
const apId = dm && JSON.stringify(dm.body).match(/"value":"(ap_[A-Za-z0-9_-]+)"/)?.[1];
check(!!apId && dm.body.channel !== UB, "the approval goes to its owner by DM, with Approve");
check(!!(await until(async () => (await calls()).find((c) => c.body.channel === channel && JSON.stringify(c.body).includes(`Switch processor ${run}`) && JSON.stringify(c.body).includes("waiting on")))), "the channel sees only its status");

// The teammate forges a click on it: refused. The owner clicks Approve: decided, via Slack.
await click(UB, "approve", apId, rb);
check(!!(await until(async () => (await calls()).some((c) => c.method === "response_url" && c.body.url === rb && JSON.stringify(c.body).includes(`only ${A} can decide`)))), "someone else's click is refused");
const ra = `https://hooks.slack.com/t/${run}/a`;
await click(dm.body.channel, "approve", apId, ra);
const decided = await until(async () => { const r = await api(`/api/approvals/${apId}`); return r.approval?.status === "approved" ? r : null; });
check(!!decided, "the owner's Approve decides it");
check(!!(await until(async () => (await calls()).some((c) => c.method === "chat.update" && c.body.channel === channel && JSON.stringify(c.body).includes(`approved by ${A}`)))), "the channel's card says who approved it");
await a.p.goto(`${BASE}/approvals`);
check(await until(async () => { const t = await a.p.locator(".ap-done").innerText(); return t.includes(`Switch processor ${run}`) && t.includes("Approved"); }), "Atteo's Approvals page shows the decision");
await a.p.screenshot({ path: `${SHOTS_DIR}/slack-approved.png` });

// The owner unlinks from the board's Slack settings.
await a.p.goto(`${BASE}/slack/board/${board}`);
await a.p.locator("button.danger").first().click();
check(await until(async () => (await a.p.locator("main").innerText()).includes("No channel follows this board yet")), "Unlink stops it");
check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
await b.close();
console.log(fails ? `${fails} FAILED` : "all slack checks passed");
process.exit(fails ? 1 : 0);
