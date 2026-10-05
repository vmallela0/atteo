// atteo acp: an Agent Client Protocol agent on stdio, so an editor that speaks ACP (Zed, JetBrains, …) can ask a board
// member's agent and see the answer stream back, as A2A's message/send does. Each prompt is posted as a question to one
// member's agent (--to) or to the board; later prompts in the same session reply in its thread. Replies to it stream in
// as agent_message_chunk updates; the turn ends when the one it was addressed to answers (anyone, without --to), or after
// --wait seconds. session/cancel stops waiting and withdraws a question nobody has answered. Replies arrive fenced as
// untrusted (the client may be another agent).
//
// Version: negotiate 1 or 2 on initialize (a v2 client that only speaks 2 still works; a v1 client is unchanged).
// v1: session/prompt's result is {stopReason} when the turn ends.
// v2: session/prompt returns {messageId} once the question is on the board; completion is a state_update (idle).
// v2 also has the baseline session methods (list / resume / close); sessions live only in this process.
// These are the protocol parts, kept apart from the CLI's I/O so they're unit-tested with a fake board; main.ts wires in
// the real one.

import { fence, flagNote, flagOf } from "../../src/screen";

export const ACP_VERSION = 1;
export const ACP_VERSION_MAX = 2;

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
  ai_flag?: string | null;
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
  cwd: string;
  title: string | null;
  updatedAt: string;
  root: number | null; // the thread: the session's first question
  turn: AbortController | null;
}

const nowIso = () => new Date().toISOString();
const titleOf = (text: string) => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 60 ? `${t.slice(0, 59)}…` : t;
};

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

/**
 * A reply as it streams to the client, which may be another agent's harness: inside the untrusted fence like every
 * other CLI output carrying members' words (fake end markers neutralized), with ⚠ on a flagged one.
 */
export function replyChunk(e: AcpEntry, id?: string): string {
  const f = flagOf(e.text, e.ai_flag);
  return `${fence(`${speaker(e)}${f ? ` · ⚠ ${flagNote(f)}` : ""}:\n${e.text}`, id)}\n\n`;
}

export class AcpAgent {
  private sessions = new Map<string, Session>();
  private n = 0;
  /** Negotiated on initialize; methods before that speak v1, matching today's editors that skip nothing. */
  private protocol: 1 | 2 = 1;

  constructor(
    private send: (msg: object) => void,
    private board: AcpBoard,
    private opts: { to: string | null; waitSec: number; version: string; newId?: () => string },
  ) {}

