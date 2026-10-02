// End-to-end test: two agents ("vedu" and "jxn") talk through a board over MCP, plus web and admin pages.
// Usage: BASE=http://localhost:8787 ADMIN_KEY=... node test/e2e.mjs
// Creates real boards on the target deployment (titled "e2e …"). Does not send invite emails.

import { readFileSync } from "node:fs";

const BASE = (process.env.BASE ?? "http://localhost:8787").replace(/\/$/, "");
let ADMIN_KEY = process.env.ADMIN_KEY;
if (!ADMIN_KEY) {
  try {
    ADMIN_KEY = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").match(/^ADMIN_KEY=(.*)$/m)?.[1];
  } catch {}
}

let passed = 0;
let failed = 0;
const failures = [];
async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name} (${Date.now() - t0}ms)`);
  } catch (e) {
    failed++;
    failures.push(name);
    console.log(`  ✗ ${name}\n      ${e?.message ?? e}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function has(text, needle) {
  assert(text.includes(needle), `expected to find ${JSON.stringify(needle)} in:\n${text.slice(0, 1500)}`);
}

let rpcId = 0;
async function rpc(user, board, method, params, { notification = false } = {}) {
  const url = `${BASE}/mcp${board ? `?board=${board}` : ""}`;
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (user) headers["x-user"] = user;
  const body = notification ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: ++rpcId, method, params };
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (notification) return { status: res.status };
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result;
}
async function tool(user, board, name, args = {}) {
  const r = await rpc(user, board, "tools/call", { name, arguments: args });
  return { text: r.content.map((c) => c.text).join("\n"), isError: !!r.isError };
}
async function ok(user, board, name, args) {
  const r = await tool(user, board, name, args);
  assert(!r.isError, `${name} failed: ${r.text}`);
  return r.text;
}
async function err(user, board, name, args, needle) {
  const r = await tool(user, board, name, args);
  assert(r.isError, `${name} should have failed but returned: ${r.text}`);
  if (needle) has(r.text, needle);
  return r.text;
}

console.log(`E2E against ${BASE}`);
const stamp = new Date().toISOString().slice(11, 19);
let board;
let q1;

await step("health", async () => {
  const r = await fetch(`${BASE}/health`);
  assert(r.ok, `status ${r.status}`);
});

await step("MCP initialize returns server info and instructions", async () => {
  const r = await rpc("vedu", null, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "e2e", version: "0" },
  });
  assert(r.protocolVersion === "2025-06-18", `protocolVersion ${r.protocolVersion}`);
  assert(r.serverInfo.name === "agent-board", "server name");
  assert(r.capabilities.tools, "tools capability");
  has(r.instructions, 'connected as "vedu"');
});

await step("unknown protocol version falls back to latest supported", async () => {
  const r = await rpc("vedu", null, "initialize", { protocolVersion: "1999-01-01", capabilities: {} });
  assert(/^\d{4}-\d{2}-\d{2}$/.test(r.protocolVersion), r.protocolVersion);
});

await step("notifications get 202 with no body", async () => {
  const r = await rpc("vedu", null, "notifications/initialized", {}, { notification: true });
  assert(r.status === 202, `status ${r.status}`);
});

await step("tools/list exposes all tools with schemas", async () => {
  const r = await rpc("vedu", null, "tools/list", {});
  const names = r.tools.map((t) => t.name).sort();
  assert(
    JSON.stringify(names) === JSON.stringify(["create_board", "get", "invite", "list_boards", "post", "read", "search", "wait"]),
    names.join(","),
  );
  for (const t of r.tools) assert(t.inputSchema?.type === "object", `${t.name} schema`);
});

await step("GET /mcp is 405 (no SSE stream)", async () => {
  const r = await fetch(`${BASE}/mcp`);
  assert(r.status === 405, `status ${r.status}`);
});

await step("unknown method is a JSON-RPC error; bad JSON is a parse error", async () => {
  const r = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "nope" }) });
  const j = await r.json();
  assert(j.error?.code === -32601, JSON.stringify(j));
  const p = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
  assert(p.status === 400 && (await p.json()).error.code === -32700, "parse error");
});

await step("tool call without X-User is rejected with guidance", async () => {
  await err(null, null, "list_boards", {}, "X-User");
});

await step("vedu creates a board", async () => {
  const text = await ok("vedu", null, "create_board", { title: `e2e ${stamp}` });
  board = text.match(/\((b_[a-z0-9]+)\)/)?.[1];
  assert(board, text);
  has(text, `/mcp?board=${board}`);
  has(text, `/join/${board}`);
});

await step("jxn joins by reading the board (default board from URL)", async () => {
  const text = await ok("jxn", board, "read");
  has(text, `Board "e2e ${stamp}"`);
  has(text, "Members: vedu, jxn");
  has(text, "(nothing new)");
});

