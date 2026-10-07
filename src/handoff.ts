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

/** One check's name and counts, kept in clear on an encrypted board so the gate can see what passed. */
export interface CheckTally {
  name: string;
  pass: number | null;
  fail: number | null;
}

/**
 * A handoff on an end-to-end encrypted board (docs/SPEC.md §16): the gate's metadata in clear, the rest sealed. The
 * branch, sha, base and checks' output are in the entry's envelope (extras `handoff`); the server keeps a keyed hash of
 * the branch (one open handoff per branch) and the checks' names and counts.
 */
export interface SealedReady {
  sealed: true;
  branch_hash: string; // HMAC-SHA256 under a key derived from the board key: the same branch, the same hash
  checks: CheckTally[];
  lgtm: number | null;
  state: "open" | "landed" | "failed";
  closed_by?: string | null;
  closed_seq?: number | null;
}

/** The lander's reply that closes handoff #of. On an encrypted board `sha` is null (it's in the reply's envelope). */
export interface HandoffResult {
  of: number;
  state: "landed" | "failed";
  sha: string | null; // landed: the commit on main
}

export type Handoff = HandoffReady | SealedReady | HandoffResult;

export class HandoffError extends Error {}

export const MAX_CHECKS = 300;
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export const isResult = (h: Handoff): h is HandoffResult => "of" in h;
export const isSealedReady = (h: Handoff): h is SealedReady => "sealed" in h && h.sealed === true;
/** What makes two handoffs the same branch: the branch, or on an encrypted board its keyed hash. */
export const branchKey = (h: HandoffReady | SealedReady): string => ("sealed" in h ? `#${h.branch_hash}` : h.branch);

export const MAX_TALLIES = 20;
const TALLY_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._:+-]{0,39}$/;
const count = (v: unknown, field: string): number | null => {
  if (v == null) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 1e7) throw new HandoffError(`${field} is a whole number of checks.`);
  return v;
};

/** The clear checks of an encrypted handoff: names (letters, digits, spaces, . _ : + -) with pass and fail counts. */
export function tallies(v: unknown): CheckTally[] {
  if (!Array.isArray(v) || !v.length) throw new HandoffError('checks is a list of {name, pass, fail}, e.g. [{"name": "vitest", "pass": 470, "fail": 0}].');
  if (v.length > MAX_TALLIES) throw new HandoffError(`At most ${MAX_TALLIES} checks.`);
  return v.map((c, i) => {
    const o = c && typeof c === "object" && !Array.isArray(c) ? (c as Record<string, unknown>) : {};
    const name = typeof o.name === "string" ? o.name.replace(/\s+/g, " ").trim() : "";
    if (!TALLY_NAME.test(name)) throw new HandoffError(`checks[${i}].name is a short check name (up to 40 letters, digits, spaces, . _ : + -).`);
    return { name, pass: count(o.pass, `checks[${i}].pass`), fail: count(o.fail, `checks[${i}].fail`) };
  });
}

/** A check list as people write it ("vitest 470, e2e 183/185, browser crawl") as tallies: "name N" passed N, "name N/M" N of M. */
export function talliesFrom(text: string): CheckTally[] {
  return text
    .split(/[,;\n]/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, MAX_TALLIES)
    .map((s) => {
      const m = s.match(/^(.*?)\s+(\d+)(?:\s*\/\s*(\d+))?(?:\s+passed)?$/);
      const name = (m ? m[1] : s).replace(/[^A-Za-z0-9 ._:+-]/g, "").trim().slice(0, 40) || "checks";
      if (!m) return { name, pass: null, fail: null };
      const pass = Number(m[2]);
      return { name, pass, fail: m[3] != null ? Math.max(0, Number(m[3]) - pass) : 0 };
    });
}

const fmtTally = (t: CheckTally) => (t.pass == null ? t.name : `${t.name} ${t.pass}${t.fail ? ` (${t.fail} failed)` : ""}`);
export const tallyText = (ts: CheckTally[]) => ts.map(fmtTally).join(", ");

