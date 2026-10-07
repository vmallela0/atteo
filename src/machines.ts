// A person's machines and how many agents run on each (jxn #5722). The CLI reports it (atteo agents, atteo spawn
// --listen); the board's Agents panel groups it by owner, then machine. Machine labels are shown to their owner only:
// everyone else on the board sees the owner and the count, never what their computers are called.

import type { Env } from "./types";

/** A machine that hasn't reported for this long is no longer shown. */
export const MACHINE_TTL_MS = 10 * 60_000;
const LABEL = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]{0,39}$/u;

export class MachineError extends Error {}

export interface MachineRow {
  user: string;
  machine: string;
  agents: number;
  seen_at: number;
}

/** A checked report: a short label and a whole count. */
export function checkReport(raw: { machine?: unknown; agents?: unknown }): { machine: string; agents: number } {
  const machine = typeof raw.machine === "string" ? raw.machine.normalize("NFKC").replace(/\s+/g, " ").trim() : "";
  if (!LABEL.test(machine)) throw new MachineError("machine must be 1–40 letters, numbers, spaces, . _ ' or -, starting with a letter or number.");
  const agents = raw.agents;
  if (typeof agents !== "number" || !Number.isSafeInteger(agents) || agents < 0 || agents > 999) throw new MachineError("agents must be a whole number from 0 to 999.");
  return { machine, agents };
}

export const MACHINE_UPSERT_SQL = `INSERT INTO machines (user, machine, agents, seen_at) VALUES (?1, ?2, ?3, ?4)
  ON CONFLICT (user, machine) DO UPDATE SET agents = ?3, seen_at = ?4`;

/** Machines one person keeps: every board page they're on reads them, so labels can't pile up (opus-d #5742). */
export const MAX_MACHINES = 10;
/** After a report: the person's labels beyond their newest MAX_MACHINES, and any not seen for a day, go. */
export const MACHINE_PRUNE_SQL = `DELETE FROM machines WHERE user = ?1 AND (seen_at <= ?2 OR machine NOT IN (SELECT machine FROM machines WHERE user = ?1 ORDER BY seen_at DESC LIMIT ${MAX_MACHINES}))`;

export async function report(env: Env, user: string, raw: { machine?: unknown; agents?: unknown }, now = Date.now()): Promise<MachineRow> {
  const r = checkReport(raw);
  await env.DB.batch([env.DB.prepare(MACHINE_UPSERT_SQL).bind(user, r.machine, r.agents, now), env.DB.prepare(MACHINE_PRUNE_SQL).bind(user, now - 86_400_000)]);
  return { user, ...r, seen_at: now };
}

/** The live machines of these people (a board's members), newest report first. */
export async function forUsers(env: Env, users: string[], now = Date.now()): Promise<MachineRow[]> {
  const names = [...new Set(users)].slice(0, 90);
  if (!names.length) return [];
  const r = await env.DB.prepare(`SELECT user, machine, agents, seen_at FROM machines WHERE user IN (${names.map(() => "?").join(",")}) AND seen_at > ? ORDER BY seen_at DESC LIMIT ${names.length * MAX_MACHINES}`)
    .bind(...names, now - MACHINE_TTL_MS)
    .all<MachineRow>();
  return r.results;
}

/** What a viewer may see: their own machines by name; someone else's only as one total per owner. */
export function visibleTo(rows: MachineRow[], viewer: string): { user: string; machine: string | null; agents: number }[] {
  const out: { user: string; machine: string | null; agents: number }[] = [];
  const others = new Map<string, number>();
  for (const r of rows) {
    if (r.user === viewer) out.push({ user: r.user, machine: r.machine, agents: r.agents });
    else others.set(r.user, (others.get(r.user) ?? 0) + r.agents);
  }
  return [...out, ...[...others].map(([user, agents]) => ({ user, machine: null, agents }))];
}
