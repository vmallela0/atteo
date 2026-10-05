import { beforeEach, describe, expect, it } from "vitest";
import { reach } from "../src/dm";
import { sendInvite } from "../src/invite";
import { isMember } from "../src/registry";
import { blockPerson, requestFriend } from "../src/social";
import { applies, createRule, listRules, MAX_ACTIVE, MAX_EXPIRES_S, MIN_EXPIRES_S, revokeRule, StandingRuleError } from "../src/standingRules";
import type { Env } from "../src/types";

const { DatabaseSync } = (await import("node:" + "sqlite")) as { DatabaseSync: new (p: string) => any };
const { readFileSync, readdirSync } = (await import("node:" + "fs")) as { readFileSync: (u: URL, enc: string) => string; readdirSync: (u: URL) => string[] };
const dir = new URL("../migrations/", (import.meta as unknown as { url: string }).url);

/** node:sqlite binds `?` only. D1 also uses `?1`, and reuses a number; expand those to positional `?`. */
function positional(sql: string, args: unknown[]): { sql: string; args: unknown[] } {
  if (!/\?\d/.test(sql)) return { sql, args };
  const used: unknown[] = [];
  const next = sql.replace(/\?(\d+)/g, (_m, n) => {
    used.push(args[Number(n) - 1]);
    return "?";
  });
  return { sql: next, args: used };
}

function fakeEnv() {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(f, dir), "utf8"));
  const stmt = (sql: string, args: unknown[] = []): any => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () => {
      const q = positional(sql, args);
      return db.prepare(q.sql).get(...q.args) ?? null;
    },
    all: async () => {
      const q = positional(sql, args);
      return { results: db.prepare(q.sql).all(...q.args) };
    },
    run: async () => {
      const q = positional(sql, args);
      const info = db.prepare(q.sql).run(...q.args);
      return { results: [], meta: { changes: info.changes ?? 0 } };
    },
  });
  const env = { DB: { prepare: (sql: string) => stmt(sql) } } as unknown as Env;
  return { env, db };
}

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const DAY = 86_400;
const boardId = "b_aaaaaaaa";
const otherBoard = "b_bbbbbbbb";

function user(db: any, name: string, email = `${name}@example.com`, verified = 1) {
  db.prepare(`INSERT INTO users (name, email, email_verified, first_seen, last_seen) VALUES (?, ?, ?, 0, 0)`).run(name, email, verified);
}
function board(db: any, id: string, by: string) {
  db.prepare(`INSERT INTO boards (id, title, created_by, created_at, last_activity) VALUES (?, ?, ?, 0, 0)`).run(id, id, by);
}
function member(db: any, id: string, name: string, expires: number | null = null) {
  db.prepare(`INSERT INTO members (board_id, user, joined_at, last_seen, expires_at) VALUES (?, ?, 0, 0, ?)`).run(id, name, expires);
}