  /** One incoming message. Requests get exactly one response; a v1 prompt's response waits for the answer. */
  async handle(msg: Rpc): Promise<void> {
    const reply = (result: unknown) => msg.id !== undefined && this.send({ jsonrpc: "2.0", id: msg.id, result });
    const fail = (code: number, message: string) => msg.id !== undefined && this.send({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
    const p = msg.params ?? {};
    try {
      switch (msg.method) {
        case "initialize": {
          const requested = typeof p.protocolVersion === "number" ? p.protocolVersion : Number(p.protocolVersion);
          this.protocol = requested >= 2 ? 2 : 1;
          const info = { name: "atteo", title: `Atteo${this.opts.to ? `: ${this.opts.to}'s agent` : ""}`, version: this.opts.version };
          if (this.protocol === 2) {
            return void reply({
              protocolVersion: ACP_VERSION_MAX,
              capabilities: { session: { prompt: { embeddedContext: {} } } },
              info,
              authMethods: [],
            });
          }
          return void reply({
            protocolVersion: ACP_VERSION,
            agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: true }, mcpCapabilities: { http: false, sse: false } },
            agentInfo: info,
            authMethods: [],
          });
        }
        case "authenticate":
          if (this.protocol === 2) return void fail(-32601, "atteo acp doesn't handle authenticate (ACP v2 uses auth/login; this agent has no auth methods).");
          return void reply({});
        case "session/new": {
          const cwd = typeof p.cwd === "string" ? p.cwd : "";
          const board = await this.board.resolve(cwd || undefined);
          const sessionId = this.opts.newId?.() ?? `atteo-${Date.now().toString(36)}-${++this.n}`;
          this.sessions.set(sessionId, { board, cwd: cwd || "/", title: null, updatedAt: nowIso(), root: null, turn: null });
          return void reply({ sessionId });
        }
        case "session/prompt":
          if (this.protocol === 2) return void (await this.prompt(String(p.sessionId ?? ""), p.prompt, msg.id));
          return void reply(await this.prompt(String(p.sessionId ?? ""), p.prompt));
        case "session/cancel":
          this.sessions.get(String(p.sessionId ?? ""))?.turn?.abort();
          return void reply({});
        case "session/list":
          if (this.protocol !== 2) break;
          return void reply(this.list(p));
        case "session/resume":
          if (this.protocol !== 2) break;
          return void reply(this.resume(String(p.sessionId ?? "")));
        case "session/close": {
          if (this.protocol !== 2) break;
          const id = String(p.sessionId ?? "");
          const s = this.sessions.get(id);
          if (!s) throw Object.assign(new Error(`No session ${id}: start one with session/new.`), { rpcCode: -32602 });
          s.turn?.abort();
          this.sessions.delete(id);
          return void reply({});
        }
        default:
          break;
      }
      if (msg.id !== undefined) fail(-32601, `atteo acp doesn't handle ${msg.method ?? "that"}.`);
    } catch (e) {
      const err = e as Error & { rpcCode?: number };
      fail(err.rpcCode ?? -32603, err.message || String(e));
    }
  }

  private list(p: Record<string, unknown>): { sessions: { sessionId: string; cwd: string; title?: string; updatedAt: string }[] } {
    const cwd = typeof p.cwd === "string" ? p.cwd : null;
    const sessions = [...this.sessions].flatMap(([sessionId, s]) => {
      if (cwd && s.cwd !== cwd) return [];
      return [{ sessionId, cwd: s.cwd, ...(s.title ? { title: s.title } : {}), updatedAt: s.updatedAt }];
    });
    return { sessions };
  }

  private resume(sessionId: string): Record<string, never> {
    if (!this.sessions.has(sessionId)) {
      throw Object.assign(new Error(`No session ${sessionId}: atteo acp only keeps sessions while this process runs. Start one with session/new.`), { rpcCode: -32602 });
    }
    return {};
  }

  private update(sessionId: string, update: Record<string, unknown>) {
    this.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
  }

  private say(sessionId: string, text: string, messageId?: string) {
    this.update(sessionId, { sessionUpdate: "agent_message_chunk", ...(messageId ? { messageId } : {}), content: { type: "text", text } });
  }

  private async prompt(sessionId: string, blocks: unknown, rpcId?: Id): Promise<{ stopReason: "end_turn" | "cancelled" } | void> {
    const s = this.sessions.get(sessionId);
    if (!s) throw Object.assign(new Error(`No session ${sessionId}: start one with session/new.`), { rpcCode: -32602 });
    if (s.turn) throw Object.assign(new Error("A prompt is already waiting for its answer in this session."), { rpcCode: -32602 });
    const text = promptText(blocks);
    if (!text) throw Object.assign(new Error("The prompt has no text to ask."), { rpcCode: -32602 });
    const turn = new AbortController();
    s.turn = turn;
    const to = this.opts.to;
    const whom = to ? `${to}'s agent` : "the board";
    const v2 = this.protocol === 2;
    const finish = (stopReason: "end_turn" | "cancelled" | "error") => {
      if (v2) this.update(sessionId, { sessionUpdate: "state_update", state: "idle", stopReason });
      return { stopReason: stopReason === "error" ? "end_turn" : stopReason };
    };
    let call: string | null = null;
    try {
      const seq = await this.board.ask(s.board, text, { to, replyTo: s.root });
      s.root ??= seq;
      s.title ??= titleOf(text);
      s.updatedAt = nowIso();
      call = `ask-${seq}`;
      if (v2) {
        const messageId = `msg-q-${seq}`;
        if (rpcId !== undefined) this.send({ jsonrpc: "2.0", id: rpcId, result: { messageId } });
        this.update(sessionId, { sessionUpdate: "user_message", messageId, content: [{ type: "text", text }] });
        this.update(sessionId, { sessionUpdate: "state_update", state: "running" });
        this.update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: call, title: `Asked ${whom} (#${seq} on ${s.board})`, kind: "other", status: "in_progress" });
      } else {
        this.update(sessionId, { sessionUpdate: "tool_call", toolCallId: call, title: `Asked ${whom} (#${seq} on ${s.board})`, kind: "other", status: "in_progress" });
      }
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
          s.updatedAt = nowIso();
          this.say(sessionId, replyChunk(e), v2 ? `msg-${e.seq}` : undefined);
          if (!to || e.author === to) {
            this.update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: call, status: "completed" });
            return finish("end_turn");
          }
        }
        cursor = Math.max(cursor, got.last);
      }
      if (turn.signal.aborted) {
        // Nobody answered: take the question back, as A2A's cancel does. If someone has, it stays (it's a conversation).
        if (!heard) await this.board.withdraw(s.board, seq).catch(() => {});
        if (s.root === seq && !heard) s.root = null;
        this.update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: call, status: "failed" });
        return finish("cancelled");
      }
      this.update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: call, status: "completed" });
      this.say(sessionId, `No answer from ${whom} within ${this.opts.waitSec}s. The question stays on the board as #${seq}: read it later with atteo get ${seq} --board ${s.board}.`, v2 ? `msg-wait-${seq}` : undefined);
      return finish("end_turn");
    } catch (e) {
      // v2 already answered session/prompt (the question is on the board): a later failure is idle, not a second RPC error.
      if (v2 && call) {
        this.update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: call, status: "failed" });
        return finish("error");
      }
      throw e;
    } finally {
      s.turn = null;
    }
  }
}
