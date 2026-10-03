// Workflow triggers: a board's rules, "when X happens on this board, wake my agent with prompt P". The board stores
// them (board.ts) and checks each event against them; a match puts a mailbox item of kind "trigger" in its creator's
// agent's mailbox (optionally for one agent session), so `atteo dispatch` / any mailbox poller picks it up.
// Nobody can wake someone else's agent: a trigger always wakes its creator's own.
// Pure helpers here (validation, matching, the mail text) so they're unit-testable.

import type { ApprovalRef, Entry, Env } from "./types";
import { ENTRY_TYPES } from "./types";

export const TRIGGER_ON = ["entry", "task", "question", "mention", "approval", "change", "schedule"] as const;
export type TriggerOn = (typeof TRIGGER_ON)[number];
export const MAX_TRIGGERS = 20; // per board
export const MAX_FIRES_PER_HOUR = 30; // per trigger; more are dropped (counted in `dropped`)
export const MAX_PROMPT = 2000;
export const SCHEDULE_GRACE_MS = 30 * 60_000; // a schedule fires once per day, up to this long after its time (missed crons)

export interface TriggerMatch {
  type?: string; // entry: the entry type (question, task, decision, …)
  text?: string; // entry/question/mention/change/task: case-insensitive text the entry (or task title) contains
  mention?: string; // entry: a member it @mentions (or is addressed to)
  status?: string; // task: the status it moved to (todo|doing|blocked|done|stopped); approval: approved|rejected|expired
  assignee?: string; // task: its assignee
  label?: string; // task: its priority (high|medium|low), or a word in its title
  task?: "created" | "status"; // task: only creations, or only status changes (default both)
  at?: string; // schedule: "HH:MM", daily, UTC
}

export interface Trigger {
  id: string;
  on: TriggerOn;
  match: TriggerMatch;
  wake: { user: string; session?: string }; // always the creator; session: one of their agent sessions, by name
  prompt: string;
  enabled: boolean;
  created_by: string;
  created_at: number;
  fires: number;
  last_fired_at: number | null;
  dropped: number; // fires skipped by the hourly limit
}

export class TriggerError extends Error {}

const SESSION_NAME = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const TASK_STATUSES = ["todo", "doing", "blocked", "done", "stopped"];

/** Checks and normalizes a trigger's event, match and prompt (the board checks ownership and limits). */
export function cleanTrigger(raw: { on?: unknown; match?: unknown; prompt?: unknown }): { on: TriggerOn; match: TriggerMatch; prompt: string } {
  const on = String(raw.on ?? "") as TriggerOn;
  if (!TRIGGER_ON.includes(on)) throw new TriggerError(`on is one of: ${TRIGGER_ON.join(", ")}.`);
  const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
  if (!prompt) throw new TriggerError("Say what your agent should do when it fires (prompt).");
  if (prompt.length > MAX_PROMPT) throw new TriggerError(`prompt is at most ${MAX_PROMPT} characters.`);
  return { on, match: cleanMatch(on, raw.match), prompt };
}

export function cleanMatch(on: TriggerOn, raw: unknown): TriggerMatch {
  const m = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const s = (k: string, max = 200) => (typeof m[k] === "string" && (m[k] as string).trim() ? (m[k] as string).trim().slice(0, max) : undefined);
  const out: TriggerMatch = {};
  const text = s("text");
  if (text && on !== "schedule" && on !== "approval") out.text = text;
  if (on === "entry") {
    const type = s("type")?.toLowerCase();
    if (type && ![...ENTRY_TYPES, "approval"].includes(type)) throw new TriggerError(`match.type is one of: ${ENTRY_TYPES.join(", ")}.`);
    if (type) out.type = type;
    const mention = s("mention", 32)?.toLowerCase().replace(/^@/, "");
    if (mention) out.mention = mention;
  }
  if (on === "task") {
    const status = s("status")?.toLowerCase();
    if (status && !TASK_STATUSES.includes(status)) throw new TriggerError(`match.status is one of: ${TASK_STATUSES.join(", ")}.`);
    if (status) out.status = status;
    const assignee = s("assignee", 32)?.toLowerCase().replace(/^@/, "");
    if (assignee) out.assignee = assignee;
    const label = s("label", 60);
    if (label) out.label = label;
    const task = s("task");
    if (task && task !== "created" && task !== "status") throw new TriggerError('match.task is "created" or "status" (default both).');
    if (task) out.task = task as "created" | "status";
  }
  if (on === "approval") {
    const status = s("status")?.toLowerCase();
    if (status && !["approved", "rejected", "expired"].includes(status)) throw new TriggerError("match.status is approved, rejected or expired.");
    if (status) out.status = status;
  }
  if (on === "schedule") {
    const at = s("at");
    if (!at || !/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) throw new TriggerError('A schedule needs match.at: "HH:MM" (daily, UTC).');
    out.at = at;
  }
  return out;
}

export function cleanSessionName(raw: unknown): string | undefined {
  if (raw == null || raw === "") return undefined;
  const n = String(raw).trim().toLowerCase();
  // "vedu/claude-2" names a session with its person; the person part is checked by the caller.
  const name = n.includes("/") ? n.split("/")[1] : n;
  if (!SESSION_NAME.test(name)) throw new TriggerError("wake.session is one of your agent sessions' names (e.g. claude-2).");
  return name;
}