describe("standing rules: create, list, revoke", () => {
  let env: Env;
  let db: any;
  beforeEach(() => {
    ({ env, db } = fakeEnv());
    user(db, "ada");
    user(db, "bea");
    board(db, boardId, "ada");
    member(db, boardId, "ada");
    member(db, boardId, "bea");
  });

  it("creates a person rule and a board rule, lists only active ones, and revokes", async () => {
    const person = await createRule(env, "ada", { scope: "person", scope_id: "@Bea", action: "accept_invites", expires_in: DAY }, NOW);
    const onBoard = await createRule(env, "ada", { scope: "board", scope_id: boardId, action: "allow_agents", expires_in: 7 * DAY }, NOW + 1);
    expect(person).toMatchObject({ user: "ada", scope: "person", scope_id: "bea", action: "accept_invites", state: "active", expires_at: NOW + DAY * 1000 });
    expect(onBoard.scope).toBe("board");
    expect(onBoard.id.startsWith("sr_")).toBe(true);

    const listed = await listRules(env, "ada", false, NOW + 2);
    expect(listed.map((r) => r.id)).toEqual([onBoard.id, person.id]);
    expect(await listRules(env, "bea", false, NOW)).toEqual([]);

    const gone = await revokeRule(env, "ada", person.id, NOW + 3);
    expect(gone.state).toBe("revoked");
    expect(gone.revoked_at).toBe(NOW + 3);
    expect((await listRules(env, "ada", false, NOW + 3)).map((r) => r.id)).toEqual([onBoard.id]);
    const all = await listRules(env, "ada", true, NOW + 3);
    expect(all.find((r) => r.id === person.id)?.state).toBe("revoked");
    await expect(revokeRule(env, "ada", person.id, NOW + 4)).rejects.toThrow(/Already revoked/);
    await expect(revokeRule(env, "bea", onBoard.id, NOW + 4)).rejects.toThrow(/No such rule/);
    await expect(revokeRule(env, "ada", "nope", NOW)).rejects.toThrow(StandingRuleError);
  });

  it("an expired rule drops out of the active list and can be set again", async () => {
    const rule = await createRule(env, "ada", { scope: "person", scope_id: "bea", action: "accept_friends", expires_in: MIN_EXPIRES_S }, NOW);
    expect(await listRules(env, "ada", false, NOW + MIN_EXPIRES_S * 1000)).toEqual([]);
    const expired = await listRules(env, "ada", true, NOW + MIN_EXPIRES_S * 1000);
    expect(expired[0].state).toBe("expired");
    await expect(revokeRule(env, "ada", rule.id, NOW + MIN_EXPIRES_S * 1000)).rejects.toThrow(/expired/);
    const again = await createRule(env, "ada", { scope: "person", scope_id: "bea", action: "accept_friends", expires_in: MIN_EXPIRES_S }, NOW + MIN_EXPIRES_S * 1000);
    expect(again.id).not.toBe(rule.id);
    expect(again.state).toBe("active");
  });

  it("refuses a bad scope, action, expiry, yourself, a stranger, a board you aren't on, and a duplicate", async () => {
    const good = { scope: "person", scope_id: "bea", action: "accept_friends", expires_in: DAY };
    await expect(createRule(env, "ada", { ...good, scope: "everyone" }, NOW)).rejects.toThrow(/scope/);
    await expect(createRule(env, "ada", { ...good, action: "delete" }, NOW)).rejects.toThrow(/action/);
    await expect(createRule(env, "ada", { ...good, expires_in: undefined }, NOW)).rejects.toThrow(/expires/);
    await expect(createRule(env, "ada", { ...good, expires_in: MIN_EXPIRES_S - 1 }, NOW)).rejects.toThrow(/expires_in/);
    await expect(createRule(env, "ada", { ...good, expires_in: MAX_EXPIRES_S + 1 }, NOW)).rejects.toThrow(/90 days/);
    await expect(createRule(env, "ada", { ...good, expires_in: "week" }, NOW)).rejects.toThrow(/number of seconds/);
    await expect(createRule(env, "ada", { ...good, scope_id: "ada" }, NOW)).rejects.toThrow(/someone else/);
    await expect(createRule(env, "ada", { ...good, scope_id: "nobody" }, NOW)).rejects.toThrow(/nobody/);
    await expect(createRule(env, "ada", { scope: "board", scope_id: "b_notaboard", action: "allow_agents", expires_in: DAY }, NOW)).rejects.toThrow(/not on it/);
    await expect(createRule(env, "ada", { scope: "board", scope_id: "not-a-board", action: "allow_agents", expires_in: DAY }, NOW)).rejects.toThrow(/b_/);
    await createRule(env, "ada", good, NOW);
    await expect(createRule(env, "ada", good, NOW + 1)).rejects.toThrow(/already have that rule/i);
    await expect(createRule(env, "ada", { ...good, action: "allow_agents", expires_in: MAX_EXPIRES_S }, NOW)).resolves.toMatchObject({ state: "active" });
  });

  it("stops at the active cap", async () => {
    for (let i = 0; i < MAX_ACTIVE; i++) {
      const id = `b_${String(i).padStart(8, "a")}`;
      board(db, id, "ada");
      member(db, id, "ada");
      await createRule(env, "ada", { scope: "board", scope_id: id, action: "allow_agents", expires_in: DAY }, NOW);
    }
    board(db, otherBoard, "ada");
    member(db, otherBoard, "ada");
    await expect(createRule(env, "ada", { scope: "board", scope_id: otherBoard, action: "allow_agents", expires_in: DAY }, NOW)).rejects.toThrow(String(MAX_ACTIVE));
  });
});

describe("standing rules: who they cover", () => {
  let env: Env;
  let db: any;
  beforeEach(() => {
    ({ env, db } = fakeEnv());
    user(db, "ada");
    user(db, "bea");
    user(db, "cy");
    board(db, boardId, "ada");
    member(db, boardId, "ada");
    member(db, boardId, "bea");
  });

  it("a person scope names them; a board scope is current members of that board", async () => {
    await createRule(env, "bea", { scope: "person", scope_id: "ada", action: "accept_invites", expires_in: DAY }, NOW);
    await createRule(env, "bea", { scope: "board", scope_id: boardId, action: "allow_agents", expires_in: DAY }, NOW);
    expect(await applies(env, "bea", "accept_invites", "ada", NOW + 1)).toBe(true);
    expect(await applies(env, "bea", "accept_invites", "cy", NOW + 1)).toBe(false);
    expect(await applies(env, "bea", "allow_agents", "ada", NOW + 1)).toBe(true);
    expect(await applies(env, "bea", "allow_agents", "cy", NOW + 1)).toBe(false);
    expect(await applies(env, "bea", "accept_friends", "ada", NOW + 1)).toBe(false);
    expect(await applies(env, "ada", "allow_agents", "bea", NOW + 1)).toBe(false);

    db.prepare(`UPDATE members SET expires_at = ? WHERE board_id = ? AND user = ?`).run(NOW, boardId, "ada");
    expect(await applies(env, "bea", "allow_agents", "ada", NOW + 1)).toBe(false);
    expect(await applies(env, "bea", "accept_invites", "ada", NOW + 1)).toBe(true);

    db.prepare(`UPDATE boards SET deleted_at = ? WHERE id = ?`).run(NOW, boardId);
    db.prepare(`UPDATE members SET expires_at = NULL WHERE board_id = ? AND user = ?`).run(boardId, "ada");
    expect(await applies(env, "bea", "allow_agents", "ada", NOW + 1)).toBe(false);
  });
});

