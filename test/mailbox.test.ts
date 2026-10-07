import { describe, expect, it } from "vitest";
import { collect, notifyMailboxes, pruneMail } from "../src/mailbox";
import { ENCRYPTED, MAIL_TEXT_MAX, mailText } from "../src/ping";
import type { Env } from "../src/types";

const { DatabaseSync } = (await import("node:" + "sqlite")) as { DatabaseSync: new (p: string) => any };
const { readFileSync, readdirSync } = (await import("node:" + "fs")) as { readFileSync: (u: URL, enc: string) => string; readdirSync: (u: URL) => string[] };
const dir = new URL("../migrations/", (import.meta as unknown as { url: string }).url);

function fakeEnv() {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(f, dir), "utf8"));
  const stmt = (sql: string, args: unknown[] = []): any => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => {
      const r = db.prepare(sql).run(...args);
      return { results: [], meta: { changes: r.changes } };
    },
  });
  return { env: { DB: { prepare: (sql: string) => stmt(sql) } } as unknown as Env, db };
}

const day = 86_400_000;
const T0 = Date.UTC(2026, 9, 3, 12, 0, 0);

/** readAt: when the person read it in their inbox (the same row is their inbox item); default read. */
function insert(db: any, user: string, board: string, seq: number, agentSeenAt: number | null, readAt: number | null = agentSeenAt ?? T0) {
  db.prepare(
    `INSERT INTO notifications (user, board_id, seq, kind, actor, actor_via, entry_type, excerpt, created_at, agent_seen_at, read_at)
     VALUES (?, ?, ?, 'mention', 'alice', 'agent', 'note', 'hi', ?, ?, ?)`,
  ).run(user, board, seq, agentSeenAt ?? T0, agentSeenAt, readAt);
}

function remaining(db: any, user: string): { seq: number; agent_seen_at: number | null }[] {
  return db.prepare(`SELECT seq, agent_seen_at FROM notifications WHERE user = ? ORDER BY seq`).all(user);
}

describe("mailbox acked retention sweep", () => {
  it("deletes acked mail older than 30 days; keeps unacked and recent acked", async () => {
    const { env, db } = fakeEnv();
    insert(db, "bob", "", 1, T0 - 31 * day); // old acked
    insert(db, "bob", "", 2, T0 - 5 * day); // recent acked
    insert(db, "bob", "", 3, null); // unacked

    expect(await pruneMail(env, T0)).toBe(1);
    const rows = remaining(db, "bob");
    expect(rows.map((r) => r.seq).sort()).toEqual([2, 3]);
    expect(rows.find((r) => r.seq === 2)?.agent_seen_at).toBe(T0 - 5 * day);
    expect(rows.find((r) => r.seq === 3)?.agent_seen_at).toBeNull();
  });

  it("keeps mail the agent collected long ago while the person hasn't read it in their inbox (opus-d #2278)", async () => {
    const { env, db } = fakeEnv();
    insert(db, "bob", "", 1, T0 - 40 * day, null); // the agent took it; bob never opened it
    insert(db, "bob", "", 2, T0 - 40 * day, T0 - 39 * day); // both done
    expect(await pruneMail(env, T0)).toBe(1);
    expect(remaining(db, "bob").map((r) => r.seq)).toEqual([1]);
  });

  it("leaves nothing to delete when all acked rows are within the window", async () => {
    const { env, db } = fakeEnv();
    insert(db, "bob", "", 1, T0 - 30 * day);
    expect(await pruneMail(env, T0)).toBe(0);
    expect(remaining(db, "bob")).toHaveLength(1);
  });
});

