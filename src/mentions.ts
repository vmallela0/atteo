// @mentions. Every member is a person plus their agent, and either can be mentioned:
//   "@vedu"          the person
//   "@vedu's agent"  their agent (you can mention your own agent, e.g. from the web, to hand it work)
//   "@vedu/scout"    one of vedu's agent sessions, by its name (a person can run several agents at once)
//   "@agents"        every member's agent on the board (unless a member is actually named "agents")
//   "@humans"        every person on the board (not their agents), the same way
// A mention counts as addressed to whoever it names, alongside the entry's `to` (which addresses the member's agent).
// Pure functions, shared by the Worker, the web UI and the CLI.

export interface Mention {
  user: string;
  agent: boolean; // true: "@user's agent"; false: the person
  session?: string; // "@user/name": one of their agent sessions (agent is true)
}

export const MAX_MENTIONS = 20;

/**
 * "@handle", optionally followed by "'s agent". It must start the text or follow a character that can't be part of
 * a handle, an email or a path, so "x@vedu.com" and "https://host/@vedu" aren't mentions. Handles follow USER_RE in
 * util.ts. The apostrophe may be straight, curly, or HTML-escaped (for text that's already escaped).
 */
const MENTION_RE = /(^|[^A-Za-z0-9_.@/-])@([A-Za-z0-9][A-Za-z0-9_.-]{0,31})((?:'|’|&#39;)s\s+agent\b|\/[A-Za-z0-9][A-Za-z0-9_.-]{0,31})?/gi;
export const SESSION_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;

/** Text with code fences and inline code blanked out: "@name" inside code is never a mention. */
function withoutCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]+`/g, " ");
}

/**
 * The member a matched handle refers to. A trailing "." or "-" is dropped unless the full handle is a member,
 * so "thanks @vedu." mentions vedu but "@j.doe" still means j.doe. "'s agent" only counts right after the handle.
 */
function resolve(handle: string, suffix: string | undefined, isMember: (name: string) => boolean): Mention & { known: boolean } {
  const raw = handle.toLowerCase();
  const trimmed = raw.replace(/[.-]+$/, "");
  const user = isMember(raw) || !trimmed ? raw : trimmed;
  const session = suffix?.startsWith("/") && user === raw ? suffix.slice(1).toLowerCase().replace(/[.-]+$/, "") : undefined;
  return { user, agent: !!suffix && user === raw, ...(session ? { session } : {}), known: isMember(user) };
}

export const ALL_AGENTS = "agents";
export const ALL_HUMANS = "humans";

const key = (m: Mention) => `${m.user}${m.agent ? "/agent" : ""}`;

/**
 * Members (and members' agents) mentioned in `text`, in order of first appearance.
 * The author mentioning themselves doesn't count; the author mentioning their own agent does, unless the post
 * was written by that agent. Handles that aren't on the board come back in `unknown` so a caller can say so.
 */
export function parseMentions(
  text: string,
  members: Iterable<string>,
  author?: string,
  via?: "agent" | "person" | null,
): { mentions: Mention[]; unknown: string[] } {
  const set = new Set([...members].map((m) => m.toLowerCase()));
  const mentions = new Map<string, Mention>();
  const unknown = new Set<string>();
  for (const m of withoutCode(text).matchAll(MENTION_RE)) {
    const group = m[2].toLowerCase();
    if ((group === ALL_AGENTS || group === ALL_HUMANS) && !m[3] && !set.has(group)) {
      for (const u of set) {
        const a = { user: u, agent: group === ALL_AGENTS };
        if (keep(a, author, via)) mentions.set(key(a), a);
      }
      continue;
    }
    const r = resolve(m[2], m[3], (n) => set.has(n));
    if (!r.known) unknown.add(r.user);
    else if (keep(r, author, via)) mentions.set(key(r), { user: r.user, agent: r.agent, ...(r.session ? { session: r.session } : {}) });
  }
  return { mentions: [...mentions.values()].slice(0, MAX_MENTIONS), unknown: [...unknown].slice(0, MAX_MENTIONS) };
}

/** Self-mentions: only a person handing work to their own agent is meaningful. */
export function keep(m: Mention, author?: string, via?: "agent" | "person" | null): boolean {
  if (m.user !== author || m.session) return true; // one of your own sessions handing work to another counts
  // Your own name only counts across the person/agent line: you hand your agent work ("@me's agent"),
  // or your agent gets your attention ("@me").
  return via === "agent" ? !m.agent : m.agent;
}

/** Quick check before looking up members: could the text mention anyone? */
export function mayMention(text: string): boolean {
  return text.includes("@");
}

type Addressable = { to: string | null; mentions?: Mention[] | null };

/** Addressed to `user`'s agent: `to` names them, or the text mentions "@user's agent". */
export function forAgent(e: Addressable, user: string): boolean {
  return e.to === user || !!e.mentions?.some((m) => m.user === user && m.agent);
}

/** The text mentions `user` the person ("@user"). */
export function forPerson(e: Addressable, user: string): boolean {
  return !!e.mentions?.some((m) => m.user === user && !m.agent);
}

/** A person mentioned their own agent: their agent should see the post as new, though they wrote it. */
export function mentionsOwnAgent(e: { author: string; mentions?: Mention[] | null }): boolean {
  return !!e.mentions?.some((m) => m.user === e.author && m.agent);
}

/** "@vedu", "@vedu's agent"; for the viewer's own: "your user" / "you" (agents) or "you" / "your agent" (people). */
export function mentionLabel(m: Mention, viewer?: string, viewerIs: "agent" | "person" = "agent"): string {
  if (m.user === viewer && m.session) return viewerIs === "agent" ? `your session "${m.session}"` : `your agent ${m.session}`;
  if (m.user === viewer) return viewerIs === "agent" ? (m.agent ? "you" : "your user") : m.agent ? "your agent" : "you";
  return m.session ? `@${m.user}/${m.session}` : m.agent ? `@${m.user}'s agent` : `@${m.user}`;
}

/** Already-escaped HTML with each stored mention wrapped in `<span class="mention">` (plus `agent` for agents). */
export function highlightMentions(escaped: string, mentions: Mention[] | null | undefined): string {
  if (!mentions?.length) return escaped;
  const wanted = new Set(mentions.map(key));
  return escaped.replace(MENTION_RE, (all, pre: string, handle: string, suffix: string | undefined) => {
    if (handle.toLowerCase() === ALL_AGENTS && !suffix && !wanted.has(ALL_AGENTS) && mentions.some((m) => m.agent)) {
      return `${pre}<span class="mention agent" data-user="${ALL_AGENTS}">@${handle}</span>`;
    }
    if (handle.toLowerCase() === ALL_HUMANS && !suffix && !wanted.has(ALL_HUMANS) && mentions.some((m) => !m.agent)) {
      return `${pre}<span class="mention" data-user="${ALL_HUMANS}">@${handle}</span>`;
    }
    const r = resolve(handle, suffix, (n) => wanted.has(n) || wanted.has(n + "/agent"));
    if (!wanted.has(key(r))) return all; // not a stored mention (e.g. a dropped self-mention): plain text
    const shown = handle.slice(0, r.user.length);
    const rest = handle.slice(r.user.length);
    const label = r.agent ? `@${shown}${suffix}` : `@${shown}`;
    return `${pre}<span class="mention${r.agent ? " agent" : ""}" data-user="${r.user}">${label}</span>${rest}${r.agent ? "" : (suffix ?? "")}`;
  });
}
