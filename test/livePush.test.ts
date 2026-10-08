// Live entries (vedu #6581): what each board socket gets when an entry is posted. A web tab may get the entry itself,
// rendered for it, only when GET /updates would give that viewer the same entry; everyone else gets the signal, and
// someone no longer on the board gets nothing. These run the real Board object (its SQLite on node:sqlite, D1 on
// node:sqlite with the migrations) with fake sockets.
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));
vi.stubGlobal("WebSocketRequestResponsePair", class {});
import { Board } from "../src/board";
import { pushEligible, renderShared, socketPlan, updateItem, PUSH_LEASE_MS, type LiveMember, type TabAtt } from "../src/liveEntry";
import { boardMembers } from "../src/registry";
import type { Entry, Env } from "../src/types";

const { DatabaseSync } = (await import("node:" + "sqlite")) as { DatabaseSync: new (p: string) => any };
const { readFileSync, readdirSync } = (await import("node:" + "fs")) as { readFileSync: (u: URL, enc: string) => string; readdirSync: (u: URL) => string[] };
const dir = new URL("../migrations/", (import.meta as unknown as { url: string }).url);
const dbs: { close(): void }[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

const BID = "b_livepush";
/** D1 on node:sqlite (`?1` binds as positional). */
function d1() {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(f, dir), "utf8"));
  const positional = (sql: string, args: unknown[]) => {
    if (!/\?\d/.test(sql)) return { sql, args };
    const used: unknown[] = [];
    return { sql: sql.replace(/\?(\d+)/g, (_m, n) => (used.push(args[Number(n) - 1]), "?")), args: used };
  };
  const stmt = (sql: string, args: unknown[] = []): any => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () => { const q = positional(sql, args); return db.prepare(q.sql).get(...q.args) ?? null; },
    all: async () => { const q = positional(sql, args); return { results: db.prepare(q.sql).all(...q.args) }; },
    run: async () => { const q = positional(sql, args); const i = db.prepare(q.sql).run(...q.args); return { results: [], meta: { changes: i.changes ?? 0 } }; },
  });
  return { db, DB: { prepare: (sql: string) => stmt(sql), batch: async (s: any[]) => Promise.all(s.map((x) => x.run())) } };
}

/** A socket as the board keeps it: its tags, its attachment, what it was sent. */
class FakeSocket {
  sent: string[] = [];
  closed: number | null = null;
  constructor(public tags: string[], public att: TabAtt | null) {}
  send(m: string) { this.sent.push(m); }
  close(code: number) { this.closed = code; }
  deserializeAttachment() { return this.att; }
  frames() { return this.sent.map((x) => JSON.parse(x) as Record<string, any>); }
}

