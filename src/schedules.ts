// Shared crons (vedu #1129): a board-level schedule a person sets ("weekdays 09:00 America/Los_Angeles: standup")
// that posts a task to the board at each due time. Members' agents claim and split it like any task, so the work is
// shared instead of every agent doing it. Unlike a workflow trigger (triggers.ts), which wakes only its creator's own
// agent, a schedule's output is an ordinary task everyone sees.
// The board stores them (board.ts) and the 5-minute cron wakes boards with one due (the board_schedules index in D1).
// Pure helpers here (validation, due times in a time zone, the task text) so they're unit-testable.

export const MAX_SCHEDULES = 10; // per board
export const MAX_SCHEDULE_TITLE = 120;
export const MAX_SCHEDULE_BODY = 2000;
export const SCHEDULE_FIRES_PER_HOUR = 30; // per board, like a trigger's limit; more are dropped (counted in `dropped`)
export const SCHEDULE_LATE_MS = 30 * 60_000; // a due time fires up to this long after it (a late or missed cron tick)

export const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Day = (typeof DAY_NAMES)[number];
const WEEKDAYS: Day[] = ["mon", "tue", "wed", "thu", "fri"];
const WEEKENDS: Day[] = ["sat", "sun"];
const FULL: Record<Day, string> = { sun: "sunday", mon: "monday", tue: "tuesday", wed: "wednesday", thu: "thursday", fri: "friday", sat: "saturday" };

/** What a schedule says: daily at `at` (HH:MM, 24h) in time zone `tz`, on `days` (all seven: every day). */
export interface ScheduleSpec {
  at: string;
  tz: string;
  days: Day[];
}

export interface Schedule extends ScheduleSpec {
  id: string; // sc_…
  title: string;
  body: string;
  enabled: boolean;
  when: string; // "weekdays 09:00 America/Los_Angeles"
  next_run: number | null; // ms, when enabled
  created_by: string;
  created_at: number;
  updated_at: number;
  fires: number;
  last_fired_at: number | null;
  last_seq: number | null; // the task it last posted
  dropped: number; // due times skipped by the board's hourly limit
}

export class ScheduleError extends Error {}

const AT = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** "9:05" → "09:05"; anything else that isn't a 24-hour time is refused. */
export function cleanAt(raw: unknown): string {
  const m = typeof raw === "string" ? raw.trim().match(AT) : null;
  if (!m) throw new ScheduleError('at is a time of day, "HH:MM" (24-hour), e.g. "09:00".');
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

/** A real IANA time zone (as the runtime knows it), in its canonical spelling. */
export function cleanTz(raw: unknown): string {
  const tz = typeof raw === "string" ? raw.trim() : "";
  if (!tz || tz.length > 64) throw new ScheduleError('tz is a time zone, e.g. "America/Los_Angeles" or "UTC".');
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    throw new ScheduleError(`Unknown time zone "${tz.slice(0, 64)}". Use an IANA name like "Europe/Berlin" or "UTC".`);
  }
}

/**
 * Which days: an array of day names (mon, Tuesday, …), or "daily" / "weekdays" / "weekends", or a comma list
 * ("mon,wed,fri"). Missing or empty: every day. Kept in week order, Sunday first.
 */
export function cleanDays(raw: unknown): Day[] {
  if (raw == null || raw === "" || (Array.isArray(raw) && !raw.length)) return [...DAY_NAMES];
  const words = Array.isArray(raw) ? raw.map((x) => String(x)) : typeof raw === "string" ? raw.split(/[\s,]+/) : null;
  if (!words) throw new ScheduleError('days is a list of days ("mon", "tue", …) or "daily", "weekdays", "weekends".');
  const out = new Set<Day>();
  for (const w0 of words) {
    const w = w0.trim().toLowerCase();
    if (!w) continue;
    if (w === "daily" || w === "everyday" || w === "all") DAY_NAMES.forEach((d) => out.add(d));
    else if (w === "weekdays") WEEKDAYS.forEach((d) => out.add(d));
    else if (w === "weekends") WEEKENDS.forEach((d) => out.add(d));
    else {
      const d = DAY_NAMES.find((n) => w === n || (w.length >= 3 && w.startsWith(n) && FULL[n].startsWith(w)));
      if (!d) throw new ScheduleError(`"${w0.slice(0, 20)}" isn't a day. Use mon, tue, wed, thu, fri, sat, sun (or daily, weekdays, weekends).`);
      out.add(d);
    }
  }
  if (!out.size) return [...DAY_NAMES];
  return DAY_NAMES.filter((d) => out.has(d));
}
/** Checks and normalizes a new schedule's fields (the board checks who may, and the limit). */
export function cleanSchedule(raw: { title?: unknown; body?: unknown; at?: unknown; tz?: unknown; days?: unknown }): { title: string; body: string } & ScheduleSpec {
  const title = typeof raw.title === "string" ? raw.title.replace(/\s+/g, " ").trim() : "";
  if (!title) throw new ScheduleError("Give the schedule a title (what the task is, e.g. Standup).");
  if (title.length > MAX_SCHEDULE_TITLE) throw new ScheduleError(`title is at most ${MAX_SCHEDULE_TITLE} characters.`);
  const body = typeof raw.body === "string" ? raw.body.replace(/\r\n/g, "\n").trim() : raw.body == null ? "" : null;
  if (body == null) throw new ScheduleError("body is text (an optional checklist).");
  if (body.length > MAX_SCHEDULE_BODY) throw new ScheduleError(`body is at most ${MAX_SCHEDULE_BODY} characters.`);
  return { title, body, at: cleanAt(raw.at), tz: cleanTz(raw.tz ?? "UTC"), days: cleanDays(raw.days) };
}

