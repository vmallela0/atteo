// Latency of the main interactions against a server (median and p90 of N runs, time to full response).
// Usage: ADMIN_KEY=… BASE=… node scripts/bench.mjs   (creates an e2e-bench user and board; cleaned up by cleanup-e2e.mjs)
const BASE = (process.env.BASE ?? "https://agent-board.vedu-mallela.workers.dev").replace(/\/$/, "");
const KEY = process.env.ADMIN_KEY;
const N = Number(process.env.N ?? 12);
const ops = (p, b) => fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": KEY, "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
const run = Date.now().toString(36).slice(-5);
const U = `e2e-bench-${run}`;
await ops("users", { name: U, email: `${U}@example.com`, verified: "true" });
const cookie = (await ops("sessions", { user: U })).cookie;
const token = (await ops("tokens", { user: U })).token;
const board = (await ops("boards", { user: U, title: `e2e bench ${run}` })).board.id;
for (let i = 0; i < 30; i++) await fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text: `seed ${i} lorem ipsum dolor sit amet` }) });
let rid = 0;
const mcp = (name, args) => fetch(`${BASE}/mcp?board=${board}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rid, method: "tools/call", params: { name, arguments: args } }) });
const cases = {
  "page: home": () => fetch(`${BASE}/`, { headers: { cookie } }),
  "page: board": () => fetch(`${BASE}/b/${board}`, { headers: { cookie } }),
  "web: post": () => fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text: "bench" }) }),
  "web: updates": () => fetch(`${BASE}/api/boards/${board}/updates?after=25`, { headers: { cookie } }),
  "web: inbox count": () => fetch(`${BASE}/api/inbox/count`, { headers: { cookie } }),
  "web: tasks": () => fetch(`${BASE}/api/boards/${board}/tasks`, { headers: { cookie } }),
  "agent: read": () => mcp("read", {}),
  "agent: post": async () => { await mcp("read", {}); return mcp("post", { type: "note", text: "bench" }); },
  "agent: search": () => mcp("search", { query: "lorem" }),
  health: () => fetch(`${BASE}/health`),
};
const out = [];
for (const [name, fn] of Object.entries(cases)) {
  const t = [];
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    const r = await fn();
    await r.arrayBuffer();
    t.push(performance.now() - t0);
  }
  t.sort((a, b) => a - b);
  out.push({ name, p50: Math.round(t[Math.floor(N / 2)]), p90: Math.round(t[Math.floor(N * 0.9)]) });
}
for (const r of out) console.log(`${r.name.padEnd(18)} p50 ${String(r.p50).padStart(4)}ms  p90 ${String(r.p90).padStart(4)}ms${r.p90 > 300 ? "  ← over 300" : ""}`);
