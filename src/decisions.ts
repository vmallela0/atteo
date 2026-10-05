// Human decisions. A decision a PERSON posts (via "person") is for the people on the board to make: agents read it and
// can reply with input, but they can't resolve it, their replies don't tick it ✅, and they shouldn't act on it until
// it's decided. Every person on the board except its author (viewers excluded) agrees or objects, one changeable vote
// each; it's decided once all of them agree, or when its author closes it (decided or dropped). A decision then gets a
// quiet line from its author ("✅ Decided by the people: …") that resolves it, so the usual auto-ticks follow.
// Agents' own decisions are plain entries, as before. Lives in the board's SQLite (two small tables); the people on the
// board come from the directory (D1), cached briefly.

import { egressRefusalText, type Later } from "./observe";
import type { Entry, Env, NewEntry } from "./types";

/** Refusals, worded for whoever is told (a person on the web, or an agent). Not board.ts's BoardError: state.ts imports this module and stays free of the Workers runtime. */
export class DecisionError extends Error {}

export const HD_STATES = ["open", "decided", "dropped"] as const;
export type HumanDecisionState = (typeof HD_STATES)[number];
export type HumanVote = "agree" | "object";

export interface HumanDecision {
  state: HumanDecisionState;
  author: string; // who asked; they close it
  votes: { user: string; vote: HumanVote; note: string | null; ts: number }[]; // current members' votes, oldest first
  voters: string[]; // everyone whose agreement it needs (the people on the board but its author; not viewers)
  waiting_on: string[]; // voters who haven't agreed yet (empty once it's closed)
  closed_by: string | null; // its author, when they closed it; null while open or when everyone agreed
  note: string | null; // the author's note on closing
  line: number | null; // the entry that announced the outcome
}

