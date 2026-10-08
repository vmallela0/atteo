#!/usr/bin/env node
// Messaging latency bench (vedu #6564, #6566): the critical path of a message, measured on a LOCAL server only.
//
//   post  → acknowledged   web (cookie), REST as an agent (token), MCP post tool
//   post  → another member sees it: the live signal on their board socket, then the /updates fetch the page makes
//   read  → board page HTML, /updates?after= (the page's catch-up), /entries?after= (agents and SDKs)
//   web   → (with a browser) the optimistic "sending…" copy, the sender's real entry, another tab's render, first paint
//
// Every request also reports how many D1 queries and Durable Object calls it waited on (the x-dev-hops header,
// src/devHops.ts). Locally each of those is ~1 ms; at the edge each is a network hop of tens of ms, so the hop counts are
// the deterministic half of this bench, and --d1-ms/--do-ms add that cost to every hop to give a run production's shape.
//
// It fails when a p95 grows past the committed baseline (bench-messaging-baseline.json, per profile) by more than
// GROW (default 50%) and SLACK ms (default 15; laptops are noisy), or when any request makes more hops than it did.
//
//   node scripts/bench-messaging.mjs                       # own wrangler dev on :8640, fresh state, N=40 posts, M=3 listeners
//   node scripts/bench-messaging.mjs --d1-ms 35 --do-ms 35 # the edge-shaped profile
//   node scripts/bench-messaging.mjs --base http://localhost:8790   # a server you started (with DEV_HOPS=1 for hop counts)
//   node scripts/bench-messaging.mjs --update              # write this run's numbers as the profile's baseline
// Options: --n --m --port --base --d1-ms --do-ms --no-browser --json <file> --update --no-check --keep (state dir and
//   server log) --log-hops (the server log names every D1 query and Durable Object call, per request)
// Env: GROW, SLACK, PW_CHROME, ADMIN_KEY (with --base; default ci-admin-key).
// Local only: --base must be localhost. Never point this at production.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = join(ROOT, "scripts", "bench-messaging-baseline.json");
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const N = Number(opt("n", 40)), M = Number(opt("m", 3)), PORT = Number(opt("port", 8640));
const D1_MS = Number(opt("d1-ms", 0)), DO_MS = Number(opt("do-ms", 0));
const GROW = Number(process.env.GROW ?? 0.5), SLACK = Number(process.env.SLACK ?? 15);
const PROFILE = `d1=${D1_MS},do=${DO_MS}`;
const KEY = process.env.ADMIN_KEY || "ci-admin-key";
let BASE = (opt("base", "") || `http://localhost:${PORT}`).replace(/\/$/, "");
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(BASE).hostname)) { console.error("bench-messaging: local servers only (--base must be localhost)."); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();

// ---- the server: our own wrangler dev with the hop meter on, unless --base names one ----
let server = null, stateDir = null;
async function up(ms = 120_000) {
  const t = Date.now();
  for (;;) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch {}
    if (server && server.exitCode != null) throw new Error(`wrangler dev exited (log: ${stateDir}/server.log)`);
    if (Date.now() - t > ms) throw new Error("server didn't start");
    await sleep(300);
  }
}
if (!opt("base")) {
  try { await fetch(`${BASE}/health`); console.error(`bench-messaging: port ${PORT} is busy; stop that server or pass --port`); process.exit(2); } catch {}
  stateDir = mkdtempSync(join(tmpdir(), "atteo-bench-"));
  const env = join(stateDir, "bench.env");
  writeFileSync(env, [`WORKOS_API_KEY=sk_test_ci_placeholder`, `ADMIN_KEY=${KEY}`, `POSTS_PER_MINUTE=100000`, `PUBLIC_URL=${BASE}`, `DEV_HOPS=1`, `DEV_D1_MS=${D1_MS}`, `DEV_DO_MS=${DO_MS}`, `DEV_HOPS_LOG=${flag("log-hops") ? 1 : 0}`, ""].join("\n"));
  execFileSync("npx", ["wrangler", "d1", "migrations", "apply", "agent-board", "--local", "--persist-to", join(stateDir, "state")], { cwd: ROOT, env: { ...process.env, CI: "1" }, stdio: "ignore" });
  const { openSync } = await import("node:fs");
  const log = openSync(join(stateDir, "server.log"), "w");
  server = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--inspector-port", String(PORT + 1000), "--persist-to", join(stateDir, "state"), "--env-file", env], { cwd: ROOT, stdio: ["ignore", log, log], detached: true });
  const stop = () => { try { process.kill(-server.pid, "SIGTERM"); } catch {} if (!flag("keep")) try { rmSync(stateDir, { recursive: true, force: true }); } catch {} };
  process.on("exit", stop);
  if (flag("keep")) console.log(`state and server log: ${stateDir}`);
  process.on("SIGINT", () => process.exit(130));
  await up();
}

