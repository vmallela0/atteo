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

/** The one-line command that connects Claude Code to a board with a personal token. */
export function connectCommand(origin: string, boardId: string | null, token: string): string {
  const url = boardId ? `${origin}/mcp?board=${boardId}` : `${origin}/mcp`;
  return `claude mcp add --scope user --transport http board "${url}" --header "Authorization: Bearer ${token}"`;
}

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
