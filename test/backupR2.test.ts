import { describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
import { backupConfig, driveBoardBackup, objectKey, rowPartKey, uploadPart, type BoardBackupStep, type PartResult } from "../src/backup";
import { b64, sha256Hex, unpackPart, type DumpTables } from "../src/backupcore";
import { Board } from "../src/board";
import type { Env } from "../src/types";

// node:sqlite, typed only as far as these tests use it (the project has no Node types).
interface Stmt {
  columns(): { name: string }[];
  setReturnArrays(on: boolean): void;
  all(...args: unknown[]): unknown[];
  get(...args: unknown[]): unknown;
  run(...args: unknown[]): unknown;
}
interface DatabaseSync {
  exec(sql: string): void;
  prepare(sql: string): Stmt;
}
const { DatabaseSync } = (await import("node:" + "sqlite")) as { DatabaseSync: new (p: string) => DatabaseSync };

// Where nightly backups go (vedu #5342): R2 in our account through the BACKUP_R2 binding, unless every BACKUP_S3_* setting
// is set (an outside bucket someone chose on purpose). The full night against a local R2 is test/backup.mjs BK_MODE=r2.

async function keypair(): Promise<{ pub: string; priv: CryptoKey }> {
  const kp = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
  return { pub: b64(new Uint8Array((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer)), priv: kp.privateKey };
}

/** Enough of an R2Bucket for put: keeps the bytes it was given. */
function fakeR2() {
  const objects = new Map<string, Uint8Array>();
  const bucket = {
    put: async (key: string, value: Uint8Array) => {
      objects.set(key, new Uint8Array(value));
      return { key } as unknown as R2Object;
    },
  } as unknown as R2Bucket;
  return { bucket, objects };
}

const S3 = { BACKUP_S3_ENDPOINT: "https://s3.example.test", BACKUP_S3_BUCKET: "b", BACKUP_S3_KEY_ID: "k", BACKUP_S3_SECRET: "s" };

describe("backup target", () => {
  it("is off without a public key, even with a bucket", async () => {
    expect(backupConfig({ BACKUP_R2: fakeR2().bucket } as unknown as Env)).toBeNull();
    expect(backupConfig({ ...S3 } as unknown as Env)).toBeNull();
  });

  it("is off with a malformed public key", () => {
    expect(backupConfig({ BACKUP_PUBLIC_KEY: "not-a-key", BACKUP_R2: fakeR2().bucket } as unknown as Env)).toBeNull();
  });

  it("is off with a public key but no bucket", async () => {
    const { pub } = await keypair();
    expect(backupConfig({ BACKUP_PUBLIC_KEY: pub } as unknown as Env)).toBeNull();
  });

  it("uses the R2 binding when no S3 bucket is set, under atteo/ by default", async () => {
    const { pub } = await keypair();
    const cfg = backupConfig({ BACKUP_PUBLIC_KEY: pub, BACKUP_R2: fakeR2().bucket } as unknown as Env);
    expect(cfg?.r2).toBeTruthy();
    expect(cfg?.s3).toBeUndefined();
    expect(cfg && objectKey(cfg, "2026-10-06", "board:b_x")).toBe("atteo/2026-10-06/boards/b_x.json.gz.enc");
  });

  it("an S3 bucket set in full wins over the binding", async () => {
    const { pub } = await keypair();
    const cfg = backupConfig({ BACKUP_PUBLIC_KEY: pub, BACKUP_R2: fakeR2().bucket, ...S3, BACKUP_S3_PREFIX: "x" } as unknown as Env);
    expect(cfg?.s3?.bucket).toBe("b");
    expect(cfg?.r2).toBeUndefined();
    expect(cfg?.prefix).toBe("x/");
  });

  it("an S3 bucket set only in part falls back to R2", async () => {
    const { pub } = await keypair();
    const cfg = backupConfig({ BACKUP_PUBLIC_KEY: pub, BACKUP_R2: fakeR2().bucket, BACKUP_S3_ENDPOINT: "https://s3.example.test" } as unknown as Env);
    expect(cfg?.r2).toBeTruthy();
  });
});

describe("uploadPart to R2", () => {
  it("puts the sealed part under its key, and only the private key opens it", async () => {
    const { pub, priv } = await keypair();
    const r2 = fakeR2();
    const cfg = backupConfig({ BACKUP_PUBLIC_KEY: pub, BACKUP_R2: r2.bucket } as unknown as Env)!;
    const key = objectKey(cfg, "2026-10-06", "d1");
    const r = await uploadPart(cfg, key, { kind: "d1", rows: [1, 2, 3] });
    expect(r.object_key).toBe("atteo/2026-10-06/d1.json.gz.enc");
    const stored = r2.objects.get(key)!;
    expect(stored.length).toBe(r.bytes);
    expect(new TextDecoder().decode(stored.slice(0, 16))).toBe("atteo-backup-v1\n");
    expect(await unpackPart(priv, stored)).toEqual({ kind: "d1", rows: [1, 2, 3] });
  });
});


// A board object over a real SQLite (node:sqlite), enough of DurableObject's sql and storage for backupStep and
// restoreTables. `fresh()` is the same board after a reset: the same database and storage, nothing in memory.
function sqlOver(db: DatabaseSync) {
  return {
    exec(query: string, ...args: unknown[]) {
      const st = db.prepare(query);
      const columnNames = st.columns().map((c) => c.name);
      st.setReturnArrays(true);
      const rows = st.all(...(args.map((a) => (a instanceof ArrayBuffer ? new Uint8Array(a) : a)) )) as unknown[][];
      return { columnNames, raw: () => rows[Symbol.iterator](), toArray: () => rows.map((r) => Object.fromEntries(columnNames.map((c, i) => [c, r[i]]))) };
    },
  };
}
function boardOver(db: DatabaseSync, env: Env, storage = new Map<string, unknown>()) {
  const fresh = () =>
    Object.assign(Object.create(Board.prototype), {
      env,
      sql: sqlOver(db),
      meta: (k: string) => (db.prepare("SELECT value FROM meta WHERE key = ?").get(k) as { value: string } | undefined)?.value ?? null,
      metaCache: new Map(),
      ctx: {
        storage: {
          get: async (k: string) => (storage.has(k) ? structuredClone(storage.get(k)) : undefined),
          put: async (k: string, v: unknown) => void storage.set(k, structuredClone(v)),
          delete: async (k: string) => storage.delete(k),
          transactionSync: (fn: () => unknown) => fn(),
        },
      },
    }) as Board;
  return { fresh, storage };
}

const SCHEMA = `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE entries (seq INTEGER PRIMARY KEY, text TEXT NOT NULL, artifact_content TEXT);
  CREATE TABLE doc_versions (name TEXT NOT NULL, version INTEGER NOT NULL, content TEXT NOT NULL, PRIMARY KEY (name, version));
  CREATE TABLE blobs (name TEXT NOT NULL, version INTEGER NOT NULL, mime TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (name, version));
  CREATE TABLE sealed_files (id TEXT PRIMARY KEY, size INTEGER NOT NULL, bytes BLOB NOT NULL);
  CREATE TABLE reactions (seq INTEGER NOT NULL, emoji TEXT NOT NULL);
  CREATE VIRTUAL TABLE search_idx USING fts5(body, ref UNINDEXED);
`;

/** A board too big for one part at these sizes: 600 entries (some long, some not ASCII), 40 versions of a document,
 *  30 files, 4 sealed files, the search index, and a table with no rows. */
function bigBoard(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  db.prepare("INSERT INTO meta VALUES ('id', 'b_big'), ('title', 'big')").run();
  const e = db.prepare("INSERT INTO entries (seq, text, artifact_content) VALUES (?, ?, ?)");
  const s = db.prepare("INSERT INTO search_idx (body, ref) VALUES (?, ?)");
  for (let i = 1; i <= 600; i++) {
    const text = `entry ${i} ${i % 7 ? "plain words" : "→ 🟦 ünïcödé"} ${"x".repeat(i % 50)}`;
    e.run(i, text, i % 100 === 0 ? "long artifact\n".repeat(400) : null);
    s.run(text, String(i));
  }
  for (let v = 1; v <= 40; v++) db.prepare("INSERT INTO doc_versions VALUES ('plan.md', ?, ?)").run(v, `# Plan v${v}\n${"step\n".repeat(v * 10)}`);
  for (let i = 0; i < 30; i++) db.prepare("INSERT INTO blobs VALUES (?, 1, 'image/png', ?)").run(`f${String(i).padStart(2, "0")}.png`, new Uint8Array(3000).map((_, j) => (i * 31 + j) % 256));
  db.prepare("INSERT INTO blobs VALUES ('f05.png', 2, 'image/png', ?)").run(new Uint8Array(12_000).fill(7)); // larger than a file part: one of its own
  for (let i = 0; i < 4; i++) db.prepare("INSERT INTO sealed_files VALUES (?, 5000, ?)").run(`s${i}`, new Uint8Array(5000).fill(i));
  return db;
}

const DAY = "2026-10-08";
type Main = { kind: string; tables: DumpTables; row_parts: string[]; file_parts: string[] };

/** Reads the night back the way scripts/backup.mjs restore-board does: the main part, then row parts, then file parts. */
async function restoreInto(priv: CryptoKey, objects: Map<string, Uint8Array>, result: PartResult): Promise<DatabaseSync> {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  const board = boardOver(db, {} as Env).fresh();
  const main = await unpackPart<Main>(priv, objects.get(result.object_key)!);
  await board.restoreTables(main.tables, false);
  for (const name of [...main.row_parts, ...main.file_parts]) await board.restoreTables((await unpackPart<{ tables: DumpTables }>(priv, objects.get(`atteo/${DAY}/boards/${name}`)!)).tables, true);
  return db;
}

const tableRows = (db: DatabaseSync, t: string) => db.prepare(`SELECT * FROM ${t}`).all().map((r) => JSON.stringify(Object.values(r as object).map((v) => (v instanceof Uint8Array ? b64(v) : v)))).sort(); // restored rows can take other rowids
const sameBoard = (a: DatabaseSync, b: DatabaseSync) => {
  for (const t of ["meta", "entries", "doc_versions", "blobs", "sealed_files", "reactions", "search_idx"]) expect(tableRows(b, t), t).toEqual(tableRows(a, t));
};

describe("a big board's backup", () => {
  const sizes = { BACKUP_BLOB_PART_BYTES: "10000", BACKUP_ROWS_PART_BYTES: "4000", BACKUP_STEP_BYTES: "20000" };

  it("goes up in bounded parts over several calls, and restores to the same board", async () => {
    const { pub, priv } = await keypair();
    const r2 = fakeR2();
    const db = bigBoard();
    const env = { BACKUP_PUBLIC_KEY: pub, BACKUP_R2: r2.bucket, ...sizes } as unknown as Env;
    const { fresh, storage } = boardOver(db, env);
    let steps = 0;
    const perStep: number[] = [];
    const result = await driveBoardBackup(async () => {
      steps++;
      const before = r2.objects.size;
      const r = await fresh().backupStep(DAY);
      perStep.push(r2.objects.size - before);
      return r;
    });
    expect(steps).toBeGreaterThan(5);
    expect(Math.max(...perStep)).toBeLessThanOrEqual(8); // ~20 KB a call at ≤10 KB / ≤4 KB a part (plus the main part)
    expect(storage.size).toBe(0); // the place is forgotten once the board is done

    const main = await unpackPart<Main>(priv, r2.objects.get(result.object_key)!);
    expect(main.kind).toBe("board");
    expect(main.tables.entries.rows).toEqual([]);
    expect(main.tables.entries.columns).toEqual(["seq", "text", "artifact_content"]);
    expect(main.tables.meta.rows).toEqual([["id", "b_big"], ["title", "big"]]);
    expect(Object.keys(main.tables)).not.toContain("search_idx_data");
    expect(main.file_parts.length).toBeGreaterThan(5);
    for (const t of ["entries", "doc_versions", "search_idx", "sealed_files"]) expect(main.row_parts.filter((n) => n.includes(`.rows-${t}-`)).length, t).toBeGreaterThan(2);
    expect(main.row_parts.some((n) => n.includes(".rows-reactions-"))).toBe(false); // no rows, no part
    // Parts are numbered in order per table, and the result lists every one with its size and hash.
    expect(main.row_parts.filter((n) => n.includes(".rows-entries-"))).toEqual(main.row_parts.filter((n) => n.includes(".rows-entries-")).map((_, k) => rowPartKey(backupConfig(env)!, DAY, "b_big", "entries", k).split("/").at(-1)));
    expect(result.extra!.map((e) => e.object_key.split("/").at(-1))).toEqual([...main.file_parts, ...main.row_parts]);
    for (const e of result.extra!) {
      const body = r2.objects.get(e.object_key)!;
      expect(body.length).toBe(e.bytes);
      expect(e.sha256).toBe(await sha256Hex(body));
    }
    // Each part is bounded: a few KB of JSON at most (one row larger than the cap rides alone).
    for (const name of main.row_parts) {
      const part = await unpackPart<{ kind: string; table: string; tables: DumpTables }>(priv, r2.objects.get(`atteo/${DAY}/boards/${name}`)!);
      expect(part.kind).toBe("board-rows");
      const rows = part.tables[part.table].rows;
      if (rows.length > 1) expect(JSON.stringify(rows).length).toBeLessThan(4000 + 200);
    }
    sameBoard(db, await restoreInto(priv, r2.objects, result));
  });

  it("carries on after the last saved part when the object resets mid-call, writing each part once", async () => {
    const { pub, priv } = await keypair();
    const r2 = fakeR2();
    const puts: string[] = [];
    let n = 0;
    const put = r2.bucket.put.bind(r2.bucket);
    (r2.bucket as unknown as { put: unknown }).put = async (key: string, v: Uint8Array) => {
      if (++n % 9 === 0) throw new Error("Network connection lost."); // every ninth upload dies with the object
      puts.push(key);
      return put(key, v);
    };
    const db = bigBoard();
    const { fresh } = boardOver(db, { BACKUP_PUBLIC_KEY: pub, BACKUP_R2: r2.bucket, ...sizes } as unknown as Env);
    const result = await driveBoardBackup(() => fresh().backupStep(DAY));
    expect(n).toBeGreaterThan(18);
    expect(new Set(puts).size).toBe(puts.length); // nothing written twice: each retry started after the last saved part
    expect(puts.length).toBe(result.extra!.length + 1);
    sameBoard(db, await restoreInto(priv, r2.objects, result));
  });

  it("a failed attempt picks up where it stopped on the next attempt (backupTick's retry)", async () => {
    const { pub, priv } = await keypair();
    const r2 = fakeR2();
    const db = bigBoard();
    const { fresh, storage } = boardOver(db, { BACKUP_PUBLIC_KEY: pub, BACKUP_R2: r2.bucket, ...sizes } as unknown as Env);
    let calls = 0;
    await expect(
      driveBoardBackup(async () => {
        if (++calls === 4) throw new Error("S3 PUT x: 503 SlowDown"); // not a reset: the attempt fails
        return fresh().backupStep(DAY);
      }),
    ).rejects.toThrow(/503/);
    const first = r2.objects.size;
    expect(first).toBeGreaterThan(5);
    expect(storage.size).toBe(1);
    const result = await driveBoardBackup(() => fresh().backupStep(DAY));
    expect(r2.objects.size).toBe(result.extra!.length + 1);
    expect(result.extra!.slice(0, first).map((e) => e.object_key)).toEqual([...r2.objects.keys()].slice(0, first));
    sameBoard(db, await restoreInto(priv, r2.objects, result));
  });

  it("a saved place from another night is ignored", async () => {
    const { pub, priv } = await keypair();
    const r2 = fakeR2();
    const db = bigBoard();
    const { fresh, storage } = boardOver(db, { BACKUP_PUBLIC_KEY: pub, BACKUP_R2: r2.bucket, ...sizes } as unknown as Env);
    expect((await fresh().backupStep("2026-10-07")).done).toBe(false);
    expect(storage.size).toBe(1);
    const result = await driveBoardBackup(() => fresh().backupStep(DAY));
    expect(result.extra!.every((e) => e.object_key.startsWith(`atteo/${DAY}/`))).toBe(true);
    sameBoard(db, await restoreInto(priv, r2.objects, result));
  });
});

describe("driveBoardBackup", () => {
  const done: BoardBackupStep = { done: true, result: { object_key: "k", bytes: 1, sha256: "x" } };
  it("tries a step again after a reset, at most `retries` times in a row", async () => {
    const lost = Object.assign(new Error("Durable Object reset because its code was updated."), { retryable: true });
    let i = 0;
    const seq = [lost, { done: false, parts: 1 }, lost, lost, done];
    await expect(driveBoardBackup(async () => { const s = seq[i++]; if (s instanceof Error) throw s; return s as BoardBackupStep; })).resolves.toEqual(done.result);
    i = 0;
    const three = [lost, lost, lost, done];
    await expect(driveBoardBackup(async () => { const s = three[i++]; if (s instanceof Error) throw s; return s as BoardBackupStep; })).rejects.toThrow(/reset/);
  });
  it("fails at once on anything else", async () => {
    let calls = 0;
    await expect(driveBoardBackup(async () => (calls++, Promise.reject(new Error("backups are not configured"))))).rejects.toThrow(/not configured/);
    expect(calls).toBe(1);
  });
});
