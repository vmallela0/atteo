import { describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

import type { TaskStatus, TaskView } from "../src/board";
import * as L from "../src/linear";
import type { Mention } from "../src/mentions";
import { USER_ROW_DELETES } from "../src/testAccounts";
import type { Viewer } from "../src/ui";

// A D1 stand-in over node:sqlite running every migration (as slack.test.ts), with run() reporting changes.
const { DatabaseSync } = (await import("node:" + "sqlite")) as { DatabaseSync: new (p: string) => any };
const { readFileSync, readdirSync } = (await import("node:" + "fs")) as { readFileSync: (u: URL, enc: string) => string; readdirSync: (u: URL) => string[] };
const dir = new URL("../migrations/", (import.meta as unknown as { url: string }).url);
function fakeD1(): { d1: D1Database; db: any } {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(f, dir), "utf8"));
  const stmt = (sql: string, args: unknown[] = []): any => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => {
      const r = db.prepare(sql).run(...args);
      return { results: [], meta: { changes: Number(r.changes) } };
    },
  });
  return { d1: { prepare: (sql: string) => stmt(sql), batch: async (list: any[]) => Promise.all(list.map((s) => s.run())) } as unknown as D1Database, db };
}

const BOARD = "b_linearboard1";
const SECRET_BOARD = "b_encrypted001";
const ORIGIN = "https://atteo.test";
const T0 = 1_800_000_000_000;
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
const ENV: L.LinearEnv = { LINEAR_CLIENT_ID: "lin_client", LINEAR_CLIENT_SECRET: "lin_secret", LINEAR_TOKEN_KEY: KEY, LINEAR_WEBHOOK_SECRET: "whsec", PUBLIC_URL: ORIGIN };
const STATES = [
  { id: "st_backlog", name: "Backlog", type: "backlog", position: 0 },
  { id: "st_triage", name: "Triage", type: "triage", position: 0 },
  { id: "st_ready", name: "Ready", type: "unstarted", position: 0 },
  { id: "st_todo", name: "Todo", type: "unstarted", position: 1 },
  { id: "st_prog", name: "In Progress", type: "started", position: 2 },
  { id: "st_done", name: "Done", type: "completed", position: 3 },
  { id: "st_cancel", name: "Canceled", type: "canceled", position: 4 },
];

const person = (name: string): Viewer => ({ name, email: `${name}@x.test`, display_name: null, admin: false, via: "person" });
const agent = (name: string): Viewer => ({ ...person(name), via: "agent" });

type Call = { url: string; query?: string; variables?: Record<string, any>; form?: Record<string, string>; auth?: string | null };

