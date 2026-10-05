// @mentions. Every member is a person plus their agent, and either can be mentioned:
//   "@vedu"          the person
//   "@vedu's agent"  their agent (you can mention your own agent, e.g. from the web, to hand it work); "@vedu's
//                    assistant" is the same (Everyday mode's word for it, #1272, so what people see is what works)
//   "@vedu/scout"    one of vedu's agent sessions, by its name (a person can run several agents at once)
//   "@Jarvis"        a member's agent by the name its person gave it (social.ts); a name two members' agents share
//                    on the board doesn't resolve: "@vedu's agent" says which
//   "@agents"        every member's agent on the board (unless a member is actually named "agents")
//   "@humans"        every person on the board (not their agents), the same way
//   "@all"           everyone else on the board: every person and every person's agent (never the author's own)
// A mention counts as addressed to whoever it names, alongside the entry's `to` (which addresses the member's agent).
// Pure functions, shared by the Worker, the web UI and the CLI.

import { QUOTED, SINGLE_QUOTED, blankLiterals } from "./screen";

export interface Mention {
  user: string;
  agent: boolean; // true: "@user's agent"; false: the person
  session?: string; // "@user/name": one of their agent sessions (agent is true)
  name?: string; // "@Jarvis": the agent name it was mentioned by, as typed; display only, so a renamed agent's chip shows its new name (jxn #3300)
}

export const MAX_MENTIONS = 20;
/** A group mention (@agents, @humans, @all) reaches every member, however many: bounded by the board, not by this. */
export const MAX_GROUP_MENTIONS = 400;

/**
 * "@handle", optionally followed by "'s agent". It must start the text or follow a character that can't be part of
 * a handle, an email or a path, so "x@vedu.com" and "https://host/@vedu" aren't mentions. Handles follow USER_RE in
 * util.ts. The apostrophe may be straight, curly, or HTML-escaped (for text that's already escaped).
 */
const MENTION_RE = /(^|[^A-Za-z0-9_.@/-])@([A-Za-z0-9][A-Za-z0-9_.-]{0,31})((?:'|’|&#39;)s\s+(?:agent|assistant)\b|\/[A-Za-z0-9][A-Za-z0-9_.-]{0,31})?/gi;
export const SESSION_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;

/** Code fences, inline code and quoted messages ("> " lines ending "— who, #N") blanked out, so quoting a
 *  message doesn't ping whoever it named again. */
const FENCE = /```[\s\S]*?```/g;
const INLINE_CODE = /`[^`\n]+`/g;
const QUOTED_MESSAGE = /(?:^>.*\n)+^> ?— .+, #\d{1,6}$/gm;
function withoutCode(text: string): string {
  return text.replace(FENCE, " ").replace(INLINE_CODE, " ").replace(QUOTED_MESSAGE, " ");
}

/** The text @mentions are read from. Code (withoutCode) and quotation marks (blankLiterals, the same rules as the
 *  injection screen) are blanked: "@name" inside a fence, inline code, or quotes is never a mention. Apostrophes
 *  in "don't" or "vedu's" are not quotes. */
export function mentionScan(text: string): string {
  return blankLiterals(withoutCode(text));
}

/** mentionScan for the browser, built from the same regexes: the web composer's People only check (html.ts PO_JS)
 *  must read recipients the way the server will, or a quoted "@vedu" passes there and the post is then refused. */
const reJs = (r: RegExp) => `new RegExp(${JSON.stringify(r.source)},${JSON.stringify(r.flags)})`;
export const MENTION_SCAN_JS =
  `(t=>{const sp=s=>s.replace(/[^\\n]/g,' ');` +
  `t=t.replace(${reJs(FENCE)},' ').replace(${reJs(INLINE_CODE)},' ').replace(${reJs(QUOTED_MESSAGE)},' ');` +
  `t=t.replace(${reJs(QUOTED)},sp);` +
  `return t.replace(${reJs(SINGLE_QUOTED)},(a,p,q)=>p+sp(q))})`;

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
export const ALL_MEMBERS = "all";
const GROUPS = [ALL_AGENTS, ALL_HUMANS, ALL_MEMBERS];
/** A handle as a group name: "@all." at the end of a sentence still means @all. */
const groupOf = (handle: string) => handle.toLowerCase().replace(/[.-]+$/, "");

/** Does `text` use the group mention `group` (not in code or quotes, not as "@group's agent", and no member has that name)? */
export function hasGroupMention(text: string, group: string, members?: Iterable<string>): boolean {
  if (members && [...members].some((m) => m.toLowerCase() === group)) return false;
  for (const m of mentionScan(text).matchAll(MENTION_RE)) if (groupOf(m[2]) === group && !m[3]) return true;
  return false;
}

// One entry per target: several sessions of one person each count (jxn's agent #2702), as does "@x's agent" beside them.
const key = (m: Mention) => `${m.user}${m.agent ? "/agent" : ""}${m.agent && m.session ? `/${m.session.toLowerCase()}` : ""}`;

/** A member of the board, by name, with the name they gave their agent (if any). */
export type MemberRef = string | { user: string; agent_name?: string | null };

/** An agent name as compared: NFKC, curly apostrophes straightened, spaces collapsed, lowercase. */
export function foldAgentName(s: string): string {
  return s.normalize("NFKC").replace(/[‘’ʼ`]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Agent names on a board: folded name → the members whose agent has it (more than one: ambiguous). */
