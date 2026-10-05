#!/usr/bin/env node
// Runs the browser checks (test/browser/checks.json) against a LOCAL Worker: PAR at a time, longest first, each check in
// its own node process. By default the checks share a couple of already-running Chromiums (lib/shim.mjs gives each check
// its own contexts); a check that fails is retried once, alone and with its own browser, before it counts as a failure.
// Prints one line per check as it finishes, then a summary; exits 1 if any check failed (2 if the server isn't up).
// A check that can't run here (a missing dev dependency) exits 3 with a last line "SKIP: <reason>": listed as skipped
// with its reason, not retried, not a failure.
//
//   node test/browser/run.mjs [check ...]        # or: npm run test:browser
//   node test/browser/run.mjs --changed [base]   # only the checks the files changed since base (origin/main) need,
//                                                # per checks-map.json; a file no rule narrows runs everything
//   node test/browser/run.mjs --changed --list   # print that selection and exit
//
// Env: BASE (default http://localhost:8787; must be a local server) · PW_CHROME (Chromium executable; default: the one
//   playwright-core installed) · PAR (default 8) · SHARD=i/n (run the i-th of n balanced slices, 1-based) · ONLY="a b"
//   · SHARED=0 (a fresh Chromium per check) · BROWSERS (shared Chromiums, default 3) · RETRY=0 (no retry) · RETRY_PAR (retries at once, each with its own Chromium; default 4) · TIMEOUT per
//   check in s (default 240; on the first pass a check is stopped at 4x its checks.json time, at least 60s, and retried alone) · SHOTS_DIR (screenshots, logs and failed.txt; default <os tmp>/atteo-browser-shots)
//   · ADMIN_KEY (default ci-admin-key, as in CI's .dev.vars) · PERSIST (the server's `wrangler dev --persist-to` dir, so
//   checks that write to local D1 directly, live and e2e-web, reach the server's database; unset = the default .wrangler).
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync, closeSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const DIR = dirname(fileURLToPath(import.meta.url)), ROOT = join(DIR, "../..");
const BASE = (process.env.BASE || "http://localhost:8787").replace(/\/$/, "");
const SHOTS_DIR = process.env.SHOTS_DIR || join(tmpdir(), "atteo-browser-shots"), LOGS = join(SHOTS_DIR, "logs");
const PAR = Math.max(1, +(process.env.PAR || 8)), NB = Math.max(1, +(process.env.BROWSERS || 3));
const TIMEOUT = +(process.env.TIMEOUT || 240) * 1000, RETRY = process.env.RETRY !== "0", SHARED = process.env.SHARED !== "0";
const T0 = Date.now(), secs = (t) => Math.round((Date.now() - t) / 1000);

// The checks create users and boards through the operator API: never against anything but a local server.
const host = new URL(BASE).hostname;
if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(host)) { console.error(`run.mjs: BASE=${BASE} is not a local server; the browser checks only run against a local Worker.`); process.exit(2); }

const timings = JSON.parse(readFileSync(join(DIR, "checks.json"), "utf8"));
const all = Object.keys(timings);
const argv = process.argv.slice(2), ci = argv.indexOf("--changed"), li = argv.indexOf("--list");
const LIST_ONLY = li >= 0; if (LIST_ONLY) argv.splice(li, 1);
// --changed [base]: only the checks the files changed since <base> (default origin/main) need, per checks-map.json.
let changedBase = null;
if (ci >= 0) { changedBase = argv[ci + 1] && !argv[ci + 1].startsWith("-") && !Object.hasOwn(timings, argv[ci + 1]) ? argv.splice(ci, 2)[1] : (argv.splice(ci, 1), "origin/main"); }
const asked = [...argv, ...(process.env.ONLY || "").split(/\s+/)].filter(Boolean);
for (const t of asked) if (!Object.hasOwn(timings, t)) { console.error(`run.mjs: no check named ${t}`); process.exit(2); }
let list = asked.length ? asked : all;
if (changedBase) {
  const { execFileSync } = await import("node:child_process");
  const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8" });
  const files = [...new Set([...git("diff", "--name-only", `${changedBase}...HEAD`).split("\n"), ...git("diff", "--name-only", "HEAD").split("\n")].filter(Boolean))];
  const { checksFor } = await import("./lib/changed.mjs");
  const pick = checksFor(files, JSON.parse(readFileSync(join(DIR, "checks-map.json"), "utf8")).rules, all);
  list = pick === "*" ? list : list.filter((t) => pick.has(t));
  console.log(`--changed ${changedBase}: ${files.length} file${files.length === 1 ? "" : "s"} → ${pick === "*" ? "every check (a file no rule narrows)" : `${list.length} check${list.length === 1 ? "" : "s"}`}`);
  if (!list.length) { console.log("no browser checks needed"); process.exit(0); }
}
if (LIST_ONLY) { console.log(list.join(" ")); process.exit(0); }


