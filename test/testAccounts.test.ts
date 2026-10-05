import { describe, expect, it } from "vitest";
import {
  DELETE_CONFIRM,
  USER_ROW_DELETES,
  apply,
  isDeletableTestUser,
  isTestAccountName,
  operatorsOf,
  parseNames,
  preview,
  skipReason,
  testAccountKind,
} from "../src/testAccounts";
import type { Env } from "../src/types";

const { DatabaseSync } = (await import("node:" + "sqlite")) as { DatabaseSync: new (p: string) => any };
const { readFileSync, readdirSync } = (await import("node:" + "fs")) as {
  readFileSync: (p: string | URL, enc: string) => string;
  readdirSync: (u: URL) => string[];
};
const here = import.meta as unknown as { url: string };
const dir = new URL("../migrations/", here.url);

function fakeEnv(operators = "vedu,jxn") {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(dir).filter((f: string) => f.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(f, dir), "utf8"));
  const stmt = (sql: string, args: unknown[] = []): any => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => {
      const r = db.prepare(sql).run(...args);
      return { results: [], meta: { changes: r.changes } };
    },
  });
  const env = {
    OPERATORS: operators,
    DB: {
      prepare: (sql: string) => stmt(sql),
      batch: async (stmts: { run: () => Promise<unknown> }[]) => {
        const out = [];
        for (const s of stmts) out.push(await s.run());
        return out;
      },
    },
  } as unknown as Env;
  return { env, db };
}

function addUser(
  db: any,
  name: string,
  extra: { workos_id?: string; stripe_customer?: string; email?: string } = {},
) {
  const now = 1_000;
  db.prepare(
    `INSERT INTO users (name, email, email_verified, workos_id, display_name, first_seen, last_seen, stripe_customer) VALUES (?, ?, 1, ?, NULL, ?, ?, ?)`,
  ).run(name, extra.email ?? `${name}@example.com`, extra.workos_id ?? null, now, now, extra.stripe_customer ?? null);
}

function addBoard(db: any, id: string, title: string, createdBy: string, members: string[]) {
  const now = 1_000;
  db.prepare(`INSERT INTO boards (id, title, created_by, created_at, entry_count, last_activity) VALUES (?, ?, ?, ?, 0, ?)`).run(
    id,
    title,
    createdBy,
    now,
    now,
  );
  for (const u of members) {
    db.prepare(`INSERT INTO members (board_id, user, joined_at, last_seen, role) VALUES (?, ?, ?, ?, 'owner')`).run(id, u, now, now);
  }
}

describe("isTestAccountName", () => {
  it("matches e2e-*, *-test, and test-N only", () => {
    expect(isTestAccountName("e2e-vedu-gtpvc")).toBe(true);
    expect(isTestAccountName("e2e-jxn-gtpvc")).toBe(true);
    expect(testAccountKind("e2e-cli-a-gtpvc")).toBe("e2e");
    expect(isTestAccountName("foo-test")).toBe(true);
    expect(testAccountKind("foo-test")).toBe("named-test");
    expect(isTestAccountName("test-1")).toBe(true);
    expect(isTestAccountName("test-12")).toBe(true);
    expect(testAccountKind("test-1")).toBe("test-n");
    expect(isTestAccountName("vedu")).toBe(false);
    expect(isTestAccountName("jxn")).toBe(false);
    expect(isTestAccountName("contest")).toBe(false);
    expect(isTestAccountName("latest")).toBe(false);
    expect(isTestAccountName("e2e")).toBe(false);
    expect(isTestAccountName("test-user")).toBe(false);
    expect(isTestAccountName("test-")).toBe(false);
    expect(isTestAccountName("")).toBe(false);
    expect(isTestAccountName("e2e-x")).toBe(true);
  });
});

describe("skipReason / isDeletableTestUser", () => {
  const ops = operatorsOf({ OPERATORS: "vedu,jxn" });
  it("never deletes WorkOS users, operators, or Stripe customers", () => {
    expect(skipReason({ name: "e2e-foo", workos_id: "user_abc" }, ops)).toBe("workos");
    expect(isDeletableTestUser({ name: "e2e-foo", workos_id: "user_abc" }, ops)).toBe(false);
    expect(skipReason({ name: "e2e-vedu", workos_id: null }, operatorsOf({ OPERATORS: "e2e-vedu" }))).toBe("operator");
    expect(skipReason({ name: "e2e-pay", stripe_customer: "cus_1" }, ops)).toBe("stripe");
    expect(isDeletableTestUser({ name: "e2e-vedu-gtpvc", workos_id: null, stripe_customer: null }, ops)).toBe(true);
    expect(isDeletableTestUser({ name: "foo-test", workos_id: null }, ops)).toBe(true);
    expect(isDeletableTestUser({ name: "test-1", workos_id: null }, ops)).toBe(true);
    expect(isDeletableTestUser({ name: "vedu", workos_id: null }, ops)).toBe(false);
    expect(ops.has("vedu") && ops.has("jxn")).toBe(true);
  });
});

