import { describe, expect, it } from "vitest";
import {
  deleteBoardFiles,
  fileKey,
  filePrefix,
  filesEnabled,
  getBoardFile,
  listBoardFiles,
  parseFileKey,
  putBoardFile,
  toArrayBuffer,
} from "../src/filesR2";

/** Duck-typed R2Bucket for unit tests (cast at the call site). */
function memoryBucket(): R2Bucket {
  const objects = new Map<string, ArrayBuffer>();
  return {
    async put(key: string, value: ArrayBuffer | ArrayBufferView) {
      const src = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      const copy = new Uint8Array(src.byteLength);
      copy.set(src);
      objects.set(key, copy.buffer);
      return { key, size: copy.byteLength };
    },
    async get(key: string) {
      const bytes = objects.get(key);
      return bytes ? { key, size: bytes.byteLength, arrayBuffer: async () => bytes } : null;
    },
    async delete(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
    },
    async list(opts: { prefix?: string; limit?: number } = {}) {
      const prefix = opts.prefix ?? "";
      const limit = opts.limit ?? 1000;
      const matches = [...objects.entries()].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      const page = matches.slice(0, limit).map(([key, bytes]) => ({ key, size: bytes.byteLength }));
      return matches.length > limit
        ? { objects: page, truncated: true, cursor: String(limit), delimitedPrefixes: [] }
        : { objects: page, truncated: false, delimitedPrefixes: [] };
    },
  } as unknown as R2Bucket;
}

describe("R2 file keys", () => {
  it("round-trips names with spaces, slashes and dots", () => {
    const key = fileKey("b_abc12345", "notes/plan v2.md", 3);
    expect(key).toBe("boards/b_abc12345/blobs/notes%2Fplan%20v2.md/v3");
    expect(parseFileKey(key)).toEqual({ boardId: "b_abc12345", name: "notes/plan v2.md", version: 3 });
    expect(filePrefix("b_abc12345")).toBe("boards/b_abc12345/blobs/");
  });
  it("refuses keys that are not this layout", () => {
    expect(parseFileKey("boards/b_abc12345/other/v1")).toBeNull();
    expect(parseFileKey("atteo/2026-10-05/boards/b_x.json.gz.enc")).toBeNull();
  });
  it("FILES_R2=0 turns the binding off", () => {
    const bucket = memoryBucket();
    expect(filesEnabled({ FILES: bucket })).toBe(true);
    expect(filesEnabled({ FILES: bucket, FILES_R2: "0" })).toBe(false);
    expect(filesEnabled({})).toBe(false);
  });
});

describe("in-memory R2 folder", () => {
  it("put, list, get and delete a board's files without touching another board", async () => {
    const bucket = memoryBucket();
    const png = new Uint8Array([1, 2, 3, 4]).buffer;
    const bin = new Uint8Array([0, 255]).buffer;
    await putBoardFile(bucket, fileKey("b_boardaaaa", "shot.png", 1), png, { board: "b_boardaaaa", name: "shot.png", version: 1, mime: "image/png" });
    await putBoardFile(bucket, fileKey("b_boardaaaa", "dump.bin", 2), bin, { board: "b_boardaaaa", name: "dump.bin", version: 2, mime: "application/octet-stream" });
    await putBoardFile(bucket, fileKey("b_boardbbbb", "other.png", 1), png, { board: "b_boardbbbb", name: "other.png", version: 1, mime: "image/png" });

    const listed = await listBoardFiles(bucket, "b_boardaaaa");
    expect(listed.backend).toBe("r2");
    expect(listed.bound).toBe(true);
    expect(listed.objects.map((o) => `${o.name}@v${o.version}`).sort()).toEqual(["dump.bin@v2", "shot.png@v1"]);
    expect(new Uint8Array((await getBoardFile(bucket, fileKey("b_boardaaaa", "shot.png", 1)))!)).toEqual(new Uint8Array([1, 2, 3, 4]));

    expect(await deleteBoardFiles(bucket, "b_boardaaaa")).toBe(2);
    expect((await listBoardFiles(bucket, "b_boardaaaa")).objects).toEqual([]);
    expect((await listBoardFiles(bucket, "b_boardbbbb")).objects).toHaveLength(1);
  });
  it("lists sqlite when there is no bucket", async () => {
    expect(await listBoardFiles(null, "b_boardaaaa")).toEqual({ backend: "sqlite", bound: false, objects: [] });
  });
  it("toArrayBuffer accepts views and buffers", () => {
    const u = new Uint8Array([9, 8, 7]);
    expect(new Uint8Array(toArrayBuffer(u)!)).toEqual(u);
    expect(new Uint8Array(toArrayBuffer(u.buffer)!)).toEqual(u);
    expect(toArrayBuffer(null)).toBeNull();
  });
});
