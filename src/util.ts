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
