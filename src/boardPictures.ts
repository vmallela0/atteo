// Board pictures, like a group chat's photo: any member who can post may set or remove one. Stored and checked the
// same way as avatars (avatars.ts): cropped to a square in the browser, PNG/JPEG/WebP by their bytes, at most 200 KB.
// Unlike avatars they are only served to the board's members (a board's existence is private), so the URL carries a
// version (?v=) and is cached privately for a year; a new picture gets a new version.
// A picture is metadata, like the board's name: on an end-to-end encrypted board the server still sees it.

import { sniffImage } from "./board";
import { MAX_AVATAR } from "./avatars";
import type { Env } from "./types";
export { pictureUrl } from "./util";

export const MAX_BOARD_PICTURE = MAX_AVATAR;
const TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

/** Checks the bytes (size, then type) and returns the image type; throws a message for the person. */
export function checkPicture(bytes: ArrayBuffer): string {
  if (bytes.byteLength > MAX_BOARD_PICTURE) throw new Error(`That picture is too large (max ${MAX_BOARD_PICTURE / 1000} KB after resizing).`);
  const mime = sniffImage(new Uint8Array(bytes));
  if (!mime || !TYPES.has(mime)) throw new Error("Use a PNG, JPEG or WebP image.");
  return mime;
}

/** Stores the picture and returns its new version. */
export async function setBoardPicture(env: Env, boardId: string, mime: string, bytes: ArrayBuffer): Promise<number> {
  const v = Date.now();
  await env.DB.batch([
    env.DB.prepare(`INSERT OR REPLACE INTO board_pictures (board_id, mime, bytes, updated_at) VALUES (?, ?, ?, ?)`).bind(boardId, mime, bytes, v),
    env.DB.prepare(`UPDATE boards SET picture_v = ? WHERE id = ?`).bind(v, boardId),
  ]);
  return v;
}

export async function removeBoardPicture(env: Env, boardId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM board_pictures WHERE board_id = ?`).bind(boardId),
    env.DB.prepare(`UPDATE boards SET picture_v = NULL WHERE id = ?`).bind(boardId),
  ]);
}

/** The picture, for someone the Worker has already checked can see the board. */
export async function boardPictureResponse(env: Env, boardId: string, v: string | null): Promise<Response> {
  const r = await env.DB.prepare(`SELECT mime, bytes, updated_at FROM board_pictures WHERE board_id = ?`).bind(boardId).first<{ mime: string; bytes: ArrayBuffer; updated_at: number }>();
  const headers = { "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" };
  if (!r) return new Response(null, { status: 404, headers: { ...headers, "cache-control": "private, no-cache" } });
  // Only the current version is cached for good: an old ?v= (or none) always asks again.
  const current = v === String(r.updated_at);
  return new Response(new Uint8Array(r.bytes), {
    headers: { ...headers, "content-type": r.mime, etag: `"${r.updated_at}"`, "cache-control": current ? "private, max-age=31536000, immutable" : "private, no-cache" },
  });
}
