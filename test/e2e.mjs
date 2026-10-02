// End-to-end test: two agents talk through a board over MCP with personal tokens, plus access control,
// web pages and the ops API.
// Usage: BASE=http://localhost:8787 ADMIN_KEY=... node test/e2e.mjs
// Creates e2e-* users and "e2e …" boards on the target (remove with scripts/cleanup-e2e.sh). Sends no email.

import { readFileSync } from "node:fs";

const BASE = (process.env.BASE ?? "http://localhost:8787").replace(/\/$/, "");
let ADMIN_KEY = process.env.ADMIN_KEY;
if (!ADMIN_KEY) {
  try {
    ADMIN_KEY = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").match(/^ADMIN_KEY=(.*)$/m)?.[1];
  } catch {}
}
// A failed step can leave a background wait() promise rejected; report it instead of crashing the run.
process.on("unhandledRejection", (e) => console.log(`      (background: ${e?.message ?? e})`));

let passed = 0;
let failed = 0;
const failures = [];
async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name} (${Date.now() - t0}ms)`);
  } catch (e) {
    failed++;
    failures.push(name);
    console.log(`  ✗ ${name}\n      ${e?.message ?? e}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function has(text, needle) {
  assert(text.includes(needle), `expected to find ${JSON.stringify(needle)} in:\n${String(text).slice(0, 1200)}`);
}

// ---- helpers ----
const run = Date.now().toString(36).slice(-5);
const A = `e2e-vedu-${run}`;
const B = `e2e-jxn-${run}`;
const OUT = `e2e-out-${run}`;
const UNV = `e2e-unv-${run}`;
const tok = {};
const cookie = {};

async function ops(path, body, key = ADMIN_KEY) {
  const r = await fetch(`${BASE}/api/ops/${path}`, {
    method: body ? "POST" : "GET",
    headers: { ...(key ? { "x-admin-key": key } : {}), "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

let rpcId = 0;
async function rpcRaw(headers, board, method, params, { notification = false } = {}) {
  const res = await fetch(`${BASE}/mcp${board ? `?board=${board}` : ""}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(notification ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  if (notification) return { status: res.status };
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result;
}
const auth = (who) => (who ? { authorization: `Bearer ${tok[who] ?? who}` } : {});
async function tool(who, board, name, args = {}) {
  const r = await rpcRaw(auth(who), board, "tools/call", { name, arguments: args });
  return { text: r.content.map((c) => c.text).join("\n"), isError: !!r.isError };
}
async function ok(who, board, name, args) {
  const r = await tool(who, board, name, args);
  assert(!r.isError, `${name} failed: ${r.text}`);
  return r.text;
}
async function err(who, board, name, args, needle) {
  const r = await tool(who, board, name, args);
  assert(r.isError, `${name} should have failed but returned: ${r.text}`);
  if (needle) has(r.text, needle);
  return r.text;
}
// Explicit MCP sessions: initialize returns an Mcp-Session-Id that later calls send back (as Claude Code does).
async function session(who, board = null) {
  const res = await fetch(`${BASE}/mcp${board ? `?board=${board}` : ""}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...auth(who) },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } }),
  });
  const sid = res.headers.get("mcp-session-id");
  assert(sid, "initialize should return Mcp-Session-Id");
  return { who, sid, board };
}
async function stool(sess, name, args = {}) {
  const res = await fetch(`${BASE}/mcp${sess.board ? `?board=${sess.board}` : ""}`, {
    method: "POST",
    headers: { "content-type": "application/json", "mcp-session-id": sess.sid, ...auth(sess.who) },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  });
  const r = (await res.json()).result;
  return { text: r.content.map((c) => c.text).join("\n"), isError: !!r.isError };
}
async function sok(sess, name, args) {
  const r = await stool(sess, name, args);
  assert(!r.isError, `${name} failed: ${r.text}`);
  return r.text;
}
async function serr(sess, name, args, needle) {
  const r = await stool(sess, name, args);
  assert(r.isError, `${name} should have failed but returned: ${r.text}`);
  if (needle) has(r.text, needle);
  return r.text;
}

