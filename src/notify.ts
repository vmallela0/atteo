// Notification volume (vedu #2490, UX research item 1): interrupt a person only for what needs them, batch the rest.
// Evidence: Pinterest cut volume 6–24% and got +11–31% clicks; batching 3×/day lowered stress in a randomized study,
// while switching notifications off entirely raised anxiety. So the default is "needs me", never "off".
//
// Each person sets a level per board (everything | needs_me | off) and, optionally, quiet hours. Every inbox item gets
// an `interrupt`: "now" (notify), "digest" (fold into the next summary) or "none" (just the Inbox). Unread counts and
// the Inbox itself don't change: this is only about interrupting. Clients (the app's local notifications, the web's
// browser notifications, and later real push) all follow the same flag. Agents never read or set any of it.

import { cleanAt, cleanTz, wallClock, zonedTime } from "./schedules";
import type { Env } from "./types";

export type Level = "everything" | "needs_me" | "off";
export type Interrupt = "now" | "digest" | "none";
export const LEVELS: readonly Level[] = ["everything", "needs_me", "off"];
export const DEFAULT_LEVEL: Level = "needs_me";
export const DEFAULT_DIGEST = ["09:00", "13:00", "18:00"] as const;

export interface Quiet {
  on: boolean;
  start: string; // "HH:MM", local
  end: string; // "HH:MM", local; before start means overnight (22:00–07:00)
  tz: string; // IANA
}
export interface NotifyPrefs {
  quiet: Quiet;
  digest: string[]; // local "HH:MM" times the digest goes out
}
export const DEFAULT_PREFS: NotifyPrefs = { quiet: { on: false, start: "22:00", end: "07:00", tz: "UTC" }, digest: [...DEFAULT_DIGEST] };

export class NotifyError extends Error {}

/** The 400 (and the web's and app's inline text) when quiet hours start and end at the same time. */
export const QUIET_SAME = "Quiet hours need different start and end times.";

/** What a notification is, for deciding whether it interrupts. */
export interface NotifyItem {
  kind: string; // inbox kind: mention | agent | reply | decision | approval | people_only | friend_request | …
  broadcast?: boolean; // a mention that came only from @all / @humans
  direct?: boolean; // on a DM board (kind = direct)
  risk?: string | null; // approvals: low | medium | high (high is urgent: it passes quiet hours)
  reminded?: boolean; // back from Remind me later: you asked for it, so it needs you
}

/** Needs you: approvals, decisions waiting on you, a direct @you, replies to what you wrote, DMs, people-only
 *  messages to you, and someone asking to be your friend or contact. Everything else (posts for your agent, @all,
 *  accepted requests) is digest material. */
export function needsYou(i: NotifyItem): boolean {
  if (i.reminded) return true;
  switch (i.kind) {
    case "approval":
    case "decision":
    case "reply":
    case "people_only":
    case "friend_request":
    case "contact_request":
    case "reminder":
    case "report":
    case "slack_link": // a Slack account now acts as you: if it isn't yours, you need to know now
      return true;
    case "mention":
      return !i.broadcast;
    case "agent":
      return !!i.direct; // a DM is for you (and your agent); a post for your agent on a shared board is not
    default:
      return false;
  }
}

/** Minutes since local midnight for "HH:MM". */
const mins = (hhmm: string) => parseInt(hhmm.slice(0, 2), 10) * 60 + parseInt(hhmm.slice(3, 5), 10);

/** Whether `now` falls inside quiet hours (start inclusive, end exclusive; overnight when end ≤ start). */
export function inQuiet(q: Quiet, now: number): boolean {
  if (!q.on) return false;
  const w = wallClock(now, q.tz);
  const t = w.h * 60 + w.mi, s = mins(q.start), e = mins(q.end);
  if (s === e) return false; // refused when saved (mergePrefs); an older row like that is no window, not the whole day
  return s < e ? t >= s && t < e : t >= s || t < e;
}

/** The interrupt for one item. Quiet hours hold "now" items for the digest, except urgent (high-risk) approvals. */
export function classify(i: NotifyItem, level: Level, quiet: Quiet, now: number): Interrupt {
  if (level === "off" || i.kind === "manual_unread") return "none"; // Mark as unread is your own note: never a notification
  const urgent = i.kind === "approval" && i.risk === "high";
  const want: Interrupt = level === "everything" || needsYou(i) ? "now" : "digest";
  if (want === "now" && !urgent && inQuiet(quiet, now)) return "digest";
  return want;
}

/**
 * The digest slot that most recently passed (ms), skipping slots inside quiet hours, within the last day; null if none.
 * Clients send one summary when this moves past the last one they sent.
 */
export function lastDigestAt(p: NotifyPrefs, now: number): number | null {
  const tz = p.quiet.tz;
  const w = wallClock(now, tz);
  let best: number | null = null;
  for (const k of [0, -1]) {
    const day = new Date(Date.UTC(w.y, w.m - 1, w.d + k));
    for (const at of p.digest) {
      const t = zonedTime(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), mins(at) / 60 | 0, mins(at) % 60, tz);
      if (t > now || inQuiet(p.quiet, t)) continue;
      if (best == null || t > best) best = t;
    }
  }
  return best;
}

// ---- input checking ----

export function cleanLevel(raw: unknown): Level {
  if (typeof raw === "string" && (LEVELS as readonly string[]).includes(raw)) return raw as Level;
  throw new NotifyError('level is "everything", "needs_me" or "off".');
}

