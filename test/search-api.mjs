// Local integration check for compact CLI/MCP output, REST compatibility and continuation cursors.
// Run npm run build:cli first. BASE=http://localhost:8805 node test/search-api.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.env.BASE ?? "http://localhost:8805";
const url = new URL(base);
assert(["localhost", "127.0.0.1"].includes(url.hostname) && +url.port >= 8805 && +url.port <= 8809, "Use local ports 8805–8809");
const key = process.env.ADMIN_KEY ?? readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").match(/^ADMIN_KEY\s*=\s*["']?([^\r\n"']+)/m)?.[1];
async function json(path, body, headers = {}) {
  const r = await fetch(`${base}${path}`, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
  assert(r.ok, `${path.split("?")[0]}: HTTP ${r.status}`);
  return r.json();
}
const ops = (path, body) => json(`/api/ops/${path}`, body, { "x-admin-key": key });
const user = `search-smoke-${Date.now().toString(36)}`;
await ops("users", { name: user, email: `${user}@example.com`, verified: "true" });
const token = (await ops("tokens", { user })).token;
const cookie = (await ops("sessions", { user })).cookie;
const headers = { authorization: `Bearer ${token}` };
const boards = [];
for (let i = 0; i < 2; i++) {
  const board = (await ops("boards", { user, title: `Search smoke ${i}` })).board.id;
  boards.push(board);
  for (let j = 0; j < 4; j++) await json(`/api/boards/${board}/entries`, { text: `needle board ${i} result ${j}\nneedle duplicate ${j}\nneedle duplicate ${j}`, own: false }, { cookie });
}
const grep = (opts, all = false) => json(`${all ? "/api/grep" : `/api/boards/${boards[0]}/grep`}?${new URLSearchParams({ q: "needle", max: "1", ...opts })}`, null, headers);
let more;
const seen = new Set();
for (let i = 0; i < 40; i++) {
  const r = await grep(more ? { more } : {}, true);
  assert(r.count <= 1 && r.count === r.hits.length);
  for (const h of r.hits) {
    const identity = `${h.board}:${h.seq}:${h.line}`;
    assert(!seen.has(identity), "Continuation repeated a hit");
    seen.add(identity);
    assert(h.ts && h.author === user && h.text.includes("«needle»"));
    assert(!("after" in h), "Internal cursors must stay out of public hits");
  }
  more = r.more;
  if (!more) break;
}
assert.equal(more, null, "Continuation must terminate");
assert.equal(seen.size, 16, "All unique entry lines across both boards must survive early stop");
const legacy = await grep({ max: "20" });
assert(legacy.text.includes(`#4 ${user}:`), "Legacy REST output remains available");
const compact = await grep({ max: "20", compact: "1" });
assert.match(compact.text, new RegExp(`#4 · ${user} · \\d{2}-\\d{2} ·`));
let rpc = 0;
async function mcp(name, args) {
  const r = await json(`/mcp?board=${boards[0]}`, { jsonrpc: "2.0", id: ++rpc, method: "tools/call", params: { name, arguments: args } }, headers);
  assert(!r.error && !r.result?.isError, "MCP call must succeed");
  return r.result.content.map((c) => c.text ?? "").join("\n");
}
const searchSeen = new Set();
more = undefined;
for (let i = 0; i < 10; i++) {
  const text = await mcp("search", { query: "needle", limit: 1, ...(more ? { more } : {}) });
  const seqs = [...text.matchAll(/^#(\d+) · /gm)].map((m) => +m[1]);
  for (const seq of seqs) { assert(!searchSeen.has(seq)); searchSeen.add(seq); }
  assert(!text.includes("match:"), "Search doesn't repeat body and snippet");
  more = text.match(/^more: (\S+)$/m)?.[1];
  if (!more) break;
}
assert.equal(searchSeen.size, 4);
const mcpGrep = await mcp("grep", { pattern: "needle", compact: true, max: 1 });
assert.match(mcpGrep, /^#4 · /m);
assert.match(mcpGrep, /^more: /m);
assert((await mcp("search", { query: "needle", compact: false })).includes("needle board 0 result 3"), "Legacy search body remains available");
const dir = mkdtempSync(join(tmpdir(), "sol-search-api-"));
const credentials = join(dir, "credentials.json");
writeFileSync(credentials, JSON.stringify({ server: base, user, token, expires_at: Date.now() + 86400000 }), { mode: 0o600 });
async function cli(args) {
  const p = spawn("node", [new URL("../cli/dist/atteo.mjs", import.meta.url).pathname, ...args, "--board", boards[0], "--quiet"], {
    cwd: dir, env: { ...process.env, ATTEO_CREDENTIALS_FILE: credentials, ATTEO_SERVER: base, XDG_CONFIG_HOME: join(dir, "config") },
  });
  let out = "", err = "";
  p.stdout.on("data", (s) => { out += s; });
  p.stderr.on("data", (s) => { err += s; });
  return new Promise((resolve, reject) => { p.on("error", reject); p.on("close", (code) => resolve({ code, out, err })); });
}
let r = await cli(["find", "needle", "--max", "1"]);
assert.equal(r.code, 0, "atteo find must succeed");
assert.match(r.out, /^#4 · /m);
more = r.out.match(/^more: (\S+)$/m)?.[1];
assert(more, "CLI exposes the continuation");
r = await cli(["find", "needle", "--max", "1", "--more", more, "--json"]);
assert.equal(r.code, 0);
assert.equal(JSON.parse(r.out).hits[0].seq, 4);
assert.equal(JSON.parse(r.out).hits[0].line, 2);
r = await cli(["grep", "needle", "--max", "1"]);
assert(r.out.includes(`#4 ${user}:`), "Legacy CLI output remains available");
r = await cli(["search", "needle", "--limit", "1", "--compact"]);
assert.match(r.out, /^#\d+ · /m);
r = await cli(["find", "missingneedle"]);
assert.equal(r.code, 1);
r = await cli(["find", "(a+)+", "-E"]);
assert.equal(r.code, 2);
console.log("Search integration passed: REST/MCP/CLI compact and legacy output, cross-board continuation (16 unique lines), ranked continuation, duplicate removal and CLI exit codes.");
