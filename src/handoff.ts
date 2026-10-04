// A handoff entry: one agent hands a task to another agent. The record is who it came from, who it goes to,
// and the task it refers to. Stored on the entry and returned on read (CLI and web can follow later).

import { SESSION_NAME_RE } from "./mentions";
import type { Handoff, HandoffParty } from "./types";
import { USER_RE } from "./util";

export class HandoffError extends Error {}

/** "jxn" or "jxn/opus-a" (or {user, session}) → the agent it names. */
export function parseAgent(raw: unknown): HandoffParty {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>;
    const user = typeof r.user === "string" ? r.user.trim().toLowerCase() : "";
    const session = r.session == null || r.session === "" ? null : String(r.session).trim().toLowerCase();
    return party(user, session);
  }
  if (typeof raw !== "string" || !raw.trim()) throw new HandoffError('Name an agent: "jxn" or "jxn/opus-a".');
  const s = raw.trim().toLowerCase();
  const slash = s.indexOf("/");
  return party(slash === -1 ? s : s.slice(0, slash), slash === -1 ? null : s.slice(slash + 1));
}

function party(user: string, session: string | null): HandoffParty {
  if (!USER_RE.test(user) || (session != null && !SESSION_NAME_RE.test(session))) {
    throw new HandoffError('Name an agent: "jxn" or "jxn/opus-a".');
  }
  return { user, session };
}

export function sameAgent(a: HandoffParty, b: HandoffParty): boolean {
  return a.user === b.user && a.session === b.session;
}

/** "jxn/opus-a", or "jxn's agent" when it isn't one session. */
export function agentLabel(a: HandoffParty): string {
  return a.session ? `${a.user}/${a.session}` : `${a.user}'s agent`;
}

/** One line for reads: who it came from, who it goes to, and the task. */
export function handoffLine(h: Handoff): string {
  return `from ${agentLabel(h.from)} to ${agentLabel(h.to)}, task #${h.task}`;
}

/**
 * Checks a handoff from an agent or the API. `from` defaults to the agent posting it.
 * Returns whether the caller named `from` themselves (it must be that posting agent).
 */
export function parseHandoff(raw: unknown, from: HandoffParty): { handoff: Handoff; fromGiven: boolean } {
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new HandoffError("handoff must be an object (or JSON text of one): {to, task, from?}.");
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HandoffError("handoff must be an object: {to, task, from?}.");
  const r = raw as Record<string, unknown>;
  if (r.to == null || r.to === "") throw new HandoffError("A handoff says who it goes to and which task.");
  const task = typeof r.task === "number" ? r.task : typeof r.task === "string" && /^\d+$/.test(r.task.trim()) ? parseInt(r.task, 10) : NaN;
  if (!Number.isInteger(task) || task < 1) throw new HandoffError("A handoff says who it goes to and which task.");
  const fromGiven = r.from != null && r.from !== "";
  const to = parseAgent(r.to);
  const src = fromGiven ? parseAgent(r.from) : from;
  if (sameAgent(src, to)) throw new HandoffError("A handoff goes to a different agent.");
  return { handoff: { from: src, to, task }, fromGiven };
}
