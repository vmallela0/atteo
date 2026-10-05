// Load test (GAPS non-functional): a board with N entries (default 10,000), then p50/p95 of the interactions that touch
// the whole log, checked against the PRD's targets: entry delivery p95 < 500 ms (a post reaching a waiting agent) and
// context pack p95 < 2 s at 10k entries (read with the board summary, at a caller-set budget).
//
// LOCAL ONLY: refuses any BASE that isn't localhost or 127.0.0.1 (never atteo.dev or workers.dev; vedu's agent #3634).
// Laptop wrangler numbers aren't production's, so by default it only reports. STRICT=1 exits 1 when a target is missed.
//
// Ops runbook (no production deploy — see docs/LOAD_TEST.md):
//   One command, throwaway Worker (raises POSTS_PER_MINUTE, writes /tmp/atteo-load-report.json):
//     scripts/load-test.sh
//     SMOKE=1 scripts/load-test.sh                 # N=200: harness check, not a PRD claim
//     OUT=load-test.json scripts/load-test.sh
//   Against a Worker you already started (raise POSTS_PER_MINUTE for the typed posts):
//     npx wrangler d1 migrations apply agent-board --local
//     npx wrangler dev --port 8801 --var ADMIN_KEY:ci-admin-key --var POSTS_PER_MINUTE:100000
//     BASE=http://localhost:8801 node scripts/load-test.mjs
//   Report: stdout lists every measurement, then a PRD block (delivery p95, worst context-pack p95).
//   OUT=path writes the same as JSON. --help prints this. BASE has no default: it seeds thousands of entries, so it
//   must never land on someone else's dev server by accident (opus-d #3643).
//
// Env / flags: BASE (required) · ADMIN_KEY (or .dev.vars) · N=10000 · RUNS=20 · SMOKE=1 · OUT=path · STRICT=1
//              --out path · --smoke · --strict · --help
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const DELIVERY_TARGET_MS = 500;
export const PACK_TARGET_MS = 2000;
export const SETTLE_MS = 250; // src/waits.ts: a wake lingers this long for the rest of a burst
export const PACK_BUDGETS = [4000, 20000, 80000];

export function percentile(sorted, p) {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))];
}

export function assertLocalBase(base) {
  if (!base) throw new Error("load-test: set BASE to your own local server (e.g. BASE=http://localhost:8801): it seeds thousands of entries there.");
  let host = "";
  try { host = new URL(base).hostname; } catch {}
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`load-test: refusing ${base}: local servers only (localhost or 127.0.0.1)`);
  }
  return base.replace(/\/$/, "");
}