/** Minutes after midnight UTC for "HH:MM". */
export const minuteOf = (at: string) => parseInt(at.slice(0, 2), 10) * 60 + parseInt(at.slice(3, 5), 10);

/** The latest daily occurrence of `at` at or before `now` (ms). */
export function lastOccurrence(at: string, now: number): number {
  const d = new Date(now);
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + minuteOf(at) * 60_000;
  return today <= now ? today : today - 86_400_000;
}

/** Something that happened on a board, as triggers see it. */
export interface TriggerEvent {
  on: Exclude<TriggerOn, "schedule"> | "schedule";
  actor: string;
  via: string | null; // "agent" | "person" | null (server)
  seq: number | null; // the entry it's about (null: a schedule)
  entry?: Entry;
  task?: { seq: number; title: string; status: string; assignee: string | null; priority: string | null; change: "created" | "status"; from?: string | null };
  approval?: ApprovalRef;
}

const has = (hay: string | null | undefined, needle: string) => (hay ?? "").toLowerCase().includes(needle.toLowerCase());

/** Does this event fire this trigger? (Enabled, ownership, loop protection and limits are the board's job.) */
export function matches(t: Pick<Trigger, "on" | "match" | "created_by">, ev: TriggerEvent): boolean {
  const m = t.match;
  const e = ev.entry;
  switch (t.on) {
    case "entry":
      if (!e || ev.on !== "entry") return false;
      if (m.type && e.type !== m.type) return false;
      if (m.mention && !(e.to === m.mention || (e.mentions ?? []).some((x) => x.user === m.mention))) return false;
      return !m.text || has(e.text, m.text) || has(e.title, m.text);
    case "question":
    case "change":
      if (!e || ev.on !== "entry" || e.type !== t.on) return false;
      return !m.text || has(e.text, m.text) || has(e.title, m.text);
    case "mention":
      // Something for the trigger's creator: @them (person or agent) or addressed to their agent.
      if (!e || ev.on !== "entry" || !(e.to === t.created_by || (e.mentions ?? []).some((x) => x.user === t.created_by))) return false;
      return !m.text || has(e.text, m.text) || has(e.title, m.text);
    case "task": {
      const k = ev.task;
      if (!k || ev.on !== "task") return false;
      if (m.task && m.task !== k.change) return false;
      if (m.status && k.status !== m.status) return false;
      if (m.assignee && k.assignee !== m.assignee) return false;
      if (m.label && !(k.priority === m.label.toLowerCase() || new RegExp(`(^|[^a-z0-9])${m.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`, "i").test(k.title))) return false;
      return !m.text || has(k.title, m.text);
    }
    case "approval":
      // Only your own approvals: their content is yours alone.
      if (!ev.approval || ev.on !== "approval" || ev.approval.user !== t.created_by) return false;
      return !m.status || ev.approval.status === m.status;
    case "schedule":
      return ev.on === "schedule";
  }
}

/** One line on what happened, for the mail (other members' words are data: the mail marks them so). */
export function eventLine(ev: TriggerEvent): string {
  const who = ev.via === "agent" ? `${ev.actor}'s agent` : ev.actor;
  const short = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 140);
  if (ev.on === "schedule") return "Scheduled time reached.";
  if (ev.on === "approval" && ev.approval) return `Your approval ${ev.approval.id} ("${short(ev.approval.title)}") was ${ev.approval.status}${ev.approval.note ? `: "${short(ev.approval.note)}"` : ""}.`;
  if (ev.on === "task" && ev.task) return `#${ev.task.seq} task ${ev.task.change === "created" ? "created" : `moved to ${ev.task.status}`} by ${who}: ${short(ev.task.title)}`;
  if (ev.entry) return `#${ev.entry.seq} ${ev.entry.type} by ${who}: ${short(ev.entry.title || ev.entry.text)}`;
  return `Event by ${who}.`;
}

/**
 * Who a trigger wakes, from a request's `wake`: always the caller's own agent. wake.user, if given, must be the caller
 * (nobody wakes someone else's agent); wake.session names one of the caller's live agent sessions ("claude-2").
 */
export async function wakeFor(env: Env, user: string, raw: unknown): Promise<{ session: string | null } | { error: string; status: number }> {
  if (raw == null) return { session: null };
  const w = (typeof raw === "object" ? raw : {}) as { user?: unknown; session?: unknown };
  const who = w.user == null || w.user === "" ? user : String(w.user).trim().toLowerCase().replace(/^@/, "");
  const sessUser = typeof w.session === "string" && w.session.includes("/") ? w.session.split("/")[0].trim().toLowerCase().replace(/^@/, "") : user;
  if (who !== user || sessUser !== user) return { error: "A trigger can only wake your own agent (wake.user is you).", status: 403 };
  let name: string | undefined;
  try {
    name = cleanSessionName(w.session);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), status: 400 };
  }
  if (!name) return { session: null };
  const s = await env.DB.prepare(`SELECT name FROM agent_sessions WHERE user = ? AND name = ? AND ended_at IS NULL LIMIT 1`).bind(user, name).first<{ name: string }>();
  if (!s) return { error: `You have no agent session named "${name}".`, status: 400 };
  return { session: name };
}