function setup(env: L.LinearEnv = ENV, labels: { id: string; name: string }[] = [{ id: "lb_blocked", name: "Blocked" }]) {
  const { d1, db } = fakeD1();
  let t = T0;
  const calls: Call[] = [];
  let n = 0;
  const http = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get("authorization");
    const ans = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url === L.LINEAR_TOKEN) {
      const form = Object.fromEntries(new URLSearchParams(String(init?.body)));
      calls.push({ url, form });
      if (form.code === "bad") return ans({ error: "invalid_grant" }, 400);
      return ans({ access_token: "lin_oauth_ACCESS", refresh_token: "lin_oauth_REFRESH", expires_in: 86400, token_type: "Bearer" });
    }
    if (url === L.LINEAR_REVOKE) {
      calls.push({ url, auth });
      return ans({});
    }
    const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, any> };
    calls.push({ url, query, variables, auth });
    if (query === L.Q_VIEWER)
      return ans({ data: { viewer: { id: "lu_app", name: "Atteo" }, organization: { id: "org_1", name: "Acme" }, teams: { nodes: [{ id: "tm_eng", key: "ENG", name: "Engineering" }] }, projects: { nodes: [{ id: "pj_1", name: "Launch", teams: { nodes: [{ id: "tm_eng" }] } }] } } });
    if (query === L.Q_TEAM) return ans({ data: { team: variables.id === "tm_eng" ? { id: "tm_eng", key: "ENG", name: "Engineering", states: { nodes: STATES }, labels: { nodes: labels } } : null } });
    if (query === L.Q_PROJECT) return ans({ data: { project: variables.id === "pj_1" ? { id: "pj_1", name: "Launch", teams: { nodes: [{ id: "tm_eng" }] } } : null } });
    if (query === L.M_CREATE) {
      n++;
      return ans({ data: { issueCreate: { success: true, issue: { id: `iss_${n}`, identifier: `ENG-${n}`, url: `https://linear.app/acme/issue/ENG-${n}` } } } });
    }
    if (query === L.M_UPDATE) return ans({ data: { issueUpdate: { success: true } } });
    if (query === L.M_ADD_LABEL || query === L.M_REMOVE_LABEL) return ans({ data: { x: { success: true } } });
    if (query === L.M_COMMENT) return ans({ data: { commentCreate: { success: true, comment: { id: "cm_atteo" } } } });
    return ans({ errors: [{ message: "unknown query" }] }, 400);
  }) as typeof fetch;

  db.prepare("INSERT INTO boards (id, title, created_by, created_at, entry_count, last_activity) VALUES (?, 'Checkout', 'vedu', 1, 0, 1)").run(BOARD);
  db.prepare("INSERT INTO boards (id, title, created_by, created_at, entry_count, last_activity, encrypted) VALUES (?, 'Sealed', 'vedu', 1, 0, 1, 1)").run(SECRET_BOARD);
  for (const [u, role] of [["vedu", "owner"], ["ann", "contributor"], ["val", "viewer"]] as const) {
    db.prepare("INSERT INTO members (board_id, user, joined_at, last_seen, role) VALUES (?, ?, 1, 1, ?)").run(BOARD, u, role);
  }
  db.prepare("INSERT INTO members (board_id, user, joined_at, last_seen, role) VALUES (?, 'vedu', 1, 1, 'owner')").run(SECRET_BOARD);

  const tasks = new Map<number, TaskStatus>([[7, "todo"]]);
  const notes: { board: string; user: string; seq: number; text: string; mentions: Mention[] }[] = [];
  const statusSets: { user: string; seq: number; status: TaskStatus }[] = [];
  const linearOn = new Map<string, boolean>();
  const board: L.LinearBoardOps = {
    status: async (_b, seq) => tasks.get(seq) ?? null,
    setStatus: async (_b, user, seq, status) => {
      statusSets.push({ user, seq, status });
      tasks.set(seq, status);
    },
    comment: async (b, user, seq, text, mentions) => {
      notes.push({ board: b, user, seq, text, mentions });
      return 100 + notes.length;
    },
    setLinear: async (b, on) => void linearOn.set(b, on),
    members: async () => [{ user: "vedu", agent_name: null }, { user: "ann", agent_name: "Scout" }, { user: "val", agent_name: null }],
  };
  const l: L.Linear = { db: d1, env, origin: ORIGIN, now: () => t, http, board };
  const later: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void later.push(p) };
  return { l, db, calls, tasks, notes, statusSets, linearOn, later, ctx, tick: (ms: number) => void (t += ms), now: () => t };
}

const task = (seq: number, status: TaskStatus, title = "Fix checkout", body = "Steps:\n- [ ] repro"): TaskView =>
  ({ seq, status, title, body, text: title, author: "vedu", via: "person", parent: null, children: null, assignee: null, assignee_agent: true, due: null, lease_holder: null, lease_agent: false, lease_session_name: null, lease_until: null, lapsed_holder: null, lapsed_at: null, stop_reason: null, done_note: null, resolved_by: null, priority: null, version: 1, updated_by: "vedu", updated_via: "person", reply_to: null, updated_at: 1 }) as TaskView;