// SHARD=i/n: deal the checks (longest first) to whichever of n slices has the least work so far, so slices take about
// as long as each other; deterministic, so every job agrees on the split.
if (process.env.SHARD) {
  const m = process.env.SHARD.match(/^(\d+)\/(\d+)$/);
  if (!m || +m[1] < 1 || +m[1] > +m[2]) { console.error(`run.mjs: SHARD must look like 2/4, got ${process.env.SHARD}`); process.exit(2); }
  const [i, n] = [+m[1], +m[2]], load = Array(n).fill(0), mine = new Set();
  for (const t of [...list].sort((a, b) => timings[b] - timings[a] || a.localeCompare(b))) {
    const k = load.indexOf(Math.min(...load)); load[k] += timings[t]; if (k === i - 1) mine.add(t);
  }
  list = list.filter((t) => mine.has(t));
}

try { const r = await fetch(`${BASE}/health`); if (!r.ok) throw new Error(`HTTP ${r.status}`); }
catch (e) { console.error(`run.mjs: no server at ${BASE} (${e.message}). Start one: npx wrangler dev (see docs/ci.md).`); process.exit(2); }
if (list.includes("e2e-web") && !existsSync(join(ROOT, "cli/dist/agent-soup.mjs"))) console.error("run.mjs: e2e-web needs the CLI: run npm run build:cli first.");

mkdirSync(LOGS, { recursive: true });
const require = createRequire(join(DIR, "run.mjs"));
const { chromium } = require("playwright-core");
const EXE = process.env.PW_CHROME || chromium.executablePath();
if (!existsSync(EXE)) { console.error(`run.mjs: no Chromium at ${EXE}. Install one (npx playwright-core install chromium) or set PW_CHROME.`); process.exit(2); }

let shared = null;
if (SHARED && list.length > 1) {
  const opts = { executablePath: process.env.PW_CHROME || undefined };
  const servers = await Promise.all([...Array(NB)].map(() => chromium.launchServer(opts)));
  const sb = await chromium.launchServer({ ...opts, ignoreDefaultArgs: ["--hide-scrollbars"] });
  shared = { servers, sb, close: () => Promise.allSettled([...servers, sb].map((s) => s.close())) };
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => { await shared.close(); process.exit(130); });
}

