// atteo ping (jxn #5433), one local round trip: an agent's CLI socket answers the board's ping frame and shows as
// listening with its round trip; a socket that never answers (an older CLI) shows as connected (old CLI), not offline;
// nothing lands on the board, non-members can't ping, and pings are capped. BASE, ADMIN_KEY.
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": process.env.ADMIN_KEY || "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), A = `pa${run}`, B = `pb${run}`, C = `pc${run}`;
for (const u of [A, B, C]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true" });
const board = (await ops("boards", { user: A, title: `Ping ${run}` })).board.id;
await ops("members", { board, user: B });
const tok = {};
for (const u of [A, B, C]) tok[u] = (await ops("tokens", { user: u })).token;
const call = (u, path, body, sid) =>
  fetch(`${BASE}${path}`, { method: "POST", headers: { authorization: `Bearer ${tok[u]}`, "content-type": "application/json", ...(sid ? { "x-atteo-session": sid } : {}) }, body: JSON.stringify(body) });
const session = async (u, name) => (await (await call(u, "/api/sessions", { suggest: name, client: "Claude Code" })).json()).session;
const ping = async (u, body) => {
  const r = await call(u, `/api/boards/${board}/ping`, body);
  return { status: r.status, j: await r.json() };
};

let fails = 0;
const check = (ok, t) => {
  console.log(`${ok ? "✓" : "✗"} ${t}`);
  if (!ok) fails++;
};

// B's agent: one session whose CLI answers pings (like this CLI's follow()), one an older CLI that ignores them.
const fresh = await session(B, "fresh"), old = await session(B, "old");
const open = (s, answer) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/api/boards/${board}/ws`, { headers: { authorization: `Bearer ${tok[B]}`, "x-atteo-session": s.id } });
    ws.onmessage = (m) => {
      let d = null;
      try {
        d = JSON.parse(String(m.data));
      } catch {}
      if (d?.type === "hello") resolve(ws);
      if (answer && d?.type === "ping") ws.send(JSON.stringify({ type: "pong", id: d.id }));
    };
    ws.onerror = () => reject(new Error("socket failed"));
  });
const a = await open(fresh, true), b = await open(old, false);
// The board's last seq, from a socket's hello: a ping must not add an entry.
const lastSeq = () =>
  new Promise((resolve) => {
    const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/api/boards/${board}/ws`, { headers: { authorization: `Bearer ${tok[A]}` } });
    ws.onmessage = (m) => {
      const d = JSON.parse(String(m.data));
      if (d.type === "hello") (resolve(d.last), ws.close());
    };
    ws.onerror = () => resolve(null);
  });
const before = await lastSeq();

const t0 = Date.now();
const r = await ping(A, { to: B });
const row = (name) => (r.j.agents ?? []).find((x) => x.session === name);
check(r.status === 200, `A pings B's agent (${r.status} ${JSON.stringify(r.j).slice(0, 200)})`);
check(row("fresh")?.state === "listening" && Number.isFinite(row("fresh")?.rtt_ms), `the answering CLI is listening, with a round trip (${row("fresh")?.line})`);
check(row("old")?.state === "old_cli" && /old CLI, atteo update/.test(row("old")?.line ?? ""), `the silent socket shows as connected (old CLI), not offline (${row("old")?.line})`);
check(Date.now() - t0 < 6000, `the ping gives up on the silent one in about 3s (${Date.now() - t0} ms)`);
const quiet = await ping(A, { to: B, probe: false });
check((quiet.j.agents ?? []).every((x) => x.state === "connected"), `without probing, both are just connected (${(quiet.j.agents ?? []).map((x) => x.state).join(", ")})`);
const after = await lastSeq();
check(before != null && before === after, `nothing was posted on the board (last seq ${before} → ${after})`);
check((await ping(C, { to: B })).status === 404, "someone who isn't on the board can't ping");
check((await ping(A, { to: C })).status === 404, "…nor ping someone who isn't on it");
a.close();
b.close();
let capped = false;
for (let i = 0; i < 12 && !capped; i++) capped = (await ping(A, { to: A })).status === 429;
check(capped, "pings are capped per person (10 a minute)");

console.log(fails ? `${fails} FAILED` : "ping: all passed");
process.exit(fails ? 1 : 0);