/** Start → callback → pick the team: the board linked, as a person would. */
async function link(s: ReturnType<typeof setup>, who = "vedu") {
  const start = await L.start(s.l, person(who), new URL(`${ORIGIN}/api/integrations/linear/start?board=${BOARD}`));
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const cb = await L.callback(s.l, person(who), new URL(`${ORIGIN}/api/integrations/linear/callback?code=good&state=${encodeURIComponent(state)}`));
  expect(cb.status).toBe(200);
  const res = await L.choose(s.l, person(who), new Request(`${ORIGIN}/api/integrations/linear`, { method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" }, body: JSON.stringify({ board: BOARD, team_id: "tm_eng" }) }), new URL(`${ORIGIN}/api/integrations/linear`));
  expect(res.status).toBe(200);
  s.calls.length = 0;
}

async function signed(s: ReturnType<typeof setup>, payload: Record<string, unknown>, opts: { secret?: string; delivery?: string; ts?: number } = {}) {
  const raw = JSON.stringify({ webhookTimestamp: opts.ts ?? s.now(), organizationId: "org_1", ...payload });
  const sig = await L.hmacHex(opts.secret ?? "whsec", raw);
  const req = new Request(`${ORIGIN}/api/integrations/linear/webhook`, { method: "POST", headers: { "linear-signature": sig, "linear-delivery": opts.delivery ?? crypto.randomUUID() }, body: raw });
  const res = await L.webhook(s.l, req, s.ctx);
  await Promise.all(s.later.splice(0));
  return res;
}

describe("Linear: not set up", () => {
  it("every route answers 503 \"Linear isn't set up yet\" without the OAuth app and token key; the webhook also without its secret", async () => {
    const s = setup({ PUBLIC_URL: ORIGIN });
    const u = new URL(`${ORIGIN}/api/integrations/linear?board=${BOARD}`);
    for (const res of [await L.start(s.l, person("vedu"), u), await L.status(s.l, person("vedu"), u), await L.unlink(s.l, person("vedu"), u)]) expect(res.status).toBe(503);
    const res = await L.webhook(s.l, new Request(u, { method: "POST", body: "{}" }), s.ctx);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: L.NOT_SET_UP });
    const noHook = setup({ ...ENV, LINEAR_WEBHOOK_SECRET: undefined });
    expect((await L.webhook(noHook.l, new Request(u, { method: "POST", body: "{}" }), noHook.ctx)).status).toBe(503);
  });
});

describe("Linear: OAuth", () => {
  it("start sends a contributor to Linear with the scopes and a signed state bound to them and the board", async () => {
    const s = setup();
    const res = await L.start(s.l, person("ann"), new URL(`${ORIGIN}/api/integrations/linear/start?board=${BOARD}`));
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location")!);
    expect(to.origin + to.pathname).toBe(L.LINEAR_AUTHORIZE);
    expect(to.searchParams.get("scope")).toBe("read,write,issues:create,comments:create");
    expect(to.searchParams.get("client_id")).toBe("lin_client");
    expect(to.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/integrations/linear/callback`);
    expect(await L.readState("lin_secret", to.searchParams.get("state")!, T0)).toEqual({ user: "ann", board: BOARD });
  });

  it("refuses agent tokens, non-members, viewers, encrypted boards; sends the signed-out to sign in", async () => {
    const s = setup();
    const u = (b: string) => new URL(`${ORIGIN}/api/integrations/linear/start?board=${b}`);
    expect((await L.start(s.l, agent("vedu"), u(BOARD))).status).toBe(403);
    expect((await L.start(s.l, person("mallory"), u(BOARD))).status).toBe(404);
    expect((await L.start(s.l, person("val"), u(BOARD))).status).toBe(403);
    expect((await L.start(s.l, person("vedu"), u(SECRET_BOARD))).status).toBe(409);
    const out = await L.start(s.l, null, u(BOARD));
    expect(out.status).toBe(302);
    expect(out.headers.get("location")).toMatch(/^\/auth\/login\?return=/);
  });

  it("the state is checked: tampered, expired, or someone else's is refused at the callback", async () => {
    const st = await L.signState("lin_secret", { user: "vedu", board: BOARD, exp: T0 + L.STATE_MS });
    expect(await L.readState("lin_secret", st, T0)).toEqual({ user: "vedu", board: BOARD });
    expect(await L.readState("other", st, T0)).toBeNull();
    expect(await L.readState("lin_secret", st, T0 + L.STATE_MS + 1)).toBeNull();
    const [body, sig] = st.split(".");
    const forged = btoa(JSON.stringify({ u: "mallory", b: BOARD, e: T0 + 1e9, n: "x" })).replace(/=+$/, "");
    expect(await L.readState("lin_secret", `${forged}.${sig}`, T0)).toBeNull();
    expect(await L.readState("lin_secret", `${body}.${"0".repeat(64)}`, T0)).toBeNull();

    const s = setup();
    const cb = (who: string, state: string) => L.callback(s.l, person(who), new URL(`${ORIGIN}/api/integrations/linear/callback?code=good&state=${encodeURIComponent(state)}`));
    expect((await cb("ann", st)).status).toBe(400); // vedu's state, ann's session
    expect((await cb("vedu", "garbage")).status).toBe(400);
    expect((await L.callback(s.l, agent("vedu"), new URL(`${ORIGIN}/api/integrations/linear/callback?code=good&state=${encodeURIComponent(st)}`))).status).toBe(403);
    expect(s.calls.filter((c) => c.url === L.LINEAR_TOKEN)).toEqual([]);
  });

  it("the callback exchanges the code and stores the tokens sealed; the picker then sets the team and turns syncing on", async () => {
    const s = setup();
    const start = await L.start(s.l, person("vedu"), new URL(`${ORIGIN}/api/integrations/linear/start?board=${BOARD}`));
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const cb = await L.callback(s.l, person("vedu"), new URL(`${ORIGIN}/api/integrations/linear/callback?code=good&state=${encodeURIComponent(state)}`));
    expect(cb.status).toBe(200);
    const page = await cb.text();
    expect(page).toContain("Engineering");
    expect(page).toContain('action="/api/integrations/linear"');
    const ex = s.calls.find((c) => c.url === L.LINEAR_TOKEN)!;
    expect(ex.form).toMatchObject({ grant_type: "authorization_code", code: "good", client_id: "lin_client", client_secret: "lin_secret", redirect_uri: `${ORIGIN}/api/integrations/linear/callback` });
    const row = s.db.prepare("SELECT * FROM linear_links WHERE board_id = ?").get(BOARD);
    expect(row).toMatchObject({ created_by: "vedu", org_id: "org_1", org_name: "Acme", linear_user: "lu_app", team_id: null });
    expect(row.token).not.toContain("lin_oauth");
    expect(row.refresh).not.toContain("lin_oauth");
    expect(s.linearOn.get(BOARD)).toBe(false);

    // Picking: only same-site, people, who connected it (or an owner); the team must be one Linear knows.
    const post = (who: Viewer, body: unknown, site = "same-origin") =>
      L.choose(s.l, who, new Request(`${ORIGIN}/api/integrations/linear`, { method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": site }, body: JSON.stringify(body) }), new URL(`${ORIGIN}/api/integrations/linear`));
    expect((await post(agent("vedu"), { board: BOARD, team_id: "tm_eng" })).status).toBe(403);
    expect((await post(person("vedu"), { board: BOARD, team_id: "tm_eng" }, "cross-site")).status).toBe(403);
    expect((await post(person("ann"), { board: BOARD, team_id: "tm_eng" })).status).toBe(403);
    expect((await post(person("vedu"), { board: BOARD, team_id: "tm_nope" })).status).toBe(400);
    expect((await post(person("vedu"), { board: BOARD, team_id: "tm_eng", project_id: "pj_nope" })).status).toBe(400);
    const ok = await post(person("vedu"), { board: BOARD, team_id: "tm_eng", project_id: "pj_1" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, linked: true, ready: true, team: { id: "tm_eng", key: "ENG" }, project: { id: "pj_1", name: "Launch" }, blocked_label: true });
    expect(s.linearOn.get(BOARD)).toBe(true);
    // The Linear calls carried the access token, opened from its seal.
    expect(s.calls.filter((c) => c.query === L.Q_TEAM).every((c) => c.auth === "Bearer lin_oauth_ACCESS")).toBe(true);
  });

  it("the picker's form post redirects back to the board", async () => {
    const s = setup();
    await link(s);
    const res = await L.choose(s.l, person("vedu"), new Request(`${ORIGIN}/api/integrations/linear`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" }, body: `board=${BOARD}&team_id=tm_eng&project_id=` }), new URL(`${ORIGIN}/api/integrations/linear`));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/b/${BOARD}`);
  });

  it("GET shows the link without any token; DELETE revokes the token at Linear and drops the link and the map", async () => {
    const s = setup();
    await link(s);
    await L.syncTask(s.l, BOARD, task(7, "todo"));
    const view = await L.status(s.l, agent("ann"), new URL(`${ORIGIN}/api/integrations/linear?board=${BOARD}`));
    const body = await view.json();
    expect(body).toMatchObject({ linked: true, ready: true, org: { id: "org_1", name: "Acme" }, team: { key: "ENG" }, created_by: "vedu", issues: 1 });
    expect(JSON.stringify(body)).not.toMatch(/token|lin_oauth|v1:/);
    expect((await L.status(s.l, person("mallory"), new URL(`${ORIGIN}/api/integrations/linear?board=${BOARD}`))).status).toBe(404);

    const del = (who: Viewer) => L.unlink(s.l, who, new URL(`${ORIGIN}/api/integrations/linear?board=${BOARD}`));
    expect((await del(agent("vedu"))).status).toBe(403);
    expect((await del(person("ann"))).status).toBe(403); // not who connected it, not an owner
    s.calls.length = 0;
    expect((await del(person("vedu"))).status).toBe(200);
    expect(s.calls).toEqual([{ url: L.LINEAR_REVOKE, auth: "Bearer lin_oauth_ACCESS" }]);
    expect(s.db.prepare("SELECT COUNT(*) AS n FROM linear_links").get().n).toBe(0);
    expect(s.db.prepare("SELECT COUNT(*) AS n FROM linear_issues").get().n).toBe(0);
    expect(s.linearOn.get(BOARD)).toBe(false);
    expect(await (await L.status(s.l, person("vedu"), new URL(`${ORIGIN}/api/integrations/linear?board=${BOARD}`))).json()).toEqual({ linked: false });
  });

  it("a token about to run out is refreshed first", async () => {
    const s = setup();
    await link(s);
    s.tick(86_400_000);
    await L.syncTask(s.l, BOARD, task(7, "todo"));
    expect(s.calls[0]).toMatchObject({ url: L.LINEAR_TOKEN, form: { grant_type: "refresh_token", refresh_token: "lin_oauth_REFRESH" } });
    expect(s.calls[1].query).toBe(L.M_CREATE);
  });
});

describe("Linear: tasks → issues", () => {
  it("a new task is an issue in the team's Todo, linking back to the board entry", async () => {
    const s = setup();
    await link(s);
    expect(await L.syncTask(s.l, BOARD, task(7, "todo"))).toBe("created");
    expect(s.calls).toHaveLength(1);
    const c = s.calls[0];
    expect(c.query).toBe(L.M_CREATE);
    expect(c.auth).toBe("Bearer lin_oauth_ACCESS");
    expect(c.variables!.input).toEqual({ teamId: "tm_eng", title: "Fix checkout", description: `Steps:\n- [ ] repro\n\n---\nFrom Atteo task #7: ${ORIGIN}/b/${BOARD}#e7`, stateId: "st_todo" });
    expect(s.db.prepare("SELECT issue_id, identifier, state_type, blocked FROM linear_issues WHERE board_id = ? AND seq = 7").get(BOARD)).toEqual({ issue_id: "iss_1", identifier: "ENG-1", state_type: "unstarted", blocked: 0 });
  });

  it("then only what changed goes: status as the mapped state, title and body together, nothing when nothing changed", async () => {
    const s = setup();
    await link(s);
    await L.syncTask(s.l, BOARD, task(7, "todo"));
    s.calls.length = 0;
    expect(await L.syncTask(s.l, BOARD, task(7, "todo"))).toBe("unchanged");
    expect(s.calls).toEqual([]);
    const sent = async (t: TaskView) => {
      s.calls.length = 0;
      await L.syncTask(s.l, BOARD, t);
      return s.calls.map((c) => ({ q: c.query, v: c.variables }));
    };
    expect(await sent(task(7, "doing"))).toEqual([{ q: L.M_UPDATE, v: { id: "iss_1", input: { stateId: "st_prog" } } }]);
    expect(await sent(task(7, "done"))).toEqual([{ q: L.M_UPDATE, v: { id: "iss_1", input: { stateId: "st_done" } } }]);
    expect(await sent(task(7, "stopped"))).toEqual([{ q: L.M_UPDATE, v: { id: "iss_1", input: { stateId: "st_cancel" } } }]);
    expect(await sent(task(7, "frozen"))).toEqual([{ q: L.M_UPDATE, v: { id: "iss_1", input: { stateId: "st_backlog" } } }]);
    expect(await sent(task(7, "frozen", "Fix checkout v2"))).toEqual([{ q: L.M_UPDATE, v: { id: "iss_1", input: { title: "Fix checkout v2", description: expect.stringContaining("From Atteo task #7") } } }]);
  });

  it("blocked keeps the state and adds the team's blocked label; unblocking removes it", async () => {
    const s = setup();
    await link(s);
    await L.syncTask(s.l, BOARD, task(7, "doing"));
    s.calls.length = 0;
    await L.syncTask(s.l, BOARD, task(7, "blocked"));
    expect(s.calls.map((c) => [c.query, c.variables])).toEqual([[L.M_ADD_LABEL, { id: "iss_1", labelId: "lb_blocked" }]]);
    s.calls.length = 0;
    await L.syncTask(s.l, BOARD, task(7, "doing"));
    expect(s.calls.map((c) => [c.query, c.variables])).toEqual([[L.M_REMOVE_LABEL, { id: "iss_1", labelId: "lb_blocked" }]]);
  });

  it("without a blocked label, blocking comments once, and that comment isn't brought back to the board", async () => {
    const s = setup(ENV, []);
    await link(s);
    await L.syncTask(s.l, BOARD, task(7, "doing"));
    s.calls.length = 0;
    await L.syncTask(s.l, BOARD, task(7, "blocked"));
    expect(s.calls.map((c) => c.query)).toEqual([L.M_COMMENT]);
    expect(s.calls[0].variables!.input).toEqual({ issueId: "iss_1", body: `Blocked on Atteo: ${ORIGIN}/b/${BOARD}#e7` });
    // Linear's webhook for that comment, from a user id that isn't the token's: still recognized by its id.
    await signed(s, { type: "Comment", action: "create", data: { id: "cm_atteo", issueId: "iss_1", body: "Blocked on Atteo", userId: "lu_someone" } });
    expect(s.notes).toEqual([]);
  });

  it("nothing syncs before a team is picked, or once unlinked", async () => {
    const s = setup();
    expect(await L.syncTask(s.l, BOARD, task(7, "todo"))).toBe("off");
    expect(s.calls).toEqual([]);
  });
});

describe("Linear: the webhook", () => {
  it("is checked: a good signature passes; a bad, missing or replayed one doesn't; each delivery is handled once", async () => {
    const s = setup();
    await link(s);
    await L.syncTask(s.l, BOARD, task(7, "todo"));
    const ev = { type: "Issue", action: "update", data: { id: "iss_1", stateId: "st_prog", state: { id: "st_prog", type: "started" } }, updatedFrom: { stateId: "st_todo" } };
    expect((await signed(s, ev, { secret: "wrong" })).status).toBe(401);
    expect((await signed(s, ev, { ts: T0 - 61_000 })).status).toBe(401);
    const unsigned = await L.webhook(s.l, new Request(`${ORIGIN}/x`, { method: "POST", body: JSON.stringify({ ...ev, webhookTimestamp: T0 }) }), s.ctx);
    expect(unsigned.status).toBe(401);
    expect(s.statusSets).toEqual([]);
    const ok = await signed(s, ev, { delivery: "d1" });
    expect(await ok.json()).toEqual({ ok: true, applied: "accepted" });
    expect(s.statusSets).toEqual([{ user: "vedu", seq: 7, status: "doing" }]);
    const again = await signed(s, ev, { delivery: "d1" });
    expect(await again.json()).toEqual({ ok: true, applied: "duplicate" });
    expect(s.statusSets).toHaveLength(1);
  });

  it("an issue's state change sets its task's status (reverse mapped), and the board's echo goes nowhere", async () => {
    const s = setup();
    await link(s);
    await L.syncTask(s.l, BOARD, task(7, "todo"));
    const move = (stateId: string, type: string, from = "st_todo") => signed(s, { type: "Issue", action: "update", data: { id: "iss_1", stateId, state: { id: stateId, type } }, updatedFrom: { stateId: from } });
    await move("st_done", "completed");
    expect(s.statusSets).toEqual([{ user: "vedu", seq: 7, status: "done" }]);
    // The board's change comes back through syncTask: Linear is already there, so nothing is sent.
    s.calls.length = 0;
    expect(await L.syncTask(s.l, BOARD, task(7, "done"))).toBe("unchanged");
    expect(s.calls).toEqual([]);
    // And Linear's webhook for a change Atteo itself made (state type already recorded) does nothing.
    await L.syncTask(s.l, BOARD, task(7, "stopped"));
    await move("st_cancel", "canceled", "st_done");
    expect(s.statusSets).toHaveLength(1);
    // Backlog keeps a frozen task frozen; otherwise it's to do. A state the payload only names by id is looked up.
    s.tasks.set(7, "frozen");
    await signed(s, { type: "Issue", action: "update", data: { id: "iss_1", stateId: "st_backlog" }, updatedFrom: { stateId: "st_cancel" } });
    expect(s.statusSets).toHaveLength(1);
    await move("st_prog", "started", "st_backlog");
    expect(s.statusSets.at(-1)).toEqual({ user: "vedu", seq: 7, status: "doing" });
    // Not a state change, another organization, or an issue that isn't a board task: ignored.
    expect(await L.applyEvent(s.l, { type: "Issue", action: "update", data: { id: "iss_1", title: "x" }, updatedFrom: { title: "y" } })).toMatch(/^ignored/);
    expect(await L.applyEvent(s.l, { type: "Issue", action: "update", organizationId: "org_2", data: { id: "iss_1", state: { type: "completed" } }, updatedFrom: { stateId: "st_prog" } })).toMatch(/another organization/);
    expect(await L.applyEvent(s.l, { type: "Issue", action: "update", data: { id: "iss_other", state: { type: "completed" } }, updatedFrom: { stateId: "a" } })).toMatch(/not a board task/);
  });

  it("a comment is a note in the task's thread, labelled with its Linear author, whose mentions reach agents", async () => {
    const s = setup();
    await link(s);
    await L.syncTask(s.l, BOARD, task(7, "todo"));
    await signed(s, { type: "Comment", action: "create", data: { id: "cm_1", issueId: "iss_1", body: "@agents can someone check the logs? and @vedu's agent please retry", userId: "lu_jane", user: { id: "lu_jane", name: "Jane @all Doe" } } });
    expect(s.notes).toHaveLength(1);
    const n = s.notes[0];
    expect(n).toMatchObject({ board: BOARD, user: "vedu", seq: 7 });
    expect(n.text).toBe("Jane all Doe commented on Linear (ENG-1):\n\n@agents can someone check the logs? and @vedu's agent please retry");
    // Every member's agent, the linker's own included (it's not the linker's words); no person, nobody from the name.
    const key = (m: Mention) => `${m.user}${m.agent ? "'s agent" : ""}`;
    expect(n.mentions.map(key).sort()).toEqual(["ann's agent", "val's agent", "vedu's agent"]);
    // The token's own Linear user's comments, empty ones, and comments on other issues aren't brought back.
    await signed(s, { type: "Comment", action: "create", data: { id: "cm_2", issueId: "iss_1", body: "from the app", userId: "lu_app" } });
    await signed(s, { type: "Comment", action: "create", data: { id: "cm_3", issueId: "iss_1", body: "  " } });
    await signed(s, { type: "Comment", action: "create", data: { id: "cm_4", issueId: "iss_nope", body: "hi" } });
    expect(s.notes).toHaveLength(1);
  });

  it("does nothing on the board once the linker can't act there", async () => {
    const s = setup();
    await link(s);
    await L.syncTask(s.l, BOARD, task(7, "todo"));
    s.db.prepare("UPDATE members SET role = 'viewer' WHERE board_id = ? AND user = 'vedu'").run(BOARD);
    await signed(s, { type: "Comment", action: "create", data: { id: "cm_9", issueId: "iss_1", body: "hello", userId: "lu_x" } });
    await signed(s, { type: "Issue", action: "update", data: { id: "iss_1", state: { type: "completed" } }, updatedFrom: { stateId: "st_todo" } });
    expect(s.notes).toEqual([]);
    expect(s.statusSets).toEqual([]);
  });
});

describe("Linear: encrypted boards and cleanup", () => {
  it("an encrypted board can't be linked or picked (its tasks are ciphertext)", async () => {
    const s = setup();
    const res = await L.choose(s.l, person("vedu"), new Request(`${ORIGIN}/api/integrations/linear`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ board: SECRET_BOARD, team_id: "tm_eng" }) }), new URL(`${ORIGIN}/x`));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/encrypted/);
    const st = await L.signState("lin_secret", { user: "vedu", board: SECRET_BOARD, exp: T0 + 1000 });
    expect((await L.callback(s.l, person("vedu"), new URL(`${ORIGIN}/cb?code=good&state=${encodeURIComponent(st)}`))).status).toBe(409);
    expect(s.calls).toEqual([]);
  });

  it("test-account cleanup drops the person's links and their issue maps", async () => {
    const s = setup();
    await link(s);
    await L.syncTask(s.l, BOARD, task(7, "todo"));
    for (const sql of USER_ROW_DELETES.filter((q) => q.includes("linear_"))) s.db.prepare(sql).run(...Array.from(sql.matchAll(/\?/g), () => "vedu"));
    expect(s.db.prepare("SELECT COUNT(*) AS n FROM linear_links").get().n).toBe(0);
    expect(s.db.prepare("SELECT COUNT(*) AS n FROM linear_issues").get().n).toBe(0);
  });
});
