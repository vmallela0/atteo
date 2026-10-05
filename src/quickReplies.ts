// One-tap replies to an agent's question (vedu #2490, UX research item 2: Gmail Smart Reply wrote 10% of mobile
// replies; a randomized study found suggested replies sped conversations up, but people suspected of using AI with
// other people were rated worse). So: only under a question an agent asks a person, never person to person.
// The page shows the chips to the people the question is for while it's open; a tap posts the chip's text as that
// person's reply in the question's thread, which answers it (state.ts: a reply from someone it was asked of).

import type { Entry } from "./types";
import { screenText } from "./screen";
import { stripBidiControls } from "./util";

/** Shown when the agent didn't offer its own options. English keys: the page translates them for the viewer. */
export const QUICK_DEFAULTS = ["Yes, go ahead", "Not now", "Tell me more"] as const;
export const MAX_QUICK = 4;
export const MAX_QUICK_LEN = 40;

/**
 * The agent's own options from the question's data (`data.options`: 2–4 short strings), cleaned; null when it gave
 * none or they aren't usable (then the defaults show). Hidden formatting is removed and whitespace collapsed.
 */
export function agentOptions(data: unknown): string[] | null {
  const raw = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>).options : undefined;
  if (!Array.isArray(raw)) return null;
  const opts: string[] = [];
  for (const o of raw) {
    if (typeof o !== "string") return null;
    const t = stripBidiControls(o).replace(/\s+/g, " ").trim();
    if (!t || [...t].length > MAX_QUICK_LEN) return null;
    if (!opts.includes(t)) opts.push(t);
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
 * never a people-only or Just mine entry, an unsent one, or one the injection screen or the model flagged. An agent's
 * own options are screened too: if any reads like an instruction, there are no chips at all.
 * (Encrypted boards: the server only ever sees "🔒 Encrypted message" with no mentions, so nothing shows there.)
 */
export function quickReplies(e: Entry, opts: { retracted?: boolean } = {}): QuickReplies | null {
  if (e.type !== "question" || e.via !== "agent" || e.audience || e.retracts != null || opts.retracted) return null;
  // A soft "quoted" flag (instruction-like text only inside code or quotes) still gets chips; a real flag doesn't.
  const flagged = (s: string) => !!screenText(s) && !screenText(s)!.quoted;
  if (e.ai_flag || flagged(e.text)) return null;
  const people = askedPeople(e);
  if (!people.length) return null;
  const own = agentOptions(e.data);
  if (own?.some((o) => screenText(o))) return null;
  return { for: people, options: own ?? [...QUICK_DEFAULTS], own: !!own };
}