const web = (path, who, init = {}) =>
  fetch(`${BASE}${path}`, { redirect: "manual", ...init, headers: { ...(init.headers ?? {}), ...(who ? { cookie: cookie[who] } : {}) } });
const seqOf = (t) => Number(t.match(/#(\d+)/)[1]);

console.log(`E2E against ${BASE}`);
let board;
let q1;

await step("health", async () => {
  assert((await fetch(`${BASE}/health`)).ok, "not ok");
});

await step("setup through the ops API: users, tokens, sessions", async () => {
  assert(ADMIN_KEY, "ADMIN_KEY not available");
  for (const [n, e, v] of [[A, `${A}@example.com`, "true"], [B, `${B}@example.com`, "true"], [OUT, `${OUT}@example.com`, "true"], [UNV, `${UNV}@example.com`, "false"]]) {
    const r = await ops("users", { name: n, email: e, verified: v });
    assert(r.status === 201, `create ${n}: ${r.status} ${JSON.stringify(r.body)}`);
    const t = await ops("tokens", { user: n, label: "e2e" });
    assert(t.body.token?.startsWith("ab_"), JSON.stringify(t.body));
    tok[n] = t.body.token;
    const s = await ops("sessions", { user: n });
    cookie[n] = s.body.cookie;
    assert(cookie[n]?.startsWith("ab_session="), JSON.stringify(s.body));
  }
  assert((await ops("users", { name: A })).status === 409, "duplicate name should conflict");
});

await step("ops API is invisible without the key", async () => {
  assert((await ops("overview", null, null)).status === 404, "no key should 404");
  assert((await ops("overview", null, "wrong")).status === 404, "wrong key should 404");
});

await step("MCP initialize, tools/list, notifications, protocol errors", async () => {
  const r = await rpcRaw(auth(A), null, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
  assert(r.protocolVersion === "2025-06-18" && r.serverInfo.name === "agent-board", JSON.stringify(r));
  has(r.instructions, "Agent Board");
  const names = (await rpcRaw(auth(A), null, "tools/list", {})).tools.map((t) => t.name).sort();
  assert(JSON.stringify(names) === JSON.stringify(["create_board", "get", "invite", "join_board", "leave_board", "list_boards", "post", "read", "retract", "search", "wait"]), names.join());
  assert((await rpcRaw({}, null, "notifications/initialized", {}, { notification: true })).status === 202, "notification status");
  assert((await fetch(`${BASE}/mcp`)).status === 405, "GET /mcp should be 405");
  const p = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
  assert(p.status === 400, "parse error");
});

await step("MCP rejects missing, legacy X-User, unknown and malformed tokens with clear guidance", async () => {
  has((await tool(null, null, "list_boards")).text, "Not signed in");
  const legacy = await rpcRaw({ "x-user": "vedu" }, null, "tools/call", { name: "list_boards", arguments: {} });
  assert(legacy.isError, "legacy should error");
  has(legacy.content[0].text, "X-User header is no longer accepted");
  has((await tool("ab_not-a-real-token", null, "list_boards")).text, "not valid");
  has((await tool("garbage", null, "list_boards")).text, "not valid");
});

await step("A creates a board and is its only member", async () => {
  const text = await ok(A, null, "create_board", { title: `e2e ${run}` });
  board = text.match(/\((b_[a-z0-9]+)\)/)?.[1];
  assert(board, text);
  has(await ok(A, board, "read"), `Members: ${A}`);
});

await step("non-members cannot read, post, wait, get, search or invite", async () => {
  for (const [name, args] of [["read", {}], ["post", { type: "note", text: "x" }], ["wait", { timeout_seconds: 1 }], ["get", { seq: 1 }], ["search", { query: "x" }], ["invite", { email: "a@b.co" }]]) {
    await err(B, board, name, args, "not a member");
  }
  await err(OUT, "b_doesnotexist1", "read", {}, "not a member");
  await err(A, "../etc", "read", {}, "not a member");
});

await step("adding B as a member grants access", async () => {
  assert((await ops("members", { board, user: B })).status === 200, "add member");
  const t = await ok(B, board, "read");
  has(t, `Members: ${A}, ${B}`);
  has(t, "(nothing new)");
});

await step("core loop: B waits, A asks, B receives the question in real time", async () => {
  const waiting = ok(B, board, "wait", { timeout_seconds: 20 });
  await new Promise((r) => setTimeout(r, 400));
  const t0 = Date.now();
  q1 = seqOf(await ok(A, board, "post", { type: "question", to: B, text: "Can you share the failing stack trace from checkout?" }));
  has(await waiting, `#${q1} question · ${A} → ${B}`);
  assert(Date.now() - t0 < 3000, `delivery took ${Date.now() - t0}ms`);
});

await step("B answers with an artifact and a claim; A's wait receives them", async () => {
  const waiting = ok(A, board, "wait", { timeout_seconds: 20 });
  await new Promise((r) => setTimeout(r, 300));
  await ok(B, board, "post", { type: "artifact", reply_to: q1, text: "Stack trace", artifact_name: "trace.log", artifact_content: "TypeError at charge (checkout.js:42)" });
  has(await waiting, "trace.log");
  await ok(B, board, "post", { type: "claim", reply_to: q1, text: "charge() gets an undefined payment when the cart is empty." });
  has(await ok(A, board, "wait", { timeout_seconds: 5 }), `re #${q1}`);
});

await step("summary, get, search, resolves and supersedes", async () => {
  const s = await ok(A, board, "read");
  has(s, "Open questions:\n  none");
  has(s, "trace.log");
  has(await ok(A, board, "get", { seq: q1 }), "Related entries:");
  const hit = await ok(A, board, "search", { query: "checkout.js:42" });
  has(await ok(A, board, "get", { seq: Number(hit.match(/#(\d+) artifact/)[1]) }), "TypeError at charge");
  const t = seqOf(await ok(A, board, "post", { type: "task", to: B, text: "Guard empty carts" }));
  const d = seqOf(await ok(A, board, "post", { type: "decision", text: "Ship behind a flag" }));
  await ok(B, board, "post", { type: "note", text: "Guard added", resolves: [t] });
  await ok(A, board, "post", { type: "decision", text: "Ship without a flag", supersedes: d });
  const s2 = await ok(B, board, "read");
  has(s2, "Open tasks:\n  none");
  has(s2, "without a flag");
  assert(!s2.includes(`#${d} (${A}) Ship behind`), "superseded decision still listed");
});

await step("validation errors are tool errors", async () => {
  await err(A, board, "post", { type: "gossip", text: "x" }, "type must be one of");
  await err(A, board, "post", { type: "note", text: " " }, "text is required");
  await err(A, board, "post", { type: "note", text: "x", reply_to: 99999 }, "does not exist");
  await err(A, board, "post", { type: "artifact", text: "x" }, "artifact_name");
  await err(A, board, "invite", { email: "nope" }, "valid email");
});

await step("wait times out cleanly", async () => {
  await ok(B, board, "read");
  const t0 = Date.now();
  has(await ok(B, board, "wait", { timeout_seconds: 1 }), "Nothing new");
  assert(Date.now() - t0 < 4000, "too slow");
});

await step("20 concurrent posts get unique, contiguous sequence numbers", async () => {
  const seqs = (await Promise.all(Array.from({ length: 20 }, (_, i) => ok(i % 2 ? A : B, board, "post", { type: "note", text: `burst ${i}` })))).map(seqOf).sort((a, b) => a - b);
  assert(new Set(seqs).size === 20 && seqs[19] - seqs[0] === 19, seqs.join());
});

await step("list_boards shows only your boards", async () => {
  has(await ok(B, null, "list_boards"), board);
  has(await ok(OUT, null, "list_boards"), "not on any board yet");
});

await step("web: signed-out visitors are sent to sign-in; landing renders", async () => {
  const home = await web("/");
  assert(home.status === 200, `home ${home.status}`);
  has(await home.text(), "Sign in");
  const b = await web(`/b/${board}`);
  assert(b.status === 303 && b.headers.get("location").startsWith("/auth/login?return="), `board ${b.status} ${b.headers.get("location")}`);
  assert((await web(`/join/${board}`)).headers.get("location") === `/b/${board}`, "join redirect");
});

await step("web: sign-in redirects to WorkOS AuthKit with our client and callback", async () => {
  const r = await web("/auth/login?return=/me");
  const loc = r.headers.get("location") ?? "";
  assert(r.status === 303 && loc.startsWith("https://api.workos.com/user_management/authorize?"), loc);
  const u = new URL(loc);
  assert(u.searchParams.get("provider") === "authkit" && u.searchParams.get("redirect_uri") === `${BASE}/auth/callback`, loc);
  assert(u.searchParams.get("client_id")?.startsWith("client_"), "client id");
  has(r.headers.get("set-cookie") ?? "", "ab_oauth=");
  assert((await web("/auth/callback?code=x&state=forged")).status === 400, "forged state should 400");
  const noState = await web("/auth/callback?code=x");
  assert(noState.status === 303 && noState.headers.get("location") === "/auth/login", `WorkOS-initiated callback should restart sign-in, got ${noState.status} ${noState.headers.get("location")}`);
});

await step("web: members see the board; outsiders get 404", async () => {
  const page = await web(`/b/${board}`, A);
  assert(page.status === 200, `member ${page.status}`);
  const html = await page.text();
  has(html, `e2e ${run}`);
  has(html, "Connect an agent");
  has(html, "burst 19");
  assert((await web(`/b/${board}`, OUT)).status === 404, "outsider should 404");
  assert((await web(`/api/boards/${board}/updates?after=0`, OUT)).status === 404, "outsider API should 404");
});

await step("web: live updates (incl. long-poll), entry detail and posting from the composer", async () => {
  const u = await (await web(`/api/boards/${board}/updates?after=${q1}`, B)).json();
  assert(u.entries.length > 5 && u.entries.every((e) => e.seq > q1 && e.html && e.row) && typeof u.last === "number", "updates shape");
  // Long-poll returns as soon as someone posts.
  const t0 = Date.now();
  const lp = web(`/api/boards/${board}/updates?after=${u.last}&wait=20`, B).then((r) => r.json());
  await new Promise((r) => setTimeout(r, 400));
  await ok(A, board, "post", { type: "note", text: "long-poll wake-up" });
  const lpr = await lp;
  assert(lpr.entries.some((e) => e.html.includes("long-poll wake-up")) && Date.now() - t0 < 4000, `long-poll ${Date.now() - t0}ms`);
  const d = await (await web(`/api/boards/${board}/entries/${q1}`, B)).json();
  assert(d.entry.seq === q1 && d.replies.length >= 2, JSON.stringify(d).slice(0, 200));
  const post = await web(`/api/boards/${board}/entries`, B, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "decision", text: "Posted from the web", to: A }) });
  assert(post.status === 201, `post ${post.status}`);
  has(await ok(A, board, "read"), "Posted from the web");
  const outsiderPost = await web(`/api/boards/${board}/entries`, OUT, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x" }) });
  assert(outsiderPost.status === 404, `outsider post ${outsiderPost.status}`);
});

await step("web: home lists my boards; tokens can be created and revoked", async () => {
  has(await (await web("/", A)).text(), `e2e ${run}`);
  const r = await web("/api/tokens", A, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ board, label: "e2e web" }) });
  const t = await r.json();
  assert(r.status === 201 && t.command.includes(`Authorization: Bearer ${t.token}`) && t.command.includes("--scope user") && !t.command.includes("board="), JSON.stringify(t));
  assert(t.mcp_url === `${BASE}/mcp`, `mcp_url ${t.mcp_url}`);
  assert(t.project_command.includes("--scope project") && t.project_command.includes(`/mcp?board=${board}`), t.project_command);
  has(await ok(t.token, board, "read"), `Board "e2e ${run}"`);
  has(await (await web("/me", A)).text(), "e2e web");
  assert((await web(`/api/tokens/${t.id}/revoke`, B, { method: "POST" })).status === 404, "cannot revoke someone else's token");
  assert((await web(`/api/tokens/${t.id}/revoke`, A, { method: "POST" })).status === 200, "revoke");
  has((await tool(t.token, board, "read")).text, "not valid");
});

await step("web: invite validation and member-only invites", async () => {
  const bad = await web(`/api/boards/${board}/invites`, A, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "nope" }) });
  assert(bad.status === 400, `bad email ${bad.status}`);
  const outsider = await web(`/api/boards/${board}/invites`, OUT, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "x@y.co" }) });
  assert(outsider.status === 404, `outsider invite ${outsider.status}`);
});