export function adminKeyFromVars(env = process.env, varsText = "") {
  if (env.ADMIN_KEY) return env.ADMIN_KEY;
  return varsText.match(/^ADMIN_KEY\s*=\s*["']?([^\r\n"']+)/m)?.[1] ?? "ci-admin-key";
}

export function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const flag = (name) => argv.includes(name);
  const opt = (name) => (flag(name) ? argv[argv.indexOf(name) + 1] : undefined);
  if (flag("-h") || flag("--help")) return { help: true };
  const smoke = env.SMOKE === "1" || flag("--smoke");
  return {
    help: false,
    base: env.BASE,
    n: Number(env.N ?? (smoke ? 200 : 10_000)),
    runs: Math.max(5, Number(env.RUNS ?? (smoke ? 8 : 20))),
    smoke,
    out: env.OUT || opt("--out"),
    strict: env.STRICT === "1" || flag("--strict"),
  };
}

export function prdCheck(deliveryP95, packP95, n, settleMs = SETTLE_MS) {
  return {
    delivery: { ok: deliveryP95 < DELIVERY_TARGET_MS, p95: deliveryP95, target: DELIVERY_TARGET_MS, settleMs },
    pack: { ok: packP95 < PACK_TARGET_MS, p95: packP95, target: PACK_TARGET_MS, n },
  };
}

export function formatPrdLines(check) {
  return [
    `${check.delivery.ok ? "✓" : "✗"} entry delivery p95 ${Math.round(check.delivery.p95)}ms (PRD: < ${check.delivery.target}ms; ${check.delivery.settleMs}ms of it is the wait's burst window, SETTLE_MS)`,
    `${check.pack.ok ? "✓" : "✗"} context pack p95 ${Math.round(check.pack.p95)}ms at ${check.pack.n} entries (PRD: < ${check.pack.target / 1000}s)`,
  ];
}

export function formatPrdBlock(check, { n, runs } = {}) {
  const ms = (v) => String(Math.round(v)).padStart(5);
  const mark = (ok) => (ok ? "✓" : "✗");
  return [
    `=== PRD (N=${n ?? check.pack.n}, RUNS=${runs ?? "?"}, local wrangler) ===`,
    `entry delivery (post → wait)  p95 ${ms(check.delivery.p95)}ms   target < ${check.delivery.target}ms    ${mark(check.delivery.ok)}`,
    `context pack (read+summary)   p95 ${ms(check.pack.p95)}ms   target < ${check.pack.target}ms   ${mark(check.pack.ok)}`,
  ].join("\n");
}

export function reportJson({ n, runs, base, smoke, seeded_s, measurements, check }) {
  return {
    n,
    runs,
    base,
    smoke: !!smoke,
    seeded_s,
    measurements,
    prd: {
      entry_delivery: {
        p95_ms: Math.round(check.delivery.p95),
        target_ms: check.delivery.target,
        ok: check.delivery.ok,
        settle_ms: check.delivery.settleMs,
      },
      context_pack: {
        p95_ms: Math.round(check.pack.p95),
        target_ms: check.pack.target,
        n: check.pack.n,
        ok: check.pack.ok,
      },
    },
  };
}

function usage() {
  return `Load test a local 10k-entry board and report p95 for post→wait and context pack.

  scripts/load-test.sh                              # throwaway Worker (recommended)
  BASE=http://localhost:8801 node scripts/load-test.mjs
  SMOKE=1 scripts/load-test.sh                      # N=200 harness check
  OUT=load-test.json STRICT=1 node scripts/load-test.mjs

Local only (localhost / 127.0.0.1). Never production. Docs: docs/LOAD_TEST.md`;
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    console.log(usage());
    return;
  }
  let base;
  try { base = assertLocalBase(args.base); } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  let varsText = "";
  try { varsText = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"); } catch {}
  const key = adminKeyFromVars(process.env, varsText);
  const { n: N, runs: RUNS, smoke, out, strict } = args;
  if (!Number.isFinite(N) || N < 1) {
    console.error("load-test: N must be a positive number");
    process.exit(2);
  }

  const ops = async (p, b) => {
    const r = await fetch(`${base}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": key, "content-type": "application/json" }, body: JSON.stringify(b) });
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); } catch { throw new Error(`ops ${p}: HTTP ${r.status} ${text.slice(0, 200)}`); }
    if (!r.ok || j.error) throw new Error(`ops ${p}: ${j.error || `HTTP ${r.status}`}`);
    return j;
  };

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
  const typedN = Math.min(200, N);
  const bulk = Math.max(0, N - typedN);
  for (let i = 0; i < bulk; i += 2000) {
    const count = Math.min(2000, bulk - i);
    const r = await ops("seed", { board, user: A, count, prefix: `entry lorem ipsum ${run}` });
    if (!r.ok) throw new Error(`seed: ${JSON.stringify(r)}`);
    console.log(`seeded ${i + count}/${N} (bulk)`);
  }
  const types = ["note", "question", "claim", "decision", "task"];
  for (let i = 0; i < typedN; i += 20) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(20, typedN - i) }, (_, k) =>
        fetch(`${base}/api/boards/${board}/entries`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ type: types[(i + k) % 5], text: `typed ${i + k} lorem ipsum about the release ${run}` }) }),
      ),
    );
    for (const r of batch) {
      if (r.ok) continue;
      const body = await r.text();
      const hint = /slow down|posts a minute/i.test(body) ? " Raise POSTS_PER_MINUTE on this Worker (scripts/load-test.sh does)." : "";
      throw new Error(`typed post: HTTP ${r.status} ${body.slice(0, 200)}.${hint}`);
    }
  }
  const seeded_s = Math.round((Date.now() - t0) / 1000);
  console.log(`seeded ${N} entries in ${seeded_s}s on ${base}; ${RUNS} runs each${smoke ? " (SMOKE: harness check, not a PRD claim)" : ""}`);

  let rid = 0;
  const mcp = (name, args, tok = token) =>
    fetch(`${base}/mcp?board=${board}`, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rid, method: "tools/call", params: { name, arguments: args } }) });
  const measurements = [];
  // Times fn RUNS times (to the full response), after one warm-up; returns {name, p50, p95}.
  const time = async (name, fn) => {
    const t = [];
    for (let i = 0; i <= RUNS; i++) {
      const s = performance.now();
      const r = await fn();
      const body = typeof r === "number" ? "" : await r.text();
      if (typeof r !== "number" && !r.ok) {
        const msg = `${name}: HTTP ${r.status} ${body.slice(0, 200)}`;
        if (i === 0) { console.log(msg); continue; }
        throw new Error(msg);
      }
      if (i === 0) continue;
      t.push(typeof r === "number" ? r : performance.now() - s);
    }
    t.sort((a, b) => a - b);
    const row = { name, p50: percentile(t, 50), p95: percentile(t, 95) };
    measurements.push(row);
    console.log(`${name.padEnd(30)} p50 ${String(Math.round(row.p50)).padStart(5)}ms   p95 ${String(Math.round(row.p95)).padStart(5)}ms`);
    return row;
  };

  // Context pack: the board summary plus entries, at a few caller-set budgets (max_chars).
  const pack = [];
  for (const budget of PACK_BUDGETS) pack.push(await time(`context pack (read, ${budget / 1000}k chars)`, () => mcp("read", { summary: true, since: Math.max(0, N - 500), max_chars: budget })));
  await time("agent: read (unread)", () => mcp("read", {}));
  await time("agent: post", async () => { await mcp("read", {}); return mcp("post", { type: "note", text: "x" }); });
  await time("agent: search", () => mcp("search", { query: "lorem 9999" }));
  await time("web: board page", () => fetch(`${base}/b/${board}`, { headers: { cookie } }));
  await time("web: earlier page (500)", () => fetch(`${base}/api/boards/${board}/entries?before=${Math.floor(N / 2)}&limit=500`, { headers: { cookie } }));
  await time("web: updates (tail)", () => fetch(`${base}/api/boards/${board}/updates?after=${N - 5}`, { headers: { cookie } }));
  // Delivery: B's agent is waiting; A posts; the time from sending the post to B's wait returning with it. B first reads
  // to the end (a read returns at most 500 entries), so the wait has nothing older to return at once.
  const readAllB = async () => { for (let i = 0; i < 100; i++) if ((await (await mcp("read", { limit: 500 }, tokenB)).text()).includes("(nothing new)")) return; };
  await readAllB();
  const delivery = await time("delivery: post → waiting agent", async () => {
    await readAllB();
    const waiting = mcp("wait", { timeout_seconds: 10 }, tokenB).then((r) => r.text()).then(() => performance.now());
    await new Promise((r) => setTimeout(r, 150)); // the wait is in place
    const s = performance.now();
    const posted = await fetch(`${base}/api/boards/${board}/entries`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text: `ping ${rid}` }) });
    if (!posted.ok) throw new Error(`delivery post: HTTP ${posted.status} ${(await posted.text()).slice(0, 200)}`);
    return (await waiting) - s;
  });
  const page = await (await fetch(`${base}/b/${board}`, { headers: { cookie } })).text();
  console.log(`board page: ${Math.round(page.length / 1024)} KB`);

  const worstPack = Math.max(...pack.map((r) => r.p95));
  const check = prdCheck(delivery.p95, worstPack, N);
  for (const line of formatPrdLines(check)) console.log(line);
  console.log(formatPrdBlock(check, { n: N, runs: RUNS }));
  const json = reportJson({ n: N, runs: RUNS, base, smoke, seeded_s, measurements: measurements.map((m) => ({ name: m.name, p50_ms: Math.round(m.p50), p95_ms: Math.round(m.p95) })), check });
  if (out) {
    writeFileSync(out, `${JSON.stringify(json, null, 2)}\n`, { mode: 0o600 });
    console.log(`JSON: ${out}`);
  }
  if (strict && (!check.delivery.ok || !check.pack.ok)) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
