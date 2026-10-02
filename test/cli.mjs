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
// (CI machines are slow too.)
const SETTLE = /localhost|127\.0\.0\.1/.test(BASE) && !process.env.CI ? 800 : 3000;

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
  // The notice line and the agent start race each other: wait for both before stopping the watcher.
  for (let t = 0; t < 50 && !out.includes(`${B}'s agent posted a question to you`); t++) await sleep(100);
  w.kill();
  assert(existsSync(marker), `agent was not started. watch output:\n${out}`);
  const argv = readFileSync(marker, "utf8");
  assert(argv.includes(`entry #${seq}`) && argv.includes("--allowedTools") && argv.includes("mcp__board__post") && !argv.includes("Bash"), argv);
  assert(argv.includes(`CWD=${realpathSync(projDir)}`), `should answer from the board's own folder:\n${argv}`);
  assert(out.includes(`${B}'s agent posted a question to you`), `no notice line; watch output: ${out || "(none)"}`);
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
  for (let t = 0; t < 150 && !out.includes(`${B}'s agent posted a question mentioning you`); t++) await sleep(100);
  await sleep(1000);
  assert(out.includes(`${B}'s agent posted a question mentioning you`), `no notice for the mention; watch output: ${out || "(none)"}`);
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

await step("watch --respond --agent-cmd: any agent CLI can answer, with the prompt as one argument", async () => {
  const marker = join(dir, "custom-agent.txt");
  const stub = join(dir, "my-agent.sh");
  writeFileSync(stub, `#!/bin/sh\n{ echo "ARGC=$#"; printf '%s\\n' "$@"; } > "${marker}"\necho "done"\n`);
  chmodSync(stub, 0o755);
  const env = { ...process.env, AGENT_BOARD_CREDENTIALS_FILE: credA, XDG_CONFIG_HOME: join(dir, "cfg-custom") };
  delete env.AGENT_BOARD_CLAUDE_BIN;
  const w = spawn("node", [CLI, "watch", "--respond", "--quiet", "--dir", dir, "--agent-cmd", `${stub} --task {prompt} --fast`, "--server", BASE], { env });
  let out = "";
  w.stdout.on("data", (d) => (out += d));
  w.stderr.on("data", (d) => (out += d));
  for (let t = 0; t < 60 && !out.includes("Watching"); t++) await sleep(100);
  assert(out.includes("your agent (") && out.includes("my-agent.sh)"), out);
  await sleep(SETTLE);
  await tool(tokB, board, "read", {});
  const posted = await tool(tokB, board, "post", { type: "question", to: A, text: "Which region? $(whoami)" });
  const seq = posted.match(/#(\d+)/)[1];
  for (let t = 0; t < 100 && !existsSync(marker); t++) await sleep(100);
  w.kill();
  assert(existsSync(marker), `custom agent was not started:\n${out}`);
  const got = readFileSync(marker, "utf8");
  assert(got.startsWith("ARGC=3\n--task\n") && got.includes(`entry #${seq}`) && got.trimEnd().endsWith("--fast"), got);
  assert(got.includes(`agent-soup post --board ${board} --reply ${seq}`), "non-MCP agents are told how to answer with the CLI");
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
  // One commit as a card: just that commit against its parent.
  r = await cli(["card", "--commit", "HEAD", "--no-gh"], { cwd: repo });
  const one = JSON.parse(r.out);
  assert(r.code === 0 && one.commits.length === 1 && one.commits[0].title === "Guard empty carts" && one.base === null, r.out);
  assert(one.files.length === 1 && one.files[0].path === "checkout.js" && one.files[0].added === 1, JSON.stringify(one.files)); // no untracked files
});

await step("people: find, add, accept, friends with presence, ask a friend's agent on your direct board", async () => {
  const home = mkdtempSync(join(tmpdir(), "agent-soup-social-")); // no folder board here, so ask goes direct
  let r = await cli(["people", B], { cwd: home });
  assert(r.code === 0 && r.out.includes(B) && r.out.includes(`agent-soup add ${B}`), r.out + r.err);
  // Not friends yet: the first DM waits for B's OK (once) instead of going through.
  r = await cli(["ask", B, "hello?", "--wait", "0", "--dm"], { cwd: home });
  assert(r.code === 0 && r.out.includes("OK it first"), r.out + r.err);
  r = await cli(["add", B, "it's", "me"], { cwd: home });
  assert(r.code === 0 && r.out.includes("Friend request sent"), r.out + r.err);
  r = await cli(["friends"], { cwd: home, cred: credB });
  assert(r.out.includes(`${A} — "it's me"`) && r.out.includes(`agent-soup accept ${A}`), r.out);
  r = await cli(["accept", A], { cwd: home, cred: credB });
  assert(r.out.includes("friends now"), r.out + r.err);
  // A asks B's agent; B's agent answers on the direct board.
  const asking = cli(["ask", B, `what's your timezone ${run}?`, "--wait", "40", "--dm"], { cwd: home }); // --dm: this session is also on a board with B
  let dmBoard = "";
  for (let i = 0; i < 40 && !dmBoard; i++) {
    await sleep(300);
    const bl = await fetch(`${BASE}/api/me/boards`, { headers: { authorization: `Bearer ${tokB}` } }).then((x) => x.json());
    dmBoard = bl.boards.find((b) => b.title.includes("↔"))?.id ?? "";
  }
  assert(dmBoard, "direct board created");
  let q = 0;
  for (let i = 0; i < 40 && !q; i++) {
    await sleep(300);
    q = Number((await tool(tokB, dmBoard, "search", { query: `timezone ${run}` })).match(/#(\d+) /)?.[1] ?? 0);
  }
  await tool(tokB, dmBoard, "read", {});
  await tool(tokB, dmBoard, "post", { type: "note", reply_to: q, text: `UTC+1 ${run}` });
  r = await asking;
  assert(r.code === 0 && r.out.includes(`UTC+1 ${run}`), r.out + r.err);
  r = await cli(["friends"], { cwd: home });
  assert(r.out.includes(B), r.out);
});

await step("sealed secrets: only the recipient's agent can open them; the server only has ciphertext", async () => {
  const proj = mkdtempSync(join(tmpdir(), "agent-soup-seal-"));
  for (const cred of [credA, credB]) await cli(["use", board], { cwd: proj, cred });
  let r = await cli(["keys"], { cwd: proj, cred: credB }); // B's machine gets a key
  assert(r.code === 0 && r.out.includes("(this machine)"), r.out + r.err);
  const secret = `postgres://app:hunter2-${run}@db.internal:5432/prod`;
  r = await cli(["seal", B, "--note", "prod db url"], { cwd: proj, input: secret });
  assert(r.code === 0 && /Sealed #\d+/.test(r.out), r.out + r.err);
  const seq = r.out.match(/Sealed #(\d+)/)[1];
  // Nothing readable on the server: not in the post, not in search, not in the raw entry.
  const got = await tool(tokA, board, "get", { seq: Number(seq) });
  assert(got.includes("sealed secret for") && !got.includes("hunter2"), got);
  assert(!(await tool(tokA, board, "search", { query: `hunter2-${run}` })).includes(`#${seq}`), "not searchable");
  r = await cli(["unseal", seq], { cwd: proj, cred: credB });
  assert(r.code === 0 && r.out === secret, `${r.code} ${r.out} ${r.err}`);
  r = await cli(["unseal", seq], { cwd: proj }); // the sender can reopen it
  assert(r.out === secret, r.out + r.err);
  const out = join(proj, "secret.txt");
  r = await cli(["unseal", seq, "--out", out], { cwd: proj, cred: credB });
  assert(readFileSync(out, "utf8") === secret, "written to a file");
});

/** Runs the CLI in a pseudo-terminal (a person at a keyboard) and answers "y" to every [y/N] / [Y/n] prompt. */
function cliTty(args, { cred = credA, cwd = dir } = {}) {
  const py = `
import os, pty, sys, json, re, time
argv = json.loads(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)
out = b""; answered = 0; deadline = time.time() + 120
while time.time() < deadline:
    try:
        chunk = os.read(fd, 4096)
    except OSError:
        break
    if not chunk:
        break
    out += chunk
    if len(re.findall(rb"\\[(y/N|Y/n)\\]", out)) > answered:
        answered += 1
        os.write(fd, b"y\\n")
_, status = os.waitpid(pid, 0)
sys.stdout.write(out.decode("utf8", "replace"))
sys.exit(os.waitstatus_to_exitcode(status))
`;
  return new Promise((resolve) => {
    const p = spawn("python3", ["-c", py, JSON.stringify(["node", CLI, ...args])], { cwd, env: { ...process.env, AGENT_BOARD_CREDENTIALS_FILE: cred, AGENT_BOARD_SERVER: BASE, XDG_CONFIG_HOME: join(dir, "cfg-cmds") } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out }));
  });
}

await step("claim checks: the author attaches one; another member's person OKs it; it runs sandboxed (no network) in a throwaway checkout; pass verifies, fail disputes", async () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "agent-board-verify-")));
  const genv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
  const g = (...a) => execFileSync("git", a, { cwd: repo, env: genv, stdio: "pipe" }).toString();
  g("init", "-q", "-b", "main");
  writeFileSync(join(repo, "check.sh"), "test -f ok.txt && echo 'all good' && touch made-in-checkout.txt\n");
  writeFileSync(join(repo, "ok.txt"), "yes\n");
  g("add", "."); g("commit", "-qm", "start");
  const c1 = Number((await tool(tokA, board, "post", { type: "claim", text: `ok.txt exists ${run}` })).match(/#(\d+)/)[1]);
  const c2 = Number((await tool(tokA, board, "post", { type: "claim", text: `the network is reachable ${run}` })).match(/#(\d+)/)[1]);
  let r = await cli(["check", String(c1), "sh check.sh", "--board", board], { cwd: repo });
  assert(r.code === 0 && r.out.includes(`agent-soup verify ${c1}`), r.out + r.err);
  r = await cli(["check", String(c2), "curl -sS -m 5 -o /dev/null https://example.com", "--board", board], { cwd: repo });
  assert(r.code === 0, r.out + r.err);
  r = await cli(["check", String(c1), "true", "--board", board], { cwd: repo, cred: credB });
  assert(r.code === 1 && r.err.includes("Only the claim's author"), r.out + r.err);
  // Agents (no terminal) can't run someone else's command.
  r = await cli(["verify", String(c1), "--board", board], { cwd: repo, cred: credB });
  assert(r.code === 1 && r.err.includes("a person has to read it"), r.out + r.err);
  const list = await (await fetch(`${BASE}/api/boards/${board}/claims`, { headers: { authorization: `Bearer ${tokB}` } })).json();
  const head = g("rev-parse", "HEAD").trim();
  assert(list.claims.find((c) => c.seq === c1)?.check?.commit === head, JSON.stringify(list).slice(0, 300));
  if (process.platform !== "darwin") return; // the sandbox runs on macOS here; CI (Linux) has no bubblewrap
  r = await cli(["verify", "--check-sandbox"], { cwd: repo, cred: credB });
  assert(r.code === 0 && r.out.includes("The sandbox holds"), r.out + r.err);
  r = await cliTty(["verify", String(c1), "--board", board], { cwd: repo, cred: credB });
  assert(r.code === 0 && r.out.includes("$ sh check.sh") && r.out.includes("all good") && r.out.includes("Check passed") && r.out.includes("verified"), `exit ${r.code}: ${r.out.slice(-600)}`);
  assert(!existsSync(join(repo, "made-in-checkout.txt")), "the check ran in a throwaway checkout, not the repo");
  r = await cliTty(["verify", String(c2), "--board", board], { cwd: repo, cred: credB });
  assert(r.code === 0 && r.out.includes("Check failed"), r.out);
  const after = (await (await fetch(`${BASE}/api/boards/${board}/claims`, { headers: { authorization: `Bearer ${tokB}` } })).json()).claims;
  const s1 = after.find((c) => c.seq === c1), s2 = after.find((c) => c.seq === c2);
  assert(s1.status === "verified" && s1.verified_by === B && s1.evidence.length === 1, JSON.stringify(s1));
  assert(s2.status === "disputed" && /check failed/.test(s2.dispute_reason), JSON.stringify(s2));
  assert(!g("worktree", "list").includes("agent-soup-verify"), "throwaway checkouts are removed");
});

await step("end-to-end encrypted board: CLI encrypts and decrypts; the server and plain agent tools only see ciphertext", async () => {
  const projA = mkdtempSync(join(tmpdir(), "agent-soup-e2ee-a-"));
  const projB = mkdtempSync(join(tmpdir(), "agent-soup-e2ee-b-"));
  let r = await cli(["create", `e2e cli enc ${run}`, "--encrypted"], { cwd: projA });
  assert(r.code === 0 && r.out.includes("end-to-end encrypted"), r.out + r.err);
  const eb = r.out.match(/\((b_[a-z0-9]+)\)/)[1];
  await ops("members", { board: eb, user: B });
  await cli(["keys"], { cwd: projB, cred: credB });
  await cli(["use", eb], { cwd: projB, cred: credB });
  const secret = `launch codes are 0000 ${run}`;
  r = await cli(["post", secret], { cwd: projA });
  assert(r.code === 0 && r.out.includes("encrypted on this machine"), r.out + r.err);
  // The server, and agents reading through it, see only a placeholder.
  const viaServer = await tool(tokB, eb, "read", {});
  assert(viaServer.includes("END-TO-END ENCRYPTED") && !viaServer.includes("launch codes"), viaServer);
  const plain = await tool(tokB, eb, "post", { type: "note", text: "plaintext please" });
  assert(plain.includes("end-to-end encrypted"), plain);
  r = await cli(["read"], { cwd: projB, cred: credB });
  assert(r.out.includes(secret), r.out + r.err);
  r = await cli(["read"], { cwd: projB, cred: credB });
  assert(r.out.includes("Nothing new"), r.out);
  // Ask across, encrypted both ways.
  const asking = cli(["ask", A, "ready?", "--wait", "40"], { cwd: projB, cred: credB });
  let q = 0;
  for (let i = 0; i < 40 && !q; i++) {
    await sleep(500);
    const list = await fetch(`${BASE}/api/boards/${eb}/sealed?after=0`, { headers: { authorization: `Bearer ${tokA}` } }).then((x) => x.json());
    q = list.entries.find((e) => e.type === "question")?.seq ?? 0;
  }
  assert(q, "question not found");
  r = await cli(["post", "--reply", String(q), `yes, go ${run}`], { cwd: projA });
  assert(r.code === 0, r.err);
  r = await asking;
  assert(r.out.includes(`yes, go ${run}`), r.out + r.err);
});

await step("sessions: each agent is its own session (found from its process), joins boards with standard commands, sees its person's other sessions", async () => {
  // Fake agents: long-lived processes named like the agent, running agent-soup commands from their shell (as real agents do).
  const cfg = mkdtempSync(join(tmpdir(), "agent-soup-sess-"));
  const agent = (name) => {
    const f = join(cfg, name);
    writeFileSync(f, `#!/bin/bash\nwhile IFS= read -r line; do eval "node ${CLI} $line"; echo "<<rc=$?>>"; done\n`);
    chmodSync(f, 0o755);
    const p = spawn(f, [], { cwd: cfg, env: { ...process.env, AGENT_BOARD_CREDENTIALS_FILE: credA, AGENT_BOARD_SERVER: BASE, XDG_CONFIG_HOME: join(cfg, "cfg") } });
    let buf = "";
    p.stdout.on("data", (d) => (buf += d));
    p.stderr.on("data", (d) => (buf += d));
    return {
      run: async (line) => {
        buf = "";
        p.stdin.write(line + "\n");
        for (let i = 0; i < 400 && !/<<rc=\d+>>/.test(buf); i++) await sleep(50);
        const code = Number(buf.match(/<<rc=(\d+)>>/)?.[1] ?? -1);
        return { code, out: buf.replace(/<<rc=\d+>>\s*$/, "") };
      },
      stop: () => p.stdin.end(),
    };
  };
  const codex = agent("codex");
  const claude = agent("claude");
  try {
    const b2 = (await ops("boards", { user: B, title: `e2e cli sess ${run}` })).board.id; // B invites A: pending
    await fetch(`${BASE}/api/boards/${b2}/invites`, { method: "POST", headers: { authorization: `Bearer ${tokB}`, "content-type": "application/json" }, body: JSON.stringify({ to: `${A}@example.com` }) });
    let r = await codex.run(`get boards --with ${B} --json`);
    const j = JSON.parse(r.out.slice(r.out.indexOf("{"), r.out.lastIndexOf("}") + 1));
    assert(j.boards.some((x) => x.id === board) && j.invitations.some((x) => x.id === b2), r.out);
    r = await codex.run(`join ${board}`);
    assert(r.code === 0 && r.out.includes("Joined") && r.out.includes("Session codex"), r.out);
    r = await claude.run(`join "e2e cli sess ${run}"`);
    assert(r.code === 0 && r.out.includes("accepting the invitation") && r.out.includes("Session claude"), r.out);
    r = await claude.run(`join ${board}`);
    assert(r.code === 0 && r.out.includes(`"e2e cli sess ${run}", "e2e cli ${run}"`), r.out);
    r = await codex.run(`get sessions`);
    assert(/claude .*Claude Code/.test(r.out) && /codex .*Codex.*← this one/.test(r.out), r.out);
    // B asks; both sessions get it; codex answers; claude sees codex's answer, labelled
    await tool(tokB, board, "read", {});
    await tool(tokB, board, "post", { type: "question", text: `@${A}'s agent retries ${run}?` });
    r = await codex.run(`read`);
    assert(r.out.includes(`retries ${run}?`), r.out);
    assert(r.out.includes("Members:"), "the first read brings the board's summary: " + r.out.slice(0, 300));
    r = await codex.run(`read`);
    assert(!r.out.includes("Members:") && r.out.includes("(nothing new)"), "…and later reads only what's new: " + r.out.slice(0, 300));
    r = await codex.run(`read --summary`);
    assert(r.out.includes("Members:"), "--summary brings it back");
    r = await codex.run(`session status "fixing the retry tests ${run}"`);
    assert(r.code === 0 && r.out.includes(`Status: fixing the retry tests ${run}`), r.out);
    r = await claude.run(`get sessions`);
    assert(r.out.includes(`fixing the retry tests ${run}`), "other sessions see the status: " + r.out);
    r = await claude.run(`read --board ${board}`);
    assert(r.out.includes(`retries ${run}?`), "the other session still sees it: " + r.out);
    r = await codex.run(`post note "three, with backoff ${run}" --title "Retry limit"`);
    assert(r.code === 0 && /Posted #\d+/.test(r.out), r.out);
    r = await claude.run(`post note "talking over codex"`);
    assert(r.code !== 0 && r.out.includes("boards"), "claude is on two boards: it has to say which: " + r.out);
    r = await claude.run(`post note "agreed" --board ${board}`);
    assert(r.code === 2 && r.out.includes(`three, with backoff ${run}`) && r.out.includes("[codex]"), "refused until it reads codex's post: " + r.out);
    r = await claude.run(`post note "agreed ${run}" --board ${board}`);
    assert(r.code === 0, r.out);
    r = await codex.run(`wait --timeout 5`);
    assert(r.out.includes(`agreed ${run}`), r.out);
    r = await codex.run(`session rename scout`);
    assert(r.out.includes(`"scout"`), r.out);
    r = await codex.run(`leave ${board}`);
    assert(r.code === 0 && r.out.includes("no board"), r.out);
    r = await codex.run(`read`);
    assert(r.code === 1 && r.out.includes("No board chosen"), r.out);
    r = await codex.run(`help`);
    assert(r.out.includes("agent-soup get boards") && !/curl[^\n]*\|\s*sh/.test(r.out), "help is for agents, and never pipes a script into a shell");
  } finally {
    codex.stop();
    claude.stop();
  }
});

await step("harness: the agent you choose answers your DMs (a person's message starts it; another agent's reply doesn't)", async () => {
  const marker = join(dir, "dm-called.txt");
  const stub = join(dir, "dm-agent.sh");
  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" >> "${marker}"\necho "answered"\n`);
  chmodSync(stub, 0o755);
  const cfg = join(dir, "cfg-harness");
  const env = { ...process.env, AGENT_BOARD_CREDENTIALS_FILE: credA, AGENT_BOARD_SERVER: BASE, XDG_CONFIG_HOME: cfg, AGENT_SOUP_DM_GRACE_MS: "1500" };
  let r = await cli(["harness", `${stub} {prompt}`], { env: { XDG_CONFIG_HOME: cfg } });
  assert(r.code === 0 && r.out.includes("now answers with"), r.out + r.err);
  r = await cli(["harness"], { env: { XDG_CONFIG_HOME: cfg } });
  assert(r.out.includes(stub), r.out);
  const dm = (await (await fetch(`${BASE}/api/direct/${A}`, { method: "POST", headers: { authorization: `Bearer ${tokB}` } })).json()).board;
  assert(dm, "direct board");
  const w = spawn("node", [CLI, "watch", "--respond", "--quiet", "--dir", dir, "--server", BASE], { env });
  let out = "";
  w.stdout.on("data", (d) => (out += d));
  w.stderr.on("data", (d) => (out += d));
  for (let t = 0; t < 60 && !out.includes("Watching"); t++) await sleep(100);
  await sleep(SETTLE);
  const cookieB = (await ops("sessions", { user: B })).cookie;
  const post = (body) => fetch(`${BASE}/api/boards/${dm}/entries`, { method: "POST", headers: { "content-type": "application/json", cookie: cookieB }, body: JSON.stringify(body) });
  assert((await post({ text: `hey, free for a quick look at the deploy? ${run}` })).status === 201, "B's DM");
  for (let t = 0; t < 100 && !existsSync(marker); t++) await sleep(100);
  // B's agent replying (a plain note from an agent) must not start another run.
  await tool(tokB, dm, "read", {});
  await tool(tokB, dm, "post", { type: "note", text: `my agent's follow-up ${run}` });
  // A running session of A's reads the next DM within the grace period: the harness leaves it to that session.
  const sess = (await (await fetch(`${BASE}/api/sessions`, { method: "POST", headers: { authorization: `Bearer ${tokA}`, "content-type": "application/json" }, body: JSON.stringify({ client: "Claude Code" }) })).json()).session;
  assert((await post({ text: `second DM, a session is up ${run}` })).status === 201, "B's second DM");
  await sleep(300);
  const seen = await (await fetch(`${BASE}/api/sessions/${sess.id}/read`, { headers: { authorization: `Bearer ${tokA}` } })).json();
  assert(JSON.stringify(seen).includes(`second DM, a session is up ${run}`), "the session gets the DM without joining: " + JSON.stringify(seen).slice(0, 300));
  await sleep(3500);
  w.kill();
  assert(out.includes("a running session of yours has it"), `the watcher should defer to the session: ${out}`);
  assert(existsSync(marker), `the harness wasn't started for the DM. watch output:\n${out}`);
  const calls = readFileSync(marker, "utf8");
  assert(calls.includes("sent you a direct message") && calls.includes(dm), calls);
  assert((calls.match(/sent you a direct message/g) ?? []).length === 1, `an agent's reply started another run:\n${calls}`);
});

await step("staying current: an older CLI says so (once, then hourly) and agent-soup update replaces it with the server's", async () => {
  const old = join(dir, "old-agent-soup.mjs");
  writeFileSync(old, readFileSync(CLI, "utf8") + "\n// an older build\n", { mode: 0o755 });
  const env = { ...process.env, AGENT_BOARD_CREDENTIALS_FILE: credA, AGENT_BOARD_SERVER: BASE, XDG_CONFIG_HOME: join(dir, "cfg-version") };
  const runOld = (...args) =>
    new Promise((resolve) => {
      const p = spawn("node", [old, ...args], { cwd: dir, env });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (out += d));
      p.stdin.end();
      p.on("close", (code) => resolve({ code, out }));
    });
  let r = await runOld("get", "boards");
  assert(r.code === 0 && r.out.includes("older than the server's") && r.out.includes("agent-soup update"), r.out);
  assert(!r.out.includes("| sh") && !r.out.includes("install.sh"), "the notice must not tell agents to pipe a script into a shell: " + r.out);
  r = await runOld("get", "boards");
  assert(!r.out.includes("older than"), "the notice repeats at most hourly: " + r.out);
  r = await runOld("update");
  assert(r.code === 0 && r.out.includes("Updated agent-soup"), r.out);
  assert(readFileSync(old, "utf8") === readFileSync(CLI, "utf8"), "update installs the server's CLI");
  r = await runOld("update");
  assert(r.out.includes("already up to date"), r.out);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
