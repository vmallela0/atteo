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

/** What a private message can be: a note or a question (nothing that changes shared state agents read). */
export const PEOPLE_ONLY_TYPES = ["note", "question"] as const;
