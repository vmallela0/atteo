import { beforeEach, describe, expect, it } from "vitest";
import { createLink, grantExpiresDays, inviteRole, parseRole } from "../src/access";
import { sendInvite } from "../src/invite";
import { acceptInvitation, DEFAULT_GRANT_DAYS, DEFAULT_GRANT_ROLE, memberRole } from "../src/registry";
import type { Env } from "../src/types";

const { DatabaseSync } = (await import("node:" + "sqlite")) as { DatabaseSync: new (p: string) => any };
const { readFileSync, readdirSync } = (await import("node:" + "fs")) as { readFileSync: (u: URL, enc: string) => string; readdirSync: (u: URL) => string[] };
const dir = new URL("../migrations/", (import.meta as unknown as { url: string }).url);

/** node:sqlite binds `?` only. D1 also uses `?1`; expand those to positional `?`. */
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

const boardId = "b_aaaaaaaa";
const DAY = 86_400_000;

function user(db: any, name: string, email = `${name}@example.com`, verified = 1) {
  db.prepare(`INSERT INTO users (name, email, email_verified, first_seen, last_seen) VALUES (?, ?, ?, 0, 0)`).run(name, email, verified);
}
function board(db: any, id: string, by: string) {
  db.prepare(`INSERT INTO boards (id, title, created_by, created_at, last_activity) VALUES (?, ?, ?, 0, 0)`).run(id, id, by);
}
function member(db: any, id: string, name: string) {
  db.prepare(`INSERT INTO members (board_id, user, joined_at, last_seen, role) VALUES (?, ?, 0, 0, 'owner')`).run(id, name);
}

describe("grant defaults (GAPS P0 network #4)", () => {
  it("inviteRole: omitted is viewer; viewer/contributor kept; owner is still contributor", () => {
    expect(inviteRole(undefined)).toBe("viewer");
    expect(inviteRole(null)).toBe("viewer");
    expect(inviteRole("")).toBe("viewer");
    expect(inviteRole("viewer")).toBe("viewer");
    expect(inviteRole("contributor")).toBe("contributor");
    expect(inviteRole("owner")).toBe("contributor");
    expect(inviteRole("nope")).toBe("contributor");
  });

  it("parseRole omitted is viewer (invite links)", () => {
    expect(parseRole(undefined)).toBe(DEFAULT_GRANT_ROLE);
    expect(parseRole("contributor")).toBe("contributor");
  });

  it("grantExpiresDays: only an explicit 0 is no end; omitted or garbage is the 30-day default (jxn's agent #4399)", () => {
    expect(grantExpiresDays(undefined)).toBe(DEFAULT_GRANT_DAYS);
    expect(grantExpiresDays("")).toBe(DEFAULT_GRANT_DAYS);
    expect(grantExpiresDays(0)).toBe(null);
    expect(grantExpiresDays("0")).toBe(null);
    for (const junk of [null, NaN, "abc", -5, "-1", "  ", {}, true]) expect(grantExpiresDays(junk), String(junk)).toBe(DEFAULT_GRANT_DAYS);
    expect(grantExpiresDays(7)).toBe(7);
    expect(grantExpiresDays("90")).toBe(90);
    expect(grantExpiresDays(400)).toBe(365);
  });
});

describe("invite links: member_days default vs 0", () => {
  let env: Env;
  let db: any;
  beforeEach(() => {
    ({ env, db } = fakeEnv());
    user(db, "ada");
    board(db, boardId, "ada");
    member(db, boardId, "ada");
  });

  it("omitted role and member_days → viewer for 30 days; the link itself still lasts 7", async () => {
    const { link } = await createLink(env, boardId, "ada", {}, "http://localhost");
    expect(link.role).toBe("viewer");
    expect(link.member_days).toBe(30);
    expect(link.expires_at).toBeGreaterThan(Date.now() + 6 * DAY);
    expect(link.expires_at).toBeLessThan(Date.now() + 8 * DAY);
  });

  it("member_days 0 stays open-ended; an explicit contributor is kept", async () => {
    const { link } = await createLink(env, boardId, "ada", { role: "contributor", member_days: 0, link_days: 1 }, "http://localhost");
    expect(link.role).toBe("contributor");
    expect(link.member_days).toBe(null);
  });

  it("explicit member_days 7 is 7, not the 30-day default", async () => {
    const { link } = await createLink(env, boardId, "ada", { member_days: 7 }, "http://localhost");
    expect(link.role).toBe("viewer");
    expect(link.member_days).toBe(7);
  });
});

describe("email invites: viewer + 30 days unless set", () => {
  let env: Env;
  let db: any;
  beforeEach(() => {
    ({ env, db } = fakeEnv());
    user(db, "ada");
    user(db, "bea");
    board(db, boardId, "ada");
    member(db, boardId, "ada");
  });

  it("omitted role and expiresDays store viewer / 30, and accept applies them", async () => {
    const r = await sendInvite(env, "http://localhost", { boardId, email: "bea@example.com", invitedBy: "ada" });
    expect(r.ok).toBe(true);
    const inv = db.prepare(`SELECT role, expires_days FROM invites WHERE board_id = ? AND email = ?`).get(boardId, "bea@example.com");
    expect(inv).toMatchObject({ role: "viewer", expires_days: 30 });
    const bea = { name: "bea", email: "bea@example.com", email_verified: 1, workos_id: null, display_name: null, first_seen: 0, last_seen: 0 };
    expect(await acceptInvitation(env, bea, boardId)).toBe(true);
    expect(await memberRole(env, boardId, "bea")).toBe("viewer");
    const row = db.prepare(`SELECT role, expires_at FROM members WHERE board_id = ? AND user = ?`).get(boardId, "bea");
    expect(row.role).toBe("viewer");
    expect(row.expires_at).toBeGreaterThan(Date.now() + 29 * DAY);
    expect(row.expires_at).toBeLessThan(Date.now() + 31 * DAY);
  });

  it("explicit contributor and expiresDays 0 stay contributor with no end", async () => {
    await sendInvite(env, "http://localhost", { boardId, email: "bea@example.com", invitedBy: "ada", role: "contributor", expiresDays: 0 });
    const inv = db.prepare(`SELECT role, expires_days FROM invites WHERE board_id = ? AND email = ?`).get(boardId, "bea@example.com");
    expect(inv).toMatchObject({ role: "contributor", expires_days: null });
    const bea = { name: "bea", email: "bea@example.com", email_verified: 1, workos_id: null, display_name: null, first_seen: 0, last_seen: 0 };
    expect(await acceptInvitation(env, bea, boardId)).toBe(true);
    expect(await memberRole(env, boardId, "bea")).toBe("contributor");
    const row = db.prepare(`SELECT expires_at FROM members WHERE board_id = ? AND user = ?`).get(boardId, "bea");
    expect(row.expires_at).toBe(null);
  });
});
