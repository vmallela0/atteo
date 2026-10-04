// Who may see an entry. Pure (no Durable Object imports), so it's unit-tested on its own (test/audience.test.ts).
//
// Two private audiences, both stored as `audience` + `to_people` (a JSON list) on the entry; NULL for everyone's:
// - "people" (vedu #1264): only the people named (author included), signed in as themselves; never any agent.
// - "own" (#1748): "Just mine": only one person (to_people = [them]) and their own agents. Agents post as their
//   person's name, so an agent viewer's `user` is its owner: an own entry is for any viewer, person or agent, whose
//   user is that one person. Every other person and every other person's agent never sees it.
// A path that doesn't say who's asking (no viewer) sees neither.

import type { Entry, Viewer } from "./types";

export type Audience = "people" | "own";

/** SQL for "this viewer may see the entry" (columns unqualified, or with `alias.`), and what it binds (bare `?`). */
export function audienceOk(v: Viewer | null | undefined, alias = ""): { sql: string; args: string[] } {
  if (!v) return { sql: `${alias}audience IS NULL`, args: [] };
  const named = `EXISTS (SELECT 1 FROM json_each(${alias}to_people) WHERE value = ?)`;
  // A person: anything private naming them (people-only for them, or their own lane). An agent: its person's own lane.
  if (v.person) return { sql: `(${alias}audience IS NULL OR ${named})`, args: [v.user] };
  return { sql: `(${alias}audience IS NULL OR (${alias}audience = 'own' AND ${named}))`, args: [v.user] };
}

/** The same test for an entry already loaded. */
export function canSee(e: Pick<Entry, "audience" | "to_people">, v: Viewer | null | undefined): boolean {
  if (!e.audience) return true;
  if (!v || !(e.to_people ?? []).includes(v.user)) return false;
  return e.audience === "own" || v.person;
}

/** "vedu", "vedu and jxn", "vedu, jxn and sam". */
export function peopleList(people: string[]): string {
  return people.length <= 1 ? people.join("") : `${people.slice(0, -1).join(", ")} and ${people[people.length - 1]}`;
}

/** What the author is told once, when they send one: "Only you and jxn can see this. Agents can't." */
export function peopleNotice(author: string, people: string[]): string {
  const others = people.filter((p) => p !== author);
  return `Only you${others.length ? ` and ${peopleList(others)}` : ""} can see this. Agents can't.`;
}

/** The same for "Just mine" (the author is the person, or one of their agents). */
export const OWN_NOTICE = "Just mine: only you and your own agents can see this.";

/** The notice for an entry's audience (null: everyone's). */
export function audienceNotice(e: Pick<Entry, "audience" | "to_people">, author: string): string | null {
  if (e.audience === "own") return OWN_NOTICE;
  return e.audience ? peopleNotice(author, e.to_people ?? []) : null;
}

/** The short name of a private audience, for errors: "people-only", "just-mine". */
export const audienceWord = (a: Audience): string => (a === "own" ? "just-mine" : "people-only");

/** Plain text for matching a forward excerpt against an entry: markdown, links and blockquotes stripped; whitespace collapsed. */
export function normalizeForwardExcerpt(text: string): string {
  let t = text.replace(/\r\n?/g, "\n");
  t = t.replace(/```[^\n]*\n([\s\S]*?)```/g, "$1");
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  t = t.replace(/<([^>\s]+)>/g, "$1");
  t = t.replace(/\*\*([^*]+)\*\*/g, "$1");
  t = t.replace(/__([^_]+)__/g, "$1");
  t = t.replace(/\*([^*\n]+)\*/g, "$1");
  t = t.replace(/_([^_\n]+)_/g, "$1");
  t = t.replace(/`([^`]+)`/g, "$1");
  t = t.replace(/^>\s?/gm, "");
  t = t.replace(/^[-*+]\s+/gm, "");
  t = t.replace(/^\d+\.\s+/gm, "");
  return t.replace(/\s+/g, " ").trim();
}

/** True when `selectedText` appears in `entryText` after the same normalization (ref chips stay as #N). */
export function forwardExcerptInEntry(selectedText: string, entryText: string): boolean {
  const sel = normalizeForwardExcerpt(selectedText);
  if (!sel) return false;
  return normalizeForwardExcerpt(entryText).includes(sel);
}

/** Whether an entry may be forwarded to a board (destMembers: everyone on the destination). */
export function forwardDestOk(
  e: Pick<Entry, "audience" | "to_people">,
  destMembers: string[],
): { ok: true; people?: string[] } | { ok: false; reason: "just-mine" | "people" } {
  if (!e.audience) return { ok: true };
  if (e.audience === "own") return { ok: false, reason: "just-mine" };
  const people = [...new Set(e.to_people ?? [])].sort();
  const dest = [...new Set(destMembers)].sort();
  if (people.length !== dest.length || people.some((m, i) => m !== dest[i])) return { ok: false, reason: "people" };
  return { ok: true, people };
}

/** What a private message can be: a note or a question (nothing that changes shared state agents read). */
export const PEOPLE_ONLY_TYPES = ["note", "question"] as const;

/** What a Just mine mail item (mailbox, webhook) says, so an agent answering it keeps it private. */
export const OWN_MAIL_HINT = "Just mine: only your person sees this; reply in its thread or with own: true.";

/** What an agent is told when its top-level post was kept in Just mine for it (ownByDefault). */
export const keptOwnNotice = (person: string): string => `Kept in Just mine (your last message from ${person} was private); pass own: false to post publicly.`;

/** How recent a person's Just mine message must be for their agent's next top-level post to stay in it. */
export const OWN_DEFAULT_MS = 10 * 60_000;

type Received = Pick<Entry, "seq" | "ts" | "author" | "via" | "audience" | "to" | "mentions">;

/**
 * Should an agent's top-level post (no thread, own not given) stay in its person's Just mine lane? Yes when the last
 * thing this agent session got on the board was its person's own message, in the last ten minutes: answering it at the
 * top level would otherwise go public. `recent`: the board's entries, newest first, that the agent may see, without
 * its own agents' posts and unsends. It "got" one it has read (seq at or below its read cursor) or one that came to it
 * as mail without a read (its person's own message, or one addressed to its agent), unless that's for another of its
 * person's sessions ("@vedu/scout"). Returns the person, or null.
 */
export function ownByDefault(user: string, recent: Received[], cursor: number, now: number, sessionName?: string | null): string | null {
  for (const e of recent) {
    if (now - e.ts > OWN_DEFAULT_MS) return null;
    const otherSession = (e.mentions ?? []).some((m) => m.user === user && !!m.session && m.session !== sessionName);
    const ownFromPerson = e.audience === "own" && e.author === user && e.via === "person";
    const mailed = !otherSession && (ownFromPerson || e.to === user || (e.mentions ?? []).some((m) => m.user === user && m.agent));
    if (e.seq > cursor && !mailed) continue; // not read yet, and not mail for this agent
    return ownFromPerson && !otherSession ? user : null;
  }
  return null;
}
