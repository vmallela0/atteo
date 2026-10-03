// CLI integration test: runs the built CLI (cli/dist/atteo.mjs) against a server.
// Usage: npm run build:cli && BASE=http://localhost:8787 ADMIN_KEY=... node test/cli.mjs

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, chmodSync, existsSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = (process.env.BASE ?? "http://localhost:8787").replace(/\/$/, "");
const ADMIN_KEY = process.env.ADMIN_KEY ?? readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").match(/^ADMIN_KEY=(.*)$/m)?.[1];
const CLI = new URL("../cli/dist/atteo.mjs", import.meta.url).pathname;
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

/** Runs `atteo mcp` and talks JSON-RPC to it over stdio. */
function startMcp(credFile, env = {}) {
  const p = spawn("node", [CLI, "mcp", "--server", BASE], { env: { ...process.env, ATTEO_CREDENTIALS_FILE: credFile, ...env } });
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

await step("replies go in the thread: --reply-to works like --reply, unknown options are refused, and the agent's answer is threaded under the message it's on", async () => {
  const cli = (cred, ...args) => new Promise((resolve) => {
    const p = spawn("node", [CLI, ...args, "--board", board], { env: { ...process.env, ATTEO_CREDENTIALS_FILE: cred, XDG_CONFIG_HOME: join(dir, "cfg-thread") } });
    let s = "";
    p.stdout.on("data", (d) => (s += d));
    p.stderr.on("data", (d) => (s += d));
    p.on("close", (code) => resolve({ code, out: s }));
  });
  // A asks B's agent; B's agent reads it (🤔) and answers.
  const q = Number((await tool(tokA, board, "post", { type: "question", text: `@${B}'s agent which branch ${run}?` })).match(/#(\d+)/)[1]);
  await cli(credB, "read");
  let r = await cli(credB, "post", `main, as usual ${run}`, "--reply-to", String(q));
  if (r.out.includes("Not posted")) r = await cli(credB, "post", `main, as usual ${run}`, "--reply-to", String(q)); // caught up by the bounce
  assert(r.code === 0 && r.out.includes(`In reply to #${q}`), `--reply-to threads: ${r.out}`);
  r = await cli(credB, "post", `oops ${run}`, "--replyto", String(q));
  assert(r.code !== 0 && r.out.includes("doesn't take --replyto"), `unknown options are refused: ${r.out}`);
  // An agent that forgets reply_to still answers in the thread of the message it's on, addressed to its author.
  await tool(tokA, board, "read", {});
  const q2 = Number((await tool(tokA, board, "post", { type: "question", text: `@${B}'s agent and the tag ${run}?` })).match(/#(\d+)/)[1]);
  await tool(tokB, board, "read", {});
  const auto = await tool(tokB, board, "post", { type: "note", to: A, text: `v2.3 ${run}` });
  assert(auto.includes(`Threaded under #${q2}`), `auto-threaded: ${auto}`);
  // reply_to 0 keeps it at the top level on purpose.
  await tool(tokB, board, "read", {});
  const top = await tool(tokB, board, "post", { type: "note", to: A, text: `separately ${run}`, reply_to: 0 });
  assert(!top.includes("Threaded") && !top.includes("In reply to"), `top level: ${top}`);
});

await step("status reads the saved login", async () => {
  const out = await new Promise((resolve) => {
    const p = spawn("node", [CLI, "status"], { env: { ...process.env, ATTEO_CREDENTIALS_FILE: credA } });
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

await step("mcp: agent-first notices: mentions and your threads at once, the rest as one digest", async () => {
  const m = startMcp(credA, { ATTEO_DIGEST_MS: "1500" });
  await m.call("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  await m.call("tools/call", { name: "join_board", arguments: { board: `cli ${run}` } });
  await sleep(SETTLE);
  const notices = () => m.lines.filter((l) => l.method === "notifications/claude/channel").map((l) => l.params.content);
  // Chatter not for A's agent: no notice now.
  await tool(tokB, board, "read", {});
  const c1 = Number((await tool(tokB, board, "post", { type: "note", text: `chatter one ${run}`, reply_to: 0 })).match(/#(\d+)/)[1]);
  await tool(tokB, board, "read", {});
  await tool(tokB, board, "post", { type: "note", text: `chatter two ${run}`, reply_to: 0 });
  await sleep(600);
  assert(notices().length === 0, `chatter pushed at once: ${JSON.stringify(notices())}`);
  // …then one digest line for both.
  for (let t = 0; t < 80 && !notices().length; t++) await sleep(50);
  assert(notices().length === 1 && /^2 new on .*none addressed to you/.test(notices()[0]), JSON.stringify(notices()));
  // A's agent replies in B's thread; B's next reply there is pushed at once, though it doesn't mention A.
  await m.call("tools/call", { name: "read", arguments: {} });
  await m.call("tools/call", { name: "post", arguments: { type: "note", text: `on it ${run}`, reply_to: c1 } });
  await tool(tokB, board, "read", {});
  await tool(tokB, board, "post", { type: "note", text: `thanks ${run}`, reply_to: c1 });
  for (let t = 0; t < 80 && notices().length < 2; t++) await sleep(50);
  assert(notices().length === 2 && notices()[1].includes("in a thread you're in"), JSON.stringify(notices()));
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
  const env = { ...process.env, ATTEO_CREDENTIALS_FILE: credA, ATTEO_CLAUDE_BIN: stub, XDG_CONFIG_HOME: join(dir, "cfg") };
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
    env: { ...process.env, ATTEO_CREDENTIALS_FILE: credA, ATTEO_CLAUDE_BIN: stub, XDG_CONFIG_HOME: join(dir, "cfg-mentions") },
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
  const env = { ...process.env, ATTEO_CREDENTIALS_FILE: credA, XDG_CONFIG_HOME: join(dir, "cfg-custom") };
  delete env.ATTEO_CLAUDE_BIN;
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
  for (let t = 0; t < 300 && !existsSync(marker); t++) await sleep(100); // the watcher waits ~20s for a running session to take it first
  w.kill();
  assert(existsSync(marker), `custom agent was not started:\n${out}`);
  const got = readFileSync(marker, "utf8");
  assert(got.startsWith("ARGC=3\n--task\n") && got.includes(`entry #${seq}`) && got.trimEnd().endsWith("--fast"), got);
  assert(got.includes(`atteo post --board ${board} --reply ${seq}`), "non-MCP agents are told how to answer with the CLI");
});

// Board commands: run the CLI like a person or a shell-only agent would.
function cli(args, { cred = credA, cwd = dir, input, env = {} } = {}) {
  return new Promise((resolve) => {
    const p = spawn("node", [CLI, ...args], { cwd, env: { ...process.env, ATTEO_CREDENTIALS_FILE: cred, ATTEO_SERVER: BASE, XDG_CONFIG_HOME: join(dir, "cfg-cmds"), ...env } });
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
  assert(r.code === 0 && /== "e2e cli [^"]+" \(b_[a-z0-9]+\) · \d+ new since your last read · \d+ open tasks? for you ==/.test(r.out), r.out + r.err);
  assert(!r.out.includes("Members:"), "A had the summary already: a later read is only what's new: " + r.out);
  r = await cli(["read", "--summary"], { cwd: proj });
  assert(r.code === 0 && r.out.includes("Members:"), r.out + r.err);
  r = await cli(["post", "hello from the cli", run], { cwd: proj });
  assert(r.code === 0 && /Posted #\d+/.test(r.out), r.out + r.err);
  r = await cli(["post", "-"], { cwd: proj, input: `piped text ${run}` });
  assert(r.code === 0, r.out + r.err);
  // B posts something not about A's post: A's post lands (exit 0) and lists it as missed.
  await tool(tokB, board, "read", {});
  await tool(tokB, board, "post", { type: "note", text: `B was here ${run}`, reply_to: 0 });
  r = await cli(["post", "not about B"], { cwd: proj });
  assert(r.code === 0 && /Posted #\d+/.test(r.out) && r.out.includes("You missed") && r.out.includes(`B was here ${run}`), `${r.code} ${r.out} ${r.err}`);
  // B posts to A: A's stale post is refused with exit code 2 and just that entry.
  await tool(tokB, board, "read", {});
  await tool(tokB, board, "post", { type: "note", to: A, text: `B asks A ${run}`, reply_to: 0 });
  r = await cli(["post", "talking over B"], { cwd: proj });
  assert(r.code === 2 && r.err.includes(`B asks A ${run}`) && !r.err.includes("Members:"), `${r.code} ${r.err}`);
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
  assert(r.out.includes(`#${t} [done]`) && r.out.includes("done: shipped"), "done keeps its note on the task: " + r.out + r.err);
  // Done is the status change: no "✅ Done" message reaches the conversation.
  const seen = await tool(tokB, board, "read", { since: Number(t) });
  assert(!seen.includes("✅ Done") && !seen.includes("shipped"), "no done note posted: " + seen);
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

await step("hooks: use installs a pre-push hook that chains the old one; a push posts a card of just the pushed commits; deletes and nothing-new are skipped; --off puts the old hook back", async () => {
  const repo = mkdtempSync(join(tmpdir(), "agent-board-hook-"));
  const genv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
  const g = (...a) => execFileSync("git", a, { cwd: repo, env: genv, stdio: "pipe" }).toString().trim();
  g("init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "one\n");
  g("add", "."); g("commit", "-qm", "Already pushed");
  const first = g("rev-parse", "HEAD");
  // Another tool's pre-push hook is already there: it must keep running, first, with git's input.
  const hooks = join(repo, ".git", "hooks");
  const hook = join(hooks, "pre-push");
  const marker = join(repo, "old-hook-ran");
  const oldHook = `#!/bin/sh\ncat > '${marker}'\n`;
  mkdirSync(hooks, { recursive: true });
  writeFileSync(hook, oldHook, { mode: 0o755 });
  let r = await cli(["use", board], { cwd: repo });
  assert(r.code === 0 && r.out.includes("atteo hooks install --off") && r.out.includes("your pre-push hook still runs first"), r.out + r.err);
  assert(statSync(hook).mode & 0o100 && readFileSync(hook, "utf8").includes("# atteo pre-push hook"), "an executable atteo hook");
  assert(readFileSync(join(hooks, "pre-push.before-agent-soup"), "utf8") === oldHook, "the old hook is kept next to it");
  writeFileSync(join(repo, "b.txt"), "two\n");
  g("add", "b.txt"); g("commit", "-qm", "Add the b file");
  writeFileSync(join(repo, "a.txt"), "one\nmore\n");
  g("commit", "-qam", "Tweak a");
  const head = g("rev-parse", "HEAD");
  // Git runs the hook from the repo with <remote> <url> and one line per ref on stdin. Someone else posted meanwhile,
  // so the first try bounces ("since you last read"); the hook posts again.
  await tool(tokB, board, "read", {});
  await tool(tokB, board, "post", { type: "note", text: `meanwhile ${run}` });
  const push = (input) =>
    new Promise((resolve) => {
      const p = spawn(hook, ["origin", "https://example.com/proj.git"], { cwd: repo, env: { ...process.env, ATTEO_CREDENTIALS_FILE: credA, ATTEO_SERVER: BASE, XDG_CONFIG_HOME: join(dir, "cfg-cmds") } });
      let err = "";
      p.stdout.on("data", (d) => (err += d));
      p.stderr.on("data", (d) => (err += d));
      p.stdin.end(input);
      p.on("close", (code) => resolve({ code, err }));
    });
  r = await push(`refs/heads/main ${head} refs/heads/main ${first}\n`);
  assert(r.code === 0 && /posted change card #\d+/.test(r.err), r.err);
  assert(readFileSync(marker, "utf8").includes(`refs/heads/main ${head} refs/heads/main ${first}`), "the old hook ran with git's input");
  const seq = Number(r.err.match(/change card #(\d+)/)[1]);
  const got = await tool(tokB, board, "get", { seq });
  assert(got.includes("Change: main · 2 commits · 2 files +2 −0") && got.includes("Add the b file") && got.includes("Tweak a") && !got.includes("Already pushed"), got);
  assert(!got.includes("+++ b/b.txt"), "no diff by default (the code isn't shared unless asked): " + got);
  // With --diff the card carries the code too.
  r = await cli(["hooks", "install", "--diff"], { cwd: repo });
  assert(r.code === 0 && r.out.includes("with the diff"), r.out + r.err);
  await tool(tokB, board, "read", {});
  r = await push(`refs/heads/main ${head} refs/heads/main ${first}\n`);
  const seq2 = Number((r.err.match(/change card #(\d+)/) ?? [])[1]);
  assert(seq2 && (await tool(tokB, board, "get", { seq: seq2 })).includes("+++ b/b.txt"), "the diff with --diff: " + r.err);
  r = await cli(["hooks", "status"], { cwd: repo });
  assert(r.out.includes("commits, files and the diff"), r.out);
  // A delete and a ref with nothing new: no card, and the push still goes on.
  const zero = "0".repeat(40);
  r = await push(`(delete) ${zero} refs/heads/old ${first}\nrefs/heads/main ${head} refs/heads/main ${head}\n`);
  assert(r.code === 0 && !r.err.includes("posted"), r.err);
  // The old hook still decides whether the push happens.
  writeFileSync(join(hooks, "pre-push.before-agent-soup"), "#!/bin/sh\nexit 3\n", { mode: 0o755 });
  r = await push(`refs/heads/main ${head} refs/heads/main ${first}\n`);
  assert(r.code === 3 && !r.err.includes("posted"), `${r.code} ${r.err}`);
  writeFileSync(join(hooks, "pre-push.before-agent-soup"), oldHook, { mode: 0o755 });
  // The board unreachable: still exit 0, quickly.
  const t0 = Date.now();
  const down = await new Promise((resolve) => {
    const p = spawn(hook, ["origin", "x"], { cwd: repo, env: { ...process.env, ATTEO_CREDENTIALS_FILE: credA, ATTEO_SERVER: "http://127.0.0.1:9", XDG_CONFIG_HOME: join(dir, "cfg-cmds"), ATTEO_HOOK_TIMEOUT_MS: "1500" } });
    p.stdin.end(`refs/heads/main ${head} refs/heads/main ${first}\n`);
    p.on("close", (code) => resolve(code));
  });
  assert(down === 0 && Date.now() - t0 < 10_000, `exit ${down} after ${Date.now() - t0}ms`);
  // --off removes it and puts the old hook back.
  r = await cli(["hooks", "install", "--off"], { cwd: repo });
  assert(r.code === 0 && readFileSync(hook, "utf8") === oldHook && !existsSync(join(hooks, "pre-push.before-agent-soup")), r.out + r.err);
  r = await cli(["hooks", "install"], { cwd: repo }); // explicit install works too, and --off again
  assert(r.code === 0 && readFileSync(hook, "utf8").includes("# atteo pre-push hook"), r.out + r.err);
  // A hook installed before the rename (the old mark) is still ours: refreshed in place, never chained behind a new one.
  writeFileSync(hook, readFileSync(hook, "utf8").replace("# atteo pre-push hook", "# agent-soup pre-push hook"));
  r = await cli(["hooks", "install"], { cwd: repo });
  assert(r.code === 0 && readFileSync(hook, "utf8").includes("# atteo pre-push hook") && readFileSync(join(hooks, "pre-push.before-agent-soup"), "utf8") === oldHook, r.out + r.err);
  r = await cli(["hooks", "install", "--off"], { cwd: repo });
  assert(r.code === 0 && readFileSync(hook, "utf8") === oldHook, r.out + r.err);
});

await step("people: find, add, accept, friends with presence, ask a friend's agent on your direct board", async () => {
  const home = mkdtempSync(join(tmpdir(), "atteo-social-")); // no folder board here, so ask goes direct
  let r = await cli(["people", B], { cwd: home });
  assert(r.code === 0 && r.out.includes(B) && r.out.includes(`atteo add ${B}`), r.out + r.err);
  // Not friends yet: the first DM waits for B's OK (once) instead of going through.
  r = await cli(["ask", B, "hello?", "--wait", "0", "--dm"], { cwd: home });
  assert(r.code === 0 && r.out.includes("OK it first"), r.out + r.err);
  r = await cli(["add", B, "it's", "me"], { cwd: home });
  assert(r.code === 0 && r.out.includes("Friend request sent"), r.out + r.err);
  r = await cli(["friends"], { cwd: home, cred: credB });
  assert(r.out.includes(`${A} — "it's me"`) && r.out.includes(`atteo accept ${A}`), r.out);
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
  const proj = mkdtempSync(join(tmpdir(), "atteo-seal-"));
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
    const p = spawn("python3", ["-c", py, JSON.stringify(["node", CLI, ...args])], { cwd, env: { ...process.env, ATTEO_CREDENTIALS_FILE: cred, ATTEO_SERVER: BASE, XDG_CONFIG_HOME: join(dir, "cfg-cmds") } });
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
  assert(r.code === 0 && r.out.includes(`atteo verify ${c1}`), r.out + r.err);
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
  assert(!g("worktree", "list").includes("atteo-verify"), "throwaway checkouts are removed");
});

await step("encryption v2: one key per board epoch; a newcomer reads history; your new device needs your OK; removing someone rotates the key", async () => {
  const C = `e2e-cli-c-${run}`;
  await ops("users", { name: C, email: `${C}@example.com`, verified: "true" });
  const tokC = (await ops("tokens", { user: C })).token;
  const credC = join(dir, "c.json"), credA2 = join(dir, "a2.json"); // a2: A's second machine (its own device key)
  writeFileSync(credC, JSON.stringify({ server: BASE, user: C, token: tokC, expires_at: Date.now() + 86400e3 }), { mode: 0o600 });
  writeFileSync(credA2, JSON.stringify({ server: BASE, user: A, token: tokA, expires_at: Date.now() + 86400e3 }), { mode: 0o600 });
  const pa = mkdtempSync(join(tmpdir(), "atteo-v2-a-")), pa2 = mkdtempSync(join(tmpdir(), "atteo-v2-a2-")), pb = mkdtempSync(join(tmpdir(), "atteo-v2-b-")), pc = mkdtempSync(join(tmpdir(), "atteo-v2-c-"));
  let r = await cli(["create", `e2e v2 ${run}`, "--encrypted"], { cwd: pa });
  const eb = r.out.match(/\((b_[a-z0-9]+)\)/)[1];
  await ops("members", { board: eb, user: B });
  await cli(["keys"], { cwd: pb, cred: credB });
  await cli(["use", eb], { cwd: pb, cred: credB });
  r = await cli(["post", `first v2 message ${run}`], { cwd: pa });
  assert(r.code === 0, r.out + r.err);
  const sealed = async (tok) => (await fetch(`${BASE}/api/boards/${eb}/sealed?after=0`, { headers: { authorization: `Bearer ${tok}` } }).then((x) => x.json())).entries;
  const p1 = JSON.parse((await sealed(tokA))[0].payload);
  assert(p1.v === 2 && p1.epoch === 1 && !p1.recipients, "posted as v2 (one ciphertext, no per-member envelopes): " + JSON.stringify(p1).slice(0, 120));
  r = await cli(["read", "--all"], { cwd: pb, cred: credB });
  assert(r.out.includes(`first v2 message ${run}`), r.out + r.err);
  // A newcomer joins later: once a member's machine is on the board again, they read the history.
  await ops("members", { board: eb, user: C });
  await cli(["keys"], { cwd: pc, cred: credC });
  await cli(["use", eb], { cwd: pc, cred: credC });
  await cli(["read"], { cwd: pb, cred: credB }); // B's machine hands C's first device the key
  r = await cli(["read", "--all"], { cwd: pc, cred: credC });
  assert(r.out.includes(`first v2 message ${run}`), "newcomer reads history: " + r.out + r.err);
  // A's second machine: nobody else may hand it the key, and A's first machine only does after A approves it.
  await cli(["keys"], { cwd: pa2, cred: credA2 });
  await cli(["use", eb], { cwd: pa2, cred: credA2 });
  await cli(["read"], { cwd: pb, cred: credB });
  r = await cli(["read", "--all"], { cwd: pa2, cred: credA2 });
  assert(!r.out.includes(`first v2 message ${run}`) && r.out.includes("no key"), "a later device waits for its owner: " + r.out);
  r = await cli(["read"], { cwd: pa });
  const kid2 = (r.err.match(/keys approve (\S+)/) ?? [])[1];
  assert(kid2, "A's first machine says a new device of A's is waiting: " + r.err);
  r = await cli(["keys", "approve", kid2], { cwd: pa });
  assert(r.out.includes("Approved"), r.out + r.err);
  await cli(["read"], { cwd: pa });
  r = await cli(["read", "--all"], { cwd: pa2, cred: credA2 });
  assert(r.out.includes(`first v2 message ${run}`), "after approval, A's second machine reads: " + r.out + r.err);
  // Pins bind a device id to its public key: a trusted id with a different key isn't trusted.
  const pinsA = JSON.parse(readFileSync(`${credA}.pins`, "utf8"));
  assert(Object.values(pinsA).flat().every((e) => e.includes("|")), "pins carry the public key: " + JSON.stringify(pinsA));
  // Removing C rotates: the next message is in epoch 2, which C can't open.
  const ck = (await ops("sessions", { user: A })).cookie;
  const rm = await fetch(`${BASE}/api/boards/${eb}/members/${C}/remove`, { method: "POST", headers: { cookie: ck } });
  assert(rm.ok, `remove C: ${rm.status}`);
  r = await cli(["post", `after removal ${run}`], { cwd: pa });
  assert(r.code === 0, r.out + r.err);
  const last = JSON.parse((await sealed(tokA)).at(-1).payload);
  assert(last.v === 2 && last.epoch === 2, "removal rotated to epoch 2: " + JSON.stringify(last).slice(0, 80));
  const st = await fetch(`${BASE}/api/boards/${eb}/epochs`, { headers: { authorization: `Bearer ${tokB}` } }).then((x) => x.json());
  assert(st.mine.some((g) => g.epoch === 2), "B holds epoch 2");
  r = await cli(["read", "--all"], { cwd: pb, cred: credB });
  assert(r.out.includes(`after removal ${run}`), r.out + r.err);
});

await step("end-to-end encrypted board: CLI encrypts and decrypts; the server and plain agent tools only see ciphertext", async () => {
  const projA = mkdtempSync(join(tmpdir(), "atteo-e2ee-a-"));
  const projB = mkdtempSync(join(tmpdir(), "atteo-e2ee-b-"));
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

await step("a shell script an agent runs (deploy.sh, a git hook) is part of that agent's session, never a session of its own", async () => {
  const d = mkdtempSync(join(tmpdir(), "atteo-script-"));
  const U = `e2e-cli-sh-${run}`; // its own user, so its session doesn't show up in the sessions step below
  await ops("users", { name: U, email: `${U}@example.com`, verified: "true" });
  const cred = join(d, "u.json");
  writeFileSync(cred, JSON.stringify({ server: BASE, user: U, token: (await ops("tokens", { user: U })).token, expires_at: Date.now() + 86400e3 }), { mode: 0o600 });
  writeFileSync(join(d, "deploy.sh"), `#!/bin/bash\nnode ${CLI} session show\n`, { mode: 0o755 });
  writeFileSync(join(d, "codex"), `#!/bin/bash\n${join(d, "deploy.sh")}\n`, { mode: 0o755 });
  const out = execFileSync(join(d, "codex"), [], { cwd: d, env: { ...process.env, ATTEO_CREDENTIALS_FILE: cred, ATTEO_SERVER: BASE, XDG_CONFIG_HOME: join(d, "cfg") } }).toString();
  assert(/^Session codex /.test(out) && !out.includes("deploy.sh"), out);
});

await step("sessions: each agent is its own session (found from its process), joins boards with standard commands, sees its person's other sessions", async () => {
  // Fake agents: long-lived processes named like the agent, running atteo commands from their shell (as real agents do).
  const cfg = mkdtempSync(join(tmpdir(), "atteo-sess-"));
  const agent = (name) => {
    const f = join(cfg, name);
    writeFileSync(f, `#!/bin/bash\nwhile IFS= read -r line; do eval "node ${CLI} $line"; echo "<<rc=$?>>"; done\n`);
    chmodSync(f, 0o755);
    const p = spawn(f, [], { cwd: cfg, env: { ...process.env, ATTEO_CREDENTIALS_FILE: credA, ATTEO_SERVER: BASE, XDG_CONFIG_HOME: join(cfg, "cfg") } });
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
    // codex's post isn't about claude's: claude's lands and lists it, labelled.
    r = await claude.run(`post note "noted" --board ${board}`);
    assert(r.code === 0 && r.out.includes("You missed") && r.out.includes(`three, with backoff ${run}`) && r.out.includes("[codex]"), "lands, listing codex's post: " + r.out);
    // One for claude's session: refused (exit 2) until claude has it.
    r = await codex.run(`post note "@${A}/claude check the backoff ${run}" --board ${board}`);
    assert(r.code === 0, r.out);
    r = await claude.run(`post note "agreed" --board ${board}`);
    assert(r.code === 2 && r.out.includes(`check the backoff ${run}`) && r.out.includes("[codex]"), "refused until it reads codex's post for it: " + r.out);
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
    assert(r.out.includes("atteo get boards") && !/curl[^\n]*\|\s*sh/.test(r.out), "help is for agents, and never pipes a script into a shell");
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
  const env = { ...process.env, ATTEO_CREDENTIALS_FILE: credA, ATTEO_SERVER: BASE, XDG_CONFIG_HOME: cfg, ATTEO_DM_GRACE_MS: "1500" };
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
  // (Polls briefly: under the parallel suites the local server can take a moment.)
  let seen = {};
  for (let t = 0; t < 10 && !JSON.stringify(seen).includes(`second DM, a session is up ${run}`); t++) {
    await sleep(300);
    seen = await (await fetch(`${BASE}/api/sessions/${sess.id}/read`, { headers: { authorization: `Bearer ${tokA}` } })).json();
  }
  assert(JSON.stringify(seen).includes(`second DM, a session is up ${run}`), "the session gets the DM without joining: " + JSON.stringify(seen).slice(0, 300));
  await sleep(3500);
  w.kill();
  assert(out.includes("a running session of yours has it"), `the watcher should defer to the session: ${out}`);
  assert(existsSync(marker), `the harness wasn't started for the DM. watch output:\n${out}`);
  const calls = readFileSync(marker, "utf8");
  assert(calls.includes("sent you a direct message") && calls.includes(dm), calls);
  assert((calls.match(/sent you a direct message/g) ?? []).length === 1, `an agent's reply started another run:\n${calls}`);
});

await step("task tick / untick / edit: tick the one checklist item matching the words; clear errors for none or several", async () => {
  const made = await tool(tokA, board, "task", { action: "create", title: `Ship tick ${run}`, body: `The plan:\n- [ ] write the tests\n- [ ] update the docs\n- [ ] update the help docs\n- [x] sketch it` });
  const n = Number(made.match(/#(\d+)/)[1]);
  const body = async () => (await (await fetch(`${BASE}/api/boards/${board}/tasks/${n}`, { headers: { authorization: `Bearer ${tokA}` } })).json()).task.body;
  const t = (...args) => cli(["task", ...args, "--board", board]);
  let r = await t("tick", String(n), "Write the TESTS");
  assert(r.code === 0 && r.out.includes(`Saved #${n} v2`), r.out + r.err);
  assert((await body()).includes("- [x] write the tests\n- [ ] update the docs"), await body());
  r = await t("tick", String(n), "write the tests");
  assert(r.code === 0 && r.out.includes("Already ticked"), "ticking twice changes nothing: " + r.out + r.err);
  r = await t("tick", String(n), "docs");
  assert(r.code === 1 && r.err.includes("matches 2 items") && r.err.includes("update the help docs"), "several matches: " + r.err);
  r = await t("tick", String(n), "deploy");
  assert(r.code === 1 && r.err.includes(`No checklist item on #${n} contains "deploy"`) && r.err.includes("- [ ] update the docs"), "no match: " + r.err);
  r = await t("untick", String(n), "sketch");
  assert(r.code === 0 && (await body()).includes("- [ ] sketch it"), r.out + r.err);
  r = await t("edit", String(n), "--old", "update the help docs", "--new", "update the agent help", "--summary", "renamed an item");
  assert(r.code === 0 && (await body()).includes("- [ ] update the agent help"), r.out + r.err);
  r = await t("edit", String(n), "--old", "not in the task", "--new", "x");
  assert(r.code === 1 && r.err.includes("wasn't found"), r.err);
  r = await t("edit", String(n), "--new", "x");
  assert(r.code === 1 && r.err.includes("Usage: atteo task edit"), r.err);
});

await step("task remove / retract: a task leaves the board (its author or the board's creator only), a note is unsent, a non-task isn't removed", async () => {
  const n = Number((await tool(tokB, board, "task", { action: "create", title: `Drop me ${run}`, body: "- [ ] nothing" })).match(/#(\d+)/)[1]);
  await tool(tokB, board, "read", {});
  const note = Number((await tool(tokB, board, "post", { type: "note", text: `typo ${run}` })).match(/Posted #(\d+)/)[1]);
  const listed = async () => (await (await fetch(`${BASE}/api/boards/${board}/tasks`, { headers: { authorization: `Bearer ${tokA}` } })).json()).tasks.some((t) => t.seq === n);
  assert(await listed(), "the task is on the board first");
  let r = await cli(["task", "remove", String(note), "--board", board], { cred: credB });
  assert(r.code === 1 && !r.out.includes("Retracted"), "a note isn't a task: " + r.out + r.err);
  r = await cli(["task", "remove", String(n), "--board", board], { cred: credB });
  assert(r.code === 0 && r.out.includes(`Retracted #${n}`), r.out + r.err);
  assert(!(await listed()), "the task left the board");
  r = await cli(["task", "remove", String(n), "--board", board], { cred: credB });
  assert(r.code === 1 && r.err.includes("retracted"), "twice: " + r.err);
  // B didn't make the board, so B can't retract A's entries; A (the creator) can retract B's.
  await tool(tokA, board, "read", {});
  const mine = Number((await tool(tokA, board, "post", { type: "note", text: `A's note ${run}` })).match(/Posted #(\d+)/)[1]);
  r = await cli(["retract", String(mine), "--board", board], { cred: credB });
  assert(r.code === 1 && r.err.includes("can retract it"), "not B's to retract: " + r.err);
  r = await cli(["retract", `#${note}`, "posted by mistake", "--board", board]);
  assert(r.code === 0 && r.out.includes(`Retracted #${note}`), r.out + r.err);
  const got = await tool(tokA, board, "get", { seq: note });
  assert(got.includes(`retracts #${note}`) && got.includes("posted by mistake"), "kept in the log with its retraction: " + got);
  r = await cli(["retract", "--board", board]);
  assert(r.code === 1 && r.err.includes("Usage: atteo retract"), r.err);
});

await step("get N on your own entry says who has seen it (people, and agents that have been here); others' entries don't", async () => {
  await tool(tokA, board, "read", {});
  const n = Number((await tool(tokA, board, "post", { type: "note", text: `seen check ${run}` })).match(/Posted #(\d+)/)[1]);
  const seen = (out) => out.split("\n").find((l) => /^(Seen by|Not seen yet)/.test(l)) ?? "";
  let r = await cli(["get", "entry", String(n), "--board", board]);
  assert(r.code === 0 && seen(r.out).includes(`not yet: `) && seen(r.out).split("not yet:")[1].includes(`${B}'s agent`), "B's agent hasn't read it: " + r.out + r.err);
  assert(!seen(r.out).includes(`${A}'s agent`), "the agent that wrote it isn't counted: " + seen(r.out));
  await tool(tokB, board, "read", {});
  await fetch(`${BASE}/api/boards/${board}/seen`, { method: "POST", headers: { authorization: `Bearer ${tokB}`, "content-type": "application/json" }, body: JSON.stringify({ seq: n }) });
  r = await cli(["get", "entry", String(n), "--board", board]);
  const line = seen(r.out);
  assert(/^Seen by /.test(line) && line.split("·")[0].includes(`${B}'s agent`) && line.split("·")[0].includes(`${B},`), "B and B's agent have seen it: " + line);
  r = await cli(["get", "entry", String(n), "--board", board], { cred: credB });
  assert(r.code === 0 && r.out.includes(`seen check ${run}`) && !seen(r.out), "not on someone else's entry: " + r.out);
});

await step("task edit / tick / done with unread board entries: the edit is saved once, 'Saved #N vX.' is printed (then the missed entries), exit 0", async () => {
  const made = await tool(tokA, board, "task", { action: "create", title: `Unread edit ${run}`, body: `Plan:\n- [ ] first step\n- [ ] second step\nline one` });
  const n = Number(made.match(/#(\d+)/)[1]);
  const get = async () => (await (await fetch(`${BASE}/api/boards/${board}/tasks/${n}`, { headers: { authorization: `Bearer ${tokA}` } })).json()).task;
  const t = (...args) => cli(["task", ...args, "--board", board]);
  await cli(["read", "--board", board]); // the CLI session is caught up, so only what B posts next is unread
  const v0 = (await get()).version;
  await tool(tokB, board, "post", { type: "note", text: `unread from B ${run}` });
  let r = await t("edit", String(n), "--old", "line one", "--new", "line two");
  const t1 = await get();
  assert(r.code === 0 && r.out.includes(`Saved #${n} v${v0 + 1}.`), `edit with unread entries prints Saved: ${r.out}${r.err}`);
  assert(!r.out.includes(`unread from B ${run}`) || r.out.indexOf("Saved") < r.out.indexOf(`unread from B ${run}`), "Saved comes before the missed entries: " + r.out);
  assert(t1.version === v0 + 1 && t1.body.split("line two").length === 2 && !t1.body.includes("line one"), `applied once: v${t1.version} ${t1.body}`);
  await tool(tokB, board, "post", { type: "note", text: `second unread from B ${run}` });
  r = await t("tick", String(n), "first step");
  assert(r.code === 0 && r.out.includes(`Saved #${n} v${v0 + 2}.`), `tick with unread entries: ${r.out}${r.err}`);
  await tool(tokB, board, "post", { type: "note", text: `third unread from B ${run}` });
  r = await t("done", String(n), "finished");
  assert(r.code === 0 && /OK\./.test(r.out) && (await get()).status === "done", `done with unread entries: ${r.out}${r.err}`);
});

await step("mailbox: another person's DM and @mention of your agent show up in full, fenced; --peek leaves them, a plain run delivers them; --json and --wait", async () => {
  // Fresh people, so earlier steps' mail doesn't get in the way.
  const M = `e2e-cli-m-${run}`, N = `e2e-cli-n-${run}`;
  for (const u of [M, N]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true" });
  const tokM = (await ops("tokens", { user: M })).token;
  const tokN = (await ops("tokens", { user: N })).token;
  const credM = join(dir, "m.json");
  writeFileSync(credM, JSON.stringify({ server: BASE, user: M, token: tokM, expires_at: Date.now() + 86400e3 }), { mode: 0o600 });
  const call = async (tok, method, path, body) => (await fetch(`${BASE}${path}`, { method, headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined })).json();
  await call(tokN, "POST", "/api/friends/request", { user: M });
  await call(tokM, "POST", `/api/friends/${N}/accept`);
  const dm = (await call(tokN, "POST", `/api/direct/${M}`)).board;
  const shared = (await ops("boards", { user: N, title: `e2e cli mail ${run}` })).board.id;
  await ops("members", { board: shared, user: M });
  const mb = (args) => cli(["mailbox", ...args], { cred: credM, env: { XDG_CONFIG_HOME: join(dir, "cfg-mailbox") } });
  // Drain what joining and befriending sent (contact requests and the like).
  await mb([]);
  const long = `Line one of the DM ${run}\nline two, ${"all of it ".repeat(30)}end`;
  // The DM from N in the browser (a person), the mention from N's agent.
  const cookieN = (await ops("sessions", { user: N })).cookie;
  const r0 = await fetch(`${BASE}/api/boards/${dm}/entries`, { method: "POST", headers: { "content-type": "application/json", cookie: cookieN }, body: JSON.stringify({ text: long }) });
  assert(r0.status === 201, "N's DM");
  await tool(tokN, shared, "post", { type: "question", text: `@${M}'s agent which port does staging use? ${run}` });
  let r = await mb(["--peek"]);
  assert(r.code === 0 && r.out.includes("Mail for your agent (2)") && r.out.includes("direct message") && r.out.includes("for your agent"), r.out + r.err);
  assert(r.out.includes(`from ${N} (person)`) && r.out.includes(`from ${N}'s agent (agent)`) && r.out.includes(`(${shared}) #`) && r.out.includes("    line two") && r.out.includes("all of it end"), "labelled, full text: " + r.out);
  assert(r.out.indexOf("Line one of the DM") < r.out.indexOf("which port does staging use"), "oldest first: " + r.out);
  assert(/<<untrusted [0-9a-f]+:[^\n]*>>/.test(r.out) && /<<end untrusted [0-9a-f]+>>/.test(r.out), "fenced as board content: " + r.out);
  assert(r.out.includes("Peeked"), r.out);
  r = await mb([]);
  assert(r.code === 0 && r.out.includes("Mail for your agent (2)") && r.out.includes("Delivered"), "a peek leaves it waiting: " + r.out + r.err);
  r = await mb([]);
  assert(r.code === 0 && r.out.trim() === "Nothing new.", "a plain run delivered it: " + r.out + r.err);
  // --json: the raw structure, for dispatchers; --wait returns as soon as mail arrives.
  const t0 = Date.now();
  const waiting = mb(["--wait", "20", "--json"]);
  await sleep(1500);
  await call(tokN, "POST", `/api/boards/${dm}/entries`, { type: "question", text: `quick one ${run}` });
  r = await waiting;
  const j = JSON.parse(r.out);
  assert(r.code === 0 && j.mail.length === 1 && j.more === false && Date.now() - t0 < 15000, `${Date.now() - t0}ms ${r.out}${r.err}`);
  const m = j.mail[0];
  assert(m.kind === "dm" && m.board === dm && m.from === N && m.type === "question" && m.text === `quick one ${run}` && typeof m.id === "number" && typeof m.seq === "number" && typeof m.ts === "number", r.out);
  r = await mb(["--wait", "2"]);
  assert(r.out.includes("Nothing new in 2s."), "--json without --peek delivered it too: " + r.out);
});

await step("dispatch: without a harness it says how to set one and exits non-zero", async () => {
  const r = await cli(["dispatch", "--once"], { env: { XDG_CONFIG_HOME: join(dir, "cfg-dispatch-none"), ATTEO_AGENT: "" } });
  assert(r.code !== 0 && r.err.includes("atteo harness claude"), r.out + r.err);
});

await step("dispatch: one fork per message, each its own session with the message and how to answer it in the thread; acked; a second run does nothing; an agent's plain note gets no fork", async () => {
  // Fresh people, so earlier steps' mail doesn't get in the way.
  const D = `e2e-cli-d-${run}`, E = `e2e-cli-e-${run}`;
  for (const u of [D, E]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true" });
  const tokD = (await ops("tokens", { user: D })).token;
  const tokE = (await ops("tokens", { user: E })).token;
  const credD = join(dir, "d.json");
  writeFileSync(credD, JSON.stringify({ server: BASE, user: D, token: tokD, expires_at: Date.now() + 86400e3 }), { mode: 0o600 });
  const call = async (tok, method, path, body) => (await fetch(`${BASE}${path}`, { method, headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined })).json();
  await call(tokE, "POST", "/api/friends/request", { user: D });
  await call(tokD, "POST", `/api/friends/${E}/accept`);
  const dm = (await call(tokE, "POST", `/api/direct/${D}`)).board;
  const shared = (await ops("boards", { user: E, title: `e2e cli dispatch ${run}` })).board.id;
  await ops("members", { board: shared, user: D });
  const cfg = join(dir, "cfg-dispatch");
  await cli(["mailbox"], { cred: credD, env: { XDG_CONFIG_HOME: cfg } }); // drain contact requests and the like
  // The fake harness records the session it runs as (via the CLI, so ATTEO_SESSION is what selects it) and its prompt.
  // (One file per fork: forks run at the same time.)
  const forkDir = join(dir, "dispatch-forks");
  mkdirSync(forkDir, { recursive: true });
  const stub = join(dir, "fake-fork.sh");
  writeFileSync(stub, `#!/bin/sh\n{ echo "START $ATTEO_SESSION"; node "${CLI}" session show --quiet; node "${CLI}" session show --quiet --json | grep '"kind"'; printf '%s\\n' "$@"; } > "${forkDir}/$ATTEO_SESSION.txt"\necho "answered"\n`);
  chmodSync(stub, 0o755);
  const task = Number((await tool(tokE, shared, "post", { type: "task", text: `@${D}'s agent please bump the version to 2.4 ${run}` })).match(/#(\d+)/)[1]);
  const cookieE = (await ops("sessions", { user: E })).cookie;
  const r0 = await fetch(`${BASE}/api/boards/${dm}/entries`, { method: "POST", headers: { "content-type": "application/json", cookie: cookieE }, body: JSON.stringify({ text: `are you around for the release? ${run}` }) });
  assert(r0.status === 201, "E's DM");
  await tool(tokE, shared, "read", {});
  await tool(tokE, shared, "post", { type: "note", text: `@${D}'s agent fyi, CI is green ${run}` }); // another agent's plain note: no fork
  const dispatch = (...args) => cli(["dispatch", "--once", "--quiet", "--json", "--agent-cmd", `${stub} {prompt}`, "--dir", dir, ...args], { cred: credD, env: { XDG_CONFIG_HOME: cfg } });
  let r = await dispatch();
  assert(r.code === 0, r.out + r.err);
  const events = r.out.trim().split("\n").map((l) => JSON.parse(l));
  const forks = events.filter((e) => e.event === "fork");
  assert(forks.length === 2, `two forks: ${r.out}${r.err}`);
  assert(forks[0].session !== forks[1].session && forks.every((f) => /^as_/.test(f.session)), `each fork has its own session: ${r.out}`);
  const names = forks.map((f) => f.name).sort();
  assert(names.includes(`task-${task}`) && names.includes(`dm-${E}`), `named after the message: ${names}`);
  assert(events.filter((e) => e.event === "done" && e.ok).length === 2, `both forks ran: ${r.out}`);
  assert(events.some((e) => e.event === "passed" && e.from === E && e.board === shared), `the agent's note was passed on, not forked: ${r.out}`);
  const forkLogs = () => (readdirSync(forkDir).sort().map((f) => readFileSync(join(forkDir, f), "utf8")));
  const runs = forkLogs().map((x) => x.replace(/^START /, ""));
  const log = runs.join("\n");
  assert(runs.length === 2, log);
  const taskRun = runs.find((x) => x.includes("bump the version")), dmRun = runs.find((x) => x.includes("around for the release"));
  assert(taskRun && dmRun, `each fork gets its message in full: ${log}`);
  const taskFork = forks.find((f) => f.name === `task-${task}`); // (by name: the task and the DM are both #1 on their own boards)
  assert(taskRun.startsWith(taskFork.session) && taskRun.includes(`(${taskFork.session})`) && taskRun.includes(`Doing: Handling task #${task}`) && taskRun.includes(shared), `the fork runs as its own session, on the board, with a status: ${taskRun}`);
  assert(runs.every((x) => x.includes(`"kind": "fork"`)), `dispatch makes its sessions as forks (never listed as your agents): ${log}`);
  assert(/<<untrusted [0-9a-f]+:/.test(taskRun), "the message is fenced: " + taskRun);
  assert(taskRun.includes(`reply_to ${task}`) && taskRun.includes(`--board ${shared} --reply ${task}`) && taskRun.includes("in the thread") && taskRun.includes(`task claim ${task}`) && taskRun.includes("✅") && taskRun.includes("session end"), "claim, reply in the thread, ✅, end: " + taskRun);
  assert(dmRun.includes(`direct board with ${E}`) && dmRun.includes(dm) && !dmRun.includes("task claim"), dmRun);
  // Acked, the forks' sessions ended, and a second run starts nothing.
  const left = await call(tokD, "GET", "/api/mailbox?peek=1");
  assert(left.mail.length === 0, "acked: " + JSON.stringify(left));
  const live = (await call(tokD, "GET", "/api/sessions?all=1")).sessions.map((s) => s.id); // all=1: forks too
  assert(forks.every((f) => !live.includes(f.session)), "fork sessions end when the fork exits: " + live);
  r = await dispatch();
  assert(r.code === 0 && !r.out.includes('"event":"fork"') && forkLogs().length === 2, "a second run doesn't redo it: " + r.out + r.err);

  // --max: one fork at a time with --max 1 (the next waits), two together with --max 2.
  const order = join(dir, "dispatch-order.txt");
  const slow = join(dir, "slow-fork.sh");
  writeFileSync(slow, `#!/bin/sh\necho "START $ATTEO_SESSION" >> "${order}"\nsleep 2\necho "END $ATTEO_SESSION" >> "${order}"\n`);
  chmodSync(slow, 0o755);
  const ask = async (n) => {
    await tool(tokE, shared, "read", {});
    return tool(tokE, shared, "post", { type: "question", text: `@${D}'s agent question ${n} ${run}` });
  };
  const slowRun = (max) => cli(["dispatch", "--once", "--quiet", "--max", String(max), "--agent-cmd", `${slow} {prompt}`, "--dir", dir], { cred: credD, env: { XDG_CONFIG_HOME: cfg } });
  await ask(1);
  await ask(2);
  r = await slowRun(1);
  let lines = readFileSync(order, "utf8").trim().split("\n");
  assert(r.code === 0 && lines.length === 4, r.out + r.err + lines);
  assert(lines[0].startsWith("START") && lines[1] === lines[0].replace("START", "END") && lines[2].startsWith("START") && lines[3] === lines[2].replace("START", "END") && lines[0] !== lines[2], `--max 1 runs them one after the other: ${lines}`);
  await ask(3);
  await ask(4);
  writeFileSync(order, "");
  r = await slowRun(2);
  lines = readFileSync(order, "utf8").trim().split("\n");
  assert(r.code === 0 && lines.length === 4 && lines[0].startsWith("START") && lines[1].startsWith("START"), `--max 2 runs two at once: ${lines}`);
});

await step("Your agent: your own messages are mail from your user; dispatch forks one (you-N) that answers on \"Your agent\"; mail for one session is only in that session's mailbox", async () => {
  const Y = `e2e-cli-y-${run}`;
  await ops("users", { name: Y, email: `${Y}@example.com`, verified: "true" });
  const tokY = (await ops("tokens", { user: Y })).token;
  const credY = join(dir, "y.json");
  writeFileSync(credY, JSON.stringify({ server: BASE, user: Y, token: tokY, expires_at: Date.now() + 86400e3 }), { mode: 0o600 });
  const call = async (method, path, body) => (await fetch(`${BASE}${path}`, { method, headers: { authorization: `Bearer ${tokY}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined })).json();
  const chat = (await call("POST", "/api/me/agent-chat")).board;
  assert(/^b_/.test(chat ?? ""), "the chat");
  const S = (await call("POST", "/api/sessions", { suggest: "claude", client: "Claude Code" })).session;
  const cookieY = (await ops("sessions", { user: Y })).cookie;
  const say = async (body) => (await (await fetch(`${BASE}/api/boards/${chat}/entries`, { method: "POST", headers: { "content-type": "application/json", cookie: cookieY }, body: JSON.stringify(body) })).json()).entry.seq;
  const p1 = await say({ type: "question", text: `what changed today? ${run}` });
  const p2 = await say({ type: "note", text: `just you: rerun the build ${run}`, to_session: S.name });
  const cfg = join(dir, "cfg-you");
  const mb = (args) => cli(["mailbox", ...args], { cred: credY, env: { XDG_CONFIG_HOME: cfg } });
  let r = await mb(["--peek"]);
  assert(r.code === 0 && r.out.includes("direct message") && r.out.includes(`from your user (${Y})`) && r.out.includes(`what changed today? ${run}`), "from your user: " + r.out + r.err);
  assert(!r.out.includes("rerun the build"), "mail for one session isn't in the mailbox without it: " + r.out);
  r = await mb(["--peek", "--session", S.id]);
  assert(r.code === 0 && r.out.includes(`rerun the build ${run}`) && r.out.includes(`for your session "${S.name}"`), "that session's own mailbox has it: " + r.out + r.err);
  // The dispatcher (no session) forks the message for any of your agents, and leaves the one for S alone.
  const forkDir = join(dir, "you-forks");
  mkdirSync(forkDir, { recursive: true });
  const stub = join(dir, "you-fork.sh");
  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > "${forkDir}/$ATTEO_SESSION.txt"\necho "answered"\n`);
  chmodSync(stub, 0o755);
  r = await cli(["dispatch", "--once", "--quiet", "--json", "--agent-cmd", `${stub} {prompt}`, "--dir", dir], { cred: credY, env: { XDG_CONFIG_HOME: cfg } });
  assert(r.code === 0, r.out + r.err);
  const forks = r.out.trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.event === "fork");
  assert(forks.length === 1 && forks[0].name === `you-${p1}` && forks[0].seq === p1, `one fork, for #${p1} (not #${p2}): ${r.out}`);
  const prompt = readFileSync(join(forkDir, `${forks[0].session}.txt`), "utf8");
  assert(prompt.includes(`your user (${Y})`) && prompt.includes(`"Your agent"`) && prompt.includes(`--board ${chat} --reply ${p1}`) && /<<untrusted [0-9a-f]+:/.test(prompt), "the fork answers on Your agent, in the thread: " + prompt);
});

await step("staying current: an older CLI says so (once, then hourly) and atteo update replaces it with the server's", async () => {
  const old = join(dir, "old-atteo.mjs");
  writeFileSync(old, readFileSync(CLI, "utf8") + "\n// an older build\n", { mode: 0o755 });
  const env = { ...process.env, ATTEO_CREDENTIALS_FILE: credA, ATTEO_SERVER: BASE, XDG_CONFIG_HOME: join(dir, "cfg-version") };
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
  assert(r.code === 0 && r.out.includes("older than the server's") && r.out.includes("atteo update"), r.out);
  assert(!r.out.includes("| sh") && !r.out.includes("install.sh"), "the notice must not tell agents to pipe a script into a shell: " + r.out);
  r = await runOld("get", "boards");
  assert(!r.out.includes("older than"), "the notice repeats at most hourly: " + r.out);
  r = await runOld("update");
  assert(r.code === 0 && r.out.includes("Updated atteo"), r.out);
  assert(readFileSync(old, "utf8") === readFileSync(CLI, "utf8"), "update installs the server's CLI");
  r = await runOld("update");
  assert(r.out.includes("already up to date"), r.out);
});

await step("the rename: help says only atteo; the agent-soup command, AGENT_SOUP_*/AGENT_BOARD_* env vars and /cli/agent-soup.mjs still work", async () => {
  let r = await cli(["help", "--all"]);
  assert(r.code === 0 && (r.out + r.err).includes("atteo login") && !/agent-soup|AGENT_SOUP|agent-board(?!\.vedu-mallela\.workers\.dev)/.test(r.out + r.err), r.out + r.err);
  // agent-soup and agent-board are aliases of the same file (existing installs, hooks and services call them).
  const pkg = JSON.parse(readFileSync(new URL("../cli/package.json", import.meta.url), "utf8"));
  assert(pkg.name === "atteo" && pkg.bin.atteo === "dist/atteo.mjs" && pkg.bin["agent-soup"] === pkg.bin.atteo && pkg.bin["agent-board"] === pkg.bin.atteo, JSON.stringify(pkg));
  const alias = new URL("../cli/dist/agent-soup.mjs", import.meta.url).pathname; // the file linked installs point at
  assert(readFileSync(alias, "utf8") === readFileSync(CLI, "utf8"), "the build keeps dist/agent-soup.mjs identical to dist/atteo.mjs");
  // The old env var names alone (no ATTEO_*): sign-in and server from AGENT_BOARD_*, the session from AGENT_SOUP_SESSION.
  r = await cli(["session", "new", `old-names-${run}`, "--json"]);
  const sid = JSON.parse(r.out).session.id;
  const oldEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("ATTEO_")));
  const old = await new Promise((resolve) => {
    const p = spawn("node", [alias, "session", "show", "--json", "--quiet"], { cwd: dir, env: { ...oldEnv, AGENT_BOARD_CREDENTIALS_FILE: credA, AGENT_BOARD_SERVER: BASE, AGENT_SOUP_SESSION: sid, XDG_CONFIG_HOME: join(dir, "cfg-old-names") } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.stdin.end();
    p.on("close", (code) => resolve({ code, out }));
  });
  assert(old.code === 0 && JSON.parse(old.out.slice(old.out.indexOf("{"))).session.id === sid, old.out);
  // An install from before the rename (just an agent-soup file, updated in place) gets the atteo command beside it.
  const bin = mkdtempSync(join(tmpdir(), "atteo-oldbin-"));
  writeFileSync(join(bin, "agent-soup"), readFileSync(CLI), { mode: 0o755 });
  execFileSync("node", [join(bin, "agent-soup"), "version"]);
  assert(realpathSync(join(bin, "atteo")) === realpathSync(join(bin, "agent-soup")), "atteo links to the agent-soup file");
  // Older CLIs update themselves from the old path.
  const [a, b] = await Promise.all(["/cli/atteo.mjs", "/cli/agent-soup.mjs"].map((p) => fetch(BASE + p).then((x) => x.text())));
  assert(a.length > 1000 && a === b, "both paths serve the CLI");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
