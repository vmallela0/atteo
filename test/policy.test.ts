// Organization policies and the first-slice org directory: list people who share a verified email
// domain that has an org_policies row. Handles and presence only; never emails.

import { beforeEach, describe, expect, it } from "vitest";
import { checkOutsideMember, emailDomain, orgDomainOf, orgPolicy } from "../src/policy";
import { blockPerson, findPeople, orgPeople } from "../src/social";
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

function user(db: any, name: string, email: string | null, verified = 1) {
  db.prepare(`INSERT INTO users (name, email, email_verified, first_seen, last_seen) VALUES (?, ?, ?, 0, 0)`).run(name, email, verified);
}
function policy(db: any, domain: string, allowOutside = 1) {
  db.prepare(`INSERT INTO org_policies (domain, require_sso, max_retention_days, allow_outside_members, updated_at) VALUES (?, 0, NULL, ?, 0)`).run(domain, allowOutside);
}
function board(db: any, id: string, by: string) {
  db.prepare(`INSERT INTO boards (id, title, created_by, created_at, last_activity) VALUES (?, ?, ?, 0, 0)`).run(id, id, by);
}

describe("emailDomain", () => {
  it("takes the host of a work email and refuses junk", () => {
    expect(emailDomain("Ada@Acme.COM")).toBe("acme.com");
    expect(emailDomain("ada@mail.acme.com")).toBe("mail.acme.com");
    expect(emailDomain(null)).toBeNull();
    expect(emailDomain("no-at")).toBeNull();
    expect(emailDomain("ada@localhost")).toBeNull();
  });
});

describe("org directory: list members by domain policy", () => {
  let env: Env;
  let db: any;
  beforeEach(() => {
    ({ env, db } = fakeEnv());
    user(db, "ada", "ada@acme.com");
    user(db, "bea", "bea@acme.com");
    user(db, "cam", "cam@acme.com", 0); // unverified: not in the directory
    user(db, "dot", "dot@other.test");
    user(db, "eve", "eve@gmail.com");
  });

  it("is empty until an operator sets a policy for the domain", async () => {
    expect(await orgPolicy(env, "ada@acme.com")).toBeNull();
    expect(await orgDomainOf(env, "ada")).toBeNull();
    expect(await orgPeople(env, "ada")).toEqual({ domain: null, people: [] });
    expect((await findPeople(env, "ada", "be")).map((p) => p.name)).toEqual([]);
  });

  it("lists verified people at that domain, never emails, and hides unverified and other domains", async () => {
    policy(db, "acme.com");
    expect(await orgDomainOf(env, "ada")).toBe("acme.com");
    expect(await orgDomainOf(env, "dot")).toBeNull();
    expect(await orgDomainOf(env, "eve")).toBeNull();

    const dir = await orgPeople(env, "ada");
    expect(dir.domain).toBe("acme.com");
    expect(dir.people.map((p) => p.name).sort()).toEqual(["ada", "bea"]);
    expect(JSON.stringify(dir)).not.toMatch(/@acme\.com/i);
    expect(dir.people.every((p) => !("email" in p))).toBe(true);

    const outsider = await orgPeople(env, "dot");
    expect(outsider).toEqual({ domain: null, people: [] });

    const filtered = await orgPeople(env, "ada", "be");
    expect(filtered.people.map((p) => p.name)).toEqual(["bea"]);
  });

  it("lets org-mates find each other by partial name without sharing a board or listing", async () => {
    policy(db, "acme.com");
    const found = await findPeople(env, "ada", "be");
    expect(found.map((p) => p.name)).toEqual(["bea"]);
    expect(JSON.stringify(found)).not.toMatch(/@/);
    expect((await findPeople(env, "dot", "be")).map((p) => p.name)).toEqual([]);
  });

  it("omits someone who blocked you", async () => {
    policy(db, "acme.com");
    await blockPerson(env, "bea", "ada");
    expect((await orgPeople(env, "ada")).people.map((p) => p.name)).toEqual(["ada"]);
  });

  it("keeps in-house boards to the domain when allow_outside_members is off", async () => {
    policy(db, "acme.com", 0);
    board(db, "b_aaaaaaaa", "ada");
    await expect(checkOutsideMember(env, "b_aaaaaaaa", "dot@other.test")).rejects.toThrow(/acme.com accounts only/);
    await expect(checkOutsideMember(env, "b_aaaaaaaa", "bea@acme.com")).resolves.toBeUndefined();
  });
});