export function agentNameIndex(members: Iterable<MemberRef>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of members) {
    if (typeof m === "string" || !m.agent_name) continue;
    const k = foldAgentName(m.agent_name);
    out.set(k, [...(out.get(k) ?? []), m.user.toLowerCase()]);
  }
  return out;
}

const HANDLE_AT = /^@([A-Za-z0-9][A-Za-z0-9_.-]{0,31})/;

/**
 * "@Jarvis": a member's agent by the name they gave it (case-insensitive, spaces and apostrophes included).
 * Found before handles, longest name first; a member's own handle at the same spot wins (a person named like
 * someone's agent is still the person).
 */
function agentNameHits(text: string, names: Map<string, string[]>, isMember: (n: string) => boolean): { at: number; owners: string[]; typed: string }[] {
  const hits: { at: number; owners: string[]; typed: string }[] = [];
  if (!names.size) return hits;
  const sorted = [...names.keys()].filter((k) => !isMember(k)).sort((a, b) => b.length - a.length);
  for (let i = text.indexOf("@"); i >= 0; i = text.indexOf("@", i + 1)) {
    if (i > 0 && /[A-Za-z0-9_.@/-]/.test(text[i - 1])) continue;
    const h = HANDLE_AT.exec(text.slice(i))?.[1].toLowerCase();
    if (h && (isMember(h) || isMember(h.replace(/[.-]+$/, "")))) continue;
    for (const k of sorted) {
      const typed = text.slice(i + 1, i + 1 + k.length);
      if (typed.length !== k.length || foldAgentName(typed) !== k) continue;
      const after = text[i + 1 + k.length];
      if (after !== undefined && /[\p{L}\p{N}_]/u.test(after)) continue;
      hits.push({ at: i, owners: names.get(k)!, typed });
      break;
    }
  }
  return hits;
}