/** A partial update to someone's prefs: quiet {on, start, end, tz} and digest ["HH:MM", …] (1–6 times). */
export function mergePrefs(cur: NotifyPrefs, raw: unknown): NotifyPrefs {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new NotifyError("Send {quiet: {on, start, end, tz}} and/or {digest: [\"09:00\", …]}.");
  const b = raw as { quiet?: unknown; digest?: unknown };
  for (const k of Object.keys(b)) if (k !== "quiet" && k !== "digest") throw new NotifyError(`Unknown setting "${k.slice(0, 32)}": use quiet or digest.`);
  const next: NotifyPrefs = { quiet: { ...cur.quiet }, digest: [...cur.digest] };
  if (b.quiet !== undefined) {
    if (!b.quiet || typeof b.quiet !== "object" || Array.isArray(b.quiet)) throw new NotifyError("quiet is {on, start, end, tz}.");
    const q = b.quiet as Record<string, unknown>;
    for (const k of Object.keys(q)) if (!["on", "start", "end", "tz"].includes(k)) throw new NotifyError(`Unknown quiet setting "${k.slice(0, 32)}": use on, start, end or tz.`);
    if (q.on !== undefined) {
      if (typeof q.on !== "boolean") throw new NotifyError("quiet.on is true or false.");
      next.quiet.on = q.on;
    }
    try {
      if (q.start !== undefined) next.quiet.start = cleanAt(q.start);
      if (q.end !== undefined) next.quiet.end = cleanAt(q.end);
      if (q.tz !== undefined) next.quiet.tz = cleanTz(q.tz);
    } catch (e) {
      throw new NotifyError((e as Error).message.replace(/^at is/, "start and end are"));
    }
    // Same start and end would read as "quiet all day" to some and "no quiet hours" to others: ask for a real window.
    if (next.quiet.start === next.quiet.end) throw new NotifyError(QUIET_SAME);
  }
  if (b.digest !== undefined) {
    if (!Array.isArray(b.digest) || !b.digest.length || b.digest.length > 6) throw new NotifyError('digest is 1–6 times of day, e.g. ["09:00", "13:00", "18:00"].');
    try {
      next.digest = [...new Set(b.digest.map((x) => cleanAt(x)))].sort();
    } catch {
      throw new NotifyError('digest times are "HH:MM" (24-hour), e.g. "09:00".');
    }
  }
  return next;
}

// ---- storage (D1: notify_levels, notify_prefs; migration 0055) ----

/** A client's own time zone (?tz=), used until the person saves prefs; anything unknown is UTC. */
export function fallbackTz(raw: unknown): string {
  try {
    return cleanTz(raw);
  } catch {
    return "UTC";
  }
}

/** This person's prefs; with no saved row, the defaults in the client's time zone (`tz`). */
export async function getPrefs(env: Env, user: string, tz = "UTC"): Promise<NotifyPrefs> {
  const r = await env.DB.prepare("SELECT quiet_on, quiet_start, quiet_end, tz, digest FROM notify_prefs WHERE user = ?")
    .bind(user)
    .first<{ quiet_on: number; quiet_start: string; quiet_end: string; tz: string; digest: string | null }>()
    .catch(() => null);
  if (!r) return { quiet: { ...DEFAULT_PREFS.quiet, tz }, digest: [...DEFAULT_PREFS.digest] };
  let digest: string[] = [...DEFAULT_DIGEST];
  try {
    const d = JSON.parse(r.digest ?? "null");
    if (Array.isArray(d) && d.length) digest = d.map(String);
  } catch {}
  return { quiet: { on: !!r.quiet_on, start: r.quiet_start, end: r.quiet_end, tz: r.tz }, digest };
}

export async function setPrefs(env: Env, user: string, p: NotifyPrefs): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO notify_prefs (user, quiet_on, quiet_start, quiet_end, tz, digest, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user) DO UPDATE SET quiet_on = excluded.quiet_on, quiet_start = excluded.quiet_start, quiet_end = excluded.quiet_end, tz = excluded.tz, digest = excluded.digest, updated_at = excluded.updated_at`,
  )
    .bind(user, p.quiet.on ? 1 : 0, p.quiet.start, p.quiet.end, p.quiet.tz, JSON.stringify(p.digest), Date.now())
    .run();
}

/** Every board level this person set (unset boards are DEFAULT_LEVEL). */
export async function getLevels(env: Env, user: string): Promise<Record<string, Level>> {
  const r = await env.DB.prepare("SELECT board_id, level FROM notify_levels WHERE user = ?").bind(user).all<{ board_id: string; level: Level }>().catch(() => null);
  const out: Record<string, Level> = {};
  for (const x of r?.results ?? []) out[x.board_id] = x.level;
  return out;
}

export async function getLevel(env: Env, user: string, board: string): Promise<Level> {
  const r = await env.DB.prepare("SELECT level FROM notify_levels WHERE user = ? AND board_id = ?").bind(user, board).first<{ level: Level }>().catch(() => null);
  return r?.level ?? DEFAULT_LEVEL;
}

/** Sets a board's level; the default removes the row. */
export async function setLevel(env: Env, user: string, board: string, level: Level): Promise<void> {
  if (level === DEFAULT_LEVEL) await env.DB.prepare("DELETE FROM notify_levels WHERE user = ? AND board_id = ?").bind(user, board).run();
  else
    await env.DB.prepare(
      "INSERT INTO notify_levels (user, board_id, level, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user, board_id) DO UPDATE SET level = excluded.level, updated_at = excluded.updated_at",
    )
      .bind(user, board, level, Date.now())
      .run();
}

/** The `notify` summary clients schedule by: is it quiet now, and when did the latest digest slot pass. */
export function summary(p: NotifyPrefs, now: number) {
  return { quiet_now: inQuiet(p.quiet, now), digest_at: lastDigestAt(p, now), digest: p.digest, tz: p.quiet.tz };
}
