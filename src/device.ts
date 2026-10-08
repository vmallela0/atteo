// CLI login via the device authorization flow (like `gh auth login`): the CLI gets a short code and a link
// (shown as a QR code too), the person approves it in the browser while signed in, and the CLI polls for its token.

import { record } from "./accountlog";
import { createToken, randomSecret, sha256hex } from "./auth";
import { clientIp } from "./appSignin";
import { publicAllowed, rateCheck } from "./limits";
import type { Env } from "./types";

export const DEVICE_TTL_MS = 10 * 60 * 1000;
export const POLL_INTERVAL_S = 3;
export const CLI_TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;
const POLLS_PER_MINUTE_PER_IP = Math.floor(60 / POLL_INTERVAL_S);
const lastPollByDevice = new Map<string, number>();

const CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ"; // no vowels (no accidental words), no 0/O, 1/I confusion

export function newUserCode(): string {
  const b = crypto.getRandomValues(new Uint8Array(8));
  const c = Array.from(b, (x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join("");
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}

export function normalizeUserCode(raw: string | null | undefined): string | null {
  const c = (raw ?? "").toUpperCase().replace(/[^A-Z]/g, "");
  if (c.length !== 8 || [...c].some((ch) => !CODE_ALPHABET.includes(ch))) return null;
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}

export interface DeviceLogin {
  user_code: string;
  client: string;
  created_at: number;
  expires_at: number;
  status: "pending" | "approved" | "denied" | "issued";
  approved_by: string | null;
  ip: string | null; // where the sign-in was started (the approve page shows it)
  kind: "cli" | "agent";
  user_agent: string | null;
  city: string | null;
  country: string | null;
  label: string | null;
}

/** Housekeeping in startDeviceLogin: forget logins that ended more than a day ago (shared with test/queryPlans.test.ts). */
export const PRUNE_DEVICE_LOGINS_SQL = `DELETE FROM device_logins WHERE expires_at < ?`;

export async function startDeviceLogin(
  env: Env,
  origin: string,
  client: string,
  ip: string | null = null,
  options: { kind?: "cli" | "agent"; userAgent?: string | null; city?: string | null; country?: string | null; label?: string | null } = {},
) {
  const now = Date.now();
  // Housekeeping: forget logins that ended more than a day ago.
  await env.DB.prepare(PRUNE_DEVICE_LOGINS_SQL).bind(now - 24 * 3600 * 1000).run();
  const deviceCode = randomSecret("dc_", 32);
  let userCode = newUserCode();
  for (let i = 0; i < 5; i++) {
    const clash = await env.DB.prepare(`SELECT 1 AS x FROM device_logins WHERE user_code = ?`).bind(userCode).first();
    if (!clash) break;
    userCode = newUserCode();
  }
  await env.DB.prepare(`INSERT INTO device_logins (device_hash, user_code, client, created_at, expires_at, ip, kind, user_agent, city, country, label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(await sha256hex(deviceCode), userCode, client.slice(0, 120) || "Atteo CLI", now, now + DEVICE_TTL_MS, ip, options.kind ?? "cli", options.userAgent?.slice(0, 240) ?? null, options.city?.slice(0, 100) ?? null, options.country?.slice(0, 100) ?? null, options.label?.slice(0, 80) ?? null)
    .run();
  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: `${origin}/device`,
    verification_uri_complete: `${origin}/device?code=${userCode}`,
    expires_in: DEVICE_TTL_MS / 1000,
    interval: POLL_INTERVAL_S,
  };
}

export async function deviceByUserCode(env: Env, userCode: string): Promise<DeviceLogin | null> {
  return env.DB.prepare(`SELECT user_code, client, created_at, expires_at, status, approved_by, ip, kind, user_agent, city, country, label FROM device_logins WHERE user_code = ?`)
    .bind(userCode)
    .first<DeviceLogin>();
}

/** The signed-in person approves or denies a pending login. */
export async function decideDeviceLogin(env: Env, userCode: string, user: string, approve: boolean): Promise<"ok" | "not_found" | "expired" | "already"> {
  const d = await deviceByUserCode(env, userCode);
  if (!d) return "not_found";
  if (d.kind !== "cli") return "not_found";
  if (d.expires_at <= Date.now()) return "expired";
  if (d.status !== "pending") return "already";
  await env.DB.prepare(`UPDATE device_logins SET status = ?, approved_by = ? WHERE user_code = ? AND status = 'pending'`)
    .bind(approve ? "approved" : "denied", user, userCode)
    .run();
  return "ok";
}

/** Denial is shared by CLI and browser-agent requests; approval of an agent request also creates its scoped login. */
export async function denyDeviceLogin(env: Env, userCode: string, user: string): Promise<"ok" | "not_found" | "expired" | "already"> {
  const d = await deviceByUserCode(env, userCode);
  if (!d) return "not_found";
  if (d.expires_at <= Date.now()) return "expired";
  if (d.status !== "pending") return "already";
  const changed = await env.DB.prepare(`UPDATE device_logins SET status = 'denied', approved_by = ? WHERE user_code = ? AND status = 'pending'`).bind(user, userCode).run();
  return (changed.meta?.changes ?? 0) === 1 ? "ok" : "already";
}

/** The CLI polls with its device code. An approved login issues a 30-day token exactly once. */
export async function pollDeviceLogin(
  env: Env,
  deviceCode: string,
  request: Request | null = null,
  deviceHash?: string,
): Promise<{ status: "pending" | "denied" | "expired" | "used" } | { status: "ok"; token: string; user: string; expires_at: number }> {
  const hash = deviceHash ?? await sha256hex(deviceCode);
  const now = Date.now();
  const d = await env.DB.prepare(`SELECT user_code, client, expires_at, status, approved_by FROM device_logins WHERE device_hash = ? AND kind = 'cli' AND expires_at > ?`)
    .bind(hash, now)
    .first<{ user_code: string; client: string; expires_at: number; status: string; approved_by: string | null }>();
  if (!d) return { status: "expired" };
  if (d.status === "denied") return { status: "denied" };
  if (d.status === "issued") return { status: "used" };
  if (d.status === "pending") return { status: "pending" };
  // approved: claim it atomically so two polls can't both get a token
  const claimNow = Date.now();
  const claimed = await env.DB.prepare(`UPDATE device_logins SET status = 'issued' WHERE device_hash = ? AND kind = 'cli' AND status = 'approved' AND expires_at > ?`).bind(hash, claimNow).run();
  if (!claimed.meta.changes) return { status: "used" };
  const expires = claimNow + CLI_TOKEN_TTL_MS;
  const t = await createToken(env, d.approved_by!, d.client, { expiresAt: expires, kind: "cli" });
  await env.DB.prepare(`UPDATE device_logins SET token_id = ? WHERE device_hash = ?`).bind(t.id, hash).run();
  await record(env, d.approved_by!, "cli.login", request ?? null, { label: d.client, kind: "cli" });
  return { status: "ok", token: t.token, user: d.approved_by!, expires_at: expires };
}

/** Public device redemption admission: cap an address, then enforce the interval for the exact secret's hash. */
export async function admitDevicePoll(
  env: Env,
  request: Request,
  deviceCode: string,
  now = Date.now(),
): Promise<{ ok: true; hash: string } | { ok: false; retryAfter: number }> {
  if (!(await publicAllowed(env, "device-poll", request))) return { ok: false, retryAfter: 60 };
  const ipRate = rateCheck(`device-poll-ip:${clientIp(request)}`, POLLS_PER_MINUTE_PER_IP, now);
  if (!ipRate.ok) return { ok: false, retryAfter: ipRate.retryAfter };
  const hash = await sha256hex(deviceCode);
  const last = lastPollByDevice.get(hash);
  if (last != null && now - last < POLL_INTERVAL_S * 1000) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((last + POLL_INTERVAL_S * 1000 - now) / 1000)) };
  }
  if (lastPollByDevice.size > 10_000) {
    for (const [key, at] of lastPollByDevice) if (now - at > DEVICE_TTL_MS) lastPollByDevice.delete(key);
    if (lastPollByDevice.size > 10_000) lastPollByDevice.clear();
  }
  lastPollByDevice.set(hash, now);
  return { ok: true, hash };
}
