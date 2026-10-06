import { describe, expect, it } from "vitest";
import { backupConfig, objectKey, uploadPart } from "../src/backup";
import { b64, unpackPart } from "../src/backupcore";
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
