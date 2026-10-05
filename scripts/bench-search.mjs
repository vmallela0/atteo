// Local-only search benchmark. First run seeds 5,000 entries through the ops API; subsequent runs reuse the fixture.
// Start wrangler with fresh local migrations and --port 8805 --persist-to /tmp/sol-$$.
// Usage: node scripts/bench-search.mjs --fixture /tmp/search-fixture.json --out /tmp/search-before.json
// BASE=http://localhost:8805 N=40; ADMIN_KEY may be supplied or read from .dev.vars (never printed).
import { readFileSync, writeFileSync } from "node:fs";

const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const option = (name, fallback) => process.argv.includes(name) ? arg(name) : fallback;
const base = (process.env.BASE ?? "http://localhost:8805").replace(/\/$/, "");
const url = new URL(base);
if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || +url.port < 8805 || +url.port > 8809) {
  throw new Error("Use a local wrangler server on ports 8805–8809.");
}
const n = Number(process.env.N ?? 40);
if (!Number.isInteger(n) || n < 5) throw new Error("N must be an integer >= 5.");
const fixturePath = option("--fixture", "/tmp/sol-search-fixture.json");
let fixture;
try { fixture = JSON.parse(readFileSync(fixturePath, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; }

async function json(path, body, headers = {}) {
  const res = await fetch(`${base}${path}`, {
    method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${path.split("?")[0]}: HTTP ${res.status}`);
  return res.json();
}

if (!fixture) {
  let key = process.env.ADMIN_KEY;
  if (!key) key = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").match(/^ADMIN_KEY\s*=\s*["']?([^\r\n"']+)/m)?.[1];
  if (!key) throw new Error("ADMIN_KEY is required to seed locally.");
  const ops = (path, body) => json(`/api/ops/${path}`, body, { "x-admin-key": key });
  const run = Date.now().toString(36);
  const users = ["reviewer", "builder", "operator"].map((role) => `bench-${role}-${run}`);
  for (const user of users) await ops("users", { name: user, email: `${user}@example.com`, verified: "true" });
  const token = (await ops("tokens", { user: users[0], label: "local search benchmark" })).token;
  const boards = [];
  const topics = ["Checkout", "Deploy", "Onboarding", "Storage", "Mobile", "Billing", "Auth", "Observability", "SDK", "Routing"];
  const messages = [
    "Reviewed checkout retry handling in src/payments.ts. The regression passes on staging.\nNext: review the empty cart guard and keep the rollout behind the feature flag. Build",
    "Deploy review: staging returned status 503 during the canary. Latency recovered after rollback.\nTrace: request 123-4567; retry budget is exhausted. Build",
    "Decision: ship the empty cart fix after the reviewer confirms the test plan. Production stays on v1.\nThe release checklist and owner are recorded in PLAN.md. Build",
    "TODO: fix the flaky integration test before the next deploy. It fails when the callback arrives twice.\nRepro: run the worker suite with concurrent requests. Build",
    "Agent handoff: schema migration is ready for review; backfill is idempotent and restartable.\nMeasurements: p95 240 ms, database reads 48, errors 0. Build",
    "Reviewed the accessibility and onboarding changes. Keyboard navigation and focus restore both pass.\nFollow up with the mobile owner after the next canary. Build",
    "The SDK client now retries timeouts with jitter. Keep the request identifier stable across attempts.\nNext: add the documentation example and review the changelog. Build",
    "Investigated auth redirect loops on staging. Session cookie expires earlier than the cached profile.\nFix: refresh the identity before returning the board list. Build",
    "Reviewed storage retention and cleanup jobs. Old file versions remain readable until retention runs.\nNext: measure the board query plan after the migration. Build",
    "Deploy completed: smoke checks are green and the canary metrics are stable. The reviewer approved.\nNext: monitor error rates and write the release notes. Build",
  ];
  for (const topic of topics) {
    const board = (await ops("boards", { user: users[0], title: `${topic} agent work` })).board.id;
    boards.push(board);
    for (const user of users.slice(1)) await ops("members", { board, user });
    for (let i = 0; i < messages.length; i++) {
      await ops("seed", { board, user: users[i % users.length], count: 50, prefix: messages[i] });
    }
    console.log(`Seeded ${boards.length}/10 boards (${boards.length * 500} entries)`);
  }
  fixture = { base, token, boards, entries: 5000 };
  writeFileSync(fixturePath, JSON.stringify(fixture), { mode: 0o600 });
}
if (fixture.base !== base) throw new Error("Fixture belongs to a different local server.");
const headers = { authorization: `Bearer ${fixture.token}`, "content-type": "application/json" };
let rpcId = 0;
const grep = (q, extra = {}, all = false) => () => fetch(`${base}${all ? "/api/grep" : `/api/boards/${fixture.boards[0]}/grep`}?${new URLSearchParams({ q, max: "20", ...extra })}`, { headers });
const mcp = (name, args) => () => fetch(`${base}/mcp?board=${fixture.boards[0]}`, {
  method: "POST", headers,
  body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
});
const cases = [
  ["health control", () => fetch(`${base}/health`)],
  ["literal word", grep("checkout")],
  ["phrase", grep("empty cart")],
  ["short regex", grep("TODO:.*fix", { regex: "1" })],
  ["no-literal regex", grep("\\d{3}-\\d{4}", { regex: "1" })],
  ["cross-board", grep("checkout", {}, true)],
  ["cross-board no hits", grep("missingneedle", {}, true)],
  ["no-literal no hits", grep("^\\d{4}$", { regex: "1" })],
  ["MCP search word", mcp("search", { query: "checkout", limit: 20 })],
  ["MCP search phrase", mcp("search", { query: '"empty cart"', limit: 20 })],
  ["MCP compact grep", mcp("grep", { pattern: "checkout", max: 20, compact: true })],
  ["MCP cross-board", mcp("grep", { pattern: "checkout", max: 20, compact: true, board: "all" })],
];
const samples = new Map(cases.map(([name]) => [name, []]));
async function sample(fn) {
  const start = performance.now();
  const res = await fn();
  const body = Buffer.from(await res.arrayBuffer());
  const ms = performance.now() - start;
  if (!res.ok) throw new Error(`Search: HTTP ${res.status}`);
  const parsed = JSON.parse(body.toString());
  if (parsed.error || parsed.result?.isError) throw new Error("Search returned an error.");
  const agentText = parsed.compact ?? parsed.text ?? parsed.result?.content?.map((c) => c.text ?? "").join("\n") ?? "";
  return { ms, bytes: body.length, agentBytes: Buffer.byteLength(agentText), hits: parsed.count };
}
// Warm each path, then interleave cases to reduce order/load bias.
for (const [, fn] of cases) for (let i = 0; i < 3; i++) await sample(fn);
for (let i = 0; i < n; i++) for (const [name, fn] of cases) samples.get(name).push(await sample(fn));
const percentile = (xs, p) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * p) - 1];
const results = [...samples].map(([name, xs]) => ({
  name, p50_ms: +percentile(xs.map((x) => x.ms), .5).toFixed(2), p95_ms: +percentile(xs.map((x) => x.ms), .95).toFixed(2),
  bytes: percentile(xs.map((x) => x.bytes), .5), agent_bytes: percentile(xs.map((x) => x.agentBytes), .5), hits: xs[0].hits,
}));
console.table(results);
const report = { base, entries: fixture.entries, boards: fixture.boards.length, samples: n, warmups: 3, results };
if (process.argv.includes("--out")) writeFileSync(arg("--out"), JSON.stringify(report, null, 2) + "\n");
