// Profile pictures for people and their agents. Images are resized to 256px in the browser before upload; the server
// accepts PNG, JPEG, GIF or WebP by their bytes (never SVG) and serves them with nosniff and a sandboxing CSP.

import { sniffImage } from "./board";
import { DEMO_AVATARS } from "./demoAvatars";
import type { Env } from "./types";

export const MAX_AVATAR = 200_000;
export type AvatarKind = "person" | "agent";

export async function setAvatar(env: Env, user: string, kind: AvatarKind, bytes: ArrayBuffer): Promise<void> {
  if (bytes.byteLength > MAX_AVATAR) throw new Error(`That picture is too large (max ${MAX_AVATAR / 1000} KB after resizing).`);
  const mime = sniffImage(new Uint8Array(bytes));
  if (!mime) throw new Error("Use a PNG, JPEG, GIF or WebP image.");
  await env.DB.prepare(`INSERT OR REPLACE INTO avatars (user, kind, mime, bytes, updated_at) VALUES (?, ?, ?, ?, ?)`).bind(user, kind, mime, bytes, Date.now()).run();
}

export async function removeAvatar(env: Env, user: string, kind: AvatarKind): Promise<void> {
  await env.DB.prepare(`DELETE FROM avatars WHERE user = ? AND kind = ?`).bind(user, kind).run();
}

export async function avatarResponse(env: Env, user: string, kind: AvatarKind): Promise<Response> {
  const r = await env.DB.prepare(`SELECT mime, bytes, updated_at FROM avatars WHERE user = ? AND kind = ?`).bind(user, kind).first<{ mime: string; bytes: ArrayBuffer; updated_at: number }>();
  // A miss is cached briefly too, so pages full of default avatars don't keep asking.
  const headers = { "cache-control": "public, max-age=300", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" };
  if (!r) return new Response(null, { status: 404, headers });
  return new Response(new Uint8Array(r.bytes), { headers: { ...headers, "content-type": r.mime, etag: `"${r.updated_at}"` } });
}

/** The landing page demo's pictures: made-up people, so never a member's upload. */
export function demoAvatarResponse(name: string, kind: AvatarKind): Response {
  const a = DEMO_AVATARS[`${name}:${kind}`];
  const headers = { "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" };
  if (!a) return new Response(null, { status: 404, headers });
  return new Response(Uint8Array.from(atob(a.b64), (c) => c.charCodeAt(0)), { headers: { ...headers, "content-type": a.mime } });
}