describe("mailbox triage", () => {
  it("shows mail in full, cutting only past MAIL_TEXT_MAX with where to get the rest (#2348)", () => {
    expect(mailText("short and whole", 4)).toBe("short and whole");
    const ok = "a".repeat(MAIL_TEXT_MAX);
    expect(mailText(ok, 4)).toBe(ok);
    const long = "b".repeat(MAIL_TEXT_MAX + 50) + "TAIL";
    expect(mailText(long, 9)).toBe("b".repeat(MAIL_TEXT_MAX) + "… [get #9 for the rest]");
  });

  it("includes kind, title, a fenced excerpt, and whether it is for this session, the person, or someone else", async () => {
    const { env, db } = fakeEnv();
    db.prepare(`INSERT INTO boards (id, title, created_by, created_at, last_activity) VALUES ('b1', 'Checkout', 'ada', 1, 1)`).run();
    db.prepare(`INSERT INTO members (board_id, user, joined_at, last_seen) VALUES ('b1', 'beau', 1, 1)`).run();
    db.prepare(`INSERT INTO agent_sessions (id, user, name, boards, created_at, last_seen) VALUES ('as1', 'beau', 'hooksess', '[]', 1, 1)`).run();
    const ins = db.prepare(
      `INSERT INTO notifications (user, board_id, seq, kind, actor, actor_via, entry_type, excerpt, created_at, to_session) VALUES (?, 'b1', ?, ?, 'ada', 'agent', ?, 'short', ?, ?)`,
    );
    ins.run("beau", 1, "agent", "task", 1, null);
    ins.run("beau", 2, "mention", "note", 2, null);
    ins.run("beau", 3, "agent", "question", 3, "as1");
    const long = `Please review the retry budget ${"padding ".repeat(40)}zzzend`;
    const full = async (_b: string, seq: number) => (seq === 1 ? { text: long, title: "Retry budget" } : { text: "a short note", title: null });
    const r = await collect(env, "beau", { limit: 10, wait: 0, peek: true }, full);
    const [task, mention] = r.mail;
    const scoped = await collect(env, "beau", { limit: 10, wait: 0, peek: true, session: "as1" }, full);
    const session = scoped.mail.find((m) => m.seq === 3);
    expect(task.kind).toBe("for_your_agent");
    expect(task.type).toBe("task");
    expect(task.title).toBe("Retry budget");
    expect(task.for).toBe("for your agent");
    expect(task.text).toBe(long);
    const inside = task.preview.slice(task.preview.indexOf(">>\n") + 3, task.preview.lastIndexOf("\n<<end untrusted"));
    expect(task.preview.startsWith("<<untrusted ")).toBe(true);
    expect(inside.startsWith("[Retry budget] Please review the retry budget")).toBe(true);
    expect(inside.endsWith("…")).toBe(true);
    expect(inside.length).toBeLessThanOrEqual(220);
    expect(inside.includes("zzzend")).toBe(false);
    expect(mention.kind).toBe("mention");
    expect(mention.for).toBe("for your person");
    expect(session?.for).toBe("for you (this session)");
    expect(session?.to_session).toBe("hooksess");
  });

  it("does not fence ciphertext", async () => {
    const { env, db } = fakeEnv();
    db.prepare(`INSERT INTO boards (id, title, created_by, created_at, last_activity, encrypted) VALUES ('b2', 'Sealed', 'ada', 1, 1, 1)`).run();
    db.prepare(`INSERT INTO members (board_id, user, joined_at, last_seen) VALUES ('b2', 'beau', 1, 1)`).run();
    db.prepare(
      `INSERT INTO notifications (user, board_id, seq, kind, actor, actor_via, entry_type, excerpt, created_at) VALUES ('beau', 'b2', 1, 'agent', 'ada', 'agent', 'note', 'ciphertext-placeholder', 1)`,
    ).run();
    const r = await collect(env, "beau", { limit: 5, wait: 0, peek: true }, async () => {
      throw new Error("sealed text is not loaded");
    });
    expect(r.mail[0].encrypted).toBe(true);
    expect(r.mail[0].preview).toBe(ENCRYPTED);
    expect(r.mail[0].text).toBe("ciphertext-placeholder");
    expect(r.mail[0].preview.includes("ciphertext")).toBe(false);
  });
});