await step("ops console is hidden from non-operators; ops API lists everything", async () => {
  assert((await web("/_ops", A)).status === 404, "member without operator rights should 404");
  assert((await web("/admin", A)).status === 404, "old /admin path should not exist");
  const o = await ops("overview");
  const b = o.body.boards.find((x) => x.id === board);
  assert(b && b.members.includes(A) && b.members.includes(B) && b.entry_count === 29, `expected 29 entries: ${JSON.stringify(b)}`);
  const acc = o.body.access.find((x) => x.user === B);
  assert(acc && acc.boards.some((x) => x.id === board) && acc.active_tokens >= 1, JSON.stringify(acc));
});


// ---- one board per session ----
let board2;
await step("an unpinned session must join a board first; the error lists the user's boards", async () => {
  board2 = (await ops("boards", { user: A, title: `e2e second ${run}` })).body.board.id;
  const s1 = await session(A);
  const e = await serr(s1, "read", {}, "hasn't joined a board");
  has(e, board);
  has(e, `e2e second ${run}`);
});

await step("join_board by id and by name; read/post act on the joined board only", async () => {
  const s1 = await session(A);
  has(await sok(s1, "join_board", { board }), `Joined "e2e ${run}"`);
  has(await sok(s1, "read"), `Board "e2e ${run}"`);
  has(await sok(s1, "join_board", { board: `SECOND ${run}` }), `Joined "e2e second ${run}"`);
  has(await sok(s1, "read"), `Board "e2e second ${run}"`);
  await serr(s1, "read", { board }, "This session is on board");
  has(await sok(s1, "list_boards"), `${board2}  "e2e second ${run}"`);
  has(await sok(s1, "list_boards"), "← this session");
});

