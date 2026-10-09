import { describe, expect, it } from "vitest";
import { b64, decodeValue, encodeValue, gunzip, gzipText, keyId, packPart, packText, seal, sealedHeader, signS3, tablePartText, tableToSql, unpackPart, open, utf8Length, type S3Config } from "../src/backupcore";

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

  it("a D1 BLOB (an array of byte values) is dumped as {$b64}, and an older night's raw array still restores", () => {
    // D1's .raw()/.all() return a BLOB as number[]: the night of Oct 9 2026 stored avatars that way and d1-sql died in
    // atob ("The string to be decoded is not correctly encoded").
    expect(encodeValue([0, 1, 254, 255])).toEqual({ $b64: "AAH+/w==" });
    expect(encodeValue([])).toEqual({ $b64: "" });
    const legacy = [0, 1, 254, 255];
    expect(tableToSql("avatars", { columns: ["user", "bytes"], rows: [["a", legacy]] })).toBe(`INSERT INTO "avatars" ("user", "bytes") VALUES ('a', X'0001feff');\n`);
    expect(new Uint8Array(decodeValue(legacy) as ArrayBuffer)).toEqual(new Uint8Array([0, 1, 254, 255]));
  });
});

describe("parts from JSON in pieces (a board's table parts)", () => {
  it("tablePartText is JSON.stringify of the same part, and packText opens like packPart", async () => {
    const { pub, priv } = await keypair();
    const rows = [[1, "héllo ✓ 🟦"], [2, { $b64: "AAH+/w==" }], [3, "x".repeat(100_000)], [4, null]];
    const head = { kind: "board-rows", board: "b_x", day: "2026-10-08", table: "entries", part: 3 };
    const value = { ...head, tables: { entries: { columns: ["seq", "text"], rows } } };
    const text = () => tablePartText(head, "entries", ["seq", "text"], rows.map((r) => JSON.stringify(r)));
    expect([...text()].join("")).toBe(JSON.stringify(value));
    expect(await unpackPart(priv, await packText(pub, text()))).toEqual(value);
    expect(await unpackPart(priv, await packText(pub, tablePartText(head, "entries", ["seq", "text"], [])))).toEqual({ ...head, tables: { entries: { columns: ["seq", "text"], rows: [] } } });
  });
  it("gzipText of many pieces gunzips to their concatenation", async () => {
    const pieces = Array.from({ length: 5000 }, (_, i) => `piece ${i} ${"é".repeat(i % 40)};`);
    expect(new TextDecoder().decode(await gunzip(await gzipText(pieces)))).toBe(pieces.join(""));
  });
  it("utf8Length matches TextEncoder", () => {
    for (const s of ["", "abc", "héllo", "→ ✓", "🟦🟦", "a\ud800b", "\udc00", "end\ud83d"]) expect(utf8Length(s), JSON.stringify(s)).toBe(new TextEncoder().encode(s).length);
  });
});
