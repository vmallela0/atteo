#!/usr/bin/env node
// Self-host / second-account checklist (GAPS.md: Self-hosted board).
// CI and a first clone have no Cloudflare credentials: this runner checks everything that can be
// checked without them (docs, wrangler.jsonc, a wrangler deploy --dry-run under a second-account
// worker name, local D1 migrations). A live second account still needs a person for WorkOS,
// `wrangler secret put`, and `wrangler deploy`. Against a deployed copy, set BASE=https://<your-site>
// (optional ADMIN_KEY) to probe health.
//
//   node scripts/self-host-check.mjs                 # dry-run (what CI runs)
//   node scripts/self-host-check.mjs --skip-wrangler # docs + config only (unit tests)
//   BASE=https://<site> node scripts/self-host-check.mjs
//   node scripts/self-host-check.mjs --json
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const REQUIRED_VARS = ["WORKOS_CLIENT_ID", "ADMIN_EMAIL", "PUBLIC_URL"];
export const REQUIRED_SECRETS = ["WORKOS_API_KEY", "ADMIN_KEY"];
export const OPTIONAL_SECRETS = [
  "AI_ACCOUNT_ID",
  "AI_TOKEN",
  "SENTRY_DSN",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "APNS_KEY",
  "XAI_API_KEY",
  "A2A_SIGNING_KEY",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_INSTALLATION_ID",
];
export const FORBIDDEN_VARS = [
  "DEV_FAKE_MAGIC",
  "DEV_FAKE_CLOCK",
  "DEV_FAKE_VOICE",
  "DEV_FAKE_NEAR_QUOTA",
  "ALLOW_LOCAL_WEBHOOKS",
  "BACKUP_RESTORE",
];
const RECIPE_SCRIPTS = [
  "scripts/stripe-setup.sh",
  "scripts/cleanup-e2e.sh",
  "scripts/ship.sh",
  "scripts/a2a-key.mjs",
  "scripts/backup.mjs",
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BINDINGS = new Set(["BOARD", "DB", "FILES", "CF_VERSION_METADATA"]);

/** Strip line (`//`) and block comments that aren't inside strings, then JSON.parse. */
export function parseJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      out += c;
      i++;
      while (i < text.length) {
        const d = text[i];
        out += d;
        if (d === "\\") {
          out += text[++i] ?? "";
          i++;
          continue;
        }
        i++;
        if (d === '"') break;
      }
      i--;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      i--;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += c;
  }
  return JSON.parse(out);
}

/** Env keys from src/types.ts: bindings, vars, secrets, local-only (.dev.vars). */
export function envKeysFromTypes(text) {
  const start = text.indexOf("export interface Env {");
  if (start < 0) throw new Error("src/types.ts has no `export interface Env`");
  const keys = { bindings: [], vars: [], secrets: [], local: [] };
  for (const line of text.slice(start).split("\n").slice(1)) {
    if (/^\}/.test(line)) break;
    const m = line.match(/^\s+([A-Z][A-Z0-9_]+)\??:/);
    if (!m) continue;
    const name = m[1];
    const comment = (line.split("//")[1] ?? "").trim();
    if (BINDINGS.has(name)) keys.bindings.push(name);
    else if (name.startsWith("DEV_") || comment.includes("LOCAL .dev.vars") || name === "ALLOW_LOCAL_WEBHOOKS") keys.local.push(name);
    else if (/^secret\b/.test(comment)) keys.secrets.push(name);
    else keys.vars.push(name);
  }
  return keys;
}

export function named(text, name) {
  return new RegExp(`(?:\`|/|\\b)${name}(?:\`|\\b)`).test(text);
}

function missingNames(text, names) {
  return names.filter((n) => !named(text, n));
}

function wranglerBin(root) {
  return join(root, "node_modules/wrangler/bin/wrangler.js");
}

function run(bin, args, { cwd, env, timeout = 120_000 } = {}) {
  return new Promise((resolve) => {
    const p = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => {
      out += d;
    });
    p.stderr.on("data", (d) => {
      err += d;
    });
    const t = setTimeout(() => {
      p.kill("SIGKILL");
      resolve({ code: 124, out, err: `${err}\ntimeout after ${timeout}ms` });
    }, timeout);
    p.on("close", (code) => {
      clearTimeout(t);
      resolve({ code: code ?? 1, out, err });
    });
  });
}

function check(id, status, detail) {
  return { id, status, detail };
}