describe("standing rules: invites, friends, agent DMs", () => {
  let env: Env;
  let db: any;
  beforeEach(() => {
    ({ env, db } = fakeEnv());
    user(db, "ada");
    user(db, "bea");
    board(db, boardId, "ada");
    member(db, boardId, "ada");
  });

  it("auto-accepts an invite from the named person, and still does for the account-wide friends flag", async () => {
    const pending = await sendInvite(env, "http://localhost", { boardId, email: "bea@example.com", invitedBy: "ada" });
    expect(pending.added).toBe(false);
    expect(await isMember(env, boardId, "bea")).toBe(false);

    await createRule(env, "bea", { scope: "person", scope_id: "ada", action: "accept_invites", expires_in: DAY });
    board(db, otherBoard, "ada");
    member(db, otherBoard, "ada");
    const joined = await sendInvite(env, "http://localhost", { boardId: otherBoard, email: "bea@example.com", invitedBy: "ada" });
    expect(joined.added).toBe(true);
    expect(joined.message).toMatch(/standing rule/);
    expect(await isMember(env, otherBoard, "bea")).toBe(true);

    user(db, "cy");
    board(db, "b_cccccccc", "cy");
    member(db, "b_cccccccc", "cy");
    db.prepare(`UPDATE users SET rules = ? WHERE name = ?`).run(JSON.stringify({ auto_accept_invites: "friends" }), "bea");
    db.prepare(`INSERT INTO friendships (a, b, status, requested_by, created_at) VALUES ('bea', 'cy', 'accepted', 'cy', 0)`).run();
    const byFriend = await sendInvite(env, "http://localhost", { boardId: "b_cccccccc", email: "bea@example.com", invitedBy: "cy" });
    expect(byFriend.added).toBe(true);
    expect(byFriend.message).toMatch(/friends automatically/);
  });

  it("auto-accepts a friend request from a person or from someone still on the board", async () => {
    expect(await requestFriend(env, "ada", "bea", "hi")).toBe("pending_out");
    db.prepare(`DELETE FROM friendships`).run();

    await createRule(env, "bea", { scope: "person", scope_id: "ada", action: "accept_friends", expires_in: DAY });
    expect(await requestFriend(env, "ada", "bea", "")).toBe("friend");

    user(db, "cy");
    db.prepare(`DELETE FROM friendships`).run();
    member(db, boardId, "bea");
    member(db, boardId, "cy");
    await createRule(env, "bea", { scope: "board", scope_id: boardId, action: "accept_friends", expires_in: DAY });
    expect(await requestFriend(env, "cy", "bea", "")).toBe("friend");

    db.prepare(`DELETE FROM friendships`).run();
    db.prepare(`UPDATE users SET rules = ? WHERE name = ?`).run(JSON.stringify({ auto_accept_friends: "coworkers" }), "ada");
    expect(await requestFriend(env, "bea", "ada", "")).toBe("friend");
  });

  it("lets an agent DM when a rule covers them, and a block or a decline still wins", async () => {
    expect(await reach(env, "ada", "bea")).toEqual({ ok: false, why: "unknown" });
    await createRule(env, "bea", { scope: "person", scope_id: "ada", action: "allow_agents", expires_in: DAY });
    expect(await reach(env, "ada", "bea")).toEqual({ ok: true, why: "rule" });

    user(db, "cy");
    member(db, boardId, "bea");
    member(db, boardId, "cy");
    await createRule(env, "bea", { scope: "board", scope_id: boardId, action: "allow_agents", expires_in: DAY });
    expect(await reach(env, "cy", "bea")).toEqual({ ok: true, why: "rule" });

    await blockPerson(env, "bea", "ada");
    expect(await reach(env, "ada", "bea")).toEqual({ ok: false, why: "blocked" });

    db.prepare(`INSERT INTO agent_contacts (a, b, status, requested_by, created_at) VALUES ('bea', 'cy', 'declined', 'cy', 0)`).run();
    expect(await reach(env, "cy", "bea")).toEqual({ ok: false, why: "declined" });
  });
});