// A check that reads the clipboard (in the file or a ./ module it imports) never runs beside another one in a shared
// browser: a browser's clipboard is shared by its contexts.
const usesClipboard = (t) => {
  const f = join(DIR, `${t}.mjs`), src = readFileSync(f, "utf8"); let text = src;
  for (const m of src.matchAll(/(?:from |import\()\s*["'](\.\.?\/[^"']+)["']/g)) { const g = join(dirname(f), m[1]); if (existsSync(g)) text += readFileSync(g, "utf8"); }
  return /clipboard/i.test(text.replace(/ClipboardEvent|clipboardData/g, ""));
};

const passed = (last) => /passed|all scripts parse/.test(last) && !/FAIL/.test(last);
// One check in a child node process; its output goes to logs/<check>.log and its last line is the verdict.
// A check gets 4x its recorded time (at least 60s) before it counts as stalled; a retry alone gets the full TIMEOUT.
const limitFor = (t, alone) => alone ? TIMEOUT : Math.min(TIMEOUT, Math.max(60, 4 * (timings[t] || 15)) * 1000);
const run1 = (t, slot, useShared) => new Promise((resolve) => {
  const f = join(DIR, `${t}.mjs`), s = Date.now(), log = join(LOGS, `${t}${useShared ? "" : ".alone"}.log`);
  const env = { ...process.env, BASE, SHOTS_DIR };
  // Older checks were written for Developer mode (lib/devmode.mjs makes the people they create start there); a check whose
  // header says "// gate: everyday" tests Everyday and runs without it, as the gate does.
  const everyday = /^\/\/ gate: everyday/m.test(readFileSync(f, "utf8"));
  // Every check retries wrangler dev's dropped requests once, its own and its pages' (lib/proxyretry.mjs, #3808).
  const imports = [`--import=${pathToFileURL(join(DIR, "lib/proxyretry.mjs"))}`];
  if (!everyday) imports.push(`--import=${pathToFileURL(join(DIR, "lib/devmode.mjs"))}`);
  env.BROWSER_CHECK = f;
  if (useShared) {
    imports.push(`--import=${pathToFileURL(join(DIR, "lib/shim.mjs"))}`);
    Object.assign(env, { BROWSER_SHIM_MAIN: f, BROWSER_SHIM_EXE: EXE, BROWSER_SHIM_WS: JSON.stringify({ default: shared.servers[slot % NB].wsEndpoint(), scrollbars: shared.sb.wsEndpoint() }) });
  }
  env.NODE_OPTIONS = [process.env.NODE_OPTIONS || "", ...imports].join(" ").trim();
  const fd = openSync(log, "w");
  const p = spawn(process.execPath, [f], { cwd: SHOTS_DIR, env, stdio: ["ignore", fd, fd] });
  let timedOut = false;
  const limit = limitFor(t, !useShared);
  const timer = setTimeout(() => { timedOut = true; p.kill("SIGKILL"); }, limit);
  p.on("close", (code) => {
    clearTimeout(timer); closeSync(fd);
    const lines = readFileSync(log, "utf8").split("\n").map((l) => l.trimEnd()).filter(Boolean);
    let last = lines.at(-1) ?? `(no output, exit ${code})`;
    if (timedOut) last = `timed out after ${limit / 1000}s (last: ${last})`;
    resolve({ t, last, secs: secs(s), ok: !timedOut && code === 0 && passed(last), skipped: !timedOut && code === 3 && /^SKIP: /.test(last) });
  });
});
const line = (r, note = "") => console.log(`${r.ok ? "ok  " : r.skipped ? "skip" : "FAIL"} ${r.t}: ${r.last} (${r.secs}s${note})`);

console.log(`browser checks: ${list.length}${process.env.SHARD ? ` (shard ${process.env.SHARD})` : ""} against ${BASE}, PAR=${PAR}, ${shared ? `${NB}+1 shared Chromiums` : "a Chromium per check"}; logs and screenshots in ${SHOTS_DIR}`);
const queue = [...list].sort((a, b) => timings[b] - timings[a]);
const clip = new Set(shared ? list.filter(usesClipboard) : []);
const results = {}; let clipBusy = false; const waiters = [];
const next = () => { const i = queue.findIndex((t) => !(clip.has(t) && clipBusy)); return i < 0 ? null : queue.splice(i, 1)[0]; };
await Promise.all(Array.from({ length: Math.min(PAR, list.length) }, async (_, slot) => {
  for (;;) {
    let t = next();
    while (!t && queue.length) { await new Promise((r) => waiters.push(r)); t = next(); }
    if (!t) return;
    const c = clip.has(t); if (c) clipBusy = true;
    const r = results[t] = await run1(t, slot, !!shared);
    if (c) { clipBusy = false; waiters.splice(0).forEach((w) => w()); }
    if (r.ok || r.skipped || !RETRY) line(r); else console.log(`.... ${t}: ${r.last} (${r.secs}s; will retry alone)`);
  }
}));
const firstPass = secs(T0);
if (shared) await shared.close();

const failed1 = list.filter((t) => !results[t].ok && !results[t].skipped);
if (RETRY && failed1.length) {
  // Each retry gets its own Chromium (not the shared ones), RETRY_PAR at a time: one by one, a dozen flaky checks cost minutes.
  const RETRY_PAR = Math.max(1, +(process.env.RETRY_PAR || 4)), again = [...failed1];
  console.log(`retrying alone (${Math.min(RETRY_PAR, again.length)} at a time): ${failed1.join(" ")}`);
  await Promise.all(Array.from({ length: Math.min(RETRY_PAR, again.length) }, async () => {
    for (let t; (t = again.shift()); ) { const r = await run1(t, 0, false); results[t] = { ...r, retried: true }; line(r, r.ok ? "; passed on retry alone" : "; failed again alone"); }
  }));
}

const skipped = list.filter((t) => results[t].skipped);
const failed = list.filter((t) => !results[t].ok && !results[t].skipped), flaky = list.filter((t) => results[t].ok && results[t].retried);
writeFileSync(join(SHOTS_DIR, "failed.txt"), failed.map((t) => t + "\n").join(""));
console.log(`\n${list.length - failed.length - skipped.length}/${list.length} browser checks passed${flaky.length ? ` (${flaky.length} only on retry: ${flaky.join(" ")})` : ""}${skipped.length ? `, ${skipped.length} skipped` : ""}; first pass ${firstPass}s, total ${secs(T0)}s`);
for (const t of skipped) console.log(`  skipped ${t}: ${results[t].last.replace(/^SKIP: /, "")}`);
if (failed.length) { console.log(`FAILED: ${failed.join(" ")}  (logs: ${LOGS})`); for (const t of failed) console.log(`  ${t}: ${results[t].last}`); }
process.exit(failed.length ? 1 : 0);