export const MAX_HD_NOTE = 280;
const VOTERS_TTL_MS = 30_000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS human_decisions (
    seq INTEGER PRIMARY KEY,
    author TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'open',
    closed_by TEXT,
    note TEXT,
    line_seq INTEGER,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS hd_votes (
    seq INTEGER NOT NULL,
    user TEXT NOT NULL,
    vote TEXT NOT NULL,
    note TEXT,
    ts INTEGER NOT NULL,
    PRIMARY KEY (seq, user)
  );
`;

/** Is this new entry a human decision? (Decided when it's posted; older person decisions stay plain.) */
export const isHumanDecisionPost = (e: Pick<Entry, "type" | "via">) => e.type === "decision" && e.via === "person";

/** One line for agents: what state it's in and that people decide it. */
export function humanDecisionLine(hd: HumanDecision): string {
  if (hd.state === "open") {
    const objected = hd.votes.filter((v) => v.vote === "object").map((v) => v.user);
    return `Human decision (people decide; don't act on it until it's decided) · ${hd.waiting_on.length ? `waiting on: ${hd.waiting_on.join(", ")}` : `waiting on ${hd.author} to close it`}${objected.length ? ` · objected: ${objected.join(", ")}` : ""}`;
  }
  if (hd.state === "decided") return `Human decision · decided ${hd.closed_by ? `(closed by ${hd.closed_by})` : "by the people"}${hd.note ? `: ${hd.note}` : ""}`;
  return `Human decision · dropped by ${hd.closed_by ?? hd.author}${hd.note ? `: ${hd.note}` : ""} (don't act on it)`;
}

/** Short tag for summary lines: "human decision · waiting on jxn". */
export function humanDecisionTag(hd: HumanDecision): string {
  if (hd.state === "open") return `human decision · ${hd.waiting_on.length ? `waiting on ${hd.waiting_on.join(", ")}` : `waiting on ${hd.author} to close it`} · don't act yet`;
  return hd.state === "decided" ? "human decision · decided" : "human decision · dropped";
}

type Post = (user: string, input: NewEntry) => Promise<Entry>;
interface Ctx {
  entry: Entry; // the decision
  encrypted: boolean;
  post: Post; // posts a quiet line as the decision's author, without moving their read position
}

export class HumanDecisions {
  private people: { at: number; list: { user: string; role: string }[] } | null = null;
  private any: boolean | null = null; // whether this board has any human decision at all (most don't: no D1 lookups then)
  private memo: Record<number, HumanDecision> | null = null;

  constructor(
    private sql: SqlStorage,
    private env: Env,
    private boardId: () => string | null,
    private later: Later | null = null,
  ) {
    sql.exec(SCHEMA);
  }

  private hasAny(): boolean {
    return (this.any ??= this.sql.exec("SELECT 1 AS x FROM human_decisions LIMIT 1").toArray().length > 0);
  }

  isHuman(seq: number | null | undefined): boolean {
    if (seq == null || !this.hasAny()) return false;
    return this.sql.exec("SELECT 1 AS x FROM human_decisions WHERE seq = ?", seq).toArray().length > 0;
  }

  /** A person's decision just landed: it's open until the people decide. */
  record(e: Entry) {
    this.sql.exec("INSERT OR IGNORE INTO human_decisions (seq, author, state, updated_at) VALUES (?, ?, 'open', ?)", e.seq, e.author, e.ts);
    this.any = true;
    this.memo = null;
  }

  /** Agents can't resolve a human decision; their replies are input. */
  guardResolves(resolves: number[]) {
    for (const r of new Set(resolves)) {
      if (this.isHuman(r)) {
        throw new DecisionError(`#${r} is a human decision: the people on this board decide it, not agents, so it can't be resolved by an agent. Reply to it (reply_to ${r}) with your input instead, and don't act on it until it's decided.`);
      }
    }
  }

  /** The people on the board (from the directory), refreshed every 30s, or now when `force`. Skipped on boards without human decisions. */
  async refresh(force = false) {
    if (!force && (!this.hasAny() || (this.people && Date.now() - this.people.at < VOTERS_TTL_MS))) return;
    const id = this.boardId();
    if (!id) return;
    const r = await this.env.DB.prepare("SELECT user, role FROM members WHERE board_id = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY joined_at")
      .bind(id, Date.now())
      .all<{ user: string; role: string }>()
      .catch(() => null);
    if (!r) return;
    const changed = JSON.stringify(r.results) !== JSON.stringify(this.people?.list ?? null);
    this.people = { at: Date.now(), list: r.results };
    if (changed) this.memo = null;
  }

  /** Who decides a decision by this author: every person on the board but them, viewers excluded. */
  voters(author: string): string[] {
    return (this.people?.list ?? []).filter((p) => p.role !== "viewer" && p.user !== author).map((p) => p.user);
  }

  /** Every human decision on the board, by seq (small: one row per decision plus its votes). */
  all(): Record<number, HumanDecision> {
    if (!this.hasAny()) return {};
    if (this.memo) return this.memo;
    const votes = new Map<number, HumanDecision["votes"]>();
    for (const v of this.sql.exec("SELECT seq, user, vote, note, ts FROM hd_votes ORDER BY ts").toArray()) {
      const list = votes.get(v.seq as number) ?? [];
      list.push({ user: v.user as string, vote: v.vote as HumanVote, note: (v.note as string | null) ?? null, ts: v.ts as number });
      votes.set(v.seq as number, list);
    }
    const out: Record<number, HumanDecision> = {};
    for (const r of this.sql.exec("SELECT seq, author, state, closed_by, note, line_seq FROM human_decisions").toArray()) {
      const author = r.author as string;
      const voters = this.voters(author);
      const state = r.state as HumanDecisionState;
      const mine = (votes.get(r.seq as number) ?? []).filter((v) => voters.includes(v.user));
      const agreed = new Set(mine.filter((v) => v.vote === "agree").map((v) => v.user));
      out[r.seq as number] = {
        state,
        author,
        votes: mine,
        voters,
        waiting_on: state === "open" ? voters.filter((u) => !agreed.has(u)) : [],
        closed_by: (r.closed_by as string | null) ?? null,
        note: (r.note as string | null) ?? null,
        line: (r.line_seq as number | null) ?? null,
      };
    }
    return (this.memo = out);
  }

  get(seq: number): HumanDecision | null {
    return this.all()[seq] ?? null;
  }

  /** Entries with their human_decision state (for JSON, and for agents' reads). */
  attach(entries: Entry[]): Entry[] {
    if (!this.hasAny()) return entries;
    const all = this.all();
    return entries.map((e) => (all[e.seq] ? { ...e, human_decision: all[e.seq] } : e));
  }

  /** The summary's live tags, plus each human decision's. */
  tags(base: Map<number, string>): Map<number, string> {
    if (!this.hasAny()) return base;
    const out = new Map(base);
    for (const [seq, hd] of Object.entries(this.all())) out.set(Number(seq), humanDecisionTag(hd));
    return out;
  }

  private row(seq: number) {
    const r = this.sql.exec("SELECT author, state, closed_by, line_seq FROM human_decisions WHERE seq = ?", seq).toArray()[0];
    if (!r) throw new DecisionError(`#${seq} isn't a human decision (a decision a person posted). Only those take votes.`);
    if (this.sql.exec("SELECT 1 AS x FROM entries WHERE retracts = ?", seq).toArray().length) throw new DecisionError(`#${seq} was unsent.`);
    return { author: r.author as string, state: r.state as HumanDecisionState, closed_by: (r.closed_by as string | null) ?? null, line: (r.line_seq as number | null) ?? null };
  }

  private set(seq: number, change: { state: HumanDecisionState; closed_by?: string | null; note?: string | null; line: number | null }) {
    this.sql.exec(
      "UPDATE human_decisions SET state = ?, closed_by = COALESCE(?, closed_by), note = COALESCE(?, note), line_seq = ?, updated_at = ? WHERE seq = ?",
      change.state, change.closed_by ?? null, change.note ?? null, change.line, Date.now(), seq,
    );
    this.memo = null;
  }

  private cleanNote(note: unknown): string | null {
    const n = typeof note === "string" ? note.replace(/\s+/g, " ").trim() : "";
    if (!n) return null;
    if (n.length > MAX_HD_NOTE) throw new DecisionError(`Keep the note short (at most ${MAX_HD_NOTE} characters).`);
    const blocked = egressRefusalText(this.env, this.later, n, "note");
    if (blocked) throw new DecisionError(blocked);
    return n;
  }

  private static what(c: Ctx): string {
    if (c.encrypted) return `#${c.entry.seq}`;
    const t = c.entry.title || c.entry.text.split("\n").map((l) => l.trim()).find(Boolean) || `#${c.entry.seq}`;
    return t.length > 120 ? t.slice(0, 119) + "…" : t;
  }

  private async announce(c: Ctx, decided: boolean, head: string, note: string | null): Promise<number> {
    const text = `${head}: ${HumanDecisions.what(c)}${note && !c.encrypted ? `\n${note}` : ""}`;
    const e = await c.post(c.entry.author, { type: "note", title: decided ? "Decided" : "Dropped", text, reply_to: c.entry.seq, ...(decided ? { resolves: [c.entry.seq] } : {}), via: "person" });
    return e.seq;
  }

  private async unannounce(c: Ctx, line: number, why: string) {
    await c.post(c.entry.author, { type: "note", text: why, retracts: line, reply_to: c.entry.seq, via: "person" });
  }

  /** A person agrees or objects (one vote each, changeable). Everyone agreeing decides it; an objection reopens it unless its author closed it. */
  async vote(user: string, via: string | null | undefined, vote: string, note: unknown, c: Ctx): Promise<HumanDecision> {
    if (via === "agent") throw new DecisionError("Human decisions are for people: agents can't vote on them. Reply with your input instead.");
    if (vote !== "agree" && vote !== "object") throw new DecisionError('vote is "agree" or "object".');
    const seq = c.entry.seq;
    const row = this.row(seq);
    await this.refresh(true);
    if (user === row.author) throw new DecisionError(`You asked for #${seq}: close it (decided or dropped) when it's settled.`);
    const me = this.people?.list.find((p) => p.user === user);
    if (!me) throw new DecisionError(`Only the people on this board decide #${seq}.`);
    if (me.role === "viewer") throw new DecisionError("You can view this board but not change it, so you can't vote on its decisions.");
    const n = vote === "object" ? this.cleanNote(note) : null;
    this.sql.exec("INSERT OR REPLACE INTO hd_votes (seq, user, vote, note, ts) VALUES (?, ?, ?, ?, ?)", seq, user, vote, n, Date.now());
    this.memo = null;
    const hd = this.get(seq)!;
    if (row.state === "open" && hd.voters.length && !hd.waiting_on.length) {
      // Everyone agreed: it's decided.
      this.set(seq, { state: "decided", line: await this.announce(c, true, "✅ Decided by the people", null) });
    } else if (row.state === "decided" && !row.closed_by && vote === "object") {
      // Decided by agreement, then someone objected: open again (its author's close is final).
      if (row.line != null) await this.unannounce(c, row.line, `↩ Reopened: ${user} objected.`);
      this.set(seq, { state: "open", line: null });
    }
    return this.get(seq)!;
  }

  /** Its author closes it: decided or dropped, with an optional note. */
  async close(user: string, via: string | null | undefined, outcome: string, note: unknown, c: Ctx): Promise<HumanDecision> {
    if (via === "agent") throw new DecisionError("Human decisions are for people: agents can't close them.");
    if (outcome !== "decided" && outcome !== "dropped") throw new DecisionError('outcome is "decided" or "dropped".');
    const seq = c.entry.seq;
    const row = this.row(seq);
    if (user !== row.author) throw new DecisionError(`Only ${row.author}, who asked for #${seq}, can close it.`);
    if (row.closed_by) throw new DecisionError(`#${seq} is already closed (${row.state}).`);
    const n = this.cleanNote(note);
    await this.refresh(true);
    if (outcome === "decided") {
      if (row.state === "decided" && row.line != null) this.set(seq, { state: "decided", closed_by: user, note: n, line: row.line });
      else this.set(seq, { state: "decided", closed_by: user, note: n, line: await this.announce(c, true, `✅ Decided by ${user}`, n) });
    } else {
      if (row.line != null) await this.unannounce(c, row.line, `↩ ${user} dropped #${seq}.`);
      this.set(seq, { state: "dropped", closed_by: user, note: n, line: await this.announce(c, false, `✖ Dropped by ${user}`, n) });
    }
    return this.get(seq)!;
  }
}
