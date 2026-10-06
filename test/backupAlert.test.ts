import { describe, expect, it } from "vitest";
import { backupTick, type PartResult } from "../src/backup";
import { b64 } from "../src/backupcore";
import type { Env } from "../src/types";

// When a night's backup is reported late (SOUP-A, Oct 6): turning backups on after the deadline isn't a late night,
// but a night that started and didn't finish is, and so is any missed night once one has finished.
// D1 is node:sqlite with every migration; R2 is a map; boards answer through `board`.

const { DatabaseSync } = (await import("node:" + "sqlite")) as { DatabaseSync: new (p: string) => any };
const { readFileSync, readdirSync } = (await import("node:" + "fs")) as { readFileSync: (u: URL, enc: string) => string; readdirSync: (u: URL) => string[] };
const dir = new URL("../migrations/", (import.meta as unknown as { url: string }).url);

async function fakeEnv() {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(f, dir), "utf8"));
  db.prepare(`INSERT INTO boards (id, title, created_by, created_at, last_activity) VALUES ('b1', 'b1', 'u', 0, 0)`).run();
  const stmt = (sql: string, args: unknown[] = []): any => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    raw: async () => {
      const s = db.prepare(sql);
      s.setReturnArrays(true);
      return s.all(...args);
    },
    run: async () => ({ results: [], meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  });
  const kp = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
  const objects = new Map<string, unknown>();
  const env = {
    DB: { prepare: (sql: string) => stmt(sql) },
    BACKUP_PUBLIC_KEY: b64(new Uint8Array((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer)),
    BACKUP_R2: { put: async (key: string, v: unknown) => objects.set(key, v) },
  } as unknown as Env;
  return { env, db };
}

const ok = async (id: string, day: string): Promise<PartResult> => ({ object_key: `atteo/${day}/board-${id}`, bytes: 1, sha256: "x" });
const down = async (): Promise<PartResult> => {
  throw new Error("board unreachable");
};
const at = (day: number, h: number, m = 0) => Date.UTC(2026, 9, day, h, m);

describe("late-night alert", () => {
  it("isn't raised for the night backups were turned on after the deadline", async () => {
    const { env } = await fakeEnv();
    // Turned on at 19:10; the board doesn't answer yet, so the night isn't finished by 19:11 or 19:12.
    expect((await backupTick(env, at(6, 19, 11), down)).alert).toBeUndefined();
    expect((await backupTick(env, at(6, 19, 12), down)).alert).toBeUndefined();
    const t = await backupTick(env, at(6, 19, 13), ok);
    expect(t.manifest).toBe(true);
    expect(t.alert).toBeUndefined();
  });

  it("is raised for a night that started and didn't finish", async () => {
    const { env } = await fakeEnv();
    expect((await backupTick(env, at(6, 4), down)).alert).toBeUndefined();
    expect((await backupTick(env, at(6, 9), down)).alert).toMatch(/^Backup 2026-10-06 incomplete: no manifest by 09:00 UTC/);
  });

  it("is raised for a missed night once a night has finished", async () => {
    const { env } = await fakeEnv();
    expect((await backupTick(env, at(5, 4), ok)).manifest).toBe(true);
    // Nothing ran on the 6th until 10:00.
    expect((await backupTick(env, at(6, 10), down)).alert).toMatch(/^Backup 2026-10-06 incomplete: no manifest by 09:00 UTC/);
  });

  it("still reports a first night that gave up on a part", async () => {
    const { env } = await fakeEnv();
    for (const m of [11, 12, 13]) await backupTick(env, at(6, 19, m), down);
    const rows = await env.DB.prepare(`SELECT error FROM backup_parts WHERE day = '2026-10-06' AND part = 'alert'`).first<{ error: string }>();
    expect(rows?.error).toBe("1 part failed 3 times");
  });
});
