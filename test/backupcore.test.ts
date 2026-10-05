import { describe, expect, it } from "vitest";
import { b64, decodeValue, encodeValue, keyId, packPart, seal, sealedHeader, signS3, tableToSql, unpackPart, open, type S3Config } from "../src/backupcore";

// AWS's worked examples for Signature Version 4 (docs: "Examples: Signature calculations in AWS Signature Version 4").
const AWS: S3Config = { endpoint: "https://s3.amazonaws.com", bucket: "examplebucket", region: "us-east-1", keyId: "AKIAIOSFODNN7EXAMPLE", secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", prefix: "", virtualHost: true };
const AT = new Date("2013-05-24T00:00:00Z");
const sig = (h: Record<string, string>) => /Signature=([0-9a-f]+)/.exec(h.authorization)?.[1];

async function keypair(): Promise<{ pub: string; priv: CryptoKey }> {
  const kp = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
  return { pub: b64(new Uint8Array((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer)), priv: kp.privateKey };
}

describe("S3 signing (SigV4)", () => {
  it("GET object matches AWS's example", async () => {
    const { url, headers } = await signS3(AWS, "GET", "test.txt", { headers: { Range: "bytes=0-9" }, now: AT });
    expect(url).toBe("https://examplebucket.s3.amazonaws.com/test.txt");
    expect(sig(headers)).toBe("f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
    expect(headers.authorization).toContain("SignedHeaders=host;range;x-amz-content-sha256;x-amz-date");
  });
  it("PUT object with a body matches AWS's example", async () => {
    const body = new TextEncoder().encode("Welcome to Amazon S3.");
    const { headers } = await signS3(AWS, "PUT", "test$file.text", { body, headers: { Date: "Fri, 24 May 2013 00:00:00 GMT", "x-amz-storage-class": "REDUCED_REDUNDANCY" }, now: AT });
    expect(sig(headers)).toBe("98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd");
  });
  it("GET bucket with a query matches AWS's example", async () => {
    const { url, headers } = await signS3(AWS, "GET", "", { query: { "max-keys": "2", prefix: "J" }, now: AT });
    expect(url).toBe("https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J");
    expect(sig(headers)).toBe("34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
  });
  it("path style puts the bucket in the path", async () => {
    const { url } = await signS3({ ...AWS, endpoint: "https://s3.us-west-004.backblazeb2.com", virtualHost: false }, "PUT", "atteo/2026-10-05/boards/b_x.json.gz.enc");
    expect(url).toBe("https://s3.us-west-004.backblazeb2.com/examplebucket/atteo/2026-10-05/boards/b_x.json.gz.enc");
  });
});

describe("sealing", () => {
  it("round-trips a part, and only the right key opens it", async () => {
    const { pub, priv } = await keypair();
    const value = { kind: "board", tables: { entries: { columns: ["seq", "text"], rows: [[1, "héllo ✓"]] } } };
    const sealed = await packPart(pub, value);
    expect(sealedHeader(sealed).kid).toBe(await keyId(pub));
    expect(new TextDecoder().decode(sealed).includes("héllo")).toBe(false);
    expect(await unpackPart(priv, sealed)).toEqual(value);
    const other = await keypair();
    await expect(unpackPart(other.priv, sealed)).rejects.toThrow();
  });
  it("each part gets its own ephemeral key", async () => {
    const { pub, priv } = await keypair();
    const data = new TextEncoder().encode("same");
    const [a, b] = [await seal(pub, data), await seal(pub, data)];
    expect(sealedHeader(a).epk).not.toBe(sealedHeader(b).epk);
    expect(new TextDecoder().decode(await open(priv, b))).toBe("same");
  });
  it("refuses a file that isn't a backup", () => {
    expect(() => sealedHeader(new TextEncoder().encode("hello\n{}\n"))).toThrow(/not an Atteo backup/);
  });
});

describe("dump values", () => {
  it("blobs survive JSON and become SQL hex literals", () => {
    const blob = new Uint8Array([0, 1, 254, 255]).buffer;
    const v = encodeValue(blob);
    expect(v).toEqual({ $b64: "AAH+/w==" });
    expect(new Uint8Array(decodeValue(JSON.parse(JSON.stringify(v))) as ArrayBuffer)).toEqual(new Uint8Array([0, 1, 254, 255]));
    expect(tableToSql("blobs", { columns: ["name", "bytes", "n", "x"], rows: [["it's", v, 3, null]] })).toBe(`INSERT INTO "blobs" ("name", "bytes", "n", "x") VALUES ('it''s', X'0001feff', 3, NULL);\n`);
  });
});
