import { describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
import { backupConfig, objectKey, rowPartKey, uploadPart } from "../src/backup";
import { b64, unpackPart } from "../src/backupcore";
import { Board } from "../src/board";
import type { Env } from "../src/types";

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

describe("board row parts", () => {
  it("uploads growing table rows in bounded rowid order and keeps the main part small", async () => {
    const { pub, priv } = await keypair();
    const r2 = fakeR2();
    const env = { BACKUP_PUBLIC_KEY: pub, BACKUP_R2: r2.bucket, BACKUP_ROWS_PART_BYTES: "400" } as unknown as Env;
    const entries = Array.from({ length: 20 }, (_, i) => [i + 1, `entry ${i} ${"x".repeat(80)}`]);
    const sql = {
      exec(query: string, ...args: unknown[]) {
        if (query.includes("FROM blobs ORDER BY")) return { toArray: () => [] };
        if (query.includes("FROM sqlite_master")) return { toArray: () => [{ name: "entries", sql: "CREATE TABLE entries" }, { name: "meta", sql: "CREATE TABLE meta" }] };
        if (query.includes('FROM "entries" LIMIT 0')) return { columnNames: ["seq", "text"], raw: () => [] };
        if (query.includes('FROM "meta"')) return { columnNames: ["key", "value"], raw: () => [["id", "b_test"]] };
        if (query.includes('FROM "entries" WHERE rowid >')) {
          const page = entries.filter((r) => (r[0] as number) > (args[0] as number)).slice(0, 16).map((r) => [r[0], ...r]);
          return { raw: () => page };
        }
        throw new Error(`unexpected SQL: ${query}`);
      },
    };
    const board = Object.assign(Object.create(Board.prototype), { env, sql, meta: () => "b_test" }) as Board;
    const result = await board.backup("2026-10-07");
    const main = await unpackPart<{ tables: Record<string, { rows: unknown[][] }>; row_parts: string[]; file_parts: string[] }>(priv, r2.objects.get(result.object_key)!);
    expect(main.tables.entries.rows).toEqual([]);
    expect(main.tables.meta.rows).toEqual([["id", "b_test"]]);
    expect(main.file_parts).toEqual([]);
    expect(main.row_parts.length).toBeGreaterThan(2);
    expect(result.extra?.length).toBe(main.row_parts.length);
    const restored: unknown[][] = [];
    for (const [k, name] of main.row_parts.entries()) {
      expect(name).toBe(rowPartKey(backupConfig(env)!, "2026-10-07", "b_test", "entries", k).split("/").at(-1));
      const part = await unpackPart<{ tables: { entries: { rows: unknown[][] } } }>(priv, r2.objects.get(`atteo/2026-10-07/boards/${name}`)!);
      restored.push(...part.tables.entries.rows);
    }
    expect(restored).toEqual(entries);
  });
});