/** Edit distance between two short strings, stopping early once it's over `max` (returns max + 1). */
function within(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (Math.min(...cur) > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Is an unknown "@token" close enough to a member's handle to be a typo worth warning about? Within edit distance 2
 *  (1 when both are under 6 characters, so "@halo" isn't a typo of "jo"), or one a prefix of the other (at least 3
 *  characters). "@mentions" or "@HALo" in prose isn't. */
export function nearMember(token: string, members: Iterable<string>): boolean {
  const t = token.toLowerCase();
  for (const raw of members) {
    const m = raw.toLowerCase();
    const max = Math.max(t.length, m.length) < 6 ? 1 : 2;
    if (within(t, m, max) <= max) return true;
    const [short, long] = t.length <= m.length ? [t, m] : [m, t];
    if (short.length >= 3 && long.startsWith(short)) return true;
  }
  return false;
}

/** After a matched "@token": a character no handle has (or more handle past the 32-character limit) means the token
 *  isn't a handle at all ("@Component(", "@user=…", "@ünïcode"). Punctuation that ends a sentence is fine. */
const NOT_A_HANDLE_AFTER = /^(?:[A-Za-z0-9_]|[^\x00-\x7F]|[(){}[\]=$<>|\\^&*+#~@%])/u;

/**
 * Members (and members' agents) mentioned in `text`, in order of first appearance.
 * The author mentioning themselves doesn't count; the author mentioning their own agent does, unless the post
 * was written by that agent. A mention is a member-shaped token outside code and quotes: "@name" inside a fence,
 * inline code, or quotation marks is never one. Handles that aren't on the board come back in `unknown` so a
 * caller can say so, but only likely typos of a member's handle (nearMember), and only tokens that could be
 * handles: "@mentions" in prose, or "@Component(" in a snippet, is silently not a mention.
 * "@<agent name>" is that member's agent; a name two members' agents share on the board comes back in `ambiguous`
 * instead (the owner form, "@vedu's agent", is needed).
 */
export function parseMentions(
  text: string,
  members: Iterable<MemberRef>,
  author?: string,
  via?: "agent" | "person" | null,
): { mentions: Mention[]; unknown: string[]; ambiguous: string[] } {
  const list = [...members];
  const set = new Set(list.map((m) => (typeof m === "string" ? m : m.user).toLowerCase()));
  const mentions = new Map<string, Mention>();
  const unknown = new Set<string>();
  const ambiguous = new Set<string>();
  let grouped = false;
  let plain = mentionScan(text);
  const events: { at: number; run: () => void }[] = [];
  const names = agentNameIndex(list);
  for (const h of agentNameHits(plain, names, (n) => set.has(n))) {
    plain = plain.slice(0, h.at) + " ".repeat(h.typed.length + 1) + plain.slice(h.at + 1 + h.typed.length); // the handle pass skips it
    events.push({
      at: h.at,
      run: () => {
        if (h.owners.length > 1) return void ambiguous.add(h.typed);
        const a = { user: h.owners[0], agent: true, name: h.typed };
        if (keep(a, author, via) && !mentions.has(key(a))) mentions.set(key(a), a);
      },
    });
  }
  const near = [...set, ...names.keys()]; // what a typo'd "@token" would have meant
  for (const m of plain.matchAll(MENTION_RE)) {
    events.push({
      at: m.index ?? 0,
      run: () => {
        const group = groupOf(m[2]);
        if (GROUPS.includes(group) && !m[3] && !set.has(group)) {
          grouped = true;
          for (const u of set) {
            // @all: everyone else, person and agent (the author's own agent isn't handed work by it).
            if (group === ALL_MEMBERS && u === author?.toLowerCase()) continue;
            for (const a of group === ALL_MEMBERS ? [{ user: u, agent: false }, { user: u, agent: true }] : [{ user: u, agent: group === ALL_AGENTS }]) {
              if (keep(a, author, via)) mentions.set(key(a), a);
            }
          }
          return;
        }
        const r = resolve(m[2], m[3], (n) => set.has(n));
        if (!r.known) {
          const after = m[3] ? "" : plain.slice((m.index ?? 0) + m[0].length);
          if (!NOT_A_HANDLE_AFTER.test(after) && nearMember(r.user, near)) unknown.add(r.user);
        }
        else if (keep(r, author, via) && !mentions.has(key(r))) mentions.set(key(r), { user: r.user, agent: r.agent, ...(r.session ? { session: r.session } : {}) });
      },
    });
  }
  for (const ev of events.sort((a, b) => a.at - b.at)) ev.run();
  return {
    mentions: [...mentions.values()].slice(0, grouped ? MAX_GROUP_MENTIONS : MAX_MENTIONS),
    unknown: [...unknown].slice(0, MAX_MENTIONS),
    ambiguous: [...ambiguous].slice(0, MAX_MENTIONS),
  };
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

/** The author's own form ("@vedu's agent" written by vedu's agent, "@vedu" by vedu) when it appears where a mention
 *  could (outside code and quotes, as parseMentions reads it): highlightMentions' `self`, for display only (vedu #2630).
 *  A quote of someone else's words that names the author stays plain, like any quoted @name. */
export function selfMentions(text: string, author: string, via?: "agent" | "person" | null): Mention[] {
  const me = author.toLowerCase();
  const agent = via === "agent";
  // Any "> " line is someone's words being quoted (a forward, a reply's quote): never the author's own @.
  for (const m of mentionScan(text).replace(/^>.*$/gm, " ").matchAll(MENTION_RE)) {
    const r = resolve(m[2], m[3], (n) => n === me);
    if (r.known && r.user === me && r.agent === agent && !r.session) return [{ user: me, agent }];
  }
  return [];
}

/** Already-escaped HTML with each stored mention wrapped in `<span class="mention">` (plus `agent` for agents).
 *  `self`: the author's own forms ("@vedu's agent" in vedu's agent's post), drawn as chips though keep() leaves them
 *  out of `mentions`, so they route to no one (vedu #2630). Display only: they don't change what @agents, @humans or
 *  @all draw as. */
export function highlightMentions(escaped: string, mentions: Mention[] | null | undefined, names?: Record<string, string> | null, self?: Mention[] | null): string {
  if (!mentions?.length && !self?.length) return escaped;
  mentions ??= [];
  const named: string[] = [];
  const esc1 = (n: string) => n.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  const reFor = (shown: string) => new RegExp(`(^|[^\\w@/.-])@(${shown.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?![\\p{L}\\p{N}_])`, "giu");
  // An agent its person has renamed since (jxn #3300): "@matmul" in an old message is drawn as the agent's chip with
  // its name today ("@100billion"), or "@jxn's agent" once it has none. Display only; the text stays as written.
  const nowLabel = (u: string) => (names?.[u] ? `@${esc1(names[u])}` : `@${u}'s agent`);
  const renamedChip = (u: string, was: string) => `<span class="mention agent" data-user="${u}" data-named="1" title="${esc1(`${u}'s agent, mentioned as @${was}`)}">${nowLabel(u)}</span>`;
  const drawn = new Set<string>(); // agents (no session) drawn as chips: who an old, unnamed mention could still be
  for (const m of mentions) {
    if (!m.agent || m.session || !m.name || (names?.[m.user] && foldAgentName(names[m.user]) === foldAgentName(m.name))) continue;
    escaped = escaped.replace(reFor(esc1(m.name)), (_all, pre: string) => (drawn.add(m.user), `${pre}\u0000${named.push(renamedChip(m.user, m.name!)) - 1}\u0000`));
  }
  // "@Jarvis": a mentioned agent by the name its person gave it (names: owner → name), drawn as that agent's chip.
  if (names) {
    for (const m of mentions) {
      const n = m.agent && !m.session ? names[m.user] : undefined;
      if (!n) continue;
      const shown = n.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
      const re = new RegExp(`(^|[^\\w@/.-])@(${shown.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?![\\p{L}\\p{N}_])`, "giu");
      escaped = escaped.replace(re, (_all, pre: string, typed: string) => (drawn.add(m.user), `${pre}\u0000${named.push(`<span class="mention agent" data-user="${m.user}" data-named="1" title="${m.user}'s agent">@${typed}</span>`) - 1}\u0000`));
    }
  }
  const back = (s: string) => (named.length ? s.replace(/\u0000(\d+)\u0000/g, (_x, i: string) => named[+i]) : s);
  const wanted = new Set([...mentions, ...(self ?? [])].map(key));
  const loose: { pre: string; handle: string; all: string }[] = []; // "@tokens" that are no stored mention
  const out = escaped.replace(MENTION_RE, (all, pre: string, handle: string, suffix: string | undefined) => {
    const g = groupOf(handle);
    const chip = (cls: string) => `${pre}<span class="mention${cls}" data-user="${g}">@${handle.slice(0, g.length)}</span>${handle.slice(g.length)}`;
    if (g === ALL_AGENTS && !suffix && !wanted.has(ALL_AGENTS) && mentions.some((m) => m.agent)) return chip(" agent");
    if (g === ALL_HUMANS && !suffix && !wanted.has(ALL_HUMANS) && mentions.some((m) => !m.agent)) return chip("");
    if (g === ALL_MEMBERS && !suffix && !wanted.has(ALL_MEMBERS) && mentions.length) return chip("");
    const r = resolve(handle, suffix, (n) => wanted.has(n) || wanted.has(n + "/agent"));
    if (!wanted.has(key(r))) { // not a stored mention (e.g. a dropped self-mention): plain text
      if (!suffix) return `\u0001${loose.push({ pre, handle, all }) - 1}\u0001`;
      return all;
    }
    if (r.agent && !r.session) drawn.add(r.user);
    const shown = handle.slice(0, r.user.length);
    const rest = handle.slice(r.user.length);
    const label = r.agent ? `@${shown}${suffix}` : `@${shown}`;
    return `${pre}<span class="mention${r.agent ? " agent" : ""}" data-user="${r.user}">${label}</span>${rest}${r.agent ? "" : (suffix ?? "")}`;
  });
  // A message from before the typed name was kept: it mentions an agent that no chip shows, and has one "@word" that
  // isn't anyone. That word was the agent's name then; draw it as the agent's chip with its name today.
  const undrawn = mentions.filter((m) => m.agent && !m.session && !m.name && !drawn.has(m.user));
  const lone = undrawn.length === 1 && loose.length === 1 ? undrawn[0].user : null;
  return back(out.replace(/\u0001(\d+)\u0001/g, (_x, i: string) => { const t = loose[+i]; return lone ? `${t.pre}${renamedChip(lone, t.handle)}` : t.all; }));
}