describe("parseNames", () => {
  it("normalizes a list and refuses junk", () => {
    expect(parseNames(undefined)).toBeUndefined();
    expect(parseNames(["e2e-a", "Foo-Test"])).toEqual(["e2e-a", "foo-test"]);
    expect(parseNames("e2e-a, test-1")).toEqual(["e2e-a", "test-1"]);
    expect(parseNames([])).toEqual({ error: "names is empty" });
    expect(parseNames("Nope!")).toEqual({ error: "invalid name: Nope!" });
  });
});

describe("preview and apply", () => {
  it("lists only deletable test accounts and e2e boards they solely own", async () => {
    const f = fakeEnv();
    addUser(f.db, "vedu", { workos_id: "user_vedu" });
    addUser(f.db, "jxn", { workos_id: "user_jxn" });
    addUser(f.db, "e2e-vedu-gtpvc");
    addUser(f.db, "foo-test");
    addUser(f.db, "test-1");
    addUser(f.db, "e2e-paid", { stripe_customer: "cus_x" });
    addUser(f.db, "e2e-wo", { workos_id: "user_wo" });
    addUser(f.db, "outsider", { workos_id: "user_out" });
    addBoard(f.db, "b_e2eonly0001", "e2e leftover", "e2e-vedu-gtpvc", ["e2e-vedu-gtpvc", "foo-test"]);
    addBoard(f.db, "b_shared000002", "e2e mixed", "e2e-vedu-gtpvc", ["e2e-vedu-gtpvc", "vedu"]);
    addBoard(f.db, "b_realboard003", "Checkout integration", "e2e-vedu-gtpvc", ["e2e-vedu-gtpvc", "jxn"]);

    const pre = await preview(f.env);
    expect(pre.users.map((u) => u.name).sort()).toEqual(["e2e-vedu-gtpvc", "foo-test", "test-1"]);
    expect(pre.boards.map((b) => b.id)).toEqual(["b_e2eonly0001"]);
    expect(pre.skipped.map((s) => `${s.name}:${s.reason}`).sort()).toEqual(["e2e-paid:stripe", "e2e-wo:workos"]);
  });

  it("dry-runs unless the confirm phrase is exact, and never deletes a real user", async () => {
    const f = fakeEnv();
    addUser(f.db, "vedu", { workos_id: "user_vedu" });
    addUser(f.db, "e2e-vedu-gtpvc");
    addUser(f.db, "foo-test");
    addUser(f.db, "test-1");
    addBoard(f.db, "b_e2eonly0001", "e2e leftover", "e2e-vedu-gtpvc", ["e2e-vedu-gtpvc"]);

    const dry = await apply(f.env, {});
    expect(dry.status).toBe(200);
    expect((dry.body as { dry_run: boolean }).dry_run).toBe(true);
    expect(f.db.prepare(`SELECT COUNT(*) AS n FROM users WHERE name = 'e2e-vedu-gtpvc'`).get().n).toBe(1);

    const wrong = await apply(f.env, { confirm: "yes" });
    expect(wrong.status).toBe(400);

    const mixed = await apply(f.env, { confirm: DELETE_CONFIRM, names: ["e2e-vedu-gtpvc", "vedu"] });
    expect(mixed.status).toBe(400);
    expect(f.db.prepare(`SELECT COUNT(*) AS n FROM users WHERE name = 'e2e-vedu-gtpvc'`).get().n).toBe(1);
    expect(f.db.prepare(`SELECT COUNT(*) AS n FROM users WHERE name = 'vedu'`).get().n).toBe(1);

    const gone = await apply(f.env, { confirm: DELETE_CONFIRM, names: ["e2e-vedu-gtpvc", "foo-test", "test-1"] });
    expect(gone.status).toBe(200);
    const body = gone.body as { dry_run: boolean; deleted: string[]; deleted_boards: string[] };
    expect(body.dry_run).toBe(false);
    expect(body.deleted.sort()).toEqual(["e2e-vedu-gtpvc", "foo-test", "test-1"]);
    expect(body.deleted_boards).toEqual(["b_e2eonly0001"]);
    expect(f.db.prepare(`SELECT COUNT(*) AS n FROM users WHERE name = 'e2e-vedu-gtpvc'`).get().n).toBe(0);
    expect(f.db.prepare(`SELECT COUNT(*) AS n FROM users WHERE name = 'vedu'`).get().n).toBe(1);
    expect(f.db.prepare(`SELECT COUNT(*) AS n FROM boards WHERE id = 'b_e2eonly0001'`).get().n).toBe(0);
  });

  it("every per-user DELETE statement is valid against current migrations", () => {
    const db = new DatabaseSync(":memory:");
    for (const f of readdirSync(dir).filter((x: string) => x.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(f, dir), "utf8"));
    for (const sql of USER_ROW_DELETES) expect(() => db.prepare(sql), sql).not.toThrow();
  });

  it("the CLI is dry-run by default and does not DELETE FROM users itself", () => {
    const sh = readFileSync(new URL("../scripts/cleanup-e2e.sh", here.url), "utf8");
    const js = readFileSync(new URL("../scripts/cleanup-e2e.mjs", here.url), "utf8");
    expect(sh).not.toMatch(/DELETE FROM users/);
    expect(js).toContain("--allow-production");
    expect(js).toContain(DELETE_CONFIRM);
    expect(js).toContain("dry-run");
    expect(js).toContain("WorkOS");
  });
});
