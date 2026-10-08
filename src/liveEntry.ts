// Live entries (vedu #6581): a board tab gets a new message over its socket, rendered for it, instead of a signal and
// then a GET /updates for it (one request, ~140 ms at the edge, per open tab per message).
//
// The rule: a socket never carries anything GET /updates wouldn't return to the same viewer. So there is one path:
// - what an entry looks like: updateItem() below builds each entry of /updates' response, and the board's push builds
//   its entry with the same function, from the same inputs (registry.boardMembers, the board's creator, the viewer);
// - who may see it: the board Durable Object asks its entriesAfter() (the query snapshot() runs for /updates) whether
//   the entry is among those this viewer gets, and the socket's user must be in the board's members as D1 says at
//   post time (registry.boardMembers: not removed, not expired), which is what /updates' membership check reads.
// Anything this module isn't sure of falls back to the signal and the fetch: an encrypted board, a sealed post,
// People only and Just mine, unsends, edits, purges, anything that resolves or supersedes, types other than note and
// question, a socket that isn't a signed-in person's web tab, a lease that ran out, or a rendering over the size cap.
import { agentNames, entryHtml, logRow, withAgentNames } from "./html";
import { LANG_NAMES, type Lang } from "./i18n";
import { displayMap } from "./names";
import type { Entry } from "./types";

/** One entry as GET /updates returns it (and as a live push carries it). */
export interface UpdateItem {
  seq: number;
  author: string;
  agent_name?: string;
  root: number;
  retracts: number | null;
  html: string;
  row: string;
  reactions: unknown[];
  reviews?: unknown[];
  claim?: unknown;
  human_decision?: unknown;
}

/** The board's members as registry.boardMembers gives them (only what rendering and the member check read). */
export interface LiveMember {
  user: string;
  display_name?: string | null;
  agent_name?: string | null;
}

/** What every viewer's rendering shares: from the members list, once per update or push. */
export interface RenderShared {
  boardId: string;
  creator: string | null;
  names: Record<string, string>;
  members: ReadonlySet<string>;
  people: Record<string, string>;
}

/** Who it is rendered for (null: no viewer, as /updates with an operator key). */
export interface RenderFor {
  name: string;
  person: boolean;
  lang?: Lang;
}

export function renderShared(boardId: string, creator: string | null, members: LiveMember[]): RenderShared {
  return { boardId, creator, names: agentNames(members), members: new Set(members.map((m) => m.user)), people: displayMap(members) };
}

/** One entry of GET /updates, for this viewer. The live push calls this too: the two can't render differently. */
export function updateItem(e: Entry, s: RenderShared, viewer: RenderFor | null, extra: { root: number; reactions: unknown[]; reviews?: unknown[]; claim?: unknown }): UpdateItem {
  const canRetract = !!viewer && (e.author === viewer.name || s.creator === viewer.name);
  return {
    seq: e.seq,
    author: e.author, // their "… is typing" ends when their message arrives
    ...(e.via === "agent" && s.names[e.author] ? { agent_name: s.names[e.author] } : {}), // "Jarvis · vedu's agent"
    root: extra.root,
    retracts: e.retracts,
    html: entryHtml(withAgentNames(e, s.names), s.boardId, true, { canRetract, canEdit: !!viewer && e.author === viewer.name, lang: viewer?.lang, members: s.members, people: s.people, person: !!viewer && viewer.person }),
    row: logRow(e, undefined, undefined, viewer?.lang),
    reactions: extra.reactions,
    ...(e.type === "change" ? { reviews: extra.reviews ?? [] } : {}),
    ...(extra.claim ? { claim: extra.claim } : {}),
    ...(e.human_decision ? { human_decision: e.human_decision } : {}),
  };
}

/** A push frame over this many bytes goes as the plain signal (the tab fetches it, as before). */
export const PUSH_MAX_BYTES = 48 * 1024;
/** How long the board waits for its members (D1) before giving web tabs the plain signal instead. */
export const PUSH_MEMBERS_MS = 2000;
/** How long a socket's sign-in is trusted for pushes: after this, it gets signals (and is asked to reconnect, which
 *  checks the session or token again), so a signed-out or revoked session stops getting rendered entries. */
export const PUSH_LEASE_MS = 10 * 60_000;

/** A board tab's (or CLI watcher's) socket, as the board keeps it (serializeAttachment): whose, and whether it's the
 *  person themselves (not an agent's token). */
export interface TabAtt {
  user: string;
  person: boolean;
  session?: string; // the agent session a CLI socket belongs to (X-Atteo-Session), for atteo ping
  lang?: string; // the viewer's language, for rendering pushes
  push?: number; // a signed-in person's web tab (cookie): pushes until this time (PUSH_LEASE_MS after it connected)
}

/** The language a socket said, if it's one we have. */
export function langOf(v: string | null | undefined): Lang | undefined {
  return v && Object.prototype.hasOwnProperty.call(LANG_NAMES, v) ? (v as Lang) : undefined;
}

/**
 * May this new entry go out rendered at all? Only the plain cases: a note or question for everyone, on a board that
 * isn't encrypted. Everything else: the signal.
 */
export function pushEligible(e: Entry, o: { encrypted: boolean; sealed: boolean }): boolean {
  if (o.encrypted || o.sealed) return false;
  if (e.audience || (e.to_people?.length ?? 0) > 0) return false; // People only and Just mine: the signal, then /updates
  if (e.type !== "note" && e.type !== "question") return false;
  if (e.retracts != null || e.supersedes != null || e.resolves.length) return false;
  if (e.purged || e.edited_at || e.card || e.handoff || e.approval) return false;
  return true;
}

/**
 * What one socket gets for an entry (before the board's own visibility check, which can only take a "push" away):
 * - "skip": nothing (its user isn't a member now: removed, or their access expired);
 * - "signal": today's signal (agents' sockets, the app, old tabs, an entry that can't be pushed);
 * - "renew": the signal, and the tab is asked to reconnect (its push lease ran out);
 * - "push": the rendered entry, if the board says this viewer gets it.
 * `members`: who is on the board per D1, read for this post; null when it couldn't be read (no member check, and
 * nothing is pushed: today's signal).
 */
export function socketPlan(att: TabAtt | null, tagUser: string | undefined, members: ReadonlySet<string> | null, pushable: boolean, now: number): "skip" | "signal" | "renew" | "push" {
  const user = att?.user ?? tagUser ?? "";
  if (members && !members.has(user)) return "skip";
  if (!pushable || !att || !att.person || !att.push) return "signal";
  return att.push > now ? "push" : "renew";
}
