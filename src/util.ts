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

/** A request to this machine (wrangler dev, tests): its links must keep pointing at itself. */
export function isLocalHost(hostname: string): boolean {
  return /^(localhost|.+\.localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1?\])$/i.test(hostname);
}

/**
 * The request clock. Local e2e may supply an absolute epoch-millisecond value so long retention windows can be tested
 * without changing stored data. Both the env opt-in and localhost check are required, so deployments always use real time.
 */
export function requestNow(env: { DEV_FAKE_CLOCK?: string }, request: Request): number {
  if (env.DEV_FAKE_CLOCK === "1" && isLocalHost(new URL(request.url).hostname)) {
    const raw = request.headers.get("x-dev-now");
    if (raw && /^\d+$/.test(raw)) {
      const value = Number(raw);
      if (Number.isSafeInteger(value)) return value;
    }
  }
  return Date.now();
}

/**
 * The address people and agents should use: PUBLIC_URL (https://atteo.dev) when it's set, else the request's own origin.
 * atteo.dev is a proxy in front of the workers.dev host, so inside the Worker every request looks like workers.dev and
 * url.origin can't be trusted for anything that points back at the product (sign-in callback, emails, OAuth metadata,
 * install script…). Local requests keep their own origin so dev and tests never send anyone to production.
 */
export function publicOrigin(env: { PUBLIC_URL?: string }, url: URL): string {
  const pub = env.PUBLIC_URL?.trim().replace(/\/+$/, "");
  return pub && !isLocalHost(url.hostname) ? pub : url.origin;
}

/** Paths the old workers.dev host must keep serving itself: JSON/POST clients (app, CLIs, MCP), auth, health and status checks, downloads. */
const STAYS_ON_WORKERS_DEV =
  /^\/(api|mcp|\.well-known|oauth|health|status|upload|files|cli|a2a|stripe|github|avatar|demo-avatar|favicon|apple-touch-icon)(?:[/.-]|$)|^\/(auth\/callback|install\.sh|ws|openapi\.json|skill\.md|__webhook-sink)$/;

/**
 * Where an old workers.dev link should be sent (301 target), or null to serve the request normally.
 * Only browser page navigations (GET/HEAD, Accept: text/html or Sec-Fetch-Mode: navigate) on a *.workers.dev host move.
 * The cf-worker check is the loop guard: atteo.dev is a separate Worker that fetch()es this workers.dev host, and
 * Cloudflare stamps every Worker subrequest with a CF-Worker header, so the proxy's requests (which look like browser
 * navigations, headers and all) are never redirected back to atteo.dev. Everything that isn't a page (API, MCP, OAuth,
 * health, downloads, WebSockets) stays on workers.dev because a redirect would break POSTs and auth.
 */
export function legacyHostRedirect(env: { PUBLIC_URL?: string }, request: Request, url: URL): string | null {
  const pub = env.PUBLIC_URL?.trim().replace(/\/+$/, "");
  if (!pub || !/\.workers\.dev$/i.test(url.hostname)) return null;
  let pubHost: string;
  try {
    pubHost = new URL(pub).hostname;
  } catch {
    return null;
  }
  if (pubHost === url.hostname ||/\.workers\.dev$/i.test(pubHost)) return null;
  if (request.headers.has("cf-worker") || request.headers.has("upgrade")) return null;
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const wantsPage = (request.headers.get("accept") ?? "").toLowerCase().includes("text/html") || request.headers.get("sec-fetch-mode") === "navigate";
  if (!wantsPage) return null;
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (STAYS_ON_WORKERS_DEV.test(path)) return null;
  return pub + url.pathname + url.search;
}

/**
 * Claude Code command for a personal token. Default: once per machine (user scope, no board; each session joins a board by name).
 * With a board: a project-scoped install that pins every session in that folder to the board.
 */
/** An Atteo request header (x-atteo-<name>), or its name from before the rename (x-agent-soup-<name>), which older CLIs still send. */
export function atteoHeader(request: Request, name: "session" | "watch" | "model"): string | null {
  return request.headers.get(`x-atteo-${name}`) ?? request.headers.get(`x-agent-soup-${name}`);
}

export function connectCommand(origin: string, boardId: string | null, token: string): string {
  return boardId
    ? `claude mcp add --scope project --transport http atteo "${origin}/mcp?board=${boardId}" --header "Authorization: Bearer ${token}"`
    : `claude mcp add --scope user --transport http atteo "${origin}/mcp" --header "Authorization: Bearer ${token}"`;
}

/**
 * Hidden formatting removed before a person or an agent reads a name or message.
 * Explicit bidi controls: embeddings (U+202A–U+202B), overrides (U+202D–U+202E), isolates (U+2066–U+2068) and their
 * pops (U+202C, U+2069). An override draws the characters after it backwards, and the rest of the set can reorder the
 * text around it, including someone else's name.
 * Zero-width space (U+200B), word joiner (U+2060), and BOM (U+FEFF) can split a word without showing.
 * ZWJ (U+200D) and ZWNJ (U+200C) are not in this set: ZWJ builds emoji, and ZWNJ is required for Persian, Hindi, and
 * Bengali. Marks (LRM U+200E, RLM U+200F, ALM U+061C) stay too: Arabic uses them to place a Latin word, and they do
 * not reverse letters.
 */