await step("core loop: jxn waits, vedu asks, jxn receives the question in real time", async () => {
  const waiting = ok("jxn", board, "wait", { timeout_seconds: 20 });
  await new Promise((r) => setTimeout(r, 400));
  const t0 = Date.now();
  const posted = await ok("vedu", board, "post", { type: "question", to: "jxn", text: "Can you share the failing stack trace from checkout?" });
  q1 = Number(posted.match(/Posted #(\d+)/)?.[1]);
  assert(q1, posted);
  has(posted, "Call wait");
  const got = await waiting;
  const latency = Date.now() - t0;
  has(got, `#${q1} question · vedu → jxn`);
  has(got, "failing stack trace");
  assert(latency < 3000, `delivery took ${latency}ms`);
});

await step("question shows as waiting for jxn in jxn's summary", async () => {
  const text = await ok("jxn", board, "read");
  has(text, "Questions waiting for YOU");
  has(text, `#${q1} (vedu → jxn)`);
  has(text, "(nothing new)"); // already delivered by wait
});

await step("jxn answers with an artifact and a claim; vedu's wait receives both", async () => {
  const waiting = ok("vedu", board, "wait", { timeout_seconds: 20 });
  await new Promise((r) => setTimeout(r, 300));
  const a = await ok("jxn", board, "post", {
    type: "artifact",
    text: "Stack trace from checkout-service",
    artifact_name: "checkout-trace.log",
    artifact_content: "TypeError: cannot read properties of undefined (reading 'amount')\n    at charge (checkout.js:42)",
  });
  const aSeq = Number(a.match(/#(\d+)/)[1]);
  const first = await waiting;
  has(first, "checkout-trace.log");
  const c = await ok("jxn", board, "post", {
    type: "claim",
    reply_to: q1,
    text: `Trace attached in #${aSeq}: charge() gets an undefined payment when the cart is empty.`,
  });
  has(c, "Posted");
  const second = await ok("vedu", board, "wait", { timeout_seconds: 5 });
  has(second, `re #${q1}`);
  has(second, "undefined payment");
});

await step("answered question leaves the summary; file is listed", async () => {
  const text = await ok("vedu", board, "read");
  has(text, "Open questions:\n  none");
  has(text, "checkout-trace.log");
  has(text, "Recent claims:");
});

await step("get returns artifact content and related entries", async () => {
  const text = await ok("vedu", board, "get", { seq: q1 });
  has(text, "Related entries:");
  has(text, "undefined payment");
  const s = await ok("vedu", board, "search", { query: "checkout-trace" });
  const aSeq = Number(s.match(/#(\d+) artifact/)?.[1]);
  const art = await ok("vedu", board, "get", { seq: aSeq });
  has(art, "----- checkout-trace.log -----");
  has(art, "at charge (checkout.js:42)");
});

await step("search covers text and file content, with filters", async () => {
  has(await ok("vedu", board, "search", { query: "checkout.js:42" }), "artifact");
  has(await ok("vedu", board, "search", { query: "stack trace", author: "vedu" }), "question");
  has(await ok("vedu", board, "search", { query: "zzz-not-there" }), "No entries match");
  has(await ok("vedu", board, "search", { query: "100%_literal" }), "No entries match");
});

await step("tasks, decisions, resolves and supersedes update the summary", async () => {
  const t = await ok("vedu", board, "post", { type: "task", to: "jxn", text: "Add a guard for empty carts" });
  const tSeq = Number(t.match(/#(\d+)/)[1]);
  const d1 = await ok("vedu", board, "post", { type: "decision", text: "Ship the fix behind a flag" });
  const d1Seq = Number(d1.match(/#(\d+)/)[1]);
  let s = await ok("jxn", board, "read");
  has(s, `#${tSeq} (vedu → jxn) Add a guard`);
  await ok("jxn", board, "post", { type: "note", text: "Guard added in PR 118", resolves: [tSeq] });
  await ok("vedu", board, "post", { type: "decision", text: "Ship the fix without a flag", supersedes: d1Seq });
  s = await ok("jxn", board, "read");
  has(s, "Open tasks:\n  none");
  has(s, "without a flag");
  assert(!s.includes("behind a flag\n") && !s.includes(`#${d1Seq} (vedu) Ship the fix behind`), "superseded decision still in summary");
});

await step("own posts never come back as unread", async () => {
  await ok("vedu", board, "post", { type: "note", text: "note to self" });
  const r = await ok("vedu", board, "read");
  assert(!r.includes("note to self\n") || r.includes("(nothing new)"), r);
});

await step("read with since returns history without moving the cursor", async () => {
  const r = await ok("jxn", board, "read", { since: 0, limit: 3 });
  has(r, "Entries after #0 (3)");
  has(r, `#${q1} question`);
});

await step("wait times out cleanly", async () => {
  await ok("jxn", board, "read"); // catch up first, so there is nothing unread
  const t0 = Date.now();
  const r = await ok("jxn", board, "wait", { timeout_seconds: 1 });
  has(r, "Nothing new from other members in 1s");
  assert(Date.now() - t0 < 4000, "took too long");
});

await step("validation errors are tool errors with clear messages", async () => {
  await err("vedu", board, "post", { type: "gossip", text: "x" }, "type must be one of");
  await err("vedu", board, "post", { type: "note", text: "   " }, "text is required");
  await err("vedu", board, "post", { type: "note", text: "x", reply_to: 99999 }, "does not exist");
  await err("vedu", board, "post", { type: "artifact", text: "x" }, "artifact_name");
  await err("vedu", board, "post", { type: "note", text: "x", to: "Not A Name!" }, "not a valid member name");
  await err("vedu", board, "get", { seq: 99999 }, "does not exist");
  await err("vedu", "b_doesnotexist1", "read", {}, "not found");
  await err("vedu", "../etc", "read", {}, "not a board id");
});

await step("20 concurrent posts get unique, contiguous sequence numbers", async () => {
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) => ok(i % 2 ? "vedu" : "jxn", board, "post", { type: "note", text: `burst ${i}` })),
  );
  const seqs = results.map((t) => Number(t.match(/#(\d+)/)[1])).sort((a, b) => a - b);
  assert(new Set(seqs).size === 20, "duplicate seq");
  assert(seqs[19] - seqs[0] === 19, `not contiguous: ${seqs.join(",")}`);
});

await step("list_boards shows the board for both members", async () => {
  has(await ok("vedu", null, "list_boards"), board);
  has(await ok("jxn", null, "list_boards"), board);
});

await step("without a default board, a single-board user's board is used; otherwise board is required", async () => {
  const solo = `solo${Date.now().toString(36)}`;
  await ok(solo, board, "read"); // solo is only on this board
  has(await ok(solo, null, "read"), `(${board})`);
  await ok("vedu", null, "create_board", { title: `e2e second ${stamp}` });
  await err("vedu", null, "read", {}, "Pass `board`");
});

await step("web: landing, join, board view and live JSON", async () => {
  const home = await (await fetch(`${BASE}/`)).text();
  has(home, "Create a board");
  const join = await fetch(`${BASE}/join/${board}?name=jxn`);
  assert(join.ok, `join ${join.status}`);
  const jt = await join.text();
  has(jt, `e2e ${stamp}`);
  has(jt, `X-User: jxn`);
  const view = await (await fetch(`${BASE}/b/${board}`)).text();
  has(view, "failing stack trace");
  has(view, "checkout-trace.log");
  const delta = await (await fetch(`${BASE}/api/boards/${board}?after=${q1}`)).json();
  assert(delta.html.includes("checkout-trace.log") && !delta.html.includes(`id="e${q1}"`), "delta should include only newer entries");
  assert((await fetch(`${BASE}/b/b_doesnotexist1`)).status === 404, "missing board 404");
});

await step("web form creates a board and redirects to its join page", async () => {
  const r = await fetch(`${BASE}/boards`, {
    method: "POST",
    body: new URLSearchParams({ title: `e2e form ${stamp}`, user: "vedu" }),
    redirect: "manual",
  });
  assert(r.status === 303, `status ${r.status}`);
  assert(/\/join\/b_[a-z0-9]+\?name=vedu$/.test(r.headers.get("location")), r.headers.get("location"));
});

await step("admin: login required, wrong key rejected, dashboard lists boards, users and messages", async () => {
  assert(ADMIN_KEY, "ADMIN_KEY not available to the test");
  has(await (await fetch(`${BASE}/admin`)).text(), "Admin key");
  has(await (await fetch(`${BASE}/admin?key=wrong`)).text(), "Wrong key");
  assert((await fetch(`${BASE}/api/admin/overview`)).status === 401, "overview should need auth");
  const login = await fetch(`${BASE}/admin?key=${encodeURIComponent(ADMIN_KEY)}`, { redirect: "manual" });
  assert(login.status === 303, `login ${login.status}`);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const page = await (await fetch(`${BASE}/admin`, { headers: { cookie } })).text();
  has(page, `e2e ${stamp}`);
  has(page, "jxn");
  has(page, "Recent messages");
  has(page, "burst 19");
  const o = await (await fetch(`${BASE}/api/admin/overview`, { headers: { "x-admin-key": ADMIN_KEY } })).json();
  const b = o.boards.find((x) => x.id === board);
  assert(b && b.members.includes("vedu") && b.members.includes("jxn"), JSON.stringify(b));
  assert(b.entry_count === 28, `entry_count ${b.entry_count} (expected 28)`);
  const invalid = await fetch(`${BASE}/api/admin/invite`, {
    method: "POST",
    headers: { "x-admin-key": ADMIN_KEY, "content-type": "application/json" },
    body: JSON.stringify({ board, email: "not-an-email" }),
  });
  assert(invalid.status === 400, `invite validation ${invalid.status}`);
});

console.log(`\n${passed} passed, ${failed} failed${failures.length ? `: ${failures.join("; ")}` : ""}`);
process.exit(failed ? 1 : 0);
