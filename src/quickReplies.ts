// One-tap replies to an agent's question (vedu #2490, UX research item 2: Gmail Smart Reply wrote 10% of mobile
// replies; a randomized study found suggested replies sped conversations up, but people suspected of using AI with
// other people were rated worse). So: only under a question an agent asks a person, never person to person.
// The page shows the chips to the people the question is for while it's open; a tap posts the chip's text as that
// person's reply in the question's thread, which answers it (state.ts: a reply from someone it was asked of).
//
// An agent's own choices (data.options) are text another person's agent wrote that a tap posts AS the viewer, so each
// one is checked on its own (jxn's agent #2562): one short line, no @mentions, links or domains, markdown or leading
// slash command, nothing the injection screen flags. Failing ones are dropped; with fewer than 2 left, the defaults.
// They're also used only when the asking agent's person is still a member of the board (else the defaults).

import type { Entry } from "./types";
import { screenText } from "./screen";
import { stripBidiControls } from "./util";

/** Shown when the agent didn't offer usable options. English keys: the page translates them for the viewer. */
export const QUICK_DEFAULTS = ["Yes, go ahead", "Not now", "Tell me more"] as const;
export const MAX_QUICK = 4;
export const MAX_QUICK_LEN = 40;

const MARKDOWN = /[*_`#>[\]!~|]/; // emphasis, code, headings, quotes, links and images, strikethrough, tables
const LINK = /:\/\/|\bwww\.|\bmailto:|[a-z0-9-]\.[a-z]{2,}\b/i; // a URL, or a bare domain like evil.com
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/; // newlines, tabs and other control characters

/** One option, cleaned, or null when it can't be offered as something a person taps to send as themselves. */
export function cleanOption(o: unknown): string | null {
  if (typeof o !== "string") return null;
  const raw = stripBidiControls(o);
  if (CONTROL.test(raw)) return null; // one line only (no newline, tab or other control)
  const t = raw.replace(/ {2,}/g, " ").trim();
  if (!t || [...t].length > MAX_QUICK_LEN) return null;
  if (t.includes("@") || LINK.test(t) || MARKDOWN.test(t) || t.startsWith("/")) return null;
  const f = screenText(t);
  if (f) return null; // anything instruction-like, even only quoted
  return t;
}

/** The agent's usable options from the question's data (`data.options`), or null (then the defaults show). */
export function agentOptions(data: unknown): string[] | null {
  const raw = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>).options : undefined;
  if (!Array.isArray(raw)) return null;
  const opts: string[] = [];
  for (const o of raw.slice(0, 20)) {
    const t = cleanOption(o);
    if (t && !opts.includes(t)) opts.push(t);
  }
  return opts.length >= 2 ? opts.slice(0, MAX_QUICK) : null;
}

/** The people (not agents) a question is asked of: "@vedu" in its text. */
export function askedPeople(e: Pick<Entry, "mentions">): string[] {
  return [...new Set((e.mentions ?? []).filter((m) => !m.agent && !m.session).map((m) => m.user))];
}

export type QuickReplies = { for: string[]; options: string[]; own: boolean };

/**
 * The chips an entry carries, or null. Only a live question written by an agent and asked of at least one person;
 * never a people-only or Just mine entry, an unsent one, or one the injection screen or the model flagged.
 * `members`: the board's members now. The agent's own options are used only when its person is one of them; without
 * the list (or when they've left), the defaults. (Encrypted boards: the server only ever sees "🔒 Encrypted message"
 * with no mentions, so nothing shows there.)
 */
export function quickReplies(e: Entry, opts: { retracted?: boolean; members?: ReadonlySet<string> | readonly string[] } = {}): QuickReplies | null {
  if (e.type !== "question" || e.via !== "agent" || e.audience || e.retracts != null || opts.retracted) return null;
  // A soft "quoted" flag (instruction-like text only inside code or quotes) still gets chips; a real flag doesn't.
  const f = screenText(e.text);
  if (e.ai_flag || (f && !f.quoted)) return null;
  const people = askedPeople(e);
  if (!people.length) return null;
  const members = opts.members ? new Set(opts.members) : null;
  const own = members?.has(e.author) ? agentOptions(e.data) : null;
  return { for: people, options: own ?? [...QUICK_DEFAULTS], own: !!own };
}
