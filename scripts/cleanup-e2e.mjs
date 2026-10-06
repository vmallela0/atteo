#!/usr/bin/env node
// List or delete leftover e2e/test accounts through the operator API.
// Dry-run by default. Never deletes WorkOS users, operators, or Stripe customers.
// This agent (and CI) must not pass --allow-production; a person reviews the list first.
//
//   ADMIN_KEY=… BASE=http://localhost:8787 node scripts/cleanup-e2e.mjs
//   node scripts/cleanup-e2e.mjs list
//   node scripts/cleanup-e2e.mjs delete              # dry-run
//   node scripts/cleanup-e2e.mjs delete --yes        # local only, after a dry-run
//   node scripts/cleanup-e2e.mjs delete --yes --allow-production --names e2e-a,foo-test
//
// --remote in the shell wrapper sets BASE=https://atteo.dev (still a dry-run unless --yes
// and --allow-production). ADMIN_KEY may come from the environment or .dev.vars (never printed).

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { stdin as input, stdout as output } from "node:process";

const DELETE_CONFIRM = "DELETE TEST ACCOUNTS";
const HELP = `List or delete leftover e2e/test accounts (e2e-*, *-test, test-N).

WorkOS sign-ups, operators (OPERATORS), and Stripe customers are never selected.

Usage:
  node scripts/cleanup-e2e.mjs [list|delete] [options]

Options:
  --base URL              default BASE, else http://localhost:8787
  --names a,b             only these handles (still must match the test-account rules)
  --dry-run               delete previews what would go (the default)
  --yes                   skip the TTY prompt; still requires ${DELETE_CONFIRM} on the server
  --allow-production      required when BASE is not localhost
  --json                  print the API body
  -h, --help

Environment: ADMIN_KEY (or .dev.vars), BASE.

Deletes do nothing unless you send confirm=${DELETE_CONFIRM} (the CLI does that only after
a dry-run review, --yes, and --allow-production on a non-local BASE).`;

const args = process.argv.slice(2);
const flags = new Set();
const opt = {};
const pos = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "-h" || a === "--help") {
    flags.add("help");
    continue;
  }
  if (a.startsWith("--")) {
    const key = a.slice(2);
    if (["yes", "json", "dry-run", "allow-production", "help"].includes(key)) flags.add(key);
    else opt[key] = args[++i];
  } else pos.push(a);
}

if (flags.has("help")) {
  console.log(HELP);
  process.exit(0);
}

const cmd = (pos[0] ?? "list").toLowerCase();
if (pos.length > 1 || !["list", "delete"].includes(cmd)) {
  console.error(HELP);
  process.exit(2);
}

function readAdminKey() {
  if (process.env.ADMIN_KEY) return process.env.ADMIN_KEY;
  try {
    return readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").match(/^ADMIN_KEY\s*=\s*["']?([^\r\n"']+)/m)?.[1];
  } catch {
    return "";
  }
}

function isLocal(base) {
  try {
    const h = new URL(base).hostname;
    return /^(localhost|.+\.localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1?\])$/i.test(h);
  } catch {
    return false;
  }
}

const BASE = (opt.base || process.env.BASE || "http://localhost:8787").replace(/\/$/, "");
const KEY = readAdminKey();
if (!KEY) {
  console.error("ADMIN_KEY is required (environment or .dev.vars).");
  process.exit(2);
}

async function call(method, body) {
  const r = await fetch(`${BASE}/api/ops/test-accounts`, {
    method,
    headers: { "x-admin-key": KEY, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { error: text.slice(0, 200) };
  }
  return { status: r.status, body: json };
}

function printPreview(body) {
  const users = body.users ?? [];
  const boards = body.boards ?? [];
  const skipped = body.skipped ?? [];
  if (!users.length && !boards.length) {
    console.log(`No deletable test accounts on ${BASE}.`);
  } else {
    console.log(`${users.length} test account(s) on ${BASE}:`);
    for (const u of users) {
      const when = u.first_seen ? new Date(u.first_seen).toISOString().slice(0, 10) : "?";
      console.log(`  ${u.name.padEnd(28)} ${u.kind.padEnd(12)} boards=${u.boards} since=${when} ${u.email ?? ""}`);
    }
    if (boards.length) {
      console.log(`${boards.length} e2e-titled board(s) solely owned by those accounts:`);
      for (const b of boards) console.log(`  ${b.id}  ${b.title}  (${(b.members ?? []).join(", ") || "no members"})`);
    }
  }
  if (skipped.length) {
    console.log(`${skipped.length} matched a test name but were skipped (real users stay):`);
    for (const s of skipped) console.log(`  ${s.name}  (${s.reason})`);
  }
}

function ask(question) {
  if (!input.isTTY) return Promise.resolve("");
  const rl = createInterface({ input, output });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

const names = opt.names;
const payload = names ? { names } : {};

if (cmd === "list") {
  const r = names ? await call("POST", { dry_run: true, names }) : await call("GET");
  if (r.status !== 200) {
    console.error(r.body.error ?? r.status);
    process.exit(1);
  }
  if (flags.has("json")) console.log(JSON.stringify(r.body, null, 2));
  else printPreview(r.body);
  process.exit(0);
}

// delete: always dry-run first
const dry = await call("POST", { dry_run: true, ...payload });
if (dry.status !== 200) {
  console.error(dry.body.error ?? dry.status);
  process.exit(1);
}
if (flags.has("json") && (flags.has("dry-run") || !flags.has("yes"))) {
  console.log(JSON.stringify({ ...dry.body, dry_run: true }, null, 2));
} else printPreview(dry.body);

const n = (dry.body.users ?? []).length;
const b = (dry.body.boards ?? []).length;
if (!n && !b) process.exit(0);

if (flags.has("dry-run") && !flags.has("yes")) {
  console.log("Dry-run only. Nothing was deleted.");
  process.exit(0);
}

if (!isLocal(BASE) && !flags.has("allow-production")) {
  console.error(`Refusing to delete on ${BASE}. Re-run with --allow-production after reviewing the list (a person, not an agent).`);
  process.exit(2);
}

if (!flags.has("yes")) {
  if (!input.isTTY) {
    console.error("Not a TTY. Review the dry-run, then pass --yes to delete.");
    process.exit(2);
  }
  const typed = (await ask(`Type ${DELETE_CONFIRM} to delete ${n} account(s) and ${b} board(s) from ${BASE}: `)).trim();
  if (typed !== DELETE_CONFIRM) {
    console.error("Not deleted.");
    process.exit(2);
  }
}

const gone = await call("POST", { confirm: DELETE_CONFIRM, ...payload });
if (gone.status !== 200) {
  console.error(gone.body.error ?? gone.status);
  process.exit(1);
}
if (flags.has("json")) console.log(JSON.stringify(gone.body, null, 2));
else {
  console.log(`Deleted ${(gone.body.deleted ?? []).length} account(s), ${(gone.body.deleted_boards ?? []).length} board(s).`);
  for (const name of gone.body.deleted ?? []) console.log(`  ${name}`);
}
