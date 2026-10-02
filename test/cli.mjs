// CLI integration test: runs the built CLI (cli/dist/agent-board.mjs) against a server.
// Usage: npm run build:cli && BASE=http://localhost:8787 ADMIN_KEY=... node test/cli.mjs

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = (process.env.BASE ?? "http://localhost:8787").replace(/\/$/, "");
const ADMIN_KEY = process.env.ADMIN_KEY ?? readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").match(/^ADMIN_KEY=(.*)$/m)?.[1];
const CLI = new URL("../cli/dist/agent-board.mjs", import.meta.url).pathname;
const run = Date.now().toString(36).slice(-5);
const A = `e2e-cli-a-${run}`;
const B = `e2e-cli-b-${run}`;
const dir = mkdtempSync(join(tmpdir(), "agent-board-cli-"));

let passed = 0;
let failed = 0;
async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${e?.message ?? e}`);
  }
}
const assert = (c, m) => {
  if (!c) throw new Error(m);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ops(path, body) {
  const r = await fetch(`${BASE}/api/ops/${path}`, { method: "POST", headers: { "x-admin-key": ADMIN_KEY, "content-type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}
let rid = 0;
async function tool(token, board, name, args) {
  const r = await fetch(`${BASE}/mcp?board=${board}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rid, method: "tools/call", params: { name, arguments: args } }),
  });
  return (await r.json()).result.content[0].text;
}

/** Runs `agent-board mcp` and talks JSON-RPC to it over stdio. */
function startMcp(credFile, env = {}) {
  const p = spawn("node", [CLI, "mcp", "--server", BASE], { env: { ...process.env, AGENT_BOARD_CREDENTIALS_FILE: credFile, ...env } });
  const lines = [];
  let buf = "";
  p.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      lines.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
  let id = 0;
  const call = async (method, params) => {
    const my = ++id;
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: my, method, params }) + "\n");
    for (let t = 0; t < 200; t++) {
      const hit = lines.find((l) => l.id === my);
      if (hit) return hit;
      await sleep(50);
    }
    throw new Error(`no response to ${method}`);
  };
  return { p, lines, call, stop: () => p.stdin.end() };
}

console.log(`CLI test against ${BASE}`);
let board, tokA, tokB, credA, credB;

