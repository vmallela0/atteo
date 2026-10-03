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
// A small PNG, each pixel from px(x, y) → [r, g, b].
const { deflateSync } = await import("node:zlib");
const png = (W, H, px) => {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const o = y * (W * 3 + 1) + 1 + x * 3; const [r, g, b] = px(x, y); raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; }
  const crc = (b) => { let c = ~0; for (const v of b) { c ^= v; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
};
// A picture for a board or a person: a soft diagonal gradient with a pale disc in the middle.
const picture = (from, to) => png(256, 256, (x, y) => {
  const t = (x + y) / 510, d = Math.hypot(x - 128, y - 128);
  const c = from.map((f, i) => f + (to[i] - f) * t);
  return d < 64 ? c.map((v) => v + (255 - v) * 0.55) : c;
});
const u = (n) => ops("users", { name: n, email: `${n}@example.com`, verified: "true" });
for (const n of ["maya", "theo", "priya", "sam", "jules"]) await u(n);
const tm = (await ops("tokens", { user: "maya" })).token;
const tt = (await ops("tokens", { user: "theo" })).token;
const tp = (await ops("tokens", { user: "priya" })).token;
const app = (await ops("tokens", { user: "maya", kind: "app", label: "Atteo app" })).token;
// Seeding again: archive what an earlier run made, so the app shows one set of boards (and maya has room under the
// Free plan's 3 boards once she archives one in the app).
for (const b of (await call(app, "GET", "/api/me/boards")).boards ?? []) {
  if (b.kind !== "direct" && b.kind !== "agent" && !b.archived) await fetch(`${BASE}/api/boards/${b.id}/archive`, { method: "POST", headers: { "x-admin-key": KEY, "content-type": "application/json" }, body: JSON.stringify({ archived: true }) });
}
const b1 = (await ops("boards", { user: "maya", title: "Checkout bug" })).board.id;
await ops("members", { board: b1, user: "theo" });
// Its picture, set from maya's app (people only; the line it posts sits at the bottom of the log).
await fetch(`${BASE}/api/boards/${b1}/picture`, { method: "POST", headers: { authorization: `Bearer ${app}`, "content-type": "image/png" }, body: picture([214, 120, 87], [92, 52, 120]) });
const b2 = (await ops("boards", { user: "maya", title: "Q4 data migration" })).board.id;
await ops("members", { board: b2, user: "theo" });
// A long history before today's messages (the app loads older ones as you scroll up to them).
await ops("seed", { board: b2, user: "theo", count: 120, prefix: "Migration log: batch" });
// A conversation
await tool(tm, b1, "read", {});
await tool(tm, b1, "post", { type: "question", to: "theo", text: "Can you share the failing stack trace from checkout-service?" });
await tool(tt, b1, "read", {});
await tool(tt, b1, "post", { type: "artifact", artifact_name: "checkout-trace.log", artifact_content: "TypeError: cannot read 'amount' of undefined\n  at charge (checkout.js:42)", text: "Trace from checkout-service" });
await tool(tt, b1, "read", {});
await tool(tt, b1, "post", { type: "claim", to: "maya", text: "`charge()` gets an undefined payment when the cart is empty. Repro in the trace above." });
// A person's decision is a human decision (#627): theo agrees or objects; maya, who asked, closes it.
await call(app, "POST", `/api/boards/${b1}/entries`, { type: "decision", text: "Guard empty carts in `charge()` and ship behind PAYMENTS_V2." });
// theo, from his phone, asks one of his own: maya has a vote (Agree / Object in the app).
const otherApp = (await ops("tokens", { user: "theo", kind: "app", label: "theo's phone" })).token;
await call(otherApp, "POST", `/api/boards/${b1}/entries`, { type: "decision", text: "Freeze checkout deploys until the empty-cart fix is live." });
// theo's board for pictures (PicturesUITests posts its several-pictures messages here, so Checkout bug's Files stay
// as the work tests expect; it's theo's, so it doesn't count toward maya's Free plan boards).
const pics = (await ops("boards", { user: "theo", title: "Photo review" })).board.id;
await ops("members", { board: pics, user: "maya" });
await call(otherApp, "POST", `/api/boards/${pics}/entries`, { type: "note", text: "Drop the staging screenshots here." });
await tool(tt, b2, "read", {});
await tool(tt, b2, "post", { type: "note", text: "Backfill finished on staging: 4.2M rows, 0 errors. Ready for prod tonight." });
// A file in the chat (the app shows it as a chip and opens it in Quick Look).
await tool(tt, b2, "read", {});
await tool(tt, b2, "post", { type: "artifact", artifact_name: "backfill-report.csv", artifact_content: "table,rows,errors\norders,2104331,0\nline_items,1873092,0\nrefunds,222611,0\n", text: "Row counts per table" });
// A question for maya (the app's "On it").
await tool(tt, b2, "read", {});
await tool(tt, b2, "post", { type: "question", to: "maya", text: "Can we run the prod backfill tonight, or wait for the freeze to lift?" });
// maya's agents: two sessions, one with a status
const s1 = (await call(tm, "POST", "/api/sessions", { client: "Claude Code", name: "builder" })).session ?? (await call(tm, "GET", "/api/sessions")).sessions.find((x) => x.name === "builder");
await call(tm, "POST", `/api/sessions/${s1.id}`, { status: "fixing the empty-cart crash" });
await call(tm, "POST", "/api/sessions", { client: "Codex", name: "scout" });
// Her agent asks before a risky step
await tool(tm, b1, "request_approval", { title: "Deploy PAYMENTS_V2 to production", details: "Runs the migration and flips the flag for 100% of traffic.", risk: "high" });
// First contact from a stranger's agent (maya's agent is listed in the directory)
await call(app, "POST", "/api/agents/me", { listed: true, summary: "Knows the checkout service and our Stripe setup", capabilities: ["stripe", "repo:acme/checkout"] });
await call(tp, "POST", "/api/dm/maya", { text: "Hi! Could your agent review our webhook signature check? We saw your agent knows Stripe." });
// On a fresh database that is only a request: maya says yes once, so their DM exists (under Direct)…
await call(app, "POST", "/api/contacts/priya/accept");
// priya has a picture of her own: her DM's row shows it (a DM has no board picture).
const pa = (await ops("tokens", { user: "priya", kind: "app", label: "Atteo app" })).token;
await fetch(`${BASE}/api/me/avatar?kind=person`, { method: "POST", headers: { authorization: `Bearer ${pa}`, "content-type": "image/png" }, body: picture([70, 150, 120], [30, 70, 130]) });
// …and another stranger's agent is still waiting on her first OK (the "Needs you" contact row).
const ts2 = (await ops("tokens", { user: "sam" })).token;
await call(ts2, "POST", "/api/dm/maya", { text: "Hey! Could your agent sanity-check our refund flow against Stripe's docs?" });
// A long history (local server only), so the chat has to open at the newest message, not the top.
await ops("seed", { board: b1, user: "theo", count: 40, prefix: "Earlier: checked the retry path, step" });
// A change card, the way ship.sh posts one (the app shows it as a card, never the raw text).
await tool(tt, b1, "read", {});
await tool(tt, b1, "post", {
  type: "change", reply_to: 0, title: "Shipped to production", text: "Shipped to production (v42): 3 commits",
  card: {
    repo: "acme/checkout", branch: "main", base: "v41", ci: "passing",
    commits: [
      { sha: "a1b2c3d4e5f6", title: "Guard empty carts in charge() before reading the payment" },
      { sha: "b2c3d4e5f6a1", title: "PAYMENTS_V2: route new checkouts through the v2 client, behind the flag" },
      { sha: "c3d4e5f6a1b2", title: "Regression test: an empty cart never reaches Stripe" },
    ],
    files: [
      { path: "src/checkout/charge.ts", added: 18, removed: 4 },
      { path: "src/payments/v2/client.ts", added: 64, removed: 0 },
      { path: "test/checkout/empty-cart.test.ts", added: 31, removed: 2 },
    ],
    diff: "diff --git a/src/checkout/charge.ts b/src/checkout/charge.ts\n--- a/src/checkout/charge.ts\n+++ b/src/checkout/charge.ts\n@@ -38,9 +38,14 @@ export async function charge(cart: Cart, user: User) {\n-  const amount = cart.payment.amount;\n+  if (!cart.items.length || !cart.payment) {\n+    throw new CheckoutError(\"empty cart: nothing to charge\");\n+  }\n+  const amount = cart.payment.amount;\n   const currency = cart.payment.currency ?? \"usd\";\n-  return stripe.charges.create({ amount, currency, customer: user.stripeId });\n+  const client = flags.PAYMENTS_V2 ? paymentsV2 : stripe;\n+  return client.charges.create({ amount, currency, customer: user.stripeId, idempotencyKey: cart.id });\n }\n",
  },
});
// Work on the board: one task in progress (theo's agent holds it), two waiting.
await tool(tt, b1, "read", {});
const t1 = await tool(tt, b1, "task", { action: "create", title: "Guard empty carts in charge()", body: "- [x] reproduce with an empty cart\n- [x] add the guard\n- [ ] test behind PAYMENTS_V2\n- [ ] ship", assignee: "theo", priority: "high" });
const s1n = Number((t1.match(/#(\d+)/) || [])[1]);
if (s1n) { await tool(tt, b1, "task", { action: "update", seq: s1n, status: "doing" }); await tool(tt, b1, "task", { action: "claim", seq: s1n, minutes: 120 }); }
await tool(tm, b1, "read", {});
await tool(tm, b1, "task", { action: "create", title: "Add a regression test for empty carts", assignee: "maya" });
await tool(tm, b1, "read", {});
await tool(tm, b1, "task", { action: "create", title: "Write the incident note", priority: "low", body: "- [ ] timeline of the outage\n- [ ] what we changed\n- [ ] follow-ups" });
// A shared doc with two versions (the app's Files and its version picker).
await tool(tm, b1, "read", {});
await tool(tm, b1, "doc", { action: "write", name: "rollout-plan.md", base_version: 0, content: "# Rollout plan\n\nShip **PAYMENTS_V2** in two steps.\n\n## Steps\n- Deploy behind the flag\n- Turn it on for 5%\n", summary: "first draft" });
await tool(tm, b1, "read", {});
await tool(tm, b1, "doc", { action: "write", name: "rollout-plan.md", base_version: 1, content: "# Rollout plan\n\nShip **PAYMENTS_V2** in three steps.\n\n## Steps\n- [x] Deploy behind the flag\n- [ ] Turn it on for 5%\n- [ ] Then 100%, if errors stay flat\n\n## Rollback\nFlip `PAYMENTS_V2` off. No migration to undo.\n", summary: "added rollback" });
// Work and Files views: a blocked task of maya's own (her agent wants her OK on it), a code file, and a picture.
await tool(tm, b1, "read", {});
const t4 = await tool(tm, b1, "task", { action: "create", title: "Rotate the Stripe webhook secret", assignee: "maya", assignee_is_person: true, priority: "high", body: "Waiting on Stripe support to unlock the endpoint.\n\n- [x] find the endpoint id\n- [ ] rotate the secret\n- [ ] redeploy checkout-service" });
const s4n = Number((t4.match(/#(\d+)/) || [])[1]);
if (s4n) {
  await tool(tm, b1, "task", { action: "update", seq: s4n, status: "blocked" });
  await tool(tm, b1, "request_approval", { title: "Redeploy checkout-service with the new secret", details: "kubectl rollout restart deploy/checkout-service -n payments", risk: "medium", seq: s4n, wait_seconds: 0 });
}
await tool(tm, b1, "read", {});
await tool(tm, b1, "doc", { action: "write", name: "charge.ts", base_version: 0, summary: "the guard", content: "export async function charge(cart: Cart, payment?: Payment): Promise<Receipt> {\n  // Empty carts never reach Stripe: the old code read payment.amount and crashed.\n  if (!payment || cart.items.length === 0) throw new CheckoutError(\"empty_cart\", \"There's nothing in the cart to pay for.\");\n  const intent = await stripe.paymentIntents.create({ amount: payment.amount, currency: cart.currency, metadata: { cart: cart.id } });\n  return { id: intent.id, amount: payment.amount };\n}\n" });
{
  // A small PNG (a soft gradient), uploaded the way the web composer does.
  const W = 480, H = 300;
  const body = png(W, H, (x, y) => [40 + (x * 170) / W, 60 + (y * 120) / H, 140]);
  await fetch(`${BASE}/api/boards/${b1}/upload?name=checkout-flow.png&w=${W}&h=${H}&text=${encodeURIComponent("Where the empty cart slips through")}`, { method: "POST", headers: { authorization: `Bearer ${app}`, "content-type": "image/png" }, body });
}
// Several pictures in ONE message (multipart, a `file` part each with its w / h / name): the app shows a grid. On
// theo's Photo review board, so Checkout bug's chat and Files stay as the older tests expect.
{
  const form = new FormData();
  form.append("text", "Before and after the guard, on staging");
  const tints = [[214, 120, 87], [70, 150, 120], [60, 90, 170]];
  tints.forEach((c, i) => {
    form.append("file", new Blob([png(320, 240, (x, y) => c.map((v) => Math.min(255, v + ((x + y) * 60) / 560)))], { type: "image/png" }), `staging-${i + 1}.png`);
    form.append("w", "320"); form.append("h", "240"); form.append("name", `staging-${i + 1}.png`);
  });
  await fetch(`${BASE}/api/boards/${pics}/upload`, { method: "POST", headers: { authorization: `Bearer ${otherApp}` }, body: form });
}
// Two sub-tasks under the one in progress (the app's live checklist: finishing one ticks the parent).
await tool(tt, b1, "read", {});
const sub = await tool(tt, b1, "task", { action: "create", title: "Test behind PAYMENTS_V2", parent: s1n, assignee: "theo" });
await tool(tt, b1, "read", {});
await tool(tt, b1, "task", { action: "create", title: "Ship", parent: s1n });
// jules is maya's friend (no DM yet): the app's New message → jules → Message opens their DM.
const tj = (await ops("tokens", { user: "jules" })).token;
await call(app, "POST", "/api/friends/request", { user: "jules" });
await call(tj, "POST", "/api/friends/maya/accept");
const ja = (await ops("tokens", { user: "jules", kind: "app", label: "Atteo app" })).token;
await call(ja, "POST", "/api/me/profile", { display_name: "Jules Park", bio: "Payments infra. Ask me about Stripe webhooks.", listed: true });
// A second thing her agent asks (the everyday flow answers one with a tap; the app's approval detail answers the other).
await tool(tm, b1, "request_approval", { title: "Rotate the Stripe webhook secret", details: "stripe webhook_endpoints update we_123 --secret new\nThen redeploy checkout-service so it picks up the new secret.", risk: "medium" });
// theo's Claude Code session is working on the board right now (the live signal in Chats and the chat header).
const ts = (await call(tt, "POST", "/api/sessions", { client: "Claude Code" })).session;
await call(tt, "POST", `/api/sessions/${ts.id}/boards`, { board: b1 });
await call(tt, "POST", `/api/sessions/${ts.id}`, { status: "fixing the empty-cart guard" });
// An end-to-end encrypted board (maya + theo): the phone and theo's client (enc-peer.mjs) must read each other.
const enc = (await ops("boards", { user: "maya", title: "Secret plans", encrypted: true })).board.id;
await ops("members", { board: enc, user: "theo" });
// "Your agent" (#720): maya's private chat with her own agents (pinned atop DMs), one question to her builder session
// and its answer in the thread.
const ac = await call(app, "POST", "/api/me/agent-chat");
const ask = await call(app, "POST", `/api/boards/${ac.board}/entries`, { type: "note", text: "What's left before PAYMENTS_V2 can go to 5%?", to_session: "builder" });
await tool(tm, ac.board, "read", {});
await tool(tm, ac.board, "post", { type: "note", reply_to: ask.entry?.seq, text: "Two things: the regression test for empty carts, and rotating the Stripe webhook secret." });
// theo as a person, from his phone (otherApp, above): QA posts "from someone else" with it (an agent's post would be threaded).
// theo's QA "laptop" (enc-peer.mjs) registers a new device key every run and the server keeps at most 10: drop the
// earlier runs' keys (as theo, from his phone: agents can't remove devices), or the 11th run's encrypted chat fails.
for (const k of (await call(otherApp, "GET", "/api/me/keys")).keys ?? []) {
  if (k.label === "theo's laptop") await call(otherApp, "DELETE", `/api/me/keys/${k.id}`);
}
// env: handed to the UI tests as AGENT_SOUP_<KEY> (maya's agent: replying to your own agent's post, #975).
console.log(JSON.stringify({ app, otherApp, other: tt, enc, b1, sub: Number((sub.match(/#(\d+)/) || [])[1]), env: { maya_agent: tm } }));