function loadTree(root) {
  const read = (p) => readFileSync(join(root, p), "utf8");
  const wrangler = parseJsonc(read("wrangler.jsonc"));
  const envKeys = envKeysFromTypes(read("src/types.ts"));
  const selfHost = read("docs/SELF_HOST.md");
  const appApi = read("docs/APP_API.md");
  const backups = read("docs/BACKUPS.md");
  const gitignore = read(".gitignore");
  const cliMain = read("cli/src/main.ts");
  const migrations = readdirSync(join(root, "migrations")).filter((n) => /^\d+_.*\.sql$/.test(n)).sort();
  return { wrangler, envKeys, selfHost, appApi, backups, gitignore, cliMain, migrations };
}

/** Docs + committed config. No subprocesses. */
export function staticChecks(tree) {
  const out = [];
  const { wrangler, envKeys, selfHost, appApi, backups, gitignore, cliMain, migrations } = tree;
  const docs = `${selfHost}\n${appApi}\n${backups}`;

  const recipeMiss = [
    [/git clone/, "git clone"],
    [/npm install/, "npm install"],
    [/wrangler\.jsonc/, "wrangler.jsonc"],
    [/npx wrangler d1 create/, "wrangler d1 create"],
    [/database_id/, "database_id"],
    [/migrations_dir/, "migrations_dir"],
    [/npx wrangler d1 migrations apply/, "wrangler d1 migrations apply"],
    [/npx wrangler deploy/, "wrangler deploy"],
    [/atteo login --server/, "atteo login --server"],
    [/Never set `DEV_\*` or `ALLOW_LOCAL_WEBHOOKS`/, "DEV_* / ALLOW_LOCAL_WEBHOOKS production warning"],
    [/\.dev\.vars/, ".dev.vars"],
    [/scripts\/self-host-check\.mjs/, "scripts/self-host-check.mjs"],
    [/APP_API\.md/, "APP_API.md"],
    [/BACKUPS\.md/, "BACKUPS.md"],
  ]
    .filter(([re]) => !re.test(selfHost))
    .map(([, label]) => label);
  out.push(
    recipeMiss.length
      ? check("docs-recipe", "fail", `SELF_HOST.md is missing: ${recipeMiss.join(", ")}`)
      : check("docs-recipe", "ok", "SELF_HOST.md covers clone, wrangler.jsonc, D1, deploy, atteo login --server, DEV_* warning, and this checker"),
  );

  const reqMiss = missingNames(selfHost, [...REQUIRED_VARS, ...REQUIRED_SECRETS]);
  out.push(
    reqMiss.length
      ? check("docs-required", "fail", `SELF_HOST.md doesn't name required ${reqMiss.join(", ")}`)
      : check("docs-required", "ok", `required vars/secrets: ${[...REQUIRED_VARS, ...REQUIRED_SECRETS].join(", ")}`),
  );

  const optMiss = missingNames(selfHost, OPTIONAL_SECRETS);
  out.push(
    optMiss.length
      ? check("docs-optional", "fail", `SELF_HOST.md doesn't name optional ${optMiss.join(", ")}`)
      : check("docs-optional", "ok", `optional secrets: ${OPTIONAL_SECRETS.join(", ")}`),
  );

  const secretDocsMiss = envKeys.secrets.filter((s) => {
    if (s.startsWith("BACKUP_")) return !named(backups, s) && !named(selfHost, s);
    if (s === "CF_API_TOKEN") return !named(docs, s);
    return !named(selfHost, s);
  });
  out.push(
    secretDocsMiss.length
      ? check("docs-env-secrets", "fail", `Env secrets not documented for self-host: ${secretDocsMiss.join(", ")}`)
      : check("docs-env-secrets", "ok", "every Env secret is in SELF_HOST.md, APP_API.md, or BACKUPS.md"),
  );

  const exampleNeed = ["ALLOW_LOCAL_WEBHOOKS", "DEV_FAKE_MAGIC", "DEV_FAKE_CLOCK", "DEV_FAKE_VOICE"];
  const exampleMiss = exampleNeed.filter((n) => !named(selfHost, n));
  out.push(
    exampleMiss.length
      ? check("docs-local-only", "fail", `SELF_HOST.md .dev.vars example missing ${exampleMiss.join(", ")}`)
      : check("docs-local-only", "ok", "local-only DEV_* / ALLOW_LOCAL_WEBHOOKS are listed for .dev.vars, not production"),
  );

  const d1 = wrangler.d1_databases?.[0] ?? {};
  const doBind = wrangler.durable_objects?.bindings?.[0] ?? {};
  const vars = wrangler.vars ?? {};
  const shape = [];
  if (wrangler.main !== "src/index.ts") shape.push(`main is ${wrangler.main ?? "missing"} (want src/index.ts)`);
  if (!wrangler.name) shape.push("missing name");
  if (wrangler.workers_dev !== true) shape.push("workers_dev is not true (a second account needs a workers.dev URL without a custom domain)");
  if (d1.binding !== "DB") shape.push(`D1 binding is ${d1.binding ?? "missing"} (want DB)`);
  if (!d1.database_name) shape.push("missing d1_databases[0].database_name");
  if (!UUID.test(String(d1.database_id ?? ""))) shape.push("d1_databases[0].database_id isn't a UUID (replace it after wrangler d1 create)");
  if (d1.migrations_dir !== "migrations") shape.push(`migrations_dir is ${d1.migrations_dir ?? "missing"} (want migrations)`);
  if (doBind.name !== "BOARD" || doBind.class_name !== "Board") shape.push(`Durable Object is ${doBind.name}/${doBind.class_name} (want BOARD/Board)`);
  for (const v of REQUIRED_VARS) if (!(v in vars)) shape.push(`vars missing ${v}`);
  out.push(shape.length ? check("wrangler-shape", "fail", shape.join("; ")) : check("wrangler-shape", "ok", `Worker ${wrangler.name}, D1 ${d1.database_name}, DO Board, migrations_dir=migrations, workers_dev`));

  const leaked = [
    ...FORBIDDEN_VARS.filter((n) => n in vars),
    ...Object.keys(vars).filter((n) => n.startsWith("DEV_")),
    ...envKeys.secrets.filter((n) => n in vars),
    ...envKeys.local.filter((n) => n in vars),
  ];
  const uniqueLeaked = [...new Set(leaked)];
  out.push(
    uniqueLeaked.length
      ? check("wrangler-vars", "fail", `wrangler.jsonc vars must not include ${uniqueLeaked.join(", ")}`)
      : check("wrangler-vars", "ok", "no DEV_*, ALLOW_LOCAL_WEBHOOKS, BACKUP_RESTORE, or secrets in wrangler.jsonc vars"),
  );

  const ignoreMiss = [".dev.vars", "secrets.txt"].filter((n) => !gitignore.split(/\r?\n/).some((line) => line.trim() === n || line.trim() === `/${n}`));
  out.push(ignoreMiss.length ? check("gitignore", "fail", `.gitignore doesn't ignore ${ignoreMiss.join(", ")}`) : check("gitignore", "ok", ".dev.vars and secrets.txt are gitignored"));

  const byPrefix = new Map();
  for (const name of migrations) {
    const prefix = /^(\d+)/.exec(name)[1];
    const group = byPrefix.get(prefix);
    if (group) group.push(name);
    else byPrefix.set(prefix, [name]);
  }
  const clashes = [...byPrefix.entries()].filter(([, names]) => names.length > 1);
  out.push(
    !migrations.length
      ? check("migrations", "fail", "migrations/ is empty")
      : clashes.length
        ? check("migrations", "fail", `duplicate prefixes: ${clashes.map(([p, n]) => `${p} (${n.join(", ")})`).join("; ")}`)
        : check("migrations", "ok", `${migrations.length} D1 migrations, unique prefixes`),
  );

  const cliMiss = [];
  if (!cliMain.includes("--server")) cliMiss.push("--server");
  if (!cliMain.includes("DEFAULT_SERVER")) cliMiss.push("DEFAULT_SERVER");
  out.push(cliMiss.length ? check("cli-server", "fail", `cli/src/main.ts missing ${cliMiss.join(", ")}`) : check("cli-server", "ok", "CLI has --server (atteo login --server https://<your-site>)"));

  return out;
}

