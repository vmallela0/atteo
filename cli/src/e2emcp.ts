// End-to-end encrypted boards through `atteo mcp` (E2E design §5 (L), Phase 1c). A local MCP agent (Claude Code, Codex,
// Cursor's local MCP, Claude Desktop) reads and posts on an encrypted board the way `atteo read` / `atteo post` do:
// decrypted and encrypted on this machine, so the server only ever relays ciphertext. Plain boards are untouched: their
// calls go to the server as before.
//
// Which board a call is about: the one named in its arguments, else the one this connection joined (join_board /
// create_board, which the proxy watches). A post is never sent to the server first to find out, since that would hand it
// the plaintext: when the board isn't known and the person has any encrypted board, the post is refused here instead.

import { api, cursors, encEntries, encLine, encPost, isEncrypted, saveCursor, SEALED_PAGE } from "./commands";
import { fence } from "../../src/screen";

type Opt = Record<string, string | true>;
type Args = Record<string, unknown>;

/** Entry types the sealed route takes; anything else is posted as a note (a sealed entry has no handoff or card). */
const SEALED_TYPES = new Set(["note", "question", "claim", "decision", "task"]);
/** Arguments that would be stored in plain text, so an encrypted board can't take them. */
/** The tools atteo mcp lets through on an encrypted board (review #5525); the rest are refused locally. */
const ENC_ALLOWED = new Set(["read", "get", "post", "wait", "react", "retract", "agents", "people", "session", "join_board", "leave_board", "list_boards"]);
const PLAIN_ONLY = ["artifact_content", "artifact_name", "data", "handoff", "card", "own", "resolves", "supersedes", "depends_on"];

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined);

export const ENC_HEADER = "🔒 END-TO-END ENCRYPTED, decrypted on this machine by atteo mcp; the server only has ciphertext";

export class EncryptedTools {
  /** The board this MCP connection joined (the server keeps one per connection). */
  joined: string | null = null;

  constructor(private opt: Opt) {}

  /** The board a call is about, when it's known here. */
  boardOf(args: Args): string | null {
    return str(args.board) ?? this.joined;
  }

  /** Whether the person is on any encrypted board at all (then an unknown board is never guessed at for a post). */
  private async anyEncrypted(): Promise<boolean> {
    const j = await api(this.opt, "GET", "/api/me/boards");
    return (j.boards as { encrypted?: boolean }[]).some((b) => !!b.encrypted);
  }

  /**
   * Handles a tool call here when it's for an encrypted board. Returns the tool's text, or null to send the call to the
   * server as usual. Throws an Error whose message is the tool error to show.
   */
  async handle(name: string, args: Args): Promise<string | null> {
    if (!["read", "get", "post", "wait"].includes(name)) {
      // Everything else on an encrypted board is refused here, before anything is sent (review #5525): the server's own
      // tools would read or write plain text there (tasks, docs, search, claims, publish…). Only these are safe.
      const board = this.boardOf(args);
      if (ENC_ALLOWED.has(name) || name === "create_board") return null; // create_board: a new board, nothing of an old one
      if (board && (await isEncrypted(this.opt, board)))
        throw new Error(`${name} isn't available on an end-to-end encrypted board here: the server would see it in plain text. On this board, use read, get, post, wait, react or retract.`);
      // No board known here: the server would pick one, maybe an encrypted one, so refuse as post does (review #5559).
      if (!board && (await this.anyEncrypted()))
        throw new Error(`Join the board first (join_board) or name it (board): ${name} isn't available on an end-to-end encrypted board, and with none named here it could land on one.`);
      return null;
    }
    const board = this.boardOf(args);
    if (!board) {
      if (name === "post" && (await this.anyEncrypted()))
        throw new Error("Join the board first (join_board) or name it (board), so a message for an end-to-end encrypted board is encrypted on this machine before it's sent.");
      return null;
    }
    if (!(await isEncrypted(this.opt, board))) return null;
    if (name === "read") return this.read(board, args);
    if (name === "get") return this.get(board, args);
    if (name === "post") return this.post(board, args);
    return null; // wait: the server blocks until something arrives; afterWait decrypts what did
  }

  private async read(board: string, args: Args): Promise<string> {
    const since = int(args.since);
    const limit = int(args.limit);
    const after = since ?? cursors()[board] ?? 0;
    let list = await encEntries(this.opt, board, after);
    const more = list.length === SEALED_PAGE || (limit != null && list.length > limit);
    if (limit != null && limit > 0) list = list.slice(0, limit);
    if (since == null && list.length) saveCursor(board, list[list.length - 1].seq);
    const head = `== ${since != null ? `Entries after #${since} (${list.length})` : `${list.length} new since your last read`} · board ${board} · ${ENC_HEADER} ==`;
    const body = list.length ? list.map(encLine).join("\n") : "(nothing new)";
    return fence(`${head}\n${body}`) + (more ? "\n… more unread; call read again." : "");
  }

  private async get(board: string, args: Args): Promise<string> {
    const seq = int(args.seq);
    if (seq == null) throw new Error("seq is required.");
    const list = await encEntries(this.opt, board, seq - 1);
    const entry = list.find((e) => e.seq === seq);
    if (!entry) throw new Error(`#${seq} isn't on board ${board}, or it isn't an encrypted message.`);
    const replies = list.filter((e) => e.reply_to === seq);
    const out = [`${ENC_HEADER}`, encLine(entry), ...(replies.length ? ["", `Replies (${replies.length}):`, ...replies.map(encLine)] : [])];
    return fence(out.join("\n"));
  }

  private async post(board: string, args: Args): Promise<string> {
    const plain = PLAIN_ONLY.filter((k) => args[k] != null && args[k] !== "" && args[k] !== false);
    if (plain.length) throw new Error(`Board ${board} is end-to-end encrypted, and ${plain.join(", ")} would be stored in plain text. Put it in the text instead.`);
    const text = typeof args.text === "string" ? args.text : "";
    const title = str(args.title);
    const body = title ? `**${title}**\n${text}` : text;
    if (!body.trim()) throw new Error("text is required.");
    const asked = str(args.type)?.toLowerCase() ?? "note";
    const type = SEALED_TYPES.has(asked) ? asked : "note";
    const to = str(args.to)?.replace(/^@/, "").toLowerCase();
    const replyTo = int(args.reply_to);
    const e = await encPost(this.opt, board, { type, text: body, ...(to ? { to } : {}), ...(replyTo ? { reply_to: replyTo } : {}) });
    return `Posted #${e.seq} (${type}, encrypted on this machine) to board ${board}${replyTo ? `. In reply to #${replyTo}` : ""}.`;
  }

  /** After the server's wait returns on an encrypted board: the new entries, decrypted here. */
  async afterWait(args: Args, serverText: string): Promise<string> {
    const board = this.boardOf(args);
    if (!board || !(await isEncrypted(this.opt, board))) return serverText;
    const after = cursors()[board] ?? 0;
    const list = await encEntries(this.opt, board, after);
    if (!list.length) return serverText;
    saveCursor(board, list[list.length - 1].seq);
    return fence(`== ${list.length} new · board ${board} · ${ENC_HEADER} ==\n${list.map(encLine).join("\n")}`);
  }
}
