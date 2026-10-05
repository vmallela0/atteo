/**
 * Account log (#3490): each person's sign-ins and token changes, append-only, for them alone, kept a year.
 * Rows say what happened, when, which app or token (its label, never the token), the browser or client in a few
 * words, and the country Cloudflare saw. Never an IP address. Token refreshes (the same connection carrying on)
 * aren't logged; connecting and disconnecting are.
 */
import type { Env } from "./types";

export type AccountEvent =
  | "signin.web" // signed in on the website (WorkOS)
  | "signin.app" // signed in to the Atteo app (email code or OAuth)
  | "cli.login" // `atteo login` approved and its token issued
  | "oauth.connected" // an MCP app connected with OAuth
  | "token.created" // a key made on the Account page
  | "token.revoked" // one connection revoked
  | "tokens.revoked_all"; // Disconnect all

export const ACCOUNT_LOG_DAYS = 365;

export interface AccountLogRow {
  id: number;
  at: number;
  event: AccountEvent;
  label: string | null;
  kind: string | null;
  client: string | null;
  country: string | null;
}

/** "Chrome on macOS", "atteo-cli/0.9", … from a User-Agent: enough to recognise, not a fingerprint. */
export function describeClient(ua: string | null | undefined): string | null {
  const s = (ua ?? "").trim();
  if (!s) return null;
  if (!/^Mozilla\//.test(s)) return s.split(/\s/)[0].slice(0, 40); // CLIs and SDKs lead with name/version
  const browser = /Edg\//.test(s) ? "Edge" : /OPR\/|Opera/.test(s) ? "Opera" : /Firefox\//.test(s) ? "Firefox" : /Chrome\//.test(s) ? "Chrome" : /Safari\//.test(s) ? "Safari" : "Browser";
  const os = /iPhone/.test(s) ? "iPhone" : /iPad/.test(s) ? "iPad" : /Android/.test(s) ? "Android" : /Mac OS X|Macintosh/.test(s) ? "macOS" : /Windows/.test(s) ? "Windows" : /CrOS/.test(s) ? "ChromeOS" : /Linux/.test(s) ? "Linux" : null;
  return os ? `${browser} on ${os}` : browser;
}

function country(request: Request | null | undefined): string | null {
  const c = (request as { cf?: { country?: unknown } } | null | undefined)?.cf?.country;
  return typeof c === "string" && /^[A-Z0-9]{2}$/.test(c) ? c : null;
}

/** Adds one line to a person's account log. Never throws: a sign-in shouldn't fail because its log line did. */
export async function record(
  env: Env,
  user: string,
  event: AccountEvent,
  request: Request | null,
  d: { label?: string | null; kind?: string | null; client?: string | null; now?: number } = {},
): Promise<void> {
  try {
    await env.DB.prepare(`INSERT INTO account_audit (user, at, event, label, kind, client, country) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(user, d.now ?? Date.now(), event, d.label?.slice(0, 80) ?? null, d.kind ?? null, d.client !== undefined ? d.client : describeClient(request?.headers.get("user-agent")), country(request))
      .run();
  } catch (e) {
    console.error(`account log: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** One person's log, newest first, before an id (the next page's cursor). Uses (user, id). */
export const ACCOUNT_LOG_SQL = `SELECT id, at, event, label, kind, client, country FROM account_audit WHERE user = ? AND id < ? ORDER BY id DESC LIMIT ?`;

export async function list(env: Env, user: string, o: { before?: number; limit?: number } = {}): Promise<{ events: AccountLogRow[]; next_before?: number }> {
  const limit = Math.max(1, Math.min(1000, Math.floor(o.limit ?? 50)));
  const before = o.before && o.before > 0 ? Math.floor(o.before) : Number.MAX_SAFE_INTEGER;
  const rows = (await env.DB.prepare(ACCOUNT_LOG_SQL).bind(user, before, limit + 1).all<AccountLogRow>()).results;
  const events = rows.slice(0, limit);
  return rows.length > limit ? { events, next_before: events[events.length - 1].id } : { events };
}

/** The whole log (a year at most) as JSON Lines, newest first. */
export async function jsonl(env: Env, user: string): Promise<string> {
  const out: string[] = [];
  let before: number | undefined;
  for (;;) {
    const page = await list(env, user, { before, limit: 1000 });
    for (const e of page.events) out.push(JSON.stringify({ ...e, at: new Date(e.at).toISOString() }));
    if (!page.next_before) break;
    before = page.next_before;
  }
  return out.length ? out.join("\n") + "\n" : "";
}

export const PRUNE_ACCOUNT_LOG_SQL = `DELETE FROM account_audit WHERE at < ?`;

export async function prune(env: Env, now = Date.now(), days = ACCOUNT_LOG_DAYS): Promise<number> {
  const r = await env.DB.prepare(PRUNE_ACCOUNT_LOG_SQL).bind(now - days * 86_400_000).run();
  return r.meta.changes ?? 0;
}
