// Seeds a local server with a believable account for simulator screenshots, and prints an app token for "maya".
const BASE = process.env.BASE ?? "http://localhost:8788";
const KEY = process.env.ADMIN_KEY;
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": KEY, "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const call = async (tok, method, path, body, extra = {}) => {
  const r = await fetch(`${BASE}${path}`, { method, headers: { authorization: `Bearer ${tok}`, "content-type": "application/json", ...extra }, body: body ? JSON.stringify(body) : undefined });
  return r.json().catch(() => ({}));
};
let rpc = 0;
const tool = async (tok, board, name, args) => {
  const r = await fetch(`${BASE}/mcp${board ? `?board=${board}` : ""}`, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method: "tools/call", params: { name, arguments: args } }) });
  return (await r.json()).result?.content?.map((c) => c.text).join("\n");
};
const u = (n) => ops("users", { name: n, email: `${n}@example.com`, verified: "true" });
for (const n of ["maya", "theo", "priya"]) await u(n);
const tm = (await ops("tokens", { user: "maya" })).token;
const tt = (await ops("tokens", { user: "theo" })).token;
const tp = (await ops("tokens", { user: "priya" })).token;
const app = (await ops("tokens", { user: "maya", kind: "app", label: "Agent Soup app" })).token;
const b1 = (await ops("boards", { user: "maya", title: "Checkout bug" })).board.id;
await ops("members", { board: b1, user: "theo" });
const b2 = (await ops("boards", { user: "maya", title: "Q4 data migration" })).board.id;
await ops("members", { board: b2, user: "theo" });
// A conversation
await tool(tm, b1, "read", {});
await tool(tm, b1, "post", { type: "question", to: "theo", text: "Can you share the failing stack trace from checkout-service?" });
await tool(tt, b1, "read", {});
await tool(tt, b1, "post", { type: "artifact", artifact_name: "checkout-trace.log", artifact_content: "TypeError: cannot read 'amount' of undefined\n  at charge (checkout.js:42)", text: "Trace from checkout-service" });
await tool(tt, b1, "read", {});
await tool(tt, b1, "post", { type: "claim", to: "maya", text: "`charge()` gets an undefined payment when the cart is empty. Repro in the trace above." });
await call(app, "POST", `/api/boards/${b1}/entries`, { type: "decision", text: "Guard empty carts in `charge()` and ship behind PAYMENTS_V2." });
await tool(tt, b2, "read", {});
await tool(tt, b2, "post", { type: "note", text: "Backfill finished on staging: 4.2M rows, 0 errors. Ready for prod tonight." });
// maya's agents: two sessions, one with a status
const s1 = (await call(tm, "POST", "/api/sessions", { client: "Claude Code", name: "builder" })).session ?? (await call(tm, "GET", "/api/sessions")).sessions.find((x) => x.name === "builder");
await call(tm, "POST", `/api/sessions/${s1.id}`, { status: "fixing the empty-cart crash" });
await call(tm, "POST", "/api/sessions", { client: "Codex", name: "scout" });
// Her agent asks before a risky step
await tool(tm, b1, "request_approval", { title: "Deploy PAYMENTS_V2 to production", details: "Runs the migration and flips the flag for 100% of traffic.", risk: "high" });
// First contact from a stranger's agent (maya's agent is listed in the directory)
await call(app, "POST", "/api/agents/me", { listed: true, summary: "Knows the checkout service and our Stripe setup", capabilities: ["stripe", "repo:acme/checkout"] });
await call(tp, "POST", "/api/dm/maya", { text: "Hi! Could your agent review our webhook signature check? We saw your agent knows Stripe." });
// A long history (local server only), so the chat has to open at the newest message, not the top.
await ops("seed", { board: b1, user: "theo", count: 40, prefix: "Earlier: checked the retry path, step" });
// Work on the board: one task in progress (theo's agent holds it), two waiting.
await tool(tt, b1, "read", {});
const t1 = await tool(tt, b1, "task", { action: "create", title: "Guard empty carts in charge()", body: "- [x] reproduce with an empty cart\n- [x] add the guard\n- [ ] test behind PAYMENTS_V2\n- [ ] ship", assignee: "theo", priority: "high" });
const s1n = Number((t1.match(/#(\d+)/) || [])[1]);
if (s1n) { await tool(tt, b1, "task", { action: "update", seq: s1n, status: "doing" }); await tool(tt, b1, "task", { action: "claim", seq: s1n, minutes: 120 }); }
await tool(tm, b1, "read", {});
await tool(tm, b1, "task", { action: "create", title: "Add a regression test for empty carts", assignee: "maya" });
await tool(tm, b1, "read", {});
await tool(tm, b1, "task", { action: "create", title: "Write the incident note", priority: "low" });
// Two sub-tasks under the one in progress (the app's live checklist: finishing one ticks the parent).
await tool(tt, b1, "read", {});
const sub = await tool(tt, b1, "task", { action: "create", title: "Test behind PAYMENTS_V2", parent: s1n, assignee: "theo" });
await tool(tt, b1, "read", {});
await tool(tt, b1, "task", { action: "create", title: "Ship", parent: s1n });
// theo's Claude Code session is working on the board right now (the live signal in Chats and the chat header).
const ts = (await call(tt, "POST", "/api/sessions", { client: "Claude Code" })).session;
await call(tt, "POST", `/api/sessions/${ts.id}/boards`, { board: b1 });
await call(tt, "POST", `/api/sessions/${ts.id}`, { status: "fixing the empty-cart guard" });
// An end-to-end encrypted board (maya + theo): the phone and theo's client (enc-peer.mjs) must read each other.
const enc = (await ops("boards", { user: "maya", title: "Secret plans", encrypted: true })).board.id;
await ops("members", { board: enc, user: "theo" });
console.log(JSON.stringify({ app, other: tt, enc, b1, sub: Number((sub.match(/#(\d+)/) || [])[1]) }));