describe("peeking and held waits don't spin on mail they already showed (cost guard, #4340)", () => {
  function setup() {
    const { env, db } = fakeEnv();
    db.prepare(`INSERT INTO boards (id, title, created_by, created_at, last_activity) VALUES ('b1', 'Checkout', 'ada', 1, 1)`).run();
    db.prepare(`INSERT INTO members (board_id, user, joined_at, last_seen) VALUES ('b1', 'cara', 1, 1)`).run();
    const add = (seq: number, at: number) =>
      db.prepare(`INSERT INTO notifications (user, board_id, seq, kind, actor, actor_via, entry_type, excerpt, created_at) VALUES ('cara', 'b1', ?, 'mention', 'ada', 'agent', 'note', 'hi', ?)`).run(seq, at);
    let backlogReads = 0;
    const prep = env.DB.prepare.bind(env.DB);
    (env.DB as unknown as { prepare: (s: string) => unknown }).prepare = (s: string) => {
      if (/FROM notifications n LEFT JOIN/.test(s)) backlogReads++;
      return prep(s);
    };
    return { env, add, backlogReads: () => backlogReads };
  }
  const full = async () => ({ text: "hi", title: null });

  it("the first peek shows what's waiting at once; a second waiting peek holds instead of re-reading it", async () => {
    const { env, add, backlogReads } = setup();
    add(1, 10);
    const first = await collect(env, "cara", { limit: 10, wait: 1, peek: true, session: "s-peek", pollMs: 200 }, full);
    expect(first.mail.map((m) => m.seq)).toEqual([1]);
    const before = backlogReads();
    const t = Date.now();
    const second = await collect(env, "cara", { limit: 10, wait: 1, peek: true, session: "s-peek", pollMs: 200 }, full);
    expect(Date.now() - t).toBeGreaterThanOrEqual(700); // it waited
    expect(second.mail.map((m) => m.seq)).toEqual([1]); // and still answers with what's there
    expect(backlogReads() - before).toBe(1); // the backlog was read once, not on every poll
  });

  it("new mail ends the held wait early, with the new mail in it", async () => {
    const { env, add } = setup();
    add(1, 10);
    await collect(env, "cara", { limit: 10, wait: 0, peek: false, held: true, session: "s-held" }, full); // shown once
    setTimeout(() => add(2, 10), 250); // same millisecond as the row already shown
    const t = Date.now();
    const r = await collect(env, "cara", { limit: 10, wait: 3, peek: false, held: true, session: "s-held", pollMs: 100 }, full);
    expect(Date.now() - t).toBeLessThan(2000);
    expect(r.mail.map((m) => m.seq)).toEqual([1, 2]);
  });

  it("a delivering read (not peek, not held) is unchanged: it takes the mail at once", async () => {
    const { env, add } = setup();
    add(1, 10);
    const r = await collect(env, "cara", { limit: 10, wait: 5, peek: false, session: "s-drain" }, full);
    expect(r.mail.map((m) => m.seq)).toEqual([1]);
    const again = await collect(env, "cara", { limit: 10, wait: 0, peek: true }, full);
    expect(again.mail).toEqual([]);
  });
});

describe("mailbox push", () => {
  it("wakes a waiting read after notification insert, without waiting for the safety poll", async () => {
    const { env, db } = fakeEnv();
    db.prepare(`INSERT INTO boards (id, title, created_by, created_at, last_activity) VALUES ('push', 'Push', 'ada', 1, 1)`).run();
    db.prepare(`INSERT INTO members (board_id, user, joined_at, last_seen) VALUES ('push', 'push-reader', 1, 1)`).run();
    const sockets = new Set<EventTarget>();
    let notifications = 0;
    (env as unknown as { MAILBOX_SIGNAL: unknown }).MAILBOX_SIGNAL = {
      idFromName: (user: string) => user,
      get: (user: string) => {
        expect(user).toBe("push-reader");
        return {
          fetch: async () => {
            const socket = Object.assign(new EventTarget(), { accept() {}, close() { sockets.delete(socket); } });
            sockets.add(socket);
            return { webSocket: socket };
          },
          notify: async () => { notifications++; for (const socket of sockets) socket.dispatchEvent(new Event("message")); },
        };
      },
    };
    const started = Date.now();
    const waiting = collect(env, "push-reader", { limit: 10, wait: 3, peek: false, pollMs: 10_000 }, async () => ({ text: "new mention" }));
    await new Promise((resolve) => setTimeout(resolve, 25));
    insert(db, "push-reader", "push", 1, null);
    await notifyMailboxes(env, ["push-reader", "push-reader"]);
    const result = await waiting;
    expect(notifications).toBe(1);
    expect(result.mail.map((m) => m.seq)).toEqual([1]);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(sockets.size).toBe(0);
  });
});