await step("setup", async () => {
  for (const u of [A, B]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true" });
  tokA = (await ops("tokens", { user: A })).token;
  tokB = (await ops("tokens", { user: B })).token;
  board = (await ops("boards", { user: A, title: `e2e cli ${run}` })).board.id;
  await ops("members", { board, user: B });
  credA = join(dir, "a.json");
  credB = join(dir, "b.json");
  writeFileSync(credA, JSON.stringify({ server: BASE, user: A, token: tokA, expires_at: Date.now() + 86400e3 }), { mode: 0o600 });
  writeFileSync(credB, JSON.stringify({ server: BASE, user: B, token: tokB, expires_at: Date.now() + 86400e3 }), { mode: 0o600 });
});

await step("status reads the saved login", async () => {
  const out = await new Promise((resolve) => {
    const p = spawn("node", [CLI, "status"], { env: { ...process.env, AGENT_BOARD_CREDENTIALS_FILE: credA } });
    let s = "";
    p.stderr.on("data", (d) => (s += d));
    p.on("close", () => resolve(s));
  });
  assert(out.includes(`Signed in as ${A}`), out);
});

await step("mcp: announces Claude Code Channels, joins by name, pushes a notice when someone asks you something", async () => {
  const m = startMcp(credA);
  const init = await m.call("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  assert(init.result.capabilities.experimental?.["claude/channel"], JSON.stringify(init.result.capabilities));
  const j = await m.call("tools/call", { name: "join_board", arguments: { board: `cli ${run}` } });
  assert(j.result.content[0].text.includes(`Joined "e2e cli ${run}"`), j.result.content[0].text);
  await sleep(800); // live socket connects
  await tool(tokB, board, "read", {});
  const posted = await tool(tokB, board, "post", { type: "question", to: A, text: "Which port does the API use?" });
  for (let t = 0; t < 80 && !m.lines.some((l) => l.method === "notifications/claude/channel"); t++) await sleep(50);
  const n = m.lines.find((l) => l.method === "notifications/claude/channel");
  assert(n, `no channel notice; got ${JSON.stringify(m.lines.slice(-3))} after ${posted}`);
  assert(n.params.content.includes(`${B} posted a question to you`) && !n.params.content.includes("Which port"), n.params.content);
  // Secrets are caught locally.
  const fake = ["ghp", "_", "Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Jh1Gf0Ed9Cb8A"].join("");
  await m.call("tools/call", { name: "read", arguments: {} });
  const s = await m.call("tools/call", { name: "post", arguments: { type: "note", text: `GH_TOKEN=${fake}` } });
  assert(s.result.isError && s.result.content[0].text.includes("Caught on this machine"), s.result.content[0].text);
  m.stop();
});

await step("mcp: an expired login hands the agent a sign-in link instead of failing silently", async () => {
  const expired = join(dir, "expired.json");
  writeFileSync(expired, JSON.stringify({ server: BASE, user: A, token: tokA, expires_at: Date.now() - 1000 }), { mode: 0o600 });
  const m = startMcp(expired);
  await m.call("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  const r = await m.call("tools/call", { name: "list_boards", arguments: {} });
  assert(r.result.isError && /\/device\?code=[A-Z]{4}-[A-Z]{4}/.test(r.result.content[0].text), r.result.content[0].text);
  m.stop();
});

await step("watch --respond: starts your agent when a question is addressed to you", async () => {
  const marker = join(dir, "claude-called.txt");
  const stub = join(dir, "fake-claude.sh");
  writeFileSync(stub, `#!/bin/sh\n{ echo "CWD=$(pwd)"; printf '%s\\n' "$@"; } > "${marker}"\necho "answered"\n`);
  chmodSync(stub, 0o755);
  const projDir = mkdtempSync(join(tmpdir(), "agent-board-proj-"));
  const env = { ...process.env, AGENT_BOARD_CREDENTIALS_FILE: credA, AGENT_BOARD_CLAUDE_BIN: stub, XDG_CONFIG_HOME: join(dir, "cfg") };
  const w = spawn("node", [CLI, "watch", "--respond", "--quiet", "--dir", dir, "--board-dir", `cli ${run}=${projDir}`, "--server", BASE], { env });
  let out = "";
  w.stdout.on("data", (d) => (out += d));
  w.stderr.on("data", (d) => (out += d));
  for (let t = 0; t < 60 && !out.includes("Watching"); t++) await sleep(100);
  // A second watcher on the same machine refuses to start (no double answers).
  const second = await new Promise((resolve) => {
    const p2 = spawn("node", [CLI, "watch", "--server", BASE], { env });
    let o = "";
    p2.stderr.on("data", (d) => (o += d));
    p2.on("close", () => resolve(o));
  });
  assert(second.includes("already running"), `second watcher should refuse: ${second}`);
  await sleep(800);
  await tool(tokB, board, "read", {});
  const posted = await tool(tokB, board, "post", { type: "question", to: A, text: "Can you check the retry limit?" });
  const seq = posted.match(/#(\d+)/)[1];
  for (let t = 0; t < 100 && !existsSync(marker); t++) await sleep(100);
  w.kill();
  assert(existsSync(marker), `agent was not started. watch output:\n${out}`);
  const argv = readFileSync(marker, "utf8");
  assert(argv.includes(`entry #${seq}`) && argv.includes("--allowedTools") && argv.includes("mcp__board__post") && !argv.includes("Bash"), argv);
  assert(argv.includes(`CWD=${realpathSync(projDir)}`), `should answer from the board's own folder:\n${argv}`);
  assert(out.includes(`${B} posted a question to you`), out);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
