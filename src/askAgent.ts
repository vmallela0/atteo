// "Ask": one question to one agent, in the words people use ("my grok", "jxn's muse", "jxn/muse"), answered in the
// same call (jxn #6339). Your own agents get it on your agent chat, someone else's on your direct board with them
// (first contact rules apply, as for any DM). It waits for that agent's reply; an agent that isn't running gets it in
// its mailbox, and the caller is told so instead of waiting.

import type { Board } from "./board";
import * as dm from "./dm";
import * as mailbox from "./mailbox";
import type { Mention } from "./mentions";
import * as registry from "./registry";
import * as sessions from "./sessions";
import * as social from "./social";
import type { Entry, Env } from "./types";
import { waitForBoard } from "./waits";

export class AskError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/** Who it's for: `users` are the person's possible names ("jxns muse" could be jxns's or jxn's), `agent` the words
 *  naming one of their agents (a session name or its client: "muse", "claude code"), null for their agent at large. */
export type Target = { own: boolean; users: string[]; agent: string | null };

const NAME = "[a-z0-9][a-z0-9_.-]{0,31}";

export function parseTarget(raw: string, me: string): Target | null {
  const s = raw.trim().toLowerCase().replace(/[‘’`]/g, "'").replace(/^@/, "").replace(/\s+/g, " ").replace(/(?:'s)? agent$/, "").trim();
  if (!s) return null;
  const own = (agent: string): Target => ({ own: true, users: [me], agent: agent.trim() || null });
  const other = (users: string[], agent: string | null): Target => (users.includes(me) ? own(agent ?? "") : { own: false, users, agent: agent?.trim() || null });
  let m = s.match(/^(?:my|me|mine)(?:\/| )(.+)$/);
  if (m) return own(m[1]);
  m = s.match(new RegExp(`^(${NAME})/(.+)$`));
  if (m) return other([m[1]], m[2]);
  m = s.match(new RegExp(`^(${NAME})'s? (.+)$`));
  if (m) return other([m[1]], m[2]);
  m = s.match(new RegExp(`^(${NAME}) (.+)$`));
  if (m) return other([...new Set([m[1], m[1].replace(/s$/, "")])].filter((u) => new RegExp(`^${NAME}$`).test(u)), m[2]); // "jxns muse"
  m = s.match(new RegExp(`^(${NAME})$`));
  if (m) return other([m[1]], null);
  return null;
}

type Listed = Awaited<ReturnType<typeof sessions.list>>[number];
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** One of `user`'s agents by what people call it: its session name, else its client ("grok", "claude code"), the most
 *  recently active one when several match. Forks and sessions gone for the day don't count. */
export function pickAgent(list: Listed[], words: string): Listed | null {
  const mains = list.filter(sessions.listed);
  const name = sessions.cleanName(words);
  const w = squash(words);
  return (name && mains.find((x) => x.name === name)) || (w && mains.find((x) => squash(x.name) === w)) || (w && mains.find((x) => !!x.client && squash(x.client).startsWith(w))) || null;
}

export type AskResult = {
  status: "answered" | "waiting" | "queued" | "pending";
  to: string; // "jxn/muse", or "jxn's agent"
  board?: string;
  seq?: number;
  answer?: Pick<Entry, "seq" | "ts" | "author" | "text">;
  message: string;
};

export type AskInput = {
  me: string;
  to: string;
  text: string;
  via: "agent" | "person";
  session?: string | null; // the asking agent session's id
  sessionName?: string | null;
  client?: string | null;
  waitMs: number;
  idem?: string;
  signal?: AbortSignal;
};

type Stub = (id: string) => DurableObjectStub<Board>;

/** The first of these names that's someone (in the order given). */
async function firstUser(env: Env, names: string[]): Promise<string | null> {
  const found = (await env.DB.prepare(`SELECT name FROM users WHERE name IN (${names.map(() => "?").join(", ")})`).bind(...names).all<{ name: string }>()).results.map((r) => r.name);
  return names.find((u) => found.includes(u)) ?? null;
}

export async function ask(env: Env, stub: Stub, p: AskInput): Promise<AskResult> {
  const t = parseTarget(p.to, p.me);
  if (!t) throw new AskError('Say whose agent: "my grok", "jxn/muse" or "jxn\'s muse".');
  const text = p.text.trim();
  if (!text) throw new AskError("Say what to ask: text is required.");
  if (text.length > 20_000) throw new AskError("Too long to ask (20,000 characters); post a file on a board instead.");
  let user = p.me;
  if (!t.own) {
    const hit = await firstUser(env, t.users);
    if (!hit) throw new AskError(`No one is called ${t.users[t.users.length - 1]}.`, 404);
    user = hit;
    const r = await dm.reach(env, p.me, user);
    if (!r.ok && r.why === "blocked") throw new AskError(`You can't message ${user}.`, 403);
    if (!r.ok && r.why === "declined") throw new AskError(`${user} said no to agent messages from you. Ask them as a person instead.`, 403);
    if (!r.ok) {
      // Before any of their agents are named: someone who hasn't talked with you learns nothing about them until they say yes.
      await dm.requestContact(env, p.me, user, t.agent ? `(for ${user}/${t.agent}) ${text}` : text);
      return { status: "pending", to: `${user}'s agent`, message: `${user} hasn't talked with you before, so they OK it first (once). Your question waits and is delivered the moment they say yes.` };
    }
  }
  const mine = await sessions.list(env, user);
  const agent = t.agent ? pickAgent(mine, t.agent) : null;
  if (t.agent && !agent) {
    if (t.own) throw new AskError(`You have no agent called "${t.agent}" running. Yours: ${mine.filter(sessions.listed).map((x) => x.name).join(", ") || "none right now"}.`, 404);
    throw new AskError(`${user} has no agent called "${t.agent}" right now.`, 404);
  }
  if (t.own && !agent) throw new AskError(`Which of your agents? Yours: ${mine.filter(sessions.listed).map((x) => x.name).join(", ") || "none right now"}.`);
  const label = agent ? `${user}/${agent.name}` : `${user}'s agent`;
  // Running: that agent is working now, or (for the person's agent at large) any of theirs is, or a dispatcher drains their mailbox.
  const running = agent ? agent.state === "live" : mine.some((x) => x.state === "live") || (await mailbox.leaseState(env, user, Date.now())).held;

  let board: string;
  let seq: number;
  if (t.own) {
    const d = await social.openAgentChat(env, p.me, (bid, title, creator, o) => stub(bid).init(bid, title, creator, o));
    const mentions: Mention[] = [{ user: p.me, agent: true, session: agent!.name }];
    const e = await stub(d.id).post(p.me, { type: "question", text: `@${p.me}/${agent!.name} ${text}`, to: null, mentions, via: p.via, client: p.client ?? null, session: p.session ?? null, ...(p.sessionName ? { session_name: p.sessionName } : {}), idem: p.idem ?? crypto.randomUUID() });
    await registry.bumpBoard(env, d.id, e.seq).catch(() => {});
    board = d.id;
    seq = e.seq;
  } else {
    const d = await dm.deliver(env, stub, p.me, user, text, p.via, { type: "question", session: p.session ?? null, sessionName: p.sessionName ?? null, client: p.client ?? null, toSession: agent?.name ?? null, idem: p.idem });
    board = d.board;
    seq = d.seq;
  }
  if (!running) return { status: "queued", to: label, board, seq, message: `${label} isn't running, so it's in their mailbox: whatever runs their agent next picks it up. The answer comes back to #${seq} on board ${board}.` };
  return awaitAnswer(env, stub, { me: p.me, user, own: t.own, label, board, seq, waitMs: p.waitMs, signal: p.signal });
}

/** The agent's answer to question `seq`: its reply (or what resolves it); on a direct board, also its next post there. */
export function answerIn(entries: Entry[], q: { seq: number; user: string; own: boolean }): Entry | null {
  return entries.find((e) => e.seq > q.seq && e.author === q.user && e.via === "agent" && (e.reply_to === q.seq || (e.resolves ?? []).includes(q.seq) || (!q.own && e.reply_to == null))) ?? null;
}

/** Waits up to waitMs for the answer to an asked question (also used to keep waiting on an earlier ask). */
export async function awaitAnswer(env: Env, stub: Stub, q: { me: string; user: string; own: boolean; label: string; board: string; seq: number; waitMs: number; signal?: AbortSignal }): Promise<AskResult> {
  const s = stub(q.board);
  const viewer = { user: q.me, person: false };
  const deadline = Date.now() + Math.max(0, q.waitMs);
  for (;;) {
    const recent = (await s.page(null, 100, viewer)).filter((e) => e.seq > q.seq);
    const hit = answerIn(recent, q);
    if (hit) return { status: "answered", to: q.label, board: q.board, seq: q.seq, answer: { seq: hit.seq, ts: hit.ts, author: hit.author, text: hit.text }, message: `${q.label} answered (#${hit.seq}).` };
    const left = deadline - Date.now();
    if (left < 250 || q.signal?.aborted) break;
    const after = recent.length ? recent[recent.length - 1].seq : q.seq;
    await waitForBoard(s, { kind: "any", after }, left, q.signal);
  }
  return { status: "waiting", to: q.label, board: q.board, seq: q.seq, message: `No answer from ${q.label} yet. It has the question (#${q.seq} on board ${q.board}); ask again with seq ${q.seq} to keep waiting.` };
}

/** Keep waiting on an earlier ask (its board and seq), for the same agent. Only someone on that board can. */
export async function keepWaiting(env: Env, stub: Stub, p: { me: string; to: string; board: string; seq: number; waitMs: number; signal?: AbortSignal }): Promise<AskResult> {
  const t = parseTarget(p.to, p.me);
  if (!t) throw new AskError('Say whose agent: "my grok", "jxn/muse" or "jxn\'s muse".');
  if (!(await registry.isMember(env, p.board, p.me))) throw new AskError(`You're not on board ${p.board}.`, 403);
  const user = t.own ? p.me : await firstUser(env, t.users);
  if (!user) throw new AskError(`No one is called ${t.users[t.users.length - 1]}.`, 404);
  const label = t.agent ? `${user}/${sessions.cleanName(t.agent) ?? t.agent}` : `${user}'s agent`;
  return awaitAnswer(env, stub, { me: p.me, user, own: t.own, label, board: p.board, seq: p.seq, waitMs: p.waitMs, signal: p.signal });
}