await step("ambiguous or unknown names join nothing; outsiders can't join", async () => {
  const s1 = await session(A);
  const amb = await serr(s1, "join_board", { board: `e2e` }, "matches more than one board");
  has(amb, board);
  has(amb, board2);
  await serr(s1, "read", {}, "hasn't joined");
  await serr(s1, "join_board", { board: "no such board zzz" }, "No board of yours");
  const so = await session(OUT);
  await serr(so, "join_board", { board }, "No board of yours");
});

await step("two sessions on one token stay on different boards", async () => {
  const s1 = await session(A);
  const s2 = await session(A);
  await sok(s1, "join_board", { board });
  await sok(s2, "join_board", { board: board2 });
  has(await sok(s1, "read"), `Board "e2e ${run}"`);
  has(await sok(s2, "read"), `Board "e2e second ${run}"`);
  const p = await sok(s2, "post", { type: "note", text: `only on second ${run}` });
  has(p, board2);
  assert(!(await ok(A, board, "search", { query: `only on second ${run}` })).includes("match(es)"), "post leaked to the other board");
});

await step("ending a session (DELETE /mcp) forgets its board", async () => {
  const s1 = await session(A);
  await sok(s1, "join_board", { board });
  const d = await fetch(`${BASE}/mcp`, { method: "DELETE", headers: { "mcp-session-id": s1.sid, ...auth(A) } });
  assert(d.status === 204, `delete ${d.status}`);
  await serr(s1, "read", {}, "hasn't joined");
});

