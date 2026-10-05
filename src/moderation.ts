// Moderation on the web (#3602; GAPS "Web UI … moderate": "no reporting or muting").
// Mute: a person mutes a member on one board. Only their own view changes: that member's posts (and their agents')
// fold to one line they can open, and stop notifying them (mentions, replies, decisions, people-only posts). Mail
// addressed to their agent still arrives; the muted member isn't told.
// Report: a person reports an entry to the board's owners with a reason, once per entry. The owners (other than the
// entry's author) get it in their inbox, and it goes in the board's audit log as "reported", which only owners see.
// People only: an agent's token is refused at the routes.

import * as registry from "./registry";
import { blockedMessage, scanText } from "./secrets";
import type { Env } from "./types";
import { offBoardSeq } from "./util";

export const REASON_MAX = 500;
/** Reports a person can send in ten minutes (appSignin.hit's window). */
export const REPORTS_PER_WINDOW = 10;

export class ModerationError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

/** Whom this person has muted on this board. */
export async function mutedOn(env: Env, user: string, boardId: string): Promise<string[]> {
  return (await env.DB.prepare(`SELECT muted FROM mutes WHERE user = ? AND board_id = ? ORDER BY muted`).bind(user, boardId).all<{ muted: string }>()).results.map((r) => r.muted);
}

/** Who on this board has muted this author (the notification fan-out drops them). */
export async function mutersOf(db: D1Database, boardId: string, author: string): Promise<Set<string>> {
  return new Set((await db.prepare(`SELECT user FROM mutes WHERE board_id = ? AND muted = ?`).bind(boardId, author).all<{ user: string }>()).results.map((r) => r.user));
}

export async function mute(env: Env, user: string, boardId: string, who: string): Promise<string[]> {
  if (who === user) throw new ModerationError("You can't mute yourself.");
  if (!(await registry.isMember(env, boardId, who))) throw new ModerationError(`${who} isn't on this board.`, 404);
  await env.DB.prepare(`INSERT OR IGNORE INTO mutes (user, board_id, muted, created_at) VALUES (?, ?, ?, ?)`).bind(user, boardId, who, Date.now()).run();
  return mutedOn(env, user, boardId);
}

export async function unmute(env: Env, user: string, boardId: string, who: string): Promise<string[]> {
  await env.DB.prepare(`DELETE FROM mutes WHERE user = ? AND board_id = ? AND muted = ?`).bind(user, boardId, who).run();
  return mutedOn(env, user, boardId);
}

/** A report's reason: one line of up to REASON_MAX characters, never a credential. */
export function reportReason(v: unknown): string {
  const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  if (!s) throw new ModerationError("Say what's wrong with it, so the owners know what to look at.");
  if (s.length > REASON_MAX) throw new ModerationError(`Keep the reason under ${REASON_MAX} characters.`);
  const hit = scanText(s, "reason");
  if (hit) throw new ModerationError(blockedMessage(hit));
  return s;
}

/** The board's owners: owner members and its creator. */
export async function ownersOf(env: Env, boardId: string): Promise<string[]> {
  const [members, board] = await Promise.all([registry.boardMembers(env, boardId), registry.getBoard(env, boardId)]);
  const here = new Set(members.map((m) => m.user));
  const owners = new Set(members.filter((m) => m.role === "owner").map((m) => m.user));
  if (board?.created_by && here.has(board.created_by)) owners.add(board.created_by);
  return [...owners];
}

/** Report entry #seq to the owners. Returns how many owners were told. */
export async function report(env: Env, boardId: string, seq: number, reporter: string, entry: { author: string; type: string }, reason: string, now = Date.now()): Promise<{ notified: number }> {
  if (entry.author === reporter) throw new ModerationError("That's yours: unsend it instead.");
  const r = await env.DB.prepare(`INSERT OR IGNORE INTO reports (board_id, seq, reporter, author, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(boardId, seq, reporter, entry.author, reason, now).run();
  if (!r.meta.changes) throw new ModerationError(`You already reported #${seq}.`, 409);
  await registry.audit(env, boardId, reporter, "reported", `#${seq}`, `${entry.author}: ${reason}`);
  // The owners, not the person reported (an owner reported is left to the other owners and the audit log).
  const to = (await ownersOf(env, boardId)).filter((u) => u !== reporter && u !== entry.author);
  // Each report is a row of its own: an owner's inbox already has (board, seq) when the post @mentioned them or was People
  // only to them, so the row's seq is a unique negative one (offBoardSeq) and the entry's number is in data.entry. It
  // never touches another row (#3737).
  if (to.length)
    await env.DB.batch(
      to.map((u) =>
        env.DB.prepare(
          `INSERT INTO notifications (user, board_id, seq, kind, actor, actor_via, entry_type, excerpt, created_at, read_at, data) VALUES (?, ?, ?, 'report', ?, 'person', ?, ?, ?, NULL, ?)`,
        ).bind(u, boardId, offBoardSeq(), reporter, entry.type, reason.slice(0, 160), now, JSON.stringify({ entry: seq })),
      ),
    );
  return { notified: to.length };
}
