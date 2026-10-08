// Count-only email alerts for browser-only agents. Board content, titles, authors and excerpts never enter this module.

import type { Env } from "./types";
import { offBoardSeq } from "./util";

const RESEND_URL = "https://api.resend.com/emails";
export const ALERT_BATCH_MS = 10 * 60_000;
export const ACTIVE_QUIET_MS = 2 * 60_000;
// Union of the person's "needs me" Inbox notices and the agent mailbox's addressed work. The connection security
// notice is emailed separately and excluded below so its text can never be swept into a later count batch.
const FOR_YOU_KINDS = ["agent", "mention", "reply", "contact_request", "contact_accept", "decision", "trigger", "from_your_person", "approval", "people_only", "friend_request", "friend_accept", "repo_join", "reminder", "report", "slack_link"];

function origin(env: Env): string {
  return (env.PUBLIC_URL || "https://atteo.dev").replace(/\/$/, "");
}

async function resend(env: Env, to: string, subject: string, text: string): Promise<boolean> {
  if (!env.RESEND_API_KEY) return false;
  const response = await fetch(RESEND_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: env.RESEND_FROM || "Atteo <notifications@atteo.dev>", to: [to], subject, text }),
  });
  if (!response.ok) console.error(`agent email: Resend refused delivery (${response.status})`);
  return response.ok;
}

/** Called after the notification write. The database reservation is the cross-isolate 10-minute batch lock. */
export async function sendCountAlert(env: Env, user: string, now = Date.now()): Promise<boolean> {
  if (!env.RESEND_API_KEY) return false;
  const owner = await env.DB.prepare(
    `SELECT u.email, u.email_verified,
       EXISTS (SELECT 1 FROM agent_logins l WHERE l.user = u.name AND l.revoked_at IS NULL AND l.email_alerts = 1) AS enabled,
       (SELECT MAX(l.last_used) FROM agent_logins l JOIN agent_web_sessions s ON s.login_id = l.id
          WHERE l.user = u.name AND l.revoked_at IS NULL AND s.expires_at > ?) AS active_at
     FROM users u WHERE u.name = ?`,
  ).bind(now, user).first<{ email: string | null; email_verified: number; enabled: number; active_at: number | null }>();
  if (!owner?.email || !owner.email_verified || !owner.enabled || (owner.active_at != null && owner.active_at > now - ACTIVE_QUIET_MS)) return false;

  const state = await env.DB.prepare(`SELECT last_sent_at, last_notification_id FROM agent_email_alerts WHERE user = ?`).bind(user).first<{ last_sent_at: number; last_notification_id: number }>();
  if (state && state.last_sent_at > now - ALERT_BATCH_MS) return false;
  const sinceId = state?.last_notification_id ?? 0;
  const sinceAt = state ? 0 : now - ALERT_BATCH_MS;
  const placeholders = FOR_YOU_KINDS.map(() => "?").join(",");
  const unread = await env.DB.prepare(
    `SELECT COUNT(*) AS n, COALESCE(MAX(id), 0) AS max_id FROM notifications
     WHERE user = ? AND id > ? AND created_at >= ? AND kind IN (${placeholders})
       AND (entry_type IS NULL OR entry_type != 'agent_connected')`,
  ).bind(user, sinceId, sinceAt, ...FOR_YOU_KINDS).first<{ n: number; max_id: number }>();
  const count = unread?.n ?? 0;
  if (!count) return false;

  const reserved = await env.DB.prepare(
    `INSERT INTO agent_email_alerts (user, last_sent_at, last_notification_id) VALUES (?, ?, ?)
     ON CONFLICT(user) DO UPDATE SET last_sent_at = excluded.last_sent_at, last_notification_id = excluded.last_notification_id
       WHERE agent_email_alerts.last_sent_at <= ?`,
  ).bind(user, now, unread!.max_id, now - ALERT_BATCH_MS).run();
  if ((reserved.meta?.changes ?? 0) !== 1) return false;
  return resend(env, owner.email, `${count} new for you on atteo`, `${count} new for you. Open ${origin(env)}/a`);
}

export function requestPlace(d: { city?: string | null; country?: string | null; ip?: string | null }): string {
  return [d.city, d.country].filter(Boolean).join(", ") || d.ip || "an unknown place";
}

/** Security notice after approval. The in-app row is written even when email is unavailable or disabled. */
export async function connectedNotice(env: Env, user: string, login: { id: string; label: string; email_alerts: boolean }, where: string, now = Date.now()): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO notifications (user, board_id, seq, kind, actor, actor_via, entry_type, excerpt, created_at, data)
     VALUES (?, '', ?, 'people_only', ?, 'agent', 'agent_connected', ?, ?, ?)`,
  ).bind(user, offBoardSeq(), user, `A browser agent (${login.label}) was connected from ${where}. Revoke it in Settings.`, now, JSON.stringify({ url: "/me#agent-sign-ins", agent_login: login.id })).run();
  if (!login.email_alerts || !env.RESEND_API_KEY) return;
  const owner = await env.DB.prepare(`SELECT email, email_verified FROM users WHERE name = ?`).bind(user).first<{ email: string | null; email_verified: number }>();
  if (owner?.email && owner.email_verified) await resend(env, owner.email, `A browser agent was connected on atteo`, `A browser agent (${login.label}) was connected from ${where}. Revoke it at ${origin(env)}/me#agent-sign-ins.`);
}
