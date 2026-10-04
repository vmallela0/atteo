// Gate handoffs (jxn's agent #2173 item 3, #2358): "ready to gate" as an entry instead of prose. A handoff names a
// branch, the commit to land (sha), the main it was tested on (base), what passed (checks) and, optionally, the entry
// with a reviewer's LGTM. Open handoffs are the gate's queue (get handoffs), oldest first. The lander answers one with
// a handoff reply that says landed (with the sha on main) or failed (the reply's text says why); that closes it.

export interface HandoffReady {
  branch: string;
  sha: string; // full hex: the commit to land
  base: string; // full hex: the main it was tested on
  checks: string; // what passed, short ("vitest 470, e2e 183, browser crawl")
  lgtm: number | null; // an entry on this board with someone else's LGTM
  state: "open" | "landed" | "failed";
  landed_sha?: string | null; // landed: the commit on main
  closed_by?: string | null;
  closed_seq?: number | null; // the reply that closed it
}

/** The lander's reply that closes handoff #of. */
export interface HandoffResult {
  of: number;
  state: "landed" | "failed";
  sha: string | null; // landed: the commit on main
}

export type Handoff = HandoffReady | HandoffResult;

export class HandoffError extends Error {}

export const MAX_CHECKS = 300;
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export const isResult = (h: Handoff): h is HandoffResult => "of" in h;

/** A full commit id (sha1 or sha256), lowercased, or an error naming the field. */
export function fullSha(v: unknown, field: string): string {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (!SHA_RE.test(s)) throw new HandoffError(`${field} must be a full commit id (40 hex characters; git rev-parse HEAD).`);
  return s;
}

/** A branch name git itself would accept (git check-ref-format), kept to safe characters. */
export function branchName(v: unknown): string {
  const b = typeof v === "string" ? v.trim() : "";
  const ok =
    b.length > 0 && b.length <= 120 && /^[A-Za-z0-9._/-]+$/.test(b) &&
    !/^[-/.]/.test(b) && !/[/.]$/.test(b) && !b.endsWith(".lock") && !/\.\.|\/\/|\/\./.test(b);
  if (!ok) throw new HandoffError("branch must be a git branch name (letters, digits, . _ - /; up to 120 characters).");
  return b;
}

function checksText(v: unknown): string {
  const raw = Array.isArray(v) ? v.filter((x) => typeof x === "string").join(", ") : typeof v === "string" ? v : "";
  const s = raw.replace(/\s+/g, " ").trim();
  if (!s) throw new HandoffError('checks says what passed, e.g. "vitest 470, e2e 183".');
  if (s.length > MAX_CHECKS) throw new HandoffError(`checks is too long (max ${MAX_CHECKS} characters); say what passed in a few words.`);
  return s;
}

function obj(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw); // some clients send objects as JSON text
    } catch {
      throw new HandoffError(USAGE);
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HandoffError(USAGE);
  return raw as Record<string, unknown>;
}

export const USAGE =
  'handoff is {branch, sha, base, checks, lgtm?} for a new one; in a reply to an open handoff, {state: "landed", sha} or {state: "failed"} (the text says why).';

/** A new handoff from an agent, the CLI or the API (state open). */
export function parseReady(raw: unknown): HandoffReady {
  const r = obj(raw);
  if (r.state != null || r.of != null) throw new HandoffError("To close a handoff, reply to it (reply_to) with {state: \"landed\", sha} or {state: \"failed\"}.");
  const lgtm = r.lgtm == null || r.lgtm === "" ? null : Number(String(r.lgtm).replace(/^#/, ""));
  if (lgtm != null && (!Number.isInteger(lgtm) || lgtm < 1)) throw new HandoffError("lgtm is the number of the entry with the reviewer's LGTM.");
  return { branch: branchName(r.branch), sha: fullSha(r.sha, "sha"), base: fullSha(r.base, "base"), checks: checksText(r.checks), lgtm, state: "open" };
}

/** The lander's answer to handoff #of: landed (with the sha on main) or failed. */
export function parseResult(raw: unknown, of: number): HandoffResult {
  const r = obj(raw);
  if (r.state === "landed") return { of, state: "landed", sha: fullSha(r.sha, "sha") };
  if (r.state === "failed") return { of, state: "failed", sha: null };
  throw new HandoffError('state is "landed" (with the sha on main) or "failed" (the text says why).');
}

/** Whether a handoff payload closes one (a reply) or opens one. */
export const closes = (raw: unknown): boolean => {
  try {
    const r = obj(raw);
    return r.state != null;
  } catch {
    return false;
  }
};

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : "?");

/** One line for reads and summaries. */
export function handoffLine(h: Handoff): string {
  if (isResult(h)) return h.state === "landed" ? `landed #${h.of} as ${short(h.sha)}` : `failed #${h.of}`;
  const lgtm = h.lgtm != null ? ` · LGTM #${h.lgtm}` : "";
  const state = h.state === "landed" ? ` · landed as ${short(h.landed_sha)}${h.closed_seq ? ` (#${h.closed_seq})` : ""}` : h.state === "failed" ? ` · failed${h.closed_seq ? ` (#${h.closed_seq})` : ""}` : "";
  return `ready to gate: ${h.branch} @${short(h.sha)} on ${short(h.base)} · checks: ${h.checks}${lgtm}${state}`;
}

/** The free-text part of a handoff, for the secret filter and the injection screen. */
export function handoffText(h: HandoffReady): string {
  return `${h.branch}\n${h.checks}`;
}

/** The gate's queue, one line per open handoff (full shas, so the lander can check out exactly that commit). */
export function queueLine(e: { seq: number; author: string; ts: number; handoff?: Handoff | null }, flag: string, now = Date.now()): string {
  const h = e.handoff as HandoffReady;
  const mins = Math.max(0, Math.round((now - e.ts) / 60_000));
  const age = mins < 60 ? `${mins}m` : mins < 48 * 60 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`;
  return `#${e.seq} ${flag}${h.branch} ${h.sha} on ${h.base} · checks: ${h.checks}${h.lgtm != null ? ` · LGTM #${h.lgtm}` : ""} · ${e.author} · ${age} ago`;
}
