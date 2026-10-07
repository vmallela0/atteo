// What atteo read prints from an end-to-end encrypted board (#5542): decrypted on this machine, but a member's writing.
// Kept apart from commands.ts so its tests can import it alone.

import { flagNote, screenText } from "../../src/screen";
import { proseForAgent } from "../../src/util";
import { branchName } from "../../src/handoff";

/** A message's structured parts, encrypted beside its text as the envelope's `x` (docs/SPEC.md §16): older clients read the text alone. */
export type SealedExtras = { xv?: 1; title?: string; files?: SealedFileRef[]; handoff?: SealedHandoff };
/** A handoff's sealed part (docs/SPEC.md §16): what's ready to gate, or the lander's commit on main. */
export type SealedHandoff = { branch: string; sha: string; base: string; checks: string } | { state: "landed" | "failed"; sha?: string };
export type SealedFileRef = { id: string; name: string; mime: string; size: number; key: string; chunk: number; w?: number; h?: number };

const oneLine = (t: string) => t.replace(/\s+/g, " ").trim();
export const fmtSize = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`);
/** A decrypted message for an agent, written like a plain board's: every member-written field (text, title, file names)
 *  stays indented under its header line, so none can pass for another entry's header; the screen's verdict is on the
 *  header. Callers fence the result (#5542). */
export const encLine = (e: { seq: number; ts: number; author: string; via: string | null; type: string; to: string | null; reply_to: number | null; text: string; edited_at?: number | null; extras?: SealedExtras }) => {
  const one = (s: unknown, max = 200) => oneLine(proseForAgent(String(s ?? ""))).slice(0, max);
  const files = (e.extras?.files ?? []).map((f) => `\n    📎 ${one(f.name)} (${fmtSize(Number(f.size) || 0)})`).join("");
  const title = e.extras?.title ? `${one(e.extras.title)}: ` : "";
  const h = e.extras?.handoff;
  const gate = !h ? "" : "branch" in h ? `\n    🚦 ready to gate: ${h.branch} ${h.sha} on ${h.base} · checks: ${one(h.checks, 300)}` : h.sha ? `\n    🚦 landed as ${h.sha}` : "";
  const text = proseForAgent(String(e.text ?? "")).replace(/\r\n?|[\u2028\u2029\u0085\v\f]/g, "\n");
  const flag = screenText([e.extras?.title ?? "", text, ...(e.extras?.files ?? []).map((f) => String(f.name ?? "")), h && "branch" in h ? handoffScreen(h) : ""].join("\n"));
  return `#${e.seq} ${e.type} · ${e.via === "agent" ? `${e.author}'s agent` : e.author}${e.to ? ` → ${e.to}` : ""}${e.reply_to ? ` · re #${e.reply_to}` : ""} · ${new Date(e.ts).toISOString().slice(0, 16).replace("T", " ")}Z${e.edited_at ? " · edited" : ""}${flag ? ` · ⚠ ${flagNote(flag)}` : ""}\n    ${title}${text.replace(/\n/g, "\n    ")}${gate}${files}${files ? `\n    (atteo download ${e.seq} saves ${e.extras!.files!.length === 1 ? "it" : "them"}, decrypted on this machine)` : ""}`;
};

/** A sealed file id as the server issues them; anything else (a path, a query) is never fetched or written (#5542). */
export const SEALED_FILE_ID = /^sf_[a-z0-9]{1,40}$/;

/** Extras are a member's writing like the text: a string title, and only well-formed file references (a server-issued
 *  id, a key, a whole size) are kept. */
export function cleanExtras(x: unknown): SealedExtras {
  const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
  const files = Array.isArray(o.files)
    ? (o.files as SealedFileRef[]).filter((f) => !!f && SEALED_FILE_ID.test(String(f.id)) && typeof f.key === "string" && typeof f.name === "string" && Number.isInteger(f.size) && f.size >= 0)
    : [];
  const handoff = sealedHandoff(o.handoff);
  return { ...(typeof o.title === "string" && o.title ? { title: o.title } : {}), ...(files.length ? { files } : {}), ...(handoff ? { handoff } : {}) };
}

export type ReadyHandoff = Extract<SealedHandoff, { branch: string }>;

/** What the injection screen reads of a sealed handoff: the branch (its words apart too: "ignore-previous-…") and the
 *  checks, like handoffText on a plain board. */
export const handoffScreen = (h: ReadyHandoff) => `${h.branch}\n${h.branch.replace(/[-_./]+/g, " ")}\n${h.checks}`;

/**
 * The gate's queue on an encrypted board as the client can trust it (#5580). The server can't check a clear branch hash
 * against the sealed branch, so a member could copy someone else's: each hash is worked out again here from the
 * decrypted branch under its envelope's epoch, and a handoff whose hash doesn't match is dropped. Then the newest per
 * branch stays. One this machine can't decrypt stays, unchecked (open: null).
 */
export function verifiedQueue<R extends { seq: number; handoff?: { branch_hash?: unknown } | null }>(
  rows: R[],
  opened: Map<number, { handoff: ReadyHandoff; epoch: number }>,
  hash: (epoch: number, branch: string) => string | null,
): { rows: (R & { open: ReadyHandoff | null })[]; forged: number[] } {
  const forged: number[] = [];
  const kept = rows.flatMap((r): (R & { open: ReadyHandoff | null })[] => {
    const o = opened.get(r.seq);
    if (!o) return [{ ...r, open: null }];
    if (hash(o.epoch, o.handoff.branch) !== r.handoff?.branch_hash) return (forged.push(r.seq), []);
    return [{ ...r, open: o.handoff }];
  });
  const newest = new Map<string, number>();
  for (const r of kept) if (r.open) newest.set(r.open.branch, r.seq);
  return { rows: kept.filter((r) => !r.open || newest.get(r.open.branch) === r.seq), forged };
}

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** Only a well-formed handoff is kept: a git branch name and full commit ids (printed for the lander to check out). */
function sealedHandoff(v: unknown): SealedHandoff | null {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  if (o.state === "landed" || o.state === "failed") return { state: o.state, ...(typeof o.sha === "string" && SHA.test(o.sha) ? { sha: o.sha } : {}) };
  let branch: string;
  try {
    branch = branchName(o.branch);
  } catch {
    return null;
  }
  if (typeof o.sha !== "string" || !SHA.test(o.sha) || typeof o.base !== "string" || !SHA.test(o.base)) return null;
  return { branch, sha: o.sha, base: o.base, checks: typeof o.checks === "string" ? o.checks.slice(0, 300) : "" };
}

