// Staging smoke test (scripts/staging.sh, docs/STAGING.md). Never point it at prod: it creates users and a board.
// Usage: BASE=https://atteo-staging.vedu-mallela.workers.dev ADMIN_KEY=… node scripts/staging-smoke.mjs
// Users are e2e-stg-*, boards "e2e staging …", so scripts/cleanup-e2e.mjs finds them.
const BASE = (process.env.BASE ?? "").replace(/\/$/, "");
const KEY = process.env.ADMIN_KEY;
if (!BASE || !KEY) throw new Error("BASE and ADMIN_KEY required");
if (/atteo\.dev|agent-board\.vedu-mallela/.test(BASE)) throw new Error(`refusing to smoke-test prod (${BASE})`);

let failed = 0;
async function step(name, fn) {
  const t0 = Date.now();
  try { await fn(); console.log(`  ✓ ${name} (${Date.now() - t0}ms)`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e?.message ?? e}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const get = (p, headers = {}) => fetch(`${BASE}${p}`, { headers });
async function ops(p, body) {
  const r = await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": KEY, "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  assert(r.ok, `ops/${p} ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}
let rid = 0;
async function tool(token, board, name, args = {}) {
  const r = await fetch(`${BASE}/mcp?board=${board}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rid, method: "tools/call", params: { name, arguments: args } }),
  });
  const j = await r.json();
  assert(!j.error && !j.result?.isError, `${name}: ${JSON.stringify(j.error ?? j.result).slice(0, 300)}`);
  return j.result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
}

const run = Date.now().toString(36).slice(-5);
const A = `e2e-stg-a-${run}`, B = `e2e-stg-b-${run}`;
const t = {};
let board, cookieB;

await step("health + deep health", async () => {
  const h = await (await get("/health")).json();
  assert(h.ok && h.version, `health ${JSON.stringify(h)}`);
  const d = await (await get("/health/deep")).json();
  assert(d.ok === true, `deep ${JSON.stringify(d)}`);
});
await step("MCP metadata points at staging", async () => {
  const pr = await (await get("/.well-known/oauth-protected-resource")).json();
  assert(JSON.stringify(pr).includes(BASE), `protected resource ${JSON.stringify(pr).slice(0, 200)}`);
  const as = await (await get("/.well-known/oauth-authorization-server")).json();
  assert(String(as.issuer ?? "").startsWith(BASE), `issuer ${as.issuer}`);
  assert((await get("/.well-known/mcp/server-card.json")).status === 200, "server card");
  const r = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } }) });
  assert(r.status === 401 && /resource_metadata=/.test(r.headers.get("www-authenticate") ?? ""), `unauthenticated /mcp ${r.status}`);
});
await step("ops API: refuses no key, then users, tokens and a session", async () => {
  const r = await fetch(`${BASE}/api/ops/users`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: `e2e-stg-x-${run}` }) });
  assert(r.status >= 400 && r.status < 500, `ops without key answered ${r.status}`);
  for (const u of [A, B]) {
    await ops("users", { name: u, email: `${u}@example.com`, verified: "true" });
    t[u] = (await ops("tokens", { user: u, label: "staging smoke" })).token;
  }
  cookieB = (await ops("sessions", { user: B })).cookie;
  assert(t[A] && t[B] && cookieB, "credentials");
});
await step("create a board and add a member", async () => {
  board = (await ops("boards", { user: A, title: `e2e staging ${run}` })).board.id;
  await ops("members", { board, user: B });
  assert(/^b_/.test(board), `board ${board}`);
});
await step("post over MCP, delivered live to the other member (long-poll)", async () => {
  const u0 = await (await get(`/api/boards/${board}/updates?after=0`, { cookie: cookieB })).json();
  const t0 = Date.now();
  const lp = get(`/api/boards/${board}/updates?after=${u0.last}&wait=20`, { cookie: cookieB }).then((r) => r.json());
  await new Promise((r) => setTimeout(r, 400));
  await tool(t[A], board, "read");
  await tool(t[A], board, "post", { type: "note", text: `staging hello ${run}` });
  const got = await lp;
  assert(got.entries?.some((e) => e.html.includes(`staging hello ${run}`)), `long-poll got ${JSON.stringify(got).slice(0, 200)}`);
  assert(Date.now() - t0 < 6000, `delivery took ${Date.now() - t0}ms`);
});
await step("post from the web, read back over MCP", async () => {
  const r = await fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { cookie: cookieB, "content-type": "application/json" }, body: JSON.stringify({ type: "decision", text: `staging reply ${run}`, to: A }) });
  assert(r.status === 201, `web post ${r.status}`);
  const text = await tool(t[A], board, "read");
  assert(text.includes(`staging reply ${run}`), `read: ${text.slice(0, 300)}`);
});

console.log(failed ? `staging smoke: ${failed} failed` : "staging smoke: all passed");
process.exit(failed ? 1 : 0);
