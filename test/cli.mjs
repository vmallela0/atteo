// CLI integration test: runs the built CLI (cli/dist/agent-soup.mjs) against a server.
// Usage: npm run build:cli && BASE=http://localhost:8787 ADMIN_KEY=... node test/cli.mjs

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = (process.env.BASE ?? "http://localhost:8787").replace(/\/$/, "");
const ADMIN_KEY = process.env.ADMIN_KEY ?? readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").match(/^ADMIN_KEY=(.*)$/m)?.[1];
const CLI = new URL("../cli/dist/agent-soup.mjs", import.meta.url).pathname;
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
// Remote servers take longer to open the watcher's live sockets than a local one.
const SETTLE = /localhost|127\.0\.0\.1/.test(BASE) ? 800 : 3000;

async function ops(path, body) {
  const r = await fetch(`${BASE}/api/ops/${path}`, { method: "POST", headers: { "x-admin-key": ADMIN_KEY, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`ops ${path}: HTTP ${r.status}`);
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

/** Runs `agent-soup mcp` and talks JSON-RPC to it over stdio. */
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
// Without test logins every later step would fall back to the real login in the keychain. Never run them that way.
if (!credA || !tokA) {
  console.log("Setup failed (is ADMIN_KEY the key for this server?); stopping before anything runs as a real user.");
  process.exit(1);
}

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
  await sleep(SETTLE); // let the watcher's live connections open before posting // live socket connects
  await tool(tokB, board, "read", {});
  const posted = await tool(tokB, board, "post", { type: "question", to: A, text: "Which port does the API use?" });
  for (let t = 0; t < 80 && !m.lines.some((l) => l.method === "notifications/claude/channel"); t++) await sleep(50);
  const n = m.lines.find((l) => l.method === "notifications/claude/channel");
  assert(n, `no channel notice; got ${JSON.stringify(m.lines.slice(-3))} after ${posted}`);
  assert(n.params.content.includes(`${B}'s agent posted a question to you`) && !n.params.content.includes("Which port"), n.params.content);
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
  await sleep(SETTLE); // let the watcher's live connections open before posting
  await tool(tokB, board, "read", {});
  const posted = await tool(tokB, board, "post", { type: "question", to: A, text: "Can you check the retry limit?" });
  const seq = posted.match(/#(\d+)/)[1];
  for (let t = 0; t < 100 && !existsSync(marker); t++) await sleep(100);
  w.kill();
  assert(existsSync(marker), `agent was not started. watch output:\n${out}`);
  const argv = readFileSync(marker, "utf8");
  assert(argv.includes(`entry #${seq}`) && argv.includes("--allowedTools") && argv.includes("mcp__board__post") && !argv.includes("Bash"), argv);
  assert(argv.includes(`CWD=${realpathSync(projDir)}`), `should answer from the board's own folder:\n${argv}`);
  assert(out.includes(`${B}'s agent posted a question to you`), out);
});

await step("watch: '@you' notifies you; '@you's agent' starts your agent, even when you wrote it on the web", async () => {
  const marker = join(dir, "claude-mention.txt");
  const stub = join(dir, "fake-claude-mention.sh");
  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > "${marker}"\necho "answered"\n`);
  chmodSync(stub, 0o755);
  const w = spawn("node", [CLI, "watch", "--respond", "--quiet", "--dir", dir, "--server", BASE], {
    // Own config folder: never collide with a real background watcher on this machine (one watcher per config).
    env: { ...process.env, AGENT_BOARD_CREDENTIALS_FILE: credA, AGENT_BOARD_CLAUDE_BIN: stub, XDG_CONFIG_HOME: join(dir, "cfg-mentions") },
  });
  let out = "";
  w.stdout.on("data", (d) => (out += d));
  w.stderr.on("data", (d) => (out += d));
  for (let t = 0; t < 60 && !out.includes("Watching"); t++) await sleep(100);
  await sleep(SETTLE); // let the watcher's live connections open before posting
  await tool(tokB, board, "read", {});
  await tool(tokB, board, "post", { type: "question", text: `@${A} can you approve the deploy?` });
  for (let t = 0; t < 60 && !out.includes(`${B}'s agent posted a question mentioning you`); t++) await sleep(100);
  await sleep(1000);
  assert(out.includes(`${B}'s agent posted a question mentioning you`), out);
  assert(!existsSync(marker), "a mention of the person must not start their agent");
  const cookieA = (await ops("sessions", { user: A })).cookie;
  const r = await fetch(`${BASE}/api/boards/${board}/entries`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: cookieA },
    body: JSON.stringify({ type: "task", text: `@${A}'s agent rerun the flaky test` }),
  });
  assert(r.status === 201, `web post ${r.status}`);
  const seq = (await r.json()).entry.seq;
  for (let t = 0; t < 100 && !existsSync(marker); t++) await sleep(100);
  w.kill();
  assert(existsSync(marker), `agent was not started. watch output:\n${out}`);
  const argv = readFileSync(marker, "utf8");
  assert(argv.includes(`your user (${A}) handed you a task`) && argv.includes(`entry #${seq}`), argv);
  assert(out.includes(`You posted a task mentioning your agent`), out);
});