export function fileChecks(root) {
  const missing = RECIPE_SCRIPTS.filter((p) => {
    try {
      return !statSync(join(root, p)).isFile();
    } catch {
      return true;
    }
  });
  return [
    missing.length
      ? check("scripts", "fail", `missing ${missing.join(", ")}`)
      : check("scripts", "ok", RECIPE_SCRIPTS.map((p) => p.replace(/^scripts\//, "")).join(", ")),
  ];
}

function childEnv() {
  const env = { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" };
  for (const k of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_KEY"]) delete env[k];
  return env;
}

export async function wranglerDryRunCheck(root) {
  const bin = wranglerBin(root);
  try {
    statSync(bin);
  } catch {
    return check("wrangler-dry-run", "fail", "wrangler isn't installed (npm ci)");
  }
  const outdir = mkdtempSync(join(tmpdir(), "atteo-selfhost-dry-"));
  try {
    const r = await run(
      process.execPath,
      [
        bin,
        "deploy",
        "--dry-run",
        "--outdir",
        outdir,
        "--name",
        "agent-board-selfhost-check",
        "--var",
        "PUBLIC_URL:https://selfhost.example",
        "--var",
        "WORKOS_CLIENT_ID:client_selfhost_placeholder",
        "--var",
        "ADMIN_EMAIL:ops@example.com",
      ],
      { cwd: root, env: childEnv(), timeout: 180_000 },
    );
    const log = `${r.out}\n${r.err}`;
    if (r.code !== 0) return check("wrangler-dry-run", "fail", `exit ${r.code}: ${log.trim().slice(-800)}`);
    if (/log in to Cloudflare|Just run wrangler login|Need to login/i.test(log)) {
      return check("wrangler-dry-run", "fail", "dry-run asked to log in to Cloudflare (it must not need credentials)");
    }
    if (!/--dry-run: exiting now/.test(log)) return check("wrangler-dry-run", "fail", `dry-run finished without the usual exit line: ${log.trim().slice(-400)}`);
    return check("wrangler-dry-run", "ok", "wrangler deploy --dry-run --name agent-board-selfhost-check (no Cloudflare credentials)");
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
}

export async function d1LocalCheck(root) {
  const bin = wranglerBin(root);
  try {
    statSync(bin);
  } catch {
    return check("d1-local", "fail", "wrangler isn't installed (npm ci)");
  }
  const persist = mkdtempSync(join(tmpdir(), "atteo-selfhost-d1-"));
  try {
    const r = await run(process.execPath, [bin, "d1", "migrations", "apply", "agent-board", "--local", "--persist-to", persist], {
      cwd: root,
      env: childEnv(),
      timeout: 120_000,
    });
    const log = `${r.out}\n${r.err}`;
    if (r.code !== 0) return check("d1-local", "fail", `exit ${r.code}: ${log.trim().slice(-800)}`);
    if (/No migrations to apply/.test(log)) return check("d1-local", "fail", "no migrations applied on a fresh persist-to (migrations_dir / database_name?)");
    const n = readdirSync(join(root, "migrations")).filter((name) => /^\d+_.*\.sql$/.test(name)).length;
    return check("d1-local", "ok", `${n} D1 migrations applied locally (no Cloudflare credentials)`);
  } finally {
    rmSync(persist, { recursive: true, force: true });
  }
}

async function probe(base, path, headers = {}) {
  try {
    const r = await fetch(`${base}${path}`, { headers: { "user-agent": "atteo-self-host-check", ...headers }, signal: AbortSignal.timeout(8000), redirect: "manual" });
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: r.status, json, text };
  } catch (e) {
    return { status: 0, json: null, text: e instanceof Error ? e.message : String(e) };
  }
}

export async function liveChecks(base, adminKey) {
  const out = [];
  const origin = String(base).replace(/\/+$/, "");
  const health = await probe(origin, "/health");
  out.push(
    health.status === 200 && health.json?.ok
      ? check("live-health", "ok", `${origin}/health → 200`)
      : check("live-health", "fail", `${origin}/health → ${health.status || "unreachable"} ${health.text.slice(0, 200)}`),
  );
  if (!health.status) {
    out.push(check("live-deep", "skip", "server unreachable"));
    out.push(check("live-openapi", "skip", "server unreachable"));
    out.push(check("live-card", "skip", "server unreachable"));
    out.push(check("live-ops", "skip", "server unreachable"));
    return out;
  }
  const deep = await probe(origin, "/health/deep");
  const checks = deep.json?.checks ?? {};
  const deepOk = deep.status === 200 && deep.json?.ok && checks.boards === "ok" && checks.database === "ok";
  out.push(deepOk ? check("live-deep", "ok", `/health/deep boards=${checks.boards} database=${checks.database}`) : check("live-deep", "fail", `/health/deep → ${deep.status} ${JSON.stringify(deep.json ?? deep.text).slice(0, 240)}`));

  const spec = await probe(origin, "/openapi.json");
  const serverUrl = spec.json?.servers?.[0]?.url;
  out.push(
    spec.status === 200 && spec.json?.openapi
      ? check("live-openapi", "ok", `/openapi.json server ${serverUrl ?? "(none)"}`)
      : check("live-openapi", "fail", `/openapi.json → ${spec.status}`),
  );

  const card = await probe(origin, "/.well-known/agent-card.json");
  out.push(card.status === 200 && card.json ? check("live-card", "ok", `Agent Card ${card.json.signatures ? "signed" : "unsigned (set A2A_SIGNING_KEY to sign)"}`) : check("live-card", "fail", `/.well-known/agent-card.json → ${card.status}`));

  if (adminKey) {
    const metrics = await probe(origin, "/api/ops/metrics", { "x-admin-key": adminKey });
    out.push(metrics.status === 200 ? check("live-ops", "ok", "/api/ops/metrics with ADMIN_KEY → 200") : check("live-ops", "fail", `/api/ops/metrics → ${metrics.status} (is ADMIN_KEY the one on that deployment?)`));
  } else {
    out.push(check("live-ops", "skip", "set ADMIN_KEY to probe /api/ops/metrics"));
  }
  return out;
}

export function parseArgs(argv) {
  const opts = { json: false, skipWrangler: false, skipD1: false, base: process.env.BASE || "", adminKey: process.env.ADMIN_KEY || "", help: false };
  if (process.env.JSON === "1") opts.json = true;
  if (process.env.SKIP_WRANGLER === "1") opts.skipWrangler = true;
  if (process.env.SKIP_D1 === "1") opts.skipD1 = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") opts.json = true;
    else if (a === "--skip-wrangler") opts.skipWrangler = true;
    else if (a === "--skip-d1") opts.skipD1 = true;
    else if (a === "--base") opts.base = argv[++i] ?? "";
    else if (a === "--help" || a === "-h") opts.help = true;
    else throw new Error(`unknown flag ${a} (see --help)`);
  }
  return opts;
}

export async function runChecks(opts = {}, root = ROOT) {
  const skipWrangler = !!opts.skipWrangler;
  const skipD1 = !!opts.skipD1;
  const base = (opts.base || "").replace(/\/+$/, "");
  const checks = [];
  checks.push(...staticChecks(loadTree(root)));
  checks.push(...fileChecks(root));
  if (skipWrangler) checks.push(check("wrangler-dry-run", "skip", "--skip-wrangler"));
  else checks.push(await wranglerDryRunCheck(root));
  if (skipD1) checks.push(check("d1-local", "skip", "--skip-d1"));
  else checks.push(await d1LocalCheck(root));
  if (base) checks.push(...(await liveChecks(base, opts.adminKey)));
  else {
    checks.push(check("live", "skip", "set BASE=https://<your-site> to probe a deployed copy (needs that account's secrets)"));
  }
  return checks;
}

export function summarize(checks) {
  const ok = checks.filter((c) => c.status === "ok").length;
  const fail = checks.filter((c) => c.status === "fail").length;
  const skip = checks.filter((c) => c.status === "skip").length;
  return { ok, fail, skip, passed: fail === 0 };
}

export function reportJson(checks) {
  const s = summarize(checks);
  return { ok: s.passed, okCount: s.ok, failed: s.fail, skipped: s.skip, checks };
}

export function formatReport(checks) {
  const lines = [];
  const width = Math.max(...checks.map((c) => c.id.length));
  for (const c of checks) {
    const mark = c.status === "ok" ? "ok  " : c.status === "skip" ? "skip" : "FAIL";
    lines.push(`${mark}  ${c.id.padEnd(width)}  ${c.detail}`);
  }
  const s = summarize(checks);
  lines.push("");
  lines.push(`self-host-check: ${s.passed ? "passed" : "FAILED"} (${s.ok} ok, ${s.fail} failed, ${s.skip} skipped)`);
  return lines.join("\n");
}

const HELP = `Self-host / second-account checklist. No Cloudflare credentials in the default (CI) path.

  node scripts/self-host-check.mjs
  node scripts/self-host-check.mjs --skip-wrangler --skip-d1
  BASE=https://<your-site> ADMIN_KEY=… node scripts/self-host-check.mjs
  node scripts/self-host-check.mjs --json

  --skip-wrangler   docs + config only (no wrangler deploy --dry-run)
  --skip-d1         skip local D1 migrations apply
  --base <url>      probe /health on a deployed copy (or set BASE)
  --json            print {ok, checks} instead of the table
`;

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(HELP);
    return 0;
  }
  const checks = await runChecks(opts);
  const s = summarize(checks);
  if (opts.json) console.log(JSON.stringify(reportJson(checks), null, 2));
  else {
    console.log(opts.base ? `self-host check (live ${opts.base.replace(/\/+$/, "")})\n` : "self-host check (dry-run; no Cloudflare credentials)\n");
    console.log(formatReport(checks));
  }
  return s.passed ? 0 : 1;
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === thisFile) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof Error ? e.stack : e);
      process.exit(1);
    },
  );
}
