// Load test (GAPS non-functional): a board with N entries (default 10,000), then p50/p95 of the interactions that touch
// the whole log, checked against the PRD's targets: entry delivery p95 < 500 ms (a post reaching a waiting agent) and
// context pack p95 < 2 s at 10k entries (read with the board summary, at a caller-set budget).
// LOCAL ONLY: it refuses any BASE that isn't localhost or 127.0.0.1 (never atteo.dev or workers.dev; vedu's agent #3634).
// Usage: BASE=http://localhost:8787 ADMIN_KEY=ci-admin-key [N=10000] [RUNS=20] [STRICT=1] node scripts/load-test.mjs
//   (.dev.vars needs POSTS_PER_MINUTE raised for the typed posts.) STRICT=1 exits 1 when a target is missed; numbers on a
//   laptop's wrangler dev aren't production's, so by default it only reports.
const BASE = (process.env.BASE ?? "http://localhost:8787").replace(/\/$/, "");
let host = "";
try { host = new URL(BASE).hostname; } catch {}
if (host !== "localhost" && host !== "127.0.0.1") {
  console.error(`load-test: refusing ${BASE}: local servers only (localhost or 127.0.0.1)`);
  process.exit(2);
}
const KEY = process.env.ADMIN_KEY ?? "ci-admin-key";
const SETTLE_MS = 250; // src/waits.ts: a wake lingers this long for the rest of a burst
const N = Number(process.env.N ?? 10000);
const RUNS = Math.max(5, Number(process.env.RUNS ?? 20));
const ops = (p, b) => fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": KEY, "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
const run = Date.now().toString(36).slice(-5);
const A = `e2e-load-${run}`, B = `e2e-loadb-${run}`;
for (const u of [A, B]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true" });
const cookie = (await ops("sessions", { user: A })).cookie.split(";")[0];
const token = (await ops("tokens", { user: A })).token, tokenB = (await ops("tokens", { user: B })).token;
const board = (await ops("boards", { user: A, title: `e2e load ${run}` })).board.id;
await ops("members", { board, user: B });

// Seed: the bulk through the operator endpoint (plain notes, in chunks), then 200 typed posts so the summary has open
// questions, tasks, decisions and claims to build, as a real board would.
const t0 = Date.now();
const bulk = Math.max(0, N - 200);
for (let i = 0; i < bulk; i += 2000) {
  const r = await ops("seed", { board, user: A, count: Math.min(2000, bulk - i), prefix: `entry lorem ipsum ${run}` });
  if (!r.ok) throw new Error(`seed: ${JSON.stringify(r)}`);
}
const types = ["note", "question", "claim", "decision", "task"];
for (let i = 0; i < Math.min(200, N); i += 20)
  await Promise.all(
    Array.from({ length: Math.min(20, Math.min(200, N) - i) }, (_, k) =>
      fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ type: types[(i + k) % 5], text: `typed ${i + k} lorem ipsum about the release ${run}` }) }),
    ),
  );
console.log(`seeded ${N} entries in ${Math.round((Date.now() - t0) / 1000)}s on ${BASE}; ${RUNS} runs each`);

let rid = 0;
const mcp = (name, args, tok = token) =>
  fetch(`${BASE}/mcp?board=${board}`, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rid, method: "tools/call", params: { name, arguments: args } }) });
const pct = (t, p) => t[Math.min(t.length - 1, Math.floor((t.length * p) / 100))];
const results = [];
// Times fn RUNS times (to the full response), after one warm-up; returns [p50, p95].
const time = async (name, fn) => {
  const t = [];
  for (let i = 0; i <= RUNS; i++) {
    const s = performance.now();
    const r = await fn();
    const body = typeof r === "number" ? "" : await r.text();
    if (i === 0) { if (typeof r !== "number" && !r.ok) console.log(`${name}: HTTP ${r.status} ${body.slice(0, 200)}`); continue; }
    t.push(typeof r === "number" ? r : performance.now() - s);
  }
  t.sort((a, b) => a - b);
  const row = [name, pct(t, 50), pct(t, 95)];
  results.push(row);
  console.log(`${name.padEnd(30)} p50 ${String(Math.round(row[1])).padStart(5)}ms   p95 ${String(Math.round(row[2])).padStart(5)}ms`);
  return row;
};

// Context pack: the board summary plus entries, at a few caller-set budgets (max_chars).
const pack = [];
for (const budget of [4000, 20000, 80000]) pack.push(await time(`context pack (read, ${budget / 1000}k chars)`, () => mcp("read", { summary: true, since: Math.max(0, N - 500), max_chars: budget })));
await time("agent: read (unread)", () => mcp("read", {}));
await time("agent: post", async () => { await mcp("read", {}); return mcp("post", { type: "note", text: "x" }); });
await time("agent: search", () => mcp("search", { query: "lorem 9999" }));
await time("web: board page", () => fetch(`${BASE}/b/${board}`, { headers: { cookie } }));
await time("web: earlier page (500)", () => fetch(`${BASE}/api/boards/${board}/entries?before=${Math.floor(N / 2)}&limit=500`, { headers: { cookie } }));
await time("web: updates (tail)", () => fetch(`${BASE}/api/boards/${board}/updates?after=${N - 5}`, { headers: { cookie } }));
// Delivery: B's agent is waiting; A posts; the time from sending the post to B's wait returning with it. B first reads
// to the end (a read returns at most 500 entries), so the wait has nothing older to return at once.
const readAllB = async () => { for (let i = 0; i < 100; i++) if ((await (await mcp("read", { limit: 500 }, tokenB)).text()).includes("(nothing new)")) return; };
await readAllB();
const delivery = await time("delivery: post → waiting agent", async () => {
  await readAllB();
  const waiting = mcp("wait", { timeout_seconds: 10 }, tokenB).then((r) => r.text()).then(() => performance.now());
  await new Promise((r) => setTimeout(r, 150)); // the wait is in place
  const s = performance.now();
  await fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text: `ping ${rid}` }) });
  return (await waiting) - s;
});
const page = await (await fetch(`${BASE}/b/${board}`, { headers: { cookie } })).text();
console.log(`board page: ${Math.round(page.length / 1024)} KB`);

// Against the PRD.
const worstPack = Math.max(...pack.map((r) => r[2]));
const misses = [];
const target = (ok, line) => { console.log(`${ok ? "✓" : "✗"} ${line}`); if (!ok) misses.push(line); };
target(delivery[2] < 500, `entry delivery p95 ${Math.round(delivery[2])}ms (PRD: < 500ms; ${SETTLE_MS}ms of it is the wait's burst window, SETTLE_MS)`);
target(worstPack < 2000, `context pack p95 ${Math.round(worstPack)}ms at ${N} entries (PRD: < 2s)`);
if (process.env.STRICT === "1" && misses.length) process.exit(1);
