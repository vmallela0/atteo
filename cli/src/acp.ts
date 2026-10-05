// atteo acp: an Agent Client Protocol (v1) agent on stdio, so an editor that speaks ACP (Zed, …) can ask a board
// member's agent and see the answer stream back, as A2A's message/send does. Each prompt is posted as a question to one
// member's agent (--to) or to the board; later prompts in the same session reply in its thread. Replies to it stream in
// as agent_message_chunk updates; the turn ends when the one it was addressed to answers (anyone, without --to), or after
// --wait seconds. session/cancel stops waiting and withdraws a question nobody has answered. These are the protocol
// parts, kept apart from the CLI's I/O so they're unit-tested with a fake board; main.ts wires in the real one.

export const ACP_VERSION = 1;

/** What the protocol needs from a board (main.ts: the real one, over the CLI's API; tests: a fake). */
export interface AcpBoard {
  /** The board for a new session in `cwd`: --board, else the folder's (atteo use). Throws a readable error. */
  resolve(cwd: string | undefined): Promise<string>;
  /** Posts a question (to one member's agent, or the board), in a thread when replyTo is set; returns its number. */
  ask(board: string, text: string, opts: { to: string | null; replyTo: number | null }): Promise<number>;
  /** Entries after `after`, waiting up to `waitSec` for the first new one (the server's long-poll). */
  after(board: string, after: number, waitSec: number, signal: AbortSignal): Promise<{ entries: AcpEntry[]; last: number }>;
  /** Withdraws an unanswered question (retract). */
  withdraw(board: string, seq: number): Promise<void>;
  /** The signed-in person: their own posts never count as an answer. */
  me(): string;
}

export interface AcpEntry {
  seq: number;
  author: string;
  via?: string | null;
  agent_name?: string;
  type: string;
  text: string;
  reply_to: number | null;
  resolves?: number[];
  retracts?: number | null;
}

type Id = string | number;
interface Rpc {
  jsonrpc?: "2.0";
  id?: Id;
  method?: string;
  params?: Record<string, unknown>;
}
interface Session {
  board: string;
  root: number | null; // the thread: the session's first question
  turn: AbortController | null;
}

/** A prompt's content blocks as one message: text as written, embedded files fenced with their path, links by URI. */
export function promptText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  const parts: string[] = [];
  for (const b of blocks as { type?: string; text?: string; uri?: string; name?: string; resource?: { uri?: string; text?: string } }[]) {
    if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
    else if (b?.type === "resource" && typeof b.resource?.text === "string") parts.push(`${b.resource.uri ?? "file"}:\n\`\`\`\n${b.resource.text.replace(/\n$/, "")}\n\`\`\``);
    else if (b?.type === "resource_link" && typeof b.uri === "string") parts.push(`(${b.name ?? "link"}: ${b.uri})`);
  }
  return parts.join("\n\n").trim();
}

/** Who wrote an entry, as the editor shows it. */
export const speaker = (e: AcpEntry) => (e.via === "agent" ? `${e.author}'s agent${e.agent_name ? ` (${e.agent_name})` : ""}` : e.author);

export class AcpAgent {
  private sessions = new Map<string, Session>();
  private n = 0;

  constructor(
    private send: (msg: object) => void,
    private board: AcpBoard,
    private opts: { to: string | null; waitSec: number; version: string; newId?: () => string },
  ) {}

