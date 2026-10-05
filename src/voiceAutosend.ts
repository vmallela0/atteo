// Auto-send from a voice call (vedu #2638, rules jxn's agent #2644). With display.voice_autosend on, a post to your agent
// can go out without the spoken or tapped yes, but only when it is your own words, as the mic heard them:
//   - the text Atteo's tool call carries must be your last transcript (the speech-to-text of the mic, never the model's
//     rephrasing), or that transcript after a spoken command like "tell my agent" / "post to the board:". What gets
//     posted is that slice of the transcript, verbatim, not the tool call's text;
//   - you started speaking at least LOOPBACK_MS after Atteo's voice stopped (the client measures it): on the loudspeaker,
//     Atteo reading a hostile message aloud can reach the mic and come back as "your" transcript;
//   - the transcript passes the injection screen, names nobody (no @), and isn't long;
//   - it goes only to your agent's own chat (private to you) or to the board the call is on, with that board's normal
//     audience: post_to_my_agent never sets people_only or just-mine. Any other board asks.
// Anything else (Atteo's own wording, a summary, something read off a board, another board, a flag) still asks for a
// yes, exactly as before. The client then holds the post for UNDO_MS with an Undo before sending it.

import { screenText } from "./screen";

export const LOOPBACK_MS = 1000;
export const UNDO_MS = 5000;
export const MAX_AUTOSEND_CHARS = 500;

/** Words only, for comparing: Unicode-normalized, lowercase, punctuation and the "um"s gone, single spaces. */
export function sayWords(s: string): string {
  return String(s ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{M}\p{N}' ]+/gu, " ")
    .split(/\s+/)
    .filter((w) => w && !FILLER.has(w))
    .join(" ")
    .replace(/(^|\s)'+|'+(?=\s|$)/g, "$1")
    .trim();
}
const FILLER = new Set(["um", "umm", "uh", "uhh", "erm", "er", "hmm", "mm"]);

// A spoken command before the message itself: "tell my agent", "post to the board:", "send this to my agent that".
const COMMAND = /^\s*(?:(?:hey|ok|okay|so)[,\s]+)?(?:atteo[,\s]+)?(?:(?:please|can you|could you)\s+)?(?:post|send|tell|say|write|message|ask)\b(?:\s+(?:this|that|it))?(?:\s+(?:to|on|for)?\s*(?:my|the)\s+(?:agent'?s?|agent'?s chat|board|agent board|chat|assistant))?(?:\s+(?:board|chat))?\s*(?:[:,–—-]\s*|(?:that|saying|to)\b\s*)?/iu;

/** The message part of what was said: the transcript without a leading spoken command (or all of it). */
export function messagePart(transcript: string): string {
  const t = String(transcript ?? "").trim();
  const m = t.match(COMMAND);
  if (!m || !m[0].trim()) return t;
  const rest = t.slice(m[0].length).trim();
  return rest || t;
}

export type AutosendReason = "off" | "empty" | "loopback" | "board" | "not_your_words" | "mention" | "flagged" | "long";
export type AutosendVerdict = { auto: true; text: string; undo_ms: number } | { auto: false; reason: AutosendReason };

/**
 * Whether this post can go without a yes. transcript: the mic's last transcript; text: the tool call's text; board: the
 * tool call's board (null: your agent's chat); callBoard: the board the call is on (null: a call on no board);
 * spokeAfterMs: how long after Atteo's voice stopped you started speaking (null: Atteo hadn't spoken; negative: over it).
 */
export function autosendVerdict(o: { enabled: boolean; transcript: string; text: string; board: string | null; callBoard: string | null; spokeAfterMs: number | null }): AutosendVerdict {
  if (!o.enabled) return { auto: false, reason: "off" };
  const transcript = String(o.transcript ?? "").trim();
  if (!transcript || !String(o.text ?? "").trim()) return { auto: false, reason: "empty" };
  if (o.spokeAfterMs !== null && !(o.spokeAfterMs >= LOOPBACK_MS)) return { auto: false, reason: "loopback" };
  // Your agent's own chat (no board) is private to you; a board must be the one this call is on.
  if (o.board && o.board !== o.callBoard) return { auto: false, reason: "board" };
  const said = sayWords(o.text);
  const part = messagePart(transcript);
  let post: string | null = null;
  if (said && said === sayWords(part)) post = part;
  else if (said && said === sayWords(transcript)) post = transcript;
  if (post === null) return { auto: false, reason: "not_your_words" };
  if (/@/.test(post) || /@/.test(transcript)) return { auto: false, reason: "mention" };
  if (screenText(transcript)) return { auto: false, reason: "flagged" };
  if (post.length > MAX_AUTOSEND_CHARS) return { auto: false, reason: "long" };
  return { auto: true, text: post, undo_ms: UNDO_MS };
}