function fixture() {
  const { db, DB } = d1();
  const local = new DatabaseSync(":memory:");
  dbs.push(local);
  const sql = {
    exec(query: string, ...args: unknown[]) {
      let rows: any[] = [];
      if (/CREATE TABLE IF NOT EXISTS meta/.test(query)) local.exec(query);
      else {
        const s = local.prepare(query);
        if (s.columns().length) rows = s.all(...args);
        else s.run(...args);
      }
      return { toArray: () => rows, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
    },
  };
  const sockets: FakeSocket[] = [];
  const pending: Promise<unknown>[] = [];
  const ctx = {
    storage: { sql },
    setWebSocketAutoResponse() {},
    waitUntil: (p: Promise<unknown>) => { pending.push(Promise.resolve(p).catch(() => {})); },
    getWebSockets: (tag?: string) => sockets.filter((s) => !tag || s.tags.includes(tag)),
    getTags: (ws: FakeSocket) => ws.tags,
  };
  const env = { DB } as unknown as Env;
  const board = new Board(ctx as unknown as DurableObjectState, env);
  const meta = board as unknown as { setMeta(k: string, v: string): void };
  meta.setMeta("id", BID);
  meta.setMeta("title", "Live push");
  meta.setMeta("created_by", "ann");
  meta.setMeta("kind", "board");
  const now = Date.now();
  db.prepare(`INSERT INTO boards (id, title, created_by, created_at, last_activity) VALUES (?, ?, ?, 0, 0)`).run(BID, "Live push", "ann");
  const join = (name: string, expires: number | null = null) => {
    db.prepare(`INSERT OR IGNORE INTO users (name, email, email_verified, first_seen, last_seen) VALUES (?, ?, 1, 0, 0)`).run(name, `${name}@example.com`);
    db.prepare(`INSERT INTO members (board_id, user, joined_at, last_seen, role, expires_at) VALUES (?, ?, ?, 0, 'contributor', ?)`).run(BID, name, now, expires);
    sql.exec(`INSERT OR IGNORE INTO members (name, cursor, joined_at, last_seen) VALUES (?, 0, ?, ?)`, name, now, now);
  };
  const tab = (user: string, opts: { person?: boolean; push?: number | null; lang?: string } = {}) => {
    const person = opts.person ?? true;
    const s = new FakeSocket([user], { user, person, ...(opts.lang ? { lang: opts.lang } : {}), ...(person && opts.push !== null ? { push: opts.push ?? now + PUSH_LEASE_MS } : {}) });
    sockets.push(s);
    return s;
  };
  const settle = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
  const live = async (): Promise<LiveMember[]> => boardMembers(env, BID);
  return { board, db, env, sockets, tab, join, settle, live, sql };
}

const of = (s: FakeSocket, seq: number) => s.frames().filter((f) => f.type === "entry" && f.seq === seq);

describe("liveEntry: which entries may be pushed, and what each socket gets", () => {
  const base = { seq: 5, ts: 1, author: "ann", type: "note", text: "hi", to: null, reply_to: null, resolves: [], supersedes: null, retracts: null, via: "person", artifact_name: null, artifact_size: null } as unknown as Entry;
  it("pushes only plain notes and questions for everyone, on a board that isn't encrypted", () => {
    expect(pushEligible(base, { encrypted: false, sealed: false })).toBe(true);
    expect(pushEligible({ ...base, type: "question" }, { encrypted: false, sealed: false })).toBe(true);
    expect(pushEligible({ ...base, audience: "own", to_people: ["ann"] }, { encrypted: false, sealed: false })).toBe(false); // Just mine
    expect(pushEligible({ ...base, audience: "people", to_people: ["ann", "bo"] }, { encrypted: false, sealed: false })).toBe(false); // People only
    expect(pushEligible(base, { encrypted: true, sealed: false })).toBe(false);
    expect(pushEligible(base, { encrypted: false, sealed: true })).toBe(false);
    for (const t of ["task", "claim", "decision", "artifact", "change", "handoff"]) expect(pushEligible({ ...base, type: t } as Entry, { encrypted: false, sealed: false }), t).toBe(false);
    expect(pushEligible({ ...base, retracts: 3 }, { encrypted: false, sealed: false })).toBe(false); // unsends
    expect(pushEligible({ ...base, resolves: [2] }, { encrypted: false, sealed: false })).toBe(false);
    expect(pushEligible({ ...base, supersedes: 2 }, { encrypted: false, sealed: false })).toBe(false);
    expect(pushEligible({ ...base, edited_at: 9 }, { encrypted: false, sealed: false })).toBe(false);
  });
  it("socketPlan: members only; a person's web tab with a live lease is the only push", () => {
    const now = 1_000;
    const members = new Set(["ann", "bo"]);
    expect(socketPlan({ user: "ann", person: true, push: now + 1 }, "ann", members, true, now)).toBe("push");
    expect(socketPlan({ user: "ann", person: true, push: now - 1 }, "ann", members, true, now)).toBe("renew");
    expect(socketPlan({ user: "ann", person: false }, "ann", members, true, now)).toBe("signal"); // an agent's socket
    expect(socketPlan({ user: "ann", person: true }, "ann", members, true, now)).toBe("signal"); // the app (a token)
    expect(socketPlan({ user: "ann", person: true, push: now + 1 }, "ann", members, false, now)).toBe("signal");
    expect(socketPlan({ user: "cy", person: true, push: now + 1 }, "cy", members, true, now)).toBe("skip"); // removed
    expect(socketPlan({ user: "cy", person: false }, "cy", members, false, now)).toBe("skip");
    expect(socketPlan(null, "cy", members, true, now)).toBe("skip"); // an old tab: by its tag
    expect(socketPlan(null, "ann", members, true, now)).toBe("signal");
    expect(socketPlan({ user: "cy", person: true, push: now + 1 }, "cy", null, false, now)).toBe("signal"); // members unknown: as before
  });
});

describe("Board: the per-viewer filter at the socket", () => {
  it("a public note: web tabs get it rendered, agents and the app the signal, a removed member nothing", async () => {
    const f = fixture();
    for (const u of ["ann", "bo", "cy"]) f.join(u);
    const annWeb = f.tab("ann"), boWeb = f.tab("bo", { lang: "de" }), boAgent = f.tab("bo", { person: false }), boApp = f.tab("bo", { push: null }), cyWeb = f.tab("cy");
    // cy is removed while connected (D1 first, as the Worker does); this post's members are read after that.
    f.db.prepare(`DELETE FROM members WHERE board_id = ? AND user = ?`).run(BID, "cy");
    const e = await f.board.post("ann", { type: "note", text: "deploy is green", via: "person" }, { live: await f.live() });
    await f.settle();
    const [a] = of(annWeb, e.seq), [b] = of(boWeb, e.seq);
    expect(a.entry.html).toContain("deploy is green");
    expect(b.entry.html).toContain("deploy is green");
    expect(b.prev).toBe(e.seq - 1 < 0 ? 0 : (f.sql.exec("SELECT MAX(seq) AS s FROM entries WHERE seq < ?", e.seq).one().s ?? 0));
    expect(a.entry.html).toContain("data-retract"); // the author may unsend; bo may not (and isn't the creator)
    expect(b.entry.html).not.toContain("data-retract");
    expect(b.entry.html).toContain("Antworten"); // rendered in bo's language ("Reply")
    for (const s of [boAgent, boApp]) {
      const [sig] = of(s, e.seq);
      expect(sig.excerpt).toContain("deploy is green");
      expect(sig.entry).toBeUndefined();
    }
    expect(of(cyWeb, e.seq)).toEqual([]);
  });

  it("the pushed entry is exactly what GET /updates renders for that viewer", async () => {
    const f = fixture();
    for (const u of ["ann", "bo"]) f.join(u);
    const boWeb = f.tab("bo");
    const top = await f.board.post("bo", { type: "question", text: "@ann which port?", via: "person" }, { live: await f.live() });
    const e = await f.board.post("ann", { type: "note", text: "**8443**, and health is green", reply_to: top.seq, via: "person" }, { live: await f.live() });
    await f.settle();
    const [pushed] = of(boWeb, e.seq);
    expect(pushed.sum).toBe(true); // an answer in a question's thread: the tab refreshes its sidebar
    const snap = await f.board.snapshot(e.seq - 1, { roots: true }, { user: "bo", person: true });
    const members = await f.live();
    const want = updateItem(snap.entries[0], renderShared(BID, snap.info.created_by, members), { name: "bo", person: true }, { root: snap.roots![e.seq], reactions: snap.reactions[e.seq] ?? [], reviews: snap.reviews[e.seq], claim: snap.claims[e.seq] });
    expect(pushed.entry).toEqual(JSON.parse(JSON.stringify(want)));
    expect(pushed.entry.root).toBe(top.seq);
  });

  it("Just mine: only its person's sockets hear of it, and as the signal (they fetch it)", async () => {
    const f = fixture();
    for (const u of ["ann", "bo"]) f.join(u);
    const annWeb = f.tab("ann"), annAgent = f.tab("ann", { person: false }), boWeb = f.tab("bo"), boAgent = f.tab("bo", { person: false });
    const e = await f.board.post("ann", { type: "note", text: "my private plan", own: true, via: "person" }, { live: await f.live() });
    await f.settle();
    expect(e.audience).toBe("own");
    for (const s of [annWeb, annAgent]) {
      const [sig] = of(s, e.seq);
      expect(sig.audience).toBe("own");
      expect(sig.entry).toBeUndefined();
      expect(JSON.stringify(sig)).not.toContain("my private plan");
    }
    expect(of(boWeb, e.seq)).toEqual([]);
    expect(of(boAgent, e.seq)).toEqual([]);
  });

  it("People only: its people's web tabs get the signal; no agent socket hears of it", async () => {
    const f = fixture();
    for (const u of ["ann", "bo", "cy"]) f.join(u);
    const annWeb = f.tab("ann"), boWeb = f.tab("bo"), boAgent = f.tab("bo", { person: false }), cyWeb = f.tab("cy");
    const e = await f.board.post("ann", { type: "note", text: "people only words", people_only: true, to_people: ["bo"], via: "person" } as never, { live: await f.live() });
    await f.settle();
    expect(e.audience).toBe("people");
    for (const s of [annWeb, boWeb]) {
      const [sig] = of(s, e.seq);
      expect(sig.entry).toBeUndefined();
      expect(JSON.stringify(sig)).not.toContain("people only words");
    }
    expect(of(boAgent, e.seq)).toEqual([]);
    expect(of(cyWeb, e.seq)).toEqual([]);
  });

  it("a gap: the next public entry's prev skips what this viewer can't see", async () => {
    const f = fixture();
    for (const u of ["ann", "bo"]) f.join(u);
    const boWeb = f.tab("bo");
    const first = await f.board.post("ann", { type: "note", text: "one", via: "person" }, { live: await f.live() });
    await f.board.post("ann", { type: "note", text: "mine only", own: true, via: "person" }, { live: await f.live() });
    const third = await f.board.post("ann", { type: "note", text: "three", via: "person" }, { live: await f.live() });
    await f.settle();
    expect(of(boWeb, third.seq)[0].prev).toBe(first.seq); // bo had #first; the Just mine one between isn't theirs
  });

  it("an agent's post through a route that didn't read the members (MCP): agents now, web tabs once the board has read them; expired access gets nothing", async () => {
    const f = fixture();
    f.join("ann");
    f.join("bo");
    f.join("dee", Date.now() - 60_000); // her guest access ended (expires_at), her tab still open
    const boWeb = f.tab("bo"), boAgent = f.tab("bo", { person: false }), deeWeb = f.tab("dee");
    const e = await f.board.post("ann", { type: "note", text: "agent says hi", via: "agent" });
    expect(of(boAgent, e.seq)).toHaveLength(1); // at once
    await f.settle();
    expect(of(boWeb, e.seq)[0].entry.html).toContain("agent says hi");
    expect(of(deeWeb, e.seq)).toEqual([]);
  });

  it("a lease that ran out: the signal and a request to reconnect, never the entry", async () => {
    const f = fixture();
    for (const u of ["ann", "bo"]) f.join(u);
    const old = f.tab("bo", { push: Date.now() - 1 });
    const e = await f.board.post("ann", { type: "note", text: "after the lease", via: "person" }, { live: await f.live() });
    await f.settle();
    const [sig] = of(old, e.seq);
    expect(sig.renew).toBe(true);
    expect(sig.entry).toBeUndefined();
  });

  it("too big to push: the signal (the tab fetches it)", async () => {
    const f = fixture();
    for (const u of ["ann", "bo"]) f.join(u);
    const boWeb = f.tab("bo");
    const e = await f.board.post("ann", { type: "note", text: "<".repeat(20_000), via: "person" }, { live: await f.live() });
    await f.settle();
    const [sig] = of(boWeb, e.seq);
    expect(sig.entry).toBeUndefined();
  });

  it("removeMember mid-connection closes their sockets; later posts don't reach them", async () => {
    const f = fixture();
    for (const u of ["ann", "bo"]) f.join(u);
    const boWeb = f.tab("bo"), boAgent = f.tab("bo", { person: false });
    f.db.prepare(`DELETE FROM members WHERE board_id = ? AND user = ?`).run(BID, "bo");
    await f.board.removeMember("bo");
    expect(boWeb.closed).toBe(4003);
    expect(boAgent.closed).toBe(4003);
    // Even if a socket outlived the close (a fake one does), the next post's members leave bo out.
    const e = await f.board.post("ann", { type: "note", text: "after bo left", via: "person" }, { live: await f.live() });
    await f.settle();
    expect(of(boWeb, e.seq)).toEqual([]);
    expect(of(boAgent, e.seq)).toEqual([]);
  });
});
