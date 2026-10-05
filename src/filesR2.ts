// Board file bytes on R2 (GAPS P0 #5, first slice). Binary uploads dual-write here and to the board's SQLite
// (`blobs`); text documents stay in SQLite so FTS and collaborative edits keep working. SQLite remains the catalog
// and the fallback: a missing R2 binding, FILES_R2=0, or an R2 error never fails an upload or a read.
//
// Key layout: boards/<boardId>/blobs/<url-encoded name>/v<version>
// A later slice can stop writing SQLite bytes once reads have run on R2 long enough, and can copy leftovers with
// Board.migrateBlobsToR2 (POST /api/ops/files-migrate).

import type { Env } from "./types";

export const FILES_PREFIX = "boards/";

export type FileStorage = "sqlite" | "r2" | "both";

export interface FolderObject {
  key: string;
  name: string;
  version: number;
  size: number;
}

export interface FolderList {
  backend: "r2" | "sqlite";
  bound: boolean;
  objects: FolderObject[];
  truncated?: boolean;
}

export interface MigrateResult {
  bound: boolean;
  copied: number;
  already: number;
  skipped: number;
}

/** R2 is used when the FILES binding is present and FILES_R2 is not "0". */
export function filesEnabled(env: Pick<Env, "FILES" | "FILES_R2">): boolean {
  return !!env.FILES && env.FILES_R2 !== "0";
}

export function filesBucket(env: Pick<Env, "FILES" | "FILES_R2">): R2Bucket | null {
  return filesEnabled(env) ? (env.FILES ?? null) : null;
}

export function filePrefix(boardId: string): string {
  return `${FILES_PREFIX}${boardId}/blobs/`;
}

/** One version of one board file. The name is URL-encoded so slashes stay one key, not nested prefixes. */
export function fileKey(boardId: string, name: string, version: number): string {
  return `${filePrefix(boardId)}${encodeURIComponent(name)}/v${version}`;
}

export function parseFileKey(key: string): { boardId: string; name: string; version: number } | null {
  const m = /^boards\/(b_[a-z0-9]+)\/blobs\/(.+)\/v(\d+)$/.exec(key);
  if (!m) return null;
  try {
    return { boardId: m[1], name: decodeURIComponent(m[2]), version: Number(m[3]) };
  } catch {
    return null;
  }
}

export function toArrayBuffer(v: unknown): ArrayBuffer | null {
  if (v instanceof ArrayBuffer) return v;
  if (ArrayBuffer.isView(v)) {
    const u = v as ArrayBufferView;
    return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
  }
  return null;
}

export async function putBoardFile(
  bucket: R2Bucket,
  key: string,
  bytes: ArrayBuffer,
  meta: { board: string; name: string; version: number; mime: string },
): Promise<void> {
  await bucket.put(key, bytes, {
    httpMetadata: { contentType: meta.mime },
    customMetadata: { board: meta.board, name: meta.name, version: String(meta.version), mime: meta.mime },
  });
}

export async function getBoardFile(bucket: R2Bucket, key: string): Promise<ArrayBuffer | null> {
  const obj = await bucket.get(key);
  return obj ? obj.arrayBuffer() : null;
}

export async function deleteBoardFile(bucket: R2Bucket, key: string): Promise<void> {
  await bucket.delete(key);
}

export async function listBoardFiles(bucket: R2Bucket | null, boardId: string): Promise<FolderList> {
  if (!bucket) return { backend: "sqlite", bound: false, objects: [] };
  const page = await bucket.list({ prefix: filePrefix(boardId), limit: 1000 });
  const objects: FolderObject[] = [];
  for (const o of page.objects) {
    const parsed = parseFileKey(o.key);
    if (!parsed) continue;
    objects.push({ key: o.key, name: parsed.name, version: parsed.version, size: o.size });
  }
  return { backend: "r2", bound: true, objects, ...(page.truncated ? { truncated: true } : {}) };
}

/** Deletes every object under the board's prefix (board destroy). Pages until R2 says it is done. */
export async function deleteBoardFiles(bucket: R2Bucket | null, boardId: string): Promise<number> {
  if (!bucket) return 0;
  let n = 0;
  let cursor: string | undefined;
  for (;;) {
    const page = await bucket.list({ prefix: filePrefix(boardId), cursor, limit: 1000 });
    const keys = page.objects.map((o) => o.key);
    if (keys.length) await bucket.delete(keys);
    n += keys.length;
    if (!page.truncated || !page.cursor) return n;
    cursor = page.cursor;
  }
}