  /** One incoming message. Requests get exactly one response; a prompt's response waits for the answer. */
  async handle(msg: Rpc): Promise<void> {
    const reply = (result: unknown) => msg.id !== undefined && this.send({ jsonrpc: "2.0", id: msg.id, result });
    const fail = (code: number, message: string) => msg.id !== undefined && this.send({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
    const p = msg.params ?? {};
    try {
      switch (msg.method) {
        case "initialize":
          return void reply({
            protocolVersion: ACP_VERSION,
            agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: true }, mcpCapabilities: { http: false, sse: false } },
            agentInfo: { name: "atteo", title: `Atteo${this.opts.to ? `: ${this.opts.to}'s agent` : ""}`, version: this.opts.version },
            authMethods: [],
          });
        case "authenticate":
          return void reply({});
        case "session/new": {
          const board = await this.board.resolve(typeof p.cwd === "string" ? p.cwd : undefined);
          const sessionId = this.opts.newId?.() ?? `atteo-${Date.now().toString(36)}-${++this.n}`;
          this.sessions.set(sessionId, { board, root: null, turn: null });
          return void reply({ sessionId });
        }
        case "session/prompt":
          return void reply(await this.prompt(String(p.sessionId ?? ""), p.prompt));
        case "session/cancel":
          this.sessions.get(String(p.sessionId ?? ""))?.turn?.abort();
          return;
        default:
          if (msg.id !== undefined) fail(-32601, `atteo acp doesn't handle ${msg.method ?? "that"}.`);
      }
    } catch (e) {
      const err = e as Error & { rpcCode?: number };
      fail(err.rpcCode ?? -32603, err.message || String(e));
    }
  }

  private update(sessionId: string, update: Record<string, unknown>) {
    this.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
  }

  private say(sessionId: string, text: string) {
    this.update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  }

  private async prompt(sessionId: string, blocks: unknown): Promise<{ stopReason: "end_turn" | "cancelled" }> {
    const s = this.sessions.get(sessionId);
    if (!s) throw Object.assign(new Error(`No session ${sessionId}: start one with session/new.`), { rpcCode: -32602 });
    if (s.turn) throw Object.assign(new Error("A prompt is already waiting for its answer in this session."), { rpcCode: -32602 });
    const text = promptText(blocks);
    if (!text) throw Object.assign(new Error("The prompt has no text to ask."), { rpcCode: -32602 });
    const turn = new AbortController();
    s.turn = turn;
    const to = this.opts.to;
    const whom = to ? `${to}'s agent` : "the board";
    try {
      const seq = await this.board.ask(s.board, text, { to, replyTo: s.root });
      s.root ??= seq;
      const call = `ask-${seq}`;
      this.update(sessionId, { sessionUpdate: "tool_call", toolCallId: call, title: `Asked ${whom} (#${seq} on ${s.board})`, kind: "other", status: "in_progress" });
      const me = this.board.me();
      const until = Date.now() + this.opts.waitSec * 1000;
      let cursor = seq;
      let heard = false;
      while (Date.now() < until && !turn.signal.aborted) {
        let got: { entries: AcpEntry[]; last: number };
        try {
          got = await this.board.after(s.board, cursor, Math.max(1, Math.min(25, Math.ceil((until - Date.now()) / 1000))), turn.signal);
        } catch (e) {
          if (turn.signal.aborted) break;
          throw e;
        }
        for (const e of got.entries) {
          if (e.seq <= cursor) continue;
          // A reply to this question by someone else (your own posts, and withdrawn ones, aren't answers).
          if (e.author === me || e.retracts != null || !(e.reply_to === seq || e.resolves?.includes(seq))) continue;
          heard = true;
          this.say(sessionId, `${speaker(e)}:\n\n${e.text}\n\n`);
          if (!to || e.author === to) {
            this.update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: call, status: "completed" });
            return { stopReason: "end_turn" };
          }
        }
        cursor = Math.max(cursor, got.last);
      }
      if (turn.signal.aborted) {
        // Nobody answered: take the question back, as A2A's cancel does. If someone has, it stays (it's a conversation).
        if (!heard) await this.board.withdraw(s.board, seq).catch(() => {});
        if (s.root === seq && !heard) s.root = null;
        this.update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: call, status: "failed" });
        return { stopReason: "cancelled" };
      }
      this.update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: call, status: "completed" });
      this.say(sessionId, `No answer from ${whom} within ${this.opts.waitSec}s. The question stays on the board as #${seq}: read it later with atteo get ${seq} --board ${s.board}.`);
      return { stopReason: "end_turn" };
    } finally {
      s.turn = null;
    }
  }
}