/** A new handoff on an encrypted board: only its clear part. Branch, commits and checks' output belong in the envelope. */
export function parseSealedReady(raw: unknown): SealedReady {
  const r = obj(raw);
  if (r.state != null || r.of != null) throw new HandoffError("To close a handoff, reply to it (reply_to) with {state: \"landed\"} or {state: \"failed\"}.");
  for (const k of ["branch", "sha", "base"]) if (r[k] != null) throw new HandoffError(`On an end-to-end encrypted board the ${k} goes in the envelope, not in clear: post it with atteo post handoff.`);
  const hash = typeof r.branch_hash === "string" ? r.branch_hash.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new HandoffError("branch_hash is the branch's keyed hash (64 hex characters; atteo post handoff works it out).");
  const lgtm = r.lgtm == null || r.lgtm === "" ? null : Number(String(r.lgtm).replace(/^#/, ""));
  if (lgtm != null && (!Number.isInteger(lgtm) || lgtm < 1)) throw new HandoffError("lgtm is the number of the entry with the reviewer's LGTM.");
  return { sealed: true, branch_hash: hash, checks: tallies(r.checks), lgtm, state: "open" };
}

/** A full commit id (sha1 or sha256), lowercased, or an error naming the field. */
export function fullSha(v: unknown, field: string): string {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (!SHA_RE.test(s)) throw new HandoffError(`${field} must be a full commit id (40 hex characters, or 64 in a SHA-256 repository; git rev-parse HEAD).`);
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
export function parseResult(raw: unknown, of: number, sealed = false): HandoffResult {
  const r = obj(raw);
  // Encrypted: the commit on main is in the reply's envelope, never in clear.
  if (sealed && r.sha != null) throw new HandoffError("On an end-to-end encrypted board the sha goes in the envelope, not in clear: close it with atteo post handoff --reply.");
  if (sealed && (r.state === "landed" || r.state === "failed")) return { of, state: r.state, sha: null };
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
  if (isResult(h)) return h.state === "landed" ? (h.sha ? `landed #${h.of} as ${short(h.sha)}` : `landed #${h.of}`) : `failed #${h.of}`;
  const lgtm = h.lgtm != null ? ` · LGTM #${h.lgtm}` : "";
  const landed = "sealed" in h ? "" : ` as ${short(h.landed_sha)}`;
  const state = h.state === "landed" ? ` · landed${landed}${h.closed_seq ? ` (#${h.closed_seq})` : ""}` : h.state === "failed" ? ` · failed${h.closed_seq ? ` (#${h.closed_seq})` : ""}` : "";
  if ("sealed" in h) return `ready to gate (encrypted branch and commits) · checks: ${tallyText(h.checks)}${lgtm}${state}`;
  return `ready to gate: ${h.branch} @${short(h.sha)} on ${short(h.base)} · checks: ${h.checks}${lgtm}${state}`;
}

/** The free-text part of a handoff, for the secret filter and the injection screen (an encrypted one's check names). */
export function handoffText(h: HandoffReady | SealedReady): string {
  return "sealed" in h ? h.checks.map((c) => c.name).join("\n") : `${h.branch}\n${h.checks}`;
}

/** The gate's queue, one line per open handoff (full shas, so the lander can check out exactly that commit). `holder`:
 *  who's on it (handle), in clear on any board. */
export function queueLine(e: { seq: number; author: string; ts: number; handoff?: Handoff | null }, flag: string, now = Date.now(), holder?: string | null): string {
  const h = e.handoff as HandoffReady | SealedReady;
  const mins = Math.max(0, Math.round((now - e.ts) / 60_000));
  const age = mins < 60 ? `${mins}m` : mins < 48 * 60 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`;
  const what = "sealed" in h ? `🔒 branch and commits encrypted (atteo get handoffs decrypts them) · checks: ${tallyText(h.checks)}` : `${h.branch} ${h.sha} on ${h.base} · checks: ${h.checks}`;
  return `#${e.seq} ${flag}${what}${h.lgtm != null ? ` · LGTM #${h.lgtm}` : ""} · ${e.author} · ${age} ago${holder ? ` · ${holder} is on it` : ""}`;
}