export const HIDDEN_FORMAT = /[\u202A-\u202E\u2066-\u2069\u200B\u2060\uFEFF]/g;

/** Drops bidi controls and zero-width characters that are not ZWJ or ZWNJ. The stored text is left as written. */
export function stripBidiControls(s: string): string {
  return s.replace(HIDDEN_FORMAT, "");
}

// Names (display names, agent names, board titles, OAuth client names) are stricter than messages: a name is short and
// never needs hidden formatting, so everything invisible goes, stored that way. Controls; soft hyphen, CGJ, ALM and
// the Hangul and Khmer fillers; Mongolian selectors; zero-width characters and LRM/RLM (U+200B–U+200F); bidi
// embeddings, overrides and isolates (U+202A–U+202E, U+2066–U+2069) and the rest of U+2060–U+206F; braille blank;
// interlinear annotation (U+FFF9–U+FFFB); musical format characters; tag characters (U+E0000–U+E007F, which can carry
// hidden ASCII text); variation selectors. `NAME_GLUE` (ZWJ, VS15, VS16) is kept only where emoji may appear.
const NAME_GLUE = "\\u200D\\uFE0E\\uFE0F";
const NAME_INVISIBLE_SRC =
  "\\u0000-\\u001F\\u007F-\\u009F\\u00AD\\u034F\\u061C\\u115F\\u1160\\u17B4\\u17B5\\u180B-\\u180F\\u200B\\u200C\\u200E\\u200F\\u202A-\\u202E\\u2060-\\u206F" +
  "\\u2800\\u3164\\uFE00-\\uFE0D\\uFEFF\\uFFA0\\uFFF9-\\uFFFB\\u{1D173}-\\u{1D17A}\\u{E0000}-\\u{E007F}\\u{E0100}-\\u{E01EF}";
const NAME_INVISIBLE = new RegExp(`[${NAME_INVISIBLE_SRC}${NAME_GLUE}]`, "gu");
const NAME_INVISIBLE_KEEP_EMOJI = new RegExp(`[${NAME_INVISIBLE_SRC}]`, "gu");

/** A name without invisible or direction-changing characters (see above). `emoji`: keep ZWJ and VS15/VS16, so 👩‍💻 and
 *  ❤️ in a board title stay whole. */
export function stripInvisible(s: string, o: { emoji?: boolean } = {}): string {
  return s.replace(o.emoji ? NAME_INVISIBLE_KEEP_EMOJI : NAME_INVISIBLE, "");
}

/** A board's title as stored: invisible characters gone (emoji kept whole), one line, trimmed; "" when nothing's left. */
export function cleanBoardTitle(s: string): string {
  return stripInvisible(s.replace(/\s+/g, " "), { emoji: true }).replace(/\s+/g, " ").trim();
}

/**
 * The copy `screenText` and the model screen read. Bidi controls are gone, and every ZWJ and ZWNJ is gone, so none
 * of them can hide a phrase. What people see is unchanged: this string is not rendered.
 */
export function normalizeForScreen(s: string): string {
  return stripBidiControls(s).replace(/[\u200C\u200D]/g, "");
}

const emojiGlue = (ch: string | undefined) => !!ch && (ch === "\uFE0F" || ch === "\uFE0E" || /\p{Emoji_Modifier}/u.test(ch));
const emojiBase = (ch: string | undefined) => !!ch && /\p{Extended_Pictographic}/u.test(ch);
const letter = (ch: string | undefined) => !!ch && /\p{L}/u.test(ch);

/** Agent prose. A ZWJ stays when it sits between emoji (a variation selector or skin tone may sit beside it). A ZWNJ
 *  stays when it sits between letters, as in Persian. Any other ZWJ or ZWNJ is dropped. */
export function proseForAgent(s: string): string {
  const chars = [...stripBidiControls(s)];
  const besideEmoji = (i: number, dir: 1 | -1) => {
    for (let j = i + dir; j >= 0 && j < chars.length; j += dir) {
      if (emojiGlue(chars[j])) continue;
      return emojiBase(chars[j]);
    }
    return false;
  };
  return chars.filter((ch, i) => {
    if (ch === "\u200D") return besideEmoji(i, -1) && besideEmoji(i, 1);
    if (ch === "\u200C") return letter(chars[i - 1]) && letter(chars[i + 1]);
    return true;
  }).join("");
}

export function esc(s: unknown): string {
  return stripBidiControls(String(s ?? "")).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** An id for a heading, from its text: "No abuse, no objectionable content" → "no-abuse-no-objectionable-content". */
export function slug(text: string): string {
  return text.replace(/<[^>]*>/g, "").toLowerCase().replace(/&[a-z]+;/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
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

/**
 * The seq for an inbox item that isn't about a board entry (friend requests, approvals). Those share board_id '' and
 * notifications are unique on (user, board_id, seq), so this must never repeat: a random negative 52-bit number.
 * (Time-based values collided: a friend request and an approval a few ms apart silently dropped the approval.)
 */
/** A board picture's address (members only; ?v= is its version, for caching), or null when the board has none. */
export function pictureUrl(boardId: string, v: number | null | undefined): string | null {
  return v ? `/board-picture/${boardId}?v=${v}` : null;
}

export function offBoardSeq(): number {
  const [hi, lo] = crypto.getRandomValues(new Uint32Array(2));
  return -((hi & 0xfffff) * 2 ** 32 + lo) - 1;
}