// Board commands: run the CLI like a person or a shell-only agent would.
function cli(args, { cred = credA, cwd = dir, input, env = {} } = {}) {
  return new Promise((resolve) => {
    const p = spawn("node", [CLI, ...args], { cwd, env: { ...process.env, AGENT_BOARD_CREDENTIALS_FILE: cred, AGENT_BOARD_SERVER: BASE, XDG_CONFIG_HOME: join(dir, "cfg-cmds"), ...env } });
    let out = "";
    let errOut = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (errOut += d));
    if (input != null) p.stdin.end(input);
    else p.stdin.end();
    p.on("close", (code) => resolve({ code, out, err: errOut }));
  });
}

await step("board commands: use, post, read, ask (waits for the answer), search, share, task, doc grep, local secret filter", async () => {
  const proj = join(dir, "proj");
  (await import("node:fs")).mkdirSync(join(proj, "sub"), { recursive: true });
  let r = await cli(["read"], { cwd: proj });
  assert(r.code === 1 && r.err.includes("No board chosen"), r.err);
  r = await cli(["use", board], { cwd: proj });
  assert(r.code === 0 && r.out.includes(`e2e cli ${run}`), r.out + r.err);
  r = await cli(["use"], { cwd: join(proj, "sub") }); // inherited by subfolders
  assert(r.out.includes(board), r.out);
  r = await cli(["read"], { cwd: proj });
  assert(r.code === 0 && r.out.includes("Members:"), r.out + r.err);
  r = await cli(["post", "hello from the cli", run], { cwd: proj });
  assert(r.code === 0 && /Posted #\d+/.test(r.out), r.out + r.err);
  r = await cli(["post", "-"], { cwd: proj, input: `piped text ${run}` });
  assert(r.code === 0, r.out + r.err);
  // B posts; A's stale post is refused with exit code 2 and what was missed.
  await tool(tokB, board, "read", {});
  await tool(tokB, board, "post", { type: "note", text: `B was here ${run}` });
  r = await cli(["post", "talking over B"], { cwd: proj });
  assert(r.code === 2 && r.err.includes(`B was here ${run}`), `${r.code} ${r.err}`);
  // ask: B's agent answers while A waits.
  const asking = cli(["ask", B, `which port ${run}?`, "--wait", "40"], { cwd: proj });
  let q = 0;
  for (let i = 0; i < 40 && !q; i++) {
    await sleep(300);
    const s = await tool(tokB, board, "search", { query: `which port ${run}` });
    q = Number(s.match(/#(\d+) question/)?.[1] ?? 0);
  }
  assert(q, "question posted");
  await tool(tokB, board, "read", {});
  await tool(tokB, board, "post", { type: "note", reply_to: q, text: `port 8443 ${run}` });
  r = await asking;
  assert(r.code === 0 && r.out.includes(`port 8443 ${run}`), r.out + r.err);
  r = await cli(["search", "piped", "text", run], { cwd: proj });
  assert(r.out.includes(`piped text ${run}`), r.out);
  const file = join(dir, `notes-${run}.md`);
  writeFileSync(file, `# notes\nTODO ship ${run}\n`);
  await cli(["read"], { cwd: proj });
  r = await cli(["share", file, "--note", "my notes"], { cwd: proj });
  assert(r.code === 0, r.out + r.err);
  r = await cli(["doc", "grep", "todo"], { cwd: proj });
  assert(r.out.includes(`notes-${run}.md:2: TODO ship ${run}`), r.out + r.err);
  await cli(["read"], { cwd: proj });
  const t = (await cli(["post", "--type", "task", `write docs ${run}`], { cwd: proj })).out.match(/#(\d+)/)[1];
  r = await cli(["task", "claim", t], { cwd: proj });
  assert(r.out.includes(`#${t} [doing]`), r.out + r.err);
  r = await cli(["task", "done", t, "shipped"], { cwd: proj });
  assert(r.out.includes(`#${t} [done]`), r.out + r.err);
  // Secrets never leave the machine.
  const fake = ["ghp", "_", "Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Jh1Gf0Ed9Cb8A"].join("");
  r = await cli(["post", `token ${fake}`], { cwd: proj });
  assert(r.code === 1 && r.err.includes("nothing was sent"), r.err);
});

await step("card: a change card from local git (commits, files incl. new ones, diff), secrets kept out, posted as a change", async () => {
  const repo = mkdtempSync(join(tmpdir(), "agent-board-card-"));
  const genv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
  const g = (...a) => execFileSync("git", a, { cwd: repo, env: genv, stdio: "pipe" }).toString();
  g("init", "-q", "-b", "main");
  writeFileSync(join(repo, "checkout.js"), "function charge(cart) {\n  return pay(cart.payment);\n}\n");
  g("add", "."); g("commit", "-qm", "start");
  g("switch", "-qc", "fix/empty-cart");
  writeFileSync(join(repo, "checkout.js"), "function charge(cart) {\n  if (!cart.items.length) return null;\n  return pay(cart.payment);\n}\n");
  g("commit", "-qam", "Guard empty carts");
  writeFileSync(join(repo, "notes.md"), "one\ntwo\n"); // not committed, not tracked
  let r = await cli(["card", "--no-gh"], { cwd: repo });
  assert(r.code === 0, r.err);
  const c = JSON.parse(r.out);
  assert(c.branch === "fix/empty-cart" && c.base === "main" && c.ci === "none", r.out);
  assert(c.commits.length === 1 && c.commits[0].title === "Guard empty carts", JSON.stringify(c.commits));
  const f = Object.fromEntries(c.files.map((x) => [x.path, x]));
  assert(f["checkout.js"]?.added === 1 && f["checkout.js"].removed === 0 && f["notes.md"]?.added === 2, JSON.stringify(c.files));
  assert(c.diff.includes("+  if (!cart.items.length) return null;") && c.diff.includes("+++ b/notes.md"), c.diff);
  assert(r.err.includes("fix/empty-cart → main · 1 commit · 2 files +3 −0"), r.err);
  // A credential in the diff: the diff is left out (and never printed); the card still works.
  const fake = ["ghp", "_", "Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Jh1Gf0Ed9Cb8A"].join("");
  writeFileSync(join(repo, ".env.local"), `TOKEN=${fake}\n`);
  r = await cli(["card", "--no-gh"], { cwd: repo });
  assert(r.code === 0 && !r.out.includes(fake) && !r.err.includes(fake) && !("diff" in JSON.parse(r.out)) && r.err.includes("diff left out"), r.err + r.out);
  // Post it to the board, asking B for a review.
  r = await cli(["use", board], { cwd: repo });
  assert(r.code === 0, r.err);
  r = await cli(["card", "--no-gh", "--no-diff", "--post", "Guard empty carts in charge()", "--to", B], { cwd: repo });
  assert(r.code === 0 && /Posted #\d+/.test(r.out), r.err + r.out);
  const seq = Number(r.out.match(/Posted #(\d+)/)[1]);
  const got = await tool(tokB, board, "get", { seq });
  assert(got.includes("Change: fix/empty-cart → main · 1 commit") && got.includes("Guard empty carts"), got);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
