// Small shared helpers.

export const USER_RE = /^[a-z0-9][a-z0-9_.-]{0,31}$/;
export const BOARD_RE = /^b_[a-z0-9]{8,32}$/;

/** Member names are lowercase handles: letters, digits, - _ . (max 32). */
export function normalizeUser(raw: string | null | undefined): string | null {
  const u = (raw ?? "").trim().toLowerCase();
  return USER_RE.test(u) ? u : null;
}

/** Unguessable board id: the link is the access in this trusted-beta version. */
export function newBoardId(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return "b_" + Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

/**
 * Claude Code command for a personal token. Default: once per machine (user scope, no board; each session joins a board by name).
 * With a board: a project-scoped install that pins every session in that folder to the board.
 */
export function connectCommand(origin: string, boardId: string | null, token: string): string {
  return boardId
    ? `claude mcp add --scope project --transport http board "${origin}/mcp?board=${boardId}" --header "Authorization: Bearer ${token}"`
    : `claude mcp add --scope user --transport http board "${origin}/mcp" --header "Authorization: Bearer ${token}"`;
}

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** One emoji (with skin tones, ZWJ sequences, flags) or a :shortcode: (custom names the web app renders). */
export const EMOJI_RE = /^(?:(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]\uFE0F?\u20E3)(?:\p{Emoji_Modifier}|\p{Regional_Indicator}|\uFE0F|\u200D\p{Extended_Pictographic})*|:[a-z0-9_+\-]{1,32}:)$/u;

/** Turns what a person or agent typed into a safe FTS5 query: every word required, last word as a prefix, "phrases" kept. */
export function ftsQuery(q: string): string | null {
  const terms: { text: string; phrase: boolean }[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q)) && terms.length < 12) {
    const words = (m[1] ?? m[2]).replace(/[^\p{L}\p{N}_]+/gu, " ").trim();
    if (!words) continue;
    if (m[1] != null) terms.push({ text: words, phrase: true });
    else for (const w of words.split(/\s+/)) terms.push({ text: w, phrase: false });
  }
  if (!terms.length) return null;
  // Prefix-match the last bare word so search-as-you-type works.
  return terms.map((t, i) => `"${t.text}"${!t.phrase && i === terms.length - 1 ? "*" : ""}`).join(" ");
}

/** Checks board details from the boards page: short description, up to 8 tags, one emoji, up to 5 https links. */
export function parseBoardMeta(raw: unknown): { description: string | null; tags: string[]; emoji: string | null; links: { label: string; url: string }[] } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const description = typeof r.description === "string" && r.description.trim() ? r.description.trim().slice(0, 280) : null;
  const tagList = Array.isArray(r.tags) ? r.tags : typeof r.tags === "string" ? r.tags.split(",") : [];
  const tags = [
    ...new Set(
      tagList
        .map((t) => String(t).trim().toLowerCase().replace(/^#/, "").replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, ""))
        .filter(Boolean)
        .map((t) => t.slice(0, 24)),
    ),
  ].slice(0, 8);
  const e = typeof r.emoji === "string" ? r.emoji.trim() : "";
  if (e && !EMOJI_RE.test(e)) throw new Error("The board's emoji must be a single emoji.");
  const linkList = Array.isArray(r.links) ? r.links : [];
  const links = linkList.slice(0, 5).map((l) => {
    const o = (l && typeof l === "object" ? l : {}) as Record<string, unknown>;
    const url = String(o.url ?? "").trim();
    if (!/^https:\/\/[^\s<>"]+$/.test(url) || url.length > 500) throw new Error("Links must be https:// addresses.");
    const label = String(o.label ?? "").trim().slice(0, 40) || new URL(url).hostname;
    return { label, url };
  });
  return { description, tags, emoji: e || null, links };
}

/** A post's title: one line, at most 8 words / 60 characters; empty → null. */
export function cleanTitle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const words = raw.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().split(" ").filter(Boolean).slice(0, 8).join(" ");
  const t = words.length > 60 ? words.slice(0, 59).replace(/\s+\S*$/, "") + "…" : words;
  return t || null;
}
