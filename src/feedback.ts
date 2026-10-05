// Feedback about Atteo itself (vedu #4125): an idea, a complaint, praise. People send it from the web ("Send feedback"
// beside Report a bug) or the app (Settings); agents send it with the MCP `feedback` tool or `atteo feedback`, when
// their person says something about Atteo ("tell the Atteo team…"), after confirming the wording with them.
// It rides the bug-report pipeline: one bot member posts it on the developers' board (FEEDBACK_BOARD, else
// BUGS_BOARD), with who sent it in the text. Only what the sender writes goes: no board content, no screenshot.

import { BUG_BOT, defang } from "./bugs";
import { blockedMessage, scanText } from "./secrets";
import type { Env } from "./types";
import { BOARD_RE } from "./util";

export const FEEDBACK_MAX = 2000;
/** Per person per 10-minute window (appSignin.hit), people and their agents together. */
export const FEEDBACK_LIMIT = 5;

export class FeedbackError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Feedback {
  text: string;
  board: string | null; // the board it's about, by id only (never its content)
}

/** The developers' board feedback lands on, or "" when neither var is set. */
export function feedbackBoard(env: Pick<Env, "BUGS_BOARD"> & { FEEDBACK_BOARD?: string }): string {
  return ((env.FEEDBACK_BOARD ?? "").trim() || (env.BUGS_BOARD ?? "").trim());
}

/** Checks what was sent; throws a FeedbackError (400) with a plain-language message. */
export function parseFeedback(body: unknown): Feedback {
  const b = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const text = typeof b.text === "string" ? b.text.trim() : "";
  if (!text) throw new FeedbackError(400, "Say what you'd like the Atteo team to know (text).");
  if (text.length > FEEDBACK_MAX) throw new FeedbackError(400, `Keep feedback under ${FEEDBACK_MAX} characters.`);
  const hit = scanText(text);
  if (hit) throw new FeedbackError(400, blockedMessage(hit));
  const raw = typeof b.board === "string" ? b.board.trim() : "";
  if (raw && !BOARD_RE.test(raw)) throw new FeedbackError(400, "board is a board id (b_…), or leave it out.");
  return { text, board: raw || null };
}

/** Who sent it, as the developers read it: "vedu", or "vedu's agent (vedu/scout) on behalf of vedu". */
export function feedbackFrom(person: string, via: "person" | "agent", session?: string | null): string {
  if (via === "person") return person;
  return `${person}'s agent${session ? ` (${person}/${session})` : ""} on behalf of ${person}`;
}

/** The entry's text: the feedback first, then who sent it and what it's about. */
export function feedbackText(f: Feedback, from: string): string {
  // The sender's words can't @mention anyone on the developers' board (jxn's agent #4177); the From line stays plain.
  return [`💬 Feedback: ${defang(f.text)}`, "", `From ${from}${f.board ? ` · about board ${f.board}` : ""}`].join("\n");
}

/** Posts one piece of feedback on the developers' board; returns where it landed. Rate-limited per person. */
export async function sendFeedback(
  env: Env & { FEEDBACK_BOARD?: string },
  deps: {
    hit: (env: Env, key: string, limit: number) => Promise<boolean>;
    stub: (env: Env, id: string) => { post: (user: string, input: { type: "note"; text: string; via: "person"; client: string }) => Promise<{ seq: number }> };
    /** Sets up the bot member on the board before the first post (bugBoard.ensureBugBoard; jxn #4139). */
    ensure: (env: Env, board: string) => Promise<void>;
  },
  input: { person: string; via: "person" | "agent"; session?: string | null; body: unknown },
): Promise<{ board: string; seq: number }> {
  const board = feedbackBoard(env);
  if (!board) throw new FeedbackError(501, "Feedback isn't set up on this server yet.");
  const f = parseFeedback(input.body);
  if (!(await deps.hit(env, `feedback:u:${input.person}`, FEEDBACK_LIMIT))) {
    throw new FeedbackError(429, "That's a few in a row: send more feedback in ten minutes.");
  }
  // One bot member authors every post on the developers' board (an author must be a member, opus-d #3416),
  // set up on first use like a bug report's.
  await deps.ensure(env, board);
  const entry = await deps.stub(env, board).post(BUG_BOT, { type: "note", text: feedbackText(f, feedbackFrom(input.person, input.via, input.session)), via: "person", client: "feedback" });
  return { board, seq: entry.seq };
}