/** "daily", "weekdays", "weekends" or "Mon, Wed, Fri". */
export function daysLabel(days: Day[]): string {
  const s = new Set(days);
  if (s.size === 7) return "daily";
  if (s.size === 5 && WEEKDAYS.every((d) => s.has(d))) return "weekdays";
  if (s.size === 2 && WEEKENDS.every((d) => s.has(d))) return "weekends";
  return DAY_NAMES.filter((d) => s.has(d)).map((d) => d[0].toUpperCase() + d.slice(1)).join(", ");
}

/** "weekdays 09:00 America/Los_Angeles" */
export const scheduleLabel = (s: ScheduleSpec) => `${daysLabel(s.days)} ${s.at} ${s.tz}`;

// ---- time zones: the runtime's Intl data, no library ----

const fmts = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    fmts.set(tz, f);
  }
  return f;
}

/** The wall clock in `tz` at instant `ts`. */
export function wallClock(ts: number, tz: string): { y: number; m: number; d: number; h: number; mi: number; s: number } {
  const p: Record<string, number> = {};
  for (const x of fmt(tz).formatToParts(new Date(ts))) if (x.type !== "literal") p[x.type] = parseInt(x.value, 10);
  return { y: p.year, m: p.month, d: p.day, h: p.hour === 24 ? 0 : p.hour, mi: p.minute, s: p.second };
}

/** How far `tz` is ahead of UTC at instant `ts`, in ms. */
function offsetAt(ts: number, tz: string): number {
  const w = wallClock(ts, tz);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(ts / 1000) * 1000;
}

/**
 * The instant the wall clock in `tz` reads y-m-d hh:mm. A time that happens twice (clocks going back) is the first
 * one; a time that doesn't exist (clocks going forward) is moved forward by the gap (02:30 → 03:30), so it still fires.
 */
export function zonedTime(y: number, m: number, d: number, hh: number, mm: number, tz: string): number {
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  // Every offset in force around that day (a zone changes at most once a day).
  const offsets = [...new Set([offsetAt(wall - 86_400_000, tz), offsetAt(wall, tz), offsetAt(wall + 86_400_000, tz)])];
  const hits = offsets.map((o) => wall - o).filter((t) => {
    const w = wallClock(t, tz);
    return w.y === y && w.m === m && w.d === d && w.h === hh && w.mi === mm;
  });
  if (hits.length) return Math.min(...hits);
  return wall - Math.min(...offsets); // in the gap
}

/** The local date `k` days from the date the wall clock in `tz` shows at `ts`, with its day of the week. */
function localDay(ts: number, tz: string, k: number) {
  const w = wallClock(ts, tz);
  const d = new Date(Date.UTC(w.y, w.m - 1, w.d + k));
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), day: DAY_NAMES[d.getUTCDay()] };
}

function occurrenceOn(s: ScheduleSpec, ts: number, k: number): number | null {
  const day = localDay(ts, s.tz, k);
  if (!s.days.includes(day.day)) return null;
  return zonedTime(day.y, day.m, day.d, parseInt(s.at.slice(0, 2), 10), parseInt(s.at.slice(3, 5), 10), s.tz);
}

/** The latest due time at or before `now` (ms), or null if there's none in the last week (no days). */
export function lastDue(s: ScheduleSpec, now: number): number | null {
  for (let k = 0; k >= -8; k--) {
    const t = occurrenceOn(s, now, k);
    if (t != null && t <= now) return t;
  }
  return null;
}

/** The first due time after `after` (ms), or null (no days). */
export function nextDue(s: ScheduleSpec, after: number): number | null {
  for (let k = -1; k <= 8; k++) {
    const t = occurrenceOn(s, after, k);
    if (t != null && t > after) return t;
  }
  return null;
}

/**
 * What a cron tick at `now` does with a schedule that last handled the due time `handled` (ms, 0: none):
 * fire for `due` (the latest due time, not handled yet and at most SCHEDULE_LATE_MS ago), skip it (missed: too long
 * ago), or nothing. Either way `due` becomes the handled one, so each due time is handled once however many ticks
 * see it.
 */
export function tickAction(s: ScheduleSpec, handled: number, now: number): { act: "fire" | "skip"; due: number } | null {
  const due = lastDue(s, now);
  if (due == null || due <= handled) return null;
  return { act: now - due <= SCHEDULE_LATE_MS ? "fire" : "skip", due };
}

/** The task a schedule posts: its title (marked 🔁), its body, and where it came from. */
export function taskText(s: { id: string; title: string; body: string; created_by: string } & ScheduleSpec): string {
  return [`🔁 ${s.title}`, s.body, `From the board schedule ${s.id} (${scheduleLabel(s)}), set by ${s.created_by}. Agents: claim the parts you'll do, like any task.`].filter(Boolean).join("\n\n");
}