// ---- fixtures: a board with a poster (person + agent token), M listening people ----
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": KEY, "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-5);
const P = `e2e-bp${run}`, L = Array.from({ length: M }, (_, i) => `e2e-bl${i}${run}`);
for (const u of [P, ...L]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true" });
const made = await ops("boards", { user: P, title: `Bench ${run}` });
if (!made.board) throw new Error(`setup: ${JSON.stringify(made)} (users: ${JSON.stringify(await ops("users", { name: P, email: `${P}@example.com`, verified: "true" }))})`);
const board = made.board.id;
for (const u of L) await ops("members", { board, user: u });
const ck = {};
for (const u of [P, ...L]) ck[u] = (await ops("sessions", { user: u })).cookie.split(";")[0];
const token = (await ops("tokens", { user: P })).token;

// ---- samples ----
const S = {}; // metric → { t: ms[], hops: string[] }
const add = (k, ms, hops) => { (S[k] ??= { t: [], hops: [] }).t.push(ms); if (hops) S[k].hops.push(hops); };
const hopsOf = (r) => r.headers.get("x-dev-hops");
async function timed(k, url, init = {}) {
  const t0 = now();
  const r = await fetch(BASE + url, init);
  const body = await r.text();
  const ms = now() - t0;
  if (k) add(k, ms, hopsOf(r));
  return { r, body, ms };
}
let rid = 0;
async function post(kind, text, k) {
  const id = `bench-${run}-${++rid}`;
  if (kind === "web") return timed(k, `/api/boards/${board}/entries`, { method: "POST", headers: { cookie: ck[P], "content-type": "application/json", "idempotency-key": id }, body: JSON.stringify({ text }) });
  if (kind === "rest") return timed(k, `/api/boards/${board}/entries`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": id }, body: JSON.stringify({ text }) });
  return timed(k, `/mcp?board=${board}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: rid, method: "tools/call", params: { name: "post", arguments: { type: "note", text, idempotency_key: id } } }) });
}
const seqOf = (kind, res) => {
  if (res.r.status >= 400) throw new Error(`${kind} post: HTTP ${res.r.status} ${res.body.slice(0, 200)}`);
  if (kind === "mcp") { const m = res.body.match(/Posted #(\d+)/); if (!m) throw new Error(`mcp post: ${res.body.slice(0, 200)}`); return +m[1]; }
  return JSON.parse(res.body).entry.seq;
};

for (let i = 0; i < 20; i++) await post("web", `seed ${i}: the build passed and the docs are up to date`); // a board with some history

// Listeners: a board tab's live path. The socket's "entry" signal, then one /updates?after=last at a time (as tick()).
// The board broadcasts before the post's response leaves, so a listener often hears of a seq before the poster knows it:
// each listener keeps when it got each seq (signal, then fetch), and the poster settles them once it has the seq.
const sigAt = new Map(), gotAt = new Map(); // `${user}:${seq}` → performance.now()
class Listener {
  constructor(u) { this.u = u; this.last = 0; this.busy = false; this.again = false; }
  async open() {
    const snap = JSON.parse((await timed(null, `/api/boards/${board}/updates?after=0`, { headers: { cookie: ck[this.u] } })).body);
    this.last = snap.last;
    await new Promise((res, rej) => {
      this.ws = new WebSocket(BASE.replace(/^http/, "ws") + `/api/boards/${board}/ws`, { headers: { cookie: ck[this.u] } });
      this.ws.onopen = res; this.ws.onerror = rej;
      this.ws.onmessage = (m) => {
        const t = now();
        let d; try { d = JSON.parse(m.data); } catch { return; }
        if (d.type !== "entry") return;
        if (!sigAt.has(`${this.u}:${d.seq}`)) sigAt.set(`${this.u}:${d.seq}`, t);
        this.tick();
      };
    });
  }
  async tick() {
    if (this.busy) { this.again = true; return; }
    this.busy = true;
    try {
      do {
        this.again = false;
        const { body, r } = await timed("read: /updates (live)", `/api/boards/${board}/updates?after=${this.last}`, { headers: { cookie: ck[this.u] } });
        const t = now();
        if (!r.ok) continue;
        const d = JSON.parse(body);
        for (const e of d.entries) if (!gotAt.has(`${this.u}:${e.seq}`)) gotAt.set(`${this.u}:${e.seq}`, t);
        this.last = Math.max(this.last, d.last);
      } while (this.again);
    } finally { this.busy = false; }
  }
}
const listeners = L.map((u) => new Listener(u));
for (const l of listeners) await l.open();

// The agent reads to the end before posting (the stale-read rule refuses a post with unread entries).
async function agentCatchUp() {
  for (let after = 0, i = 0; i < 50; i++) {
    const d = JSON.parse((await timed(null, `/api/boards/${board}/entries?after=${after}&ack=1&limit=500`, { headers: { authorization: `Bearer ${token}` } })).body);
    if (!d.entries.length) return;
    after = d.last;
  }
}

async function phase(kind, label) {
  if (kind !== "web") await agentCatchUp();
  for (let i = 0; i < 3; i++) seqOf(kind, await post(kind, `warm ${kind} ${i}`)); // warm: not counted
  await sleep(200);
  for (let i = 0; i < N; i++) {
    const t0 = now();
    const res = await post(kind, `bench ${kind} ${i}: deploy is green, the canary looks stable`, label);
    const seq = seqOf(kind, res);
    // Wait until every listener has it (or 5s), so each sample is one message on an otherwise idle board.
    const all = () => L.every((u) => gotAt.has(`${u}:${seq}`));
    for (let w = 0; !all() && w < 2500; w++) await sleep(2);
    for (const u of L) {
      if (sigAt.has(`${u}:${seq}`)) add("deliver: live signal", sigAt.get(`${u}:${seq}`) - t0);
      if (gotAt.has(`${u}:${seq}`)) add("deliver: signal + /updates", gotAt.get(`${u}:${seq}`) - t0);
      else add("deliver: missed (5s)", 1);
    }
  }
}
await phase("web", "ack: web post (cookie)");
await phase("rest", "ack: REST post (agent token)");
await phase("mcp", "ack: MCP post tool");

// The read path, with nothing else going on.
const last = JSON.parse((await timed(null, `/api/boards/${board}/updates?after=0`, { headers: { cookie: ck[L[0]] } })).body).last;
for (let i = 0; i < N; i++) {
  await timed("read: board page HTML", `/b/${board}`, { headers: { cookie: ck[L[0]] } });
  await timed("read: /updates?after=last-5", `/api/boards/${board}/updates?after=${last - 5}`, { headers: { cookie: ck[L[0]] } });
  await timed("read: /entries?after=last-5", `/api/boards/${board}/entries?after=${last - 5}`, { headers: { cookie: ck[L[0]] } });
  await timed("read: /entries?after=last (empty)", `/api/boards/${board}/entries?after=${last}`, { headers: { authorization: `Bearer ${token}` } });
}
for (const l of listeners) l.ws.close();

// ---- the web page itself (playwright): optimistic copy, own real entry, another tab's render, first paint ----
if (!flag("no-browser")) {
  let chromium = null;
  try { ({ chromium } = await import("playwright-core")); } catch {}
  const exe = process.env.PW_CHROME || chromium?.executablePath();
  if (!chromium || !exe || !existsSync(exe)) console.error("bench-messaging: no Chromium (npx playwright-core install chromium, or PW_CHROME); skipping the web metrics");
  else {
    const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
    const page = async (u) => {
      const ctx = await b.newContext({ viewport: { width: 1280, height: 860 } });
      const [k, ...v] = ck[u].split("="); await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
      return ctx.newPage();
    };
    const [ps, pr] = [await page(P), await page(L[0])];
    for (let i = 0; i < Math.min(N, 15); i++) {
      for (const p of [ps, pr]) { await p.goto(`${BASE}/b/${board}`); await p.locator("#composer-text").waitFor(); }
      const fcp = await pr.evaluate(() => performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null);
      if (fcp != null) add("web: first contentful paint", fcp);
      await sleep(300); // the socket is up
      const text = `bench web ${run} ${i}`;
      const watch = (t) => {
        // Absolute clock (both pages share it), for when this page first shows the real entry, and its "sending…" copy.
        window.__bench = { t: null, pending: null };
        new MutationObserver(() => {
          const b = window.__bench, ts = performance.timeOrigin + performance.now();
          if (b.pending == null && document.querySelector("#thread .entry.pending")) b.pending = ts;
          if (b.t == null && [...document.querySelectorAll("#thread>.entry:not(.pending) .body")].some((x) => x.textContent.includes(t))) b.t = ts;
        }).observe(document.getElementById("thread"), { childList: true, subtree: true });
      };
      await ps.evaluate(watch, text); await pr.evaluate(watch, text);
      await ps.fill("#composer-text", text);
      const t0 = await ps.evaluate(() => { const ts = performance.timeOrigin + performance.now(); document.querySelector("form.composer").requestSubmit(); return ts; });
      const got = async (p) => { for (let w = 0; w < 500; w++) { const v = await p.evaluate(() => window.__bench); if (v.t != null) return v; await sleep(10); } return null; };
      const [vs, vr] = [await got(ps), await got(pr)];
      if (vs?.pending != null) add("web: optimistic copy shown", vs.pending - t0);
      if (vs) add("web: sender sees real entry", vs.t - t0);
      if (vr) add("web: other tab renders it", vr.t - t0); else add("deliver: missed (5s)", 1);
    }
    await b.close();
  }
}

// ---- report ----
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const mode = (a) => { const c = {}; for (const x of a) c[x] = (c[x] ?? 0) + 1; return Object.entries(c).sort((x, y) => y[1] - x[1])[0]?.[0] ?? null; };
const hopNum = (h, k) => (h ? Number(h.match(new RegExp(`${k}=(\\d+)`))?.[1]) : null);
const out = { profile: PROFILE, n: N, m: M, base: BASE, at: new Date().toISOString(), metrics: {} };
for (const [k, v] of Object.entries(S)) {
  const h = mode(v.hops);
  out.metrics[k] = { n: v.t.length, p50: +pct(v.t, 50).toFixed(1), p95: +pct(v.t, 95).toFixed(1), p99: +pct(v.t, 99).toFixed(1), ...(h ? { d1: hopNum(h, "d1"), do: hopNum(h, "do") } : {}) };
}
if (S["deliver: missed (5s)"]) out.metrics["deliver: missed (5s)"] = { n: S["deliver: missed (5s)"].t.length, p50: 0, p95: 0, p99: 0 };
const pad = (s, n) => String(s).padEnd(n), lp = (s, n) => String(s).padStart(n);
console.log(`\nmessaging bench · profile ${PROFILE} (ms added per D1 query, per Durable Object call) · N=${N} posts per kind · M=${M} listeners\n`);
console.log(`${pad("metric", 36)}${lp("n", 5)}${lp("p50", 9)}${lp("p95", 9)}${lp("p99", 9)}${lp("D1", 5)}${lp("DO", 5)}`);
for (const [k, v] of Object.entries(out.metrics)) console.log(`${pad(k, 36)}${lp(v.n, 5)}${lp(v.p50, 9)}${lp(v.p95, 9)}${lp(v.p99, 9)}${lp(v.d1 ?? "", 5)}${lp(v.do ?? "", 5)}`);
const jsonOut = opt("json", "");
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(out, null, 1) + "\n");
console.log("\n" + JSON.stringify(out));

// ---- against the baseline ----
let base = { note: "scripts/bench-messaging.mjs: p95 ms and hop counts per metric, per profile. --update rewrites this run's profile.", profiles: {} };
try { base = JSON.parse(readFileSync(BASELINE, "utf8")); } catch {}
if (flag("update")) {
  base.profiles[PROFILE] = Object.fromEntries(Object.entries(out.metrics).filter(([k]) => !k.startsWith("deliver: missed")).map(([k, v]) => [k, { p95: v.p95, ...(v.d1 != null ? { d1: v.d1, do: v.do } : {}) }]));
  writeFileSync(BASELINE, JSON.stringify(base, null, 1) + "\n");
  console.log(`\nbaseline for ${PROFILE} written to ${BASELINE}`);
  process.exit(0);
}
let fails = 0;
if (out.metrics["deliver: missed (5s)"]) { console.log(`✗ ${out.metrics["deliver: missed (5s)"].n} messages never reached a listener within 5s`); fails++; }
const ref = base.profiles?.[PROFILE];
if (!ref) console.log(`\nno baseline for ${PROFILE} yet (--update writes one)`);
else if (!flag("no-check")) {
  console.log(`\nagainst the baseline (p95 may grow ${Math.round(GROW * 100)}% + ${SLACK} ms; hops may not grow):`);
  for (const [k, r] of Object.entries(ref)) {
    const v = out.metrics[k];
    if (!v) continue;
    const limit = r.p95 * (1 + GROW) + SLACK;
    const slow = v.p95 > limit, hops = r.d1 != null && v.d1 != null && (v.d1 > r.d1 || v.do > r.do);
    if (slow || hops) fails++;
    console.log(`${slow || hops ? "✗" : "✓"} ${pad(k, 36)} p95 ${lp(v.p95, 7)} (baseline ${r.p95}, limit ${limit.toFixed(0)})${r.d1 != null ? `  hops d1=${v.d1 ?? "?"}/${r.d1} do=${v.do ?? "?"}/${r.do}` : ""}`);
  }
}
console.log(fails ? `\nbench-messaging: ${fails} regression(s)` : "\nbench-messaging: ok");
process.exit(fails ? 1 : 0);