await step("a pinned connection can't switch boards", async () => {
  const p = await session(A, board);
  has(await sok(p, "read"), `Board "e2e ${run}"`);
  await serr(p, "join_board", { board: board2 }, "pinned to board");
});

await step("invites wait for an answer; joining by name accepts", async () => {
  const sa = await session(A);
  await sok(sa, "join_board", { board: board2 });
  has(await sok(sa, "invite", { email: `${B}@example.com` }), "already have an account");
  has(await sok(sa, "invite", { email: `${B}@example.com` }), "already has an open invitation");
  await err(B, board2, "read", {}, "not a member"); // not added until B answers
  const sb = await session(B);
  has(await sok(sb, "list_boards"), `"e2e second ${run}"  from ${A}`);
  has(await sok(sb, "join_board", { board: "second" }), `Accepted ${A}'s invitation`);
  has(await sok(sb, "read"), `Board "e2e second ${run}"`);
  has(await sok(sa, "invite", { email: `${B}@example.com` }), "already a member");
});

await step("unverified emails can't see or accept invitations", async () => {
  const sa = await session(A);
  await sok(sa, "join_board", { board: board2 });
  await sok(sa, "invite", { email: `${UNV}@example.com` });
  const su = await session(UNV);
  const l = await sok(su, "list_boards");
  assert(!l.includes(`e2e second ${run}`), "unverified user should not see the invitation");
  await serr(su, "join_board", { board: "second" }, "No board of yours");
});

