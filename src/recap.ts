// Recaps: "what happened on this board since #N (or since I last read)": decisions made, questions still open and
// who they wait on, tasks that moved grouped by who owes what, approvals waiting, files changed and new members.
// Computed from the board's own tables (no model), as JSON for pages and as ≤15 short lines for agents.

import type { PinnedDoc } from "./board";
import type { Env } from "./types";

export interface RecapTask {
  seq: number;
  title: string;
  status: string;
  priority: string | null;
  owner: string | null; // the member who owes it (its assignee; for a done task, whoever finished it), null: nobody
  owner_label: string; // "jxn's agent", "jxn" (the person), or "unassigned"
  updated_at: number;
}
export interface RecapOwner {
  owner: string | null;
  label: string;
  new: number[];
  blocked: number[];
  done: number[];
}
export interface Recap {
  board: { id: string; title: string; encrypted: boolean };
  since: number; // entries after this seq
  since_ts: number; // when entry #since was posted (0 for the start of the board)
  basis: "seq" | "last-read";
  until: number; // the board's newest entry
  entries: number; // how many entries were posted in between
  decisions: { seq: number; title: string; author: string; via: string | null; ts: number; human: boolean; state: string | null; waiting_on: string[] }[];
  // Questions still open now (newest first). to: the member whose agent it's addressed to; waiting_on: everyone it names.
  questions: { seq: number; title: string; author: string; via: string | null; to: string | null; ts: number; waiting_on: string[]; new: boolean }[];
  // Who owes what: per member (agent: their agent, else the person), the tasks that moved since (new or blocked) and the
  // open questions waiting on them. Done tasks aren't owed (they're in tasks_moved.done).
  owed: { who: string; agent: boolean; items: { seq: number; title: string; kind: "task" | "question"; state: "new" | "blocked" | "open" }[] }[];
  tasks_moved: { new: RecapTask[]; done: RecapTask[]; blocked: RecapTask[]; by_owner: RecapOwner[] };
  approvals: { id: string; title: string; risk: string; tool: string | null; session: string | null; created_at: number; expires_at: number }[];
  files: { name: string; from_version: number; to_version: number; versions: number; authors: string[] }[];
  members: { name: string; joined_at: number }[];
  pinned: PinnedDoc | null;
}
/** What the board object computes; the Worker adds the caller's approvals and new members from the directory. */
export type RecapCore = Omit<Recap, "approvals" | "members">;

const MAX_LINE = 180;
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const short = (t: string) => cut(t.replace(/\s+/g, " ").trim(), 48);

/** The agent rendering: at most ~15 lines, each one line. */
export function formatRecap(r: Recap): string {
  const head = `Recap of "${r.board.title}" (${r.board.id}) since #${r.since}${r.basis === "last-read" ? " (your last read)" : ""} · ${r.entries} new entr${r.entries === 1 ? "y" : "ies"}`;
  const lines = [head];
  if (!r.entries) lines.push("Nothing new since then.");
  const list = <T>(items: T[], max: number, f: (x: T) => string) => items.slice(0, max).map(f).join("; ") + (items.length > max ? `; … ${items.length - max} more` : "");
  if (r.decisions.length) lines.push(`Decisions (${r.decisions.length}): ${list(r.decisions, 4, (d) => `#${d.seq} ${short(d.title)}${d.human ? ` [human: ${d.state}${d.state === "open" && d.waiting_on.length ? `, waiting on ${d.waiting_on.join(", ")}` : ""}]` : ""}`)}`);
  if (r.questions.length) lines.push(`Open questions (${r.questions.length}): ${list(r.questions, 3, (q) => `#${q.seq} ${short(q.title)} (waiting on ${q.waiting_on.length ? q.waiting_on.join(", ") : "anyone"})`)}`);
  const t = r.tasks_moved;
  if (t.new.length || t.done.length || t.blocked.length) {
    lines.push(`Tasks moved: ${t.new.length} new · ${t.done.length} done · ${t.blocked.length} blocked`);
    const title = new Map([...t.new, ...t.done, ...t.blocked].map((x) => [x.seq, short(x.title)]));
    const seqs = (label: string, s: number[]) => (s.length ? [`${label} ${s.slice(0, 3).map((n) => `#${n} ${title.get(n)}`).join(", ")}${s.length > 3 ? ` +${s.length - 3}` : ""}`] : []);
    for (const o of t.by_owner.slice(0, 5)) lines.push(`  ${o.label}: ${[...seqs("blocked", o.blocked), ...seqs("new", o.new), ...seqs("done", o.done)].join("; ")}`);
    if (t.by_owner.length > 5) lines.push(`  … ${t.by_owner.length - 5} more (task list)`);
  }
  if (r.approvals.length) lines.push(`Approvals waiting for you (${r.approvals.length}): ${list(r.approvals, 3, (a) => `${a.id} ${short(a.title)} (${a.risk} risk)`)}`);
  if (r.files.length) lines.push(`Files changed (${r.files.length}): ${list(r.files, 5, (f) => `${f.name} ${f.from_version ? `v${f.from_version}→v${f.to_version}` : `new v${f.to_version}`}`)}`);
  if (r.members.length) lines.push(`New members: ${list(r.members, 8, (m) => m.name)}`);
  if (r.pinned) lines.push(`📌 Pinned doc: ${r.pinned.name} v${r.pinned.version}`);
  return lines.map((l) => cut(l, MAX_LINE)).join("\n");
}

export function parseSince(raw: unknown): number | "last-read" {
  if (raw == null || raw === "" || raw === "last-read") return "last-read";
  const n = typeof raw === "number" ? raw : /^\d+$/.test(String(raw).trim()) ? parseInt(String(raw), 10) : NaN;
  if (!Number.isInteger(n) || n < 0) throw new RecapError('since is an entry number (e.g. 40) or "last-read".');
  return n;
}

export class RecapError extends Error {}

type BoardStub = { recap(user: string, opts: { since: number | "last-read"; session: string | null; as: "agent" | "person" }): Promise<RecapCore> };

/** The whole recap for one caller: the board's part, plus their own pending approvals here and members who joined since. */
export async function buildRecap(env: Env, stub: BoardStub, user: string, opts: { since: number | "last-read"; session: string | null; as: "agent" | "person" }): Promise<Recap & { text: string }> {
  const core = await stub.recap(user, opts);
  const [ap, mem] = await Promise.all([
    env.DB.prepare(`SELECT id, title, risk, tool, session, created_at, expires_at FROM approvals WHERE user = ? AND board_id = ? AND status = 'pending' AND expires_at > ? ORDER BY created_at LIMIT 20`)
      .bind(user, core.board.id, Date.now())
      .all<Recap["approvals"][number]>(),
    env.DB.prepare(`SELECT user AS name, joined_at FROM members WHERE board_id = ? AND joined_at > ? ORDER BY joined_at LIMIT 50`).bind(core.board.id, core.since_ts).all<{ name: string; joined_at: number }>(),
  ]);
  const r: Recap = { ...core, approvals: ap.results, members: core.since === 0 ? [] : mem.results };
  return { ...r, text: formatRecap(r) };
}
