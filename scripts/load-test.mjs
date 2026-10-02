// Load test: a board with N entries (default 10,000), then the latency of the interactions that touch the whole log.
// Usage: BASE=http://localhost:8787 ADMIN_KEY=… N=10000 node scripts/load-test.mjs   (local: the rate limit must be raised)
const BASE = (process.env.BASE ?? "http://localhost:8787").replace(/\/$/, "");
const KEY = process.env.ADMIN_KEY;
const N = Number(process.env.N ?? 10000);
const ops = (p, b) => fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": KEY, "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
const run = Date.now().toString(36).slice(-5);
const U = `e2e-load-${run}`;
await ops("users", { name: U, email: `${U}@example.com`, verified: "true" });
const cookie = (await ops("sessions", { user: U })).cookie;
const token = (await ops("tokens", { user: U })).token;
const board = (await ops("boards", { user: U, title: `e2e load ${run}` })).board.id;
const types = ["note", "question", "claim", "decision", "task"];
const t0 = Date.now();
// Production has a per-person post rate limit, so seed through the operator endpoint there (in chunks).
if (!/localhost|127\.0\.0\.1/.test(BASE)) {
  for (let i = 0; i < N; i += 500) {
    const r = await ops("seed", { board, user: U, count: Math.min(500, N - i), prefix: `entry lorem ipsum ${run}` });
    if (!r.ok) throw new Error(JSON.stringify(r));
  }
} else for (let i = 0; i < N; i += 50) {
  await Promise.all(
    Array.from({ length: Math.min(50, N - i) }, (_, k) =>
      fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ type: types[(i + k) % 5], text: `entry ${i + k} lorem ipsum dolor sit amet ${run}` }) }),
    ),
  );
}
console.log(`posted ${N} in ${Math.round((Date.now() - t0) / 1000)}s`);
let rid = 0;
const mcp = (name, args) => fetch(`${BASE}/mcp?board=${board}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rid, method: "tools/call", params: { name, arguments: args } }) });
const time = async (name, fn, n = 5) => {
  const t = [];
  for (let i = 0; i < n; i++) {
    const s = performance.now();
    const r = await fn();
    const body = await r.text();
    t.push(performance.now() - s);
    if (i === 0 && !r.ok) console.log(name, r.status, body.slice(0, 200));
  }
  t.sort((a, b) => a - b);
  console.log(`${name.padEnd(22)} p50 ${Math.round(t[Math.floor(n / 2)])}ms  max ${Math.round(t[n - 1])}ms`);
};
await time("agent: read", () => mcp("read", {}));
await time("agent: post", async () => { await mcp("read", {}); return mcp("post", { type: "note", text: "x" }); });
await time("agent: search", () => mcp("search", { query: "lorem 9999" }));
await time("web: board page", () => fetch(`${BASE}/b/${board}`, { headers: { cookie } }));
await time("web: updates (tail)", () => fetch(`${BASE}/api/boards/${board}/updates?after=${N - 5}`, { headers: { cookie } }));
await time("web: post", () => fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text: "y" }) }));
const page = await (await fetch(`${BASE}/b/${board}`, { headers: { cookie } })).text();
console.log(`board page: ${Math.round(page.length / 1024)} KB, newest entry shown: ${page.includes(` ${N - 1}<`) || page.includes(`entry ${N - 1} lorem`)}`);