await step("web: invitations on home with decline and accept", async () => {
  const inv = (email) =>
    web(`/api/boards/${board2}/invites`, A, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) }).then((r) => r.json());
  has((await inv(`${OUT}@example.com`)).message, "already have an account");
  let home = await (await web("/", OUT)).text();
  has(home, "Invitations");
  has(home, `e2e second ${run}`);
  assert((await web(`/api/invitations/${board2}/decline`, OUT, { method: "POST" })).status === 200, "decline");
  assert(!(await (await web("/", OUT)).text()).includes(`/api/invitations/${board2}/accept`), "declined invitation still shown");
  assert((await web(`/api/invitations/${board2}/accept`, OUT, { method: "POST" })).status === 404, "can't accept a declined invitation");
  await inv(`${OUT}@example.com`);
  const acc = await web(`/api/invitations/${board2}/accept`, OUT, { method: "POST" });
  assert(acc.status === 200, `accept ${acc.status}`);
  assert((await web(`/b/${board2}`, OUT)).status === 200, "accepted invitee should see the board");
  assert((await web(`/api/invitations/${board}/accept`, OUT, { method: "POST" })).status === 404, "no invitation, no access");
});

await step("retract: author withdraws own entry; creator can withdraw any; others can't; once only", async () => {
  // board: A is creator, B is a member.
  const c1 = seqOf(await ok(B, board, "post", { type: "claim", text: `wrong claim ${run}` }));
  const q2 = seqOf(await ok(B, board, "post", { type: "question", to: A, text: `retract me ${run}` }));
  const a3 = seqOf(await ok(A, board, "post", { type: "note", text: `A's note ${run}` }));
  has(await ok(B, board, "retract", { seq: c1, reason: "Measured wrong service" }), `Retracted #${c1}`);
  await err(B, board, "retract", { seq: c1 }, "already retracted");
  await err(B, board, "retract", { seq: a3 }, "can retract it");
  has(await ok(A, board, "retract", { seq: q2 }), `Retracted #${q2}`); // creator retracts B's question
  const s = await ok(A, board, "read", { since: 0, limit: 200 });
  const summary = s.split("== Entries after")[0];
  assert(!summary.includes(`wrong claim ${run}`) && !summary.includes(`retract me ${run}`), "retracted entries still in summary");
  has(await ok(A, board, "get", { seq: c1 }), `retracts #${c1}`);
  // web: author can retract via the API, outsiders can't, and live updates carry the retraction
  const n = seqOf(await ok(B, board, "post", { type: "note", text: `web retract ${run}` }));
  const r = await web(`/api/boards/${board}/entries/${n}/retract`, B, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert(r.status === 201, `web retract ${r.status}`);
  const o = await web(`/api/boards/${board}/entries/${a3}/retract`, OUT, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert(o.status === 404, `outsider retract ${o.status}`);
  const u = await (await web(`/api/boards/${board}/updates?after=${n}`, A)).json();
  assert(u.entries.some((e) => e.retracts === n), "updates should carry the retraction");
  const page = await (await web(`/b/${board}`, A)).text();
  has(page, `class="entry retracted" id="e${c1}"`);
});

await step("creator removes a member: their wait ends, their access is gone", async () => {
  // OUT accepted an invitation to board2 in the previous step; A created board2.
  const so = await session(OUT);
  await sok(so, "join_board", { board: board2 });
  const t0 = Date.now();
  const waiting = stool(so, "wait", { timeout_seconds: 30 });
  await new Promise((r) => setTimeout(r, 400));
  const rm = await web(`/api/boards/${board2}/members/${OUT}/remove`, A, { method: "POST" });
  assert(rm.status === 200, `remove ${rm.status}`);
  const w = await waiting;
  assert(Date.now() - t0 < 5000, `wait should end on removal, took ${Date.now() - t0}ms`);
  assert(!w.text.includes("new from others"), `removed member got entries: ${w.text}`);
  await serr(so, "read", {}, "hasn't joined"); // removal also clears the session's board
  await serr(so, "join_board", { board: board2 }, "No board of yours");
  assert((await web(`/b/${board2}`, OUT)).status === 404, "removed member should get 404");
  assert(!(await (await web("/", OUT)).text()).includes(`/b/${board2}`), "board still on removed member's home");
});

await step("only the creator removes people; the creator can't leave", async () => {
  const r = await web(`/api/boards/${board}/members/${A}/remove`, B, { method: "POST" });
  assert(r.status === 403, `non-creator remove ${r.status}`);
  const self = await web(`/api/boards/${board}/members/${A}/remove`, A, { method: "POST" });
  assert(self.status === 400, `creator leave ${self.status}`);
  const sa = await session(A);
  await sok(sa, "join_board", { board });
  await serr(sa, "leave_board", {}, "can't leave");
});

await step("a member leaves through their agent", async () => {
  const sb = await session(B);
  await sok(sb, "join_board", { board: board2 });
  has(await sok(sb, "leave_board"), "Left");
  await serr(sb, "read", {}, "hasn't joined");
  has(await sok(sb, "list_boards"), board); // still on the first board
  assert(!(await sok(sb, "list_boards")).includes(`${board2}  "e2e second`), "left board still listed");
});

if (/localhost|127\.0\.0\.1/.test(BASE)) {
  await step("boards past 1,000 entries page through updates without looping (local only)", async () => {
    const big = (await ops("boards", { user: A, title: `e2e big ${run}` })).body.board.id;
    const N = 1010;
    for (let i = 0; i < N; i += 50) {
      await Promise.all(Array.from({ length: Math.min(50, N - i) }, (_, k) => ok(A, big, "post", { type: "note", text: `n${i + k}` })));
    }
    const p1 = await (await web(`/api/boards/${big}/updates?after=0`, A)).json();
    assert(p1.entries.length === 1000 && p1.last === 1000, `page 1: ${p1.entries.length} entries, last ${p1.last}`);
    const p2 = await (await web(`/api/boards/${big}/updates?after=${p1.last}`, A)).json();
    assert(p2.entries.length === N - 1000 && p2.last === N, `page 2: ${p2.entries.length} entries, last ${p2.last}`);
    const t0 = Date.now();
    const p3 = await (await web(`/api/boards/${big}/updates?after=${p2.last}&wait=1`, A)).json();
    assert(p3.entries.length === 0 && p3.last === N && Date.now() - t0 >= 900, `caught-up long-poll should wait, got ${p3.entries.length} in ${Date.now() - t0}ms`);
  });
}

console.log(`\n${passed} passed, ${failed} failed${failures.length ? `: ${failures.join("; ")}` : ""}`);
process.exit(failed ? 1 : 0);
