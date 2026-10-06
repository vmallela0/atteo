// Conference calls (vedu #5383, docs/research/CONFERENCE-CALLS.md): 2–4 people on a board talk in one room on
// Cloudflare Realtime, an SFU. Each person's page (or the app's) sends its mic to the SFU once and pulls the others'
// tracks; the Worker is only the go-between for the SFU's HTTP API, so the app token never leaves it. The room costs
// next to nothing (egress, the first 1,000 GB a month free).
//
// Atteo is a gated participant: xAI hears nothing of the room. Only the person holding the Atteo turn reaches it, after
// pressing Ask Atteo or saying "Atteo, …" (addressesAtteo, checked on their own words on their own device). Their page
// opens the usual voice session (src/voice.ts), so the turn's minutes count against the same VOICE caps, and publishes
// Atteo's answer into the room as their "atteo" track. One turn at a time (a lock in D1 that expires with the session).
//
// The call is posted on the board when it starts (a note from whoever started it: "Started a call"), and when it ends a
// reply says who joined, how long it ran and what Atteo was asked.
//
// Routes (people only, board members only): GET /api/boards/:id/call (the call on now, or null), POST …/call/join,
// …/call/ping (every few seconds while in it), …/call/leave, …/call/sfu (publish, pull, renegotiate, close),
// …/call/atteo (ask, done). Calls exist only with CF_REALTIME_APP_ID + CF_REALTIME_APP_TOKEN (callsOn): until both are
// set the routes, the page and the button are not there (404), so production shows nothing before real audio is tested.
// A localhost server with DEV_FAKE_REALTIME=1 gets a stub room instead: who's in, the Atteo turn and the posts, no audio.

import { isLocalHost } from "./util";
import * as registry from "./registry";
import * as voice from "./voice";
import type { Env } from "./types";

export const MAX_PEOPLE = 4;
export const STALE_MS = 30_000; // no ping for this long: they've left
const LOG_MAX = 20;
const SFU_API = "https://rtc.live.cloudflare.com/v1/apps/";
export const NOT_SET_UP = "Calls aren't set up on this server yet: it needs CF_REALTIME_APP_ID (a var) and CF_REALTIME_APP_TOKEN (a secret) from a Cloudflare Realtime app.";
const TRACK_NAMES = new Set(["mic", "atteo"]);

// ---- the Atteo gate ----

/**
 * Whether these words are said to Atteo: "Atteo, what's next?", "hey Atteo …", "@atteo …", "what did we decide,
 * Atteo?". Talking about it ("I asked Atteo yesterday", "Atteo's summary") isn't. Speech-to-text spells it a few ways.
 * Mirrored in the app (ios/AgentSoup/Sources/CallGate.swift); keep the two the same.
 */
export function addressesAtteo(text: string): boolean {
  const t = String(text ?? "").toLowerCase().normalize("NFKC").replace(/[’‘]/g, "'").trim();
  if (!t) return false;
  const NAME = "@?(?:atteo|ateo|a teo|attayo|ateyo)";
  // At the start, after a greeting or filler: "Atteo, …", "hey Atteo …", "ok so Atteo …". Not "Atteo's …".
  if (new RegExp(`^[\\s"'(\\[]*(?:(?:hey|hi|hello|ok|okay|so|and|um|uh|yo|right)[\\s,.!]+)*${NAME}(?!['\\w])`).test(t)) return true;
  // At the end, set off by a comma: "what's next, Atteo?"
  return new RegExp(`,\\s*${NAME}\\s*[?.!]*\\s*$`).test(t);
}

// ---- the SFU (Cloudflare Realtime's HTTP API), or a stub on localhost ----

export interface SfuReply {
  status: number;
  json: unknown;
}
export interface Sfu {
  stub: boolean;
  /** A new SFU session for one person's peer connection (null in the stub). */
  newSession(): Promise<string | null>;
  /** POST tracks/new, PUT renegotiate, PUT tracks/close on that session. */
  call(session: string, op: "tracks/new" | "renegotiate" | "tracks/close", body: unknown): Promise<SfuReply>;
}

export function cloudflareSfu(appId: string, token: string, fetcher: typeof fetch = fetch): Sfu {
  const base = SFU_API + encodeURIComponent(appId);
  const req = async (method: string, url: string, body?: unknown): Promise<SfuReply> => {
    const r = await fetcher(url, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  return {
    stub: false,
    async newSession() {
      const r = await req("POST", `${base}/sessions/new`);
      const id = (r.json as { sessionId?: unknown }).sessionId;
      if (r.status >= 300 || typeof id !== "string") throw new Error(`Cloudflare Realtime: sessions/new answered ${r.status}`);
      return id;
    },
    call(session, op, body) {
      return req(op === "tracks/new" ? "POST" : "PUT", `${base}/sessions/${encodeURIComponent(session)}/${op}`, body);
    },
  };
}

/** No audio: who's in, the Atteo turn and the posts still work (local runs and the browser checks). */
export const stubSfu: Sfu = {
  stub: true,
  newSession: async () => null,
  call: async () => ({ status: 200, json: { stub: true } }),
};

type CallEnv = Pick<Env, "CF_REALTIME_APP_ID" | "CF_REALTIME_APP_TOKEN" | "DEV_FAKE_REALTIME">;
const fakeRealtime = (env: CallEnv, request: Request | null) => env.DEV_FAKE_REALTIME === "1" && !!request && isLocalHost(new URL(request.url).hostname);

/** Whether calls exist here at all: both Realtime settings, or the local stub (DEV_FAKE_REALTIME=1 on localhost). */
export function callsOn(env: CallEnv, request: Request | null): boolean {
  return !!(env.CF_REALTIME_APP_ID && env.CF_REALTIME_APP_TOKEN) || fakeRealtime(env, request);
}

/** The configured SFU; the stub on a localhost server with DEV_FAKE_REALTIME=1; otherwise null. */
export function sfuFor(env: CallEnv, request: Request): Sfu | null {
  if (env.CF_REALTIME_APP_ID && env.CF_REALTIME_APP_TOKEN) return cloudflareSfu(env.CF_REALTIME_APP_ID, env.CF_REALTIME_APP_TOKEN);
  return fakeRealtime(env, request) ? stubSfu : null;
}

// ---- the calls ----

export interface CallDeps {
  db: D1Database;
  now?: () => number;
  sfu: Sfu | null;
  /** Opens this person's voice session about the board (POST /api/app/voice/session): charged to the VOICE caps. */
  voiceStart(board: string): Promise<Response>;
  /** Settles it (POST /api/app/voice/session/end). */
  voiceEnd(body: { session_id: string; seconds: number }): Promise<Response>;
  /** Posts a note on the board as this person; its seq. */
  post(board: string, author: string, input: { text: string; reply_to?: number | null; data?: unknown }): Promise<number>;
}

interface CallRow {
  id: string;
  board: string;
  started_by: string;
  started_at: number;
  ended_at: number | null;
  card_seq: number | null;
  atteo_holder: string | null;
  atteo_until: number | null;
  atteo_session: string | null;
  atteo_log: string | null;
}
interface MemberRow {
  call_id: string;
  user: string;
  sfu_session: string | null;
  tracks: string | null;
  joined_at: number;
  left_at: number | null;
  last_seen: number;
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const err = (error: string, status: number, extra: Record<string, unknown> = {}) => json({ error, ...extra }, status);
const tracksOf = (m: MemberRow): string[] => {
  try {
    const t = JSON.parse(m.tracks ?? "[]");
    return Array.isArray(t) ? t.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};
const logOf = (c: CallRow): [string, string, string][] => {
  try {
    const l = JSON.parse(c.atteo_log ?? "[]");
    return Array.isArray(l) ? l : [];
  } catch {
    return [];
  }
};
const clip = (s: unknown, n: number) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

async function liveCall(db: D1Database, board: string): Promise<CallRow | null> {
  return db.prepare(`SELECT * FROM calls WHERE board = ? AND ended_at IS NULL`).bind(board).first<CallRow>();
}
async function membersOf(db: D1Database, call: string): Promise<MemberRow[]> {
  return (await db.prepare(`SELECT * FROM call_members WHERE call_id = ? ORDER BY joined_at`).bind(call).all<MemberRow>()).results ?? [];
}
const inCall = (m: MemberRow) => m.left_at == null;

/** How long, said plainly: "under a minute", "12 min", "1 h 5 min". */
export function lengthText(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return "under a minute";
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ""}`;
}

/** The reply that closes a call on the board: who joined, how long, what Atteo was asked. */
export function summaryText(c: { started_at: number; ended_at: number; people: string[]; log: [string, string, string][] }): string {
  const lines = [`Call ended after ${lengthText(c.ended_at - c.started_at)}. Joined: ${c.people.join(", ")}.`];
  if (!c.log.length) lines.push("Atteo wasn't asked anything.");
  else {
    lines.push(`Atteo answered ${c.log.length === 1 ? "one question" : `${c.log.length} questions`}:`);
    for (const [who, q, a] of c.log) lines.push(`- ${who}: “${clip(q, 140) || "(spoken)"}” → ${clip(a, 200) || "(no answer)"}`);
  }
  return lines.join("\n");
}

/** Members quiet for STALE_MS have left; an expired Atteo turn is let go; a call nobody's in is ended and summed up. */
async function reap(deps: CallDeps, call: CallRow, now: number): Promise<CallRow | null> {
  await deps.db.prepare(`UPDATE call_members SET left_at = last_seen WHERE call_id = ? AND left_at IS NULL AND last_seen < ?`).bind(call.id, now - STALE_MS).run();
  if (call.atteo_holder && (call.atteo_until ?? 0) < now) {
    await deps.db.prepare(`UPDATE calls SET atteo_holder = NULL, atteo_until = NULL, atteo_session = NULL WHERE id = ?`).bind(call.id).run();
    call = { ...call, atteo_holder: null, atteo_until: null, atteo_session: null };
  }
  const members = await membersOf(deps.db, call.id);
  if (members.some(inCall)) return call;
  await endCall(deps, call, members, now);
  return null;
}

async function endCall(deps: CallDeps, call: CallRow, members: MemberRow[], now: number): Promise<void> {
  const last = Math.max(call.started_at, ...members.map((m) => m.left_at ?? m.last_seen));
  const ended = Math.min(now, last);
  // Only the request that ends it posts the summary (two last pings can race).
  const won = await deps.db.prepare(`UPDATE calls SET ended_at = ?, atteo_holder = NULL, atteo_until = NULL WHERE id = ? AND ended_at IS NULL RETURNING id`).bind(ended, call.id).all();
  if (!won.results?.length) return;
  const people = members.map((m) => m.user);
  const log = logOf(call);
  await deps
    .post(call.board, call.started_by, {
      text: summaryText({ started_at: call.started_at, ended_at: ended, people, log }),
      reply_to: call.card_seq ?? null,
      data: { call: { id: call.id, state: "ended", started_at: call.started_at, ended_at: ended, people, atteo_questions: log.length } },
    })
    .catch((e) => console.error("call summary post failed", e instanceof Error ? e.message : String(e)));
}

async function state(deps: CallDeps, board: string, me: string, now: number): Promise<Record<string, unknown>> {
  let call = await liveCall(deps.db, board);
  if (call) call = await reap(deps, call, now);
  const base = { stub: deps.sfu?.stub ?? false, max: MAX_PEOPLE };
  if (!call) return { ...base, call: null };
  const members = (await membersOf(deps.db, call.id)).filter(inCall);
  return {
    ...base,
    call: {
      id: call.id,
      started_by: call.started_by,
      started_at: call.started_at,
      card_seq: call.card_seq,
      // SFU session ids stay here: a page pulls a person's track by name (op "pull"), never by session.
      members: members.map((m) => ({ user: m.user, joined_at: m.joined_at, tracks: tracksOf(m), you: m.user === me })),
      atteo: call.atteo_holder ? { holder: call.atteo_holder, until: call.atteo_until } : null,
    },
    joined: members.some((m) => m.user === me),
  };
}

const newId = () => "c_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);

async function join(deps: CallDeps, board: string, me: string, now: number): Promise<Response> {
  if (!deps.sfu) return err(NOT_SET_UP, 503, { needs: ["CF_REALTIME_APP_ID", "CF_REALTIME_APP_TOKEN"] });
  let call = await liveCall(deps.db, board);
  if (call) call = await reap(deps, call, now);
  let started = false;
  if (!call) {
    const id = newId();
    // The partial unique index keeps it to one: a join that lost the race joins the winner's.
    await deps.db.prepare(`INSERT OR IGNORE INTO calls (id, board, started_by, started_at) VALUES (?, ?, ?, ?)`).bind(id, board, me, now).run();
    call = await liveCall(deps.db, board);
    if (!call) return err("The call couldn't start. Try again.", 500);
    started = call.id === id;
  }
  const members = await membersOf(deps.db, call.id);
  const others = members.filter((m) => inCall(m) && m.user !== me);
  if (others.length >= MAX_PEOPLE) return err(`This call is full (${MAX_PEOPLE} people).`, 409);
  let session: string | null;
  try {
    session = await deps.sfu.newSession();
  } catch (e) {
    console.warn("sfu session failed", e instanceof Error ? e.message : String(e));
    return err("The call service didn't answer. Try again in a moment.", 502);
  }
  await deps.db
    .prepare(
      `INSERT INTO call_members (call_id, user, sfu_session, tracks, joined_at, left_at, last_seen) VALUES (?, ?, ?, '[]', ?, NULL, ?)
       ON CONFLICT (call_id, user) DO UPDATE SET sfu_session = excluded.sfu_session, tracks = '[]', left_at = NULL, last_seen = excluded.last_seen`,
    )
    .bind(call.id, me, session, now, now)
    .run();
  if (started) {
    const seq = await deps
      .post(board, me, { text: `Started a call. Join it with Call at the top of the board (up to ${MAX_PEOPLE} people).`, data: { call: { id: call.id, state: "live", started_at: now } } })
      .catch((e) => (console.error("call card post failed", e instanceof Error ? e.message : String(e)), null));
    if (seq != null) await deps.db.prepare(`UPDATE calls SET card_seq = ? WHERE id = ?`).bind(seq, call.id).run();
  }
  return json(await state(deps, board, me, now));
}

async function leave(deps: CallDeps, board: string, me: string, now: number): Promise<Response> {
  const call = await liveCall(deps.db, board);
  if (!call) return json({ ok: true, call: null });
  await deps.db.prepare(`UPDATE call_members SET left_at = ?, last_seen = ? WHERE call_id = ? AND user = ? AND left_at IS NULL`).bind(now, now, call.id, me).run();
  if (call.atteo_holder === me) await deps.db.prepare(`UPDATE calls SET atteo_holder = NULL, atteo_until = NULL, atteo_session = NULL WHERE id = ?`).bind(call.id).run();
  return json({ ok: true, ...(await state(deps, board, me, now)) });
}

async function myRow(deps: CallDeps, board: string, me: string): Promise<{ call: CallRow; me: MemberRow; members: MemberRow[] } | null> {
  const call = await liveCall(deps.db, board);
  if (!call) return null;
  const members = await membersOf(deps.db, call.id);
  const mine = members.find((m) => m.user === me && inCall(m));
  return mine ? { call, me: mine, members } : null;
}

async function sfuOp(deps: CallDeps, board: string, me: string, body: Record<string, unknown>): Promise<Response> {
  if (!deps.sfu) return err(NOT_SET_UP, 503);
  const row = await myRow(deps, board, me);
  if (!row) return err("Join the call first.", 409);
  if (deps.sfu.stub || !row.me.sfu_session) return json({ stub: true });
  const session = row.me.sfu_session;
  const sdp = typeof body.sdp === "string" && body.sdp.length <= 40_000 ? body.sdp : null;
  const pass = (r: SfuReply) => json(r.json, r.status >= 500 ? 502 : r.status);
  switch (body.op) {
    case "publish": {
      const tracks = Array.isArray(body.tracks) ? (body.tracks as { mid?: unknown; trackName?: unknown }[]) : [];
      if (!sdp || !tracks.length || tracks.length > 2) return err("Send sdp (an offer) and tracks [{mid, trackName}].", 400);
      for (const t of tracks) {
        if (typeof t.mid !== "string" || t.mid.length > 16 || typeof t.trackName !== "string" || !TRACK_NAMES.has(t.trackName)) return err("Each track needs a mid and a trackName (mic or atteo).", 400);
        // Only whoever holds the Atteo turn speaks as Atteo.
        if (t.trackName === "atteo" && row.call.atteo_holder !== me) return err("Ask Atteo first.", 409);
      }
      const r = await deps.sfu.call(session, "tracks/new", { sessionDescription: { type: "offer", sdp }, tracks: tracks.map((t) => ({ location: "local", mid: t.mid, trackName: t.trackName })) });
      if (r.status < 300) {
        const names = [...new Set([...tracksOf(row.me), ...tracks.map((t) => t.trackName as string)])];
        await deps.db.prepare(`UPDATE call_members SET tracks = ? WHERE call_id = ? AND user = ?`).bind(JSON.stringify(names), row.call.id, me).run();
      }
      return pass(r);
    }
    case "pull": {
      const want = Array.isArray(body.tracks) ? (body.tracks as { user?: unknown; trackName?: unknown }[]) : [];
      if (!want.length || want.length > 2 * MAX_PEOPLE) return err("Send tracks [{user, trackName}].", 400);
      const tracks = [];
      for (const w of want) {
        // Only tracks of people in this call, never another call's session.
        const m = row.members.find((x) => x.user === w.user && inCall(x) && x.user !== me);
        if (!m || !m.sfu_session || typeof w.trackName !== "string" || !tracksOf(m).includes(w.trackName)) return err(`${String(w.user)} has no ${String(w.trackName)} track in this call.`, 404);
        tracks.push({ location: "remote", sessionId: m.sfu_session, trackName: w.trackName });
      }
      return pass(await deps.sfu.call(session, "tracks/new", { tracks }));
    }
    case "renegotiate":
      if (!sdp) return err("Send sdp (the answer).", 400);
      return pass(await deps.sfu.call(session, "renegotiate", { sessionDescription: { type: "answer", sdp } }));
    case "close": {
      const mids = Array.isArray(body.mids) ? body.mids.filter((x): x is string => typeof x === "string" && x.length <= 16).slice(0, 16) : [];
      if (!mids.length) return err("Send mids.", 400);
      return pass(await deps.sfu.call(session, "tracks/close", { tracks: mids.map((mid) => ({ mid })), force: true, ...(sdp ? { sessionDescription: { type: "offer", sdp } } : {}) }));
    }
    default:
      return err("op must be publish, pull, renegotiate or close.", 400);
  }
}

async function atteo(deps: CallDeps, board: string, me: string, body: Record<string, unknown>, now: number): Promise<Response> {
  const row = await myRow(deps, board, me);
  if (!row) return err("Join the call first.", 409);
  const call = row.call;
  if (body.op === "ask") {
    // Said, not pressed: it has to be said to Atteo. Pressed: the button is the OK.
    if (body.text != null && !addressesAtteo(String(body.text))) return err("That wasn't said to Atteo. Start with “Atteo, …” or press Ask Atteo.", 400, { addressed: false });
    const got = await deps.db
      .prepare(`UPDATE calls SET atteo_holder = ?, atteo_until = ?, atteo_session = NULL WHERE id = ? AND (atteo_holder IS NULL OR atteo_until < ? OR atteo_holder = ?) RETURNING id`)
      .bind(me, now + 60_000, call.id, now, me)
      .all();
    if (!got.results?.length) return err(`${call.atteo_holder} is asking Atteo. Wait for the answer.`, 409, { holder: call.atteo_holder });
    const release = () => deps.db.prepare(`UPDATE calls SET atteo_holder = NULL, atteo_until = NULL, atteo_session = NULL WHERE id = ? AND atteo_holder = ?`).bind(call.id, me).run();
    let r: Response;
    try {
      r = await deps.voiceStart(board);
    } catch (e) {
      await release();
      throw e;
    }
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok || typeof j.session_id !== "string") {
      await release();
      return json(j, r.status >= 200 && r.status < 300 ? 502 : r.status); // the allowance, consent, not set up: voice's own words
    }
    const until = now + ((Number(j.max_seconds) || 600) + 15) * 1000;
    await deps.db.prepare(`UPDATE calls SET atteo_session = ?, atteo_until = ? WHERE id = ? AND atteo_holder = ?`).bind(j.session_id, until, call.id, me).run();
    return json({ ...j, call: call.id, holder: me, until });
  }
  if (body.op === "done") {
    if (call.atteo_holder !== me) return err("You don't hold the Atteo turn.", 409);
    const seconds = Number(body.seconds);
    if (call.atteo_session) await deps.voiceEnd({ session_id: call.atteo_session, seconds: Number.isFinite(seconds) && seconds >= 0 ? seconds : 0 }).catch(() => null);
    const q = clip(body.question, 300),
      a = clip(body.answer, 500);
    const log = logOf(call);
    if (q || a) log.push([me, q, a]);
    await deps.db.prepare(`UPDATE calls SET atteo_holder = NULL, atteo_until = NULL, atteo_session = NULL, atteo_log = ? WHERE id = ? AND atteo_holder = ?`).bind(JSON.stringify(log.slice(-LOG_MAX)), call.id, me).run();
    return json({ ok: true });
  }
  return err("op must be ask or done.", 400);
}

/** One call request from a person who is a member of the board (route checks both). sub: "", join, ping, leave, sfu, atteo. */
export async function handle(method: string, board: string, sub: string, me: string, body: unknown, deps: CallDeps): Promise<Response> {
  const now = (deps.now ?? Date.now)();
  const b = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  if (sub === "" && method === "GET") return json(await state(deps, board, me, now));
  if (method !== "POST") return err("not found", 404);
  switch (sub) {
    case "join":
      return join(deps, board, me, now);
    case "ping": {
      const call = await liveCall(deps.db, board);
      if (call) await deps.db.prepare(`UPDATE call_members SET last_seen = ? WHERE call_id = ? AND user = ? AND left_at IS NULL`).bind(now, call.id, me).run();
      return json(await state(deps, board, me, now));
    }
    case "leave":
      return leave(deps, board, me, now);
    case "sfu":
      return sfuOp(deps, board, me, b);
    case "atteo":
      return atteo(deps, board, me, b, now);
  }
  return err("not found", 404);
}

/** Calls nobody pinged for STALE_MS end (the cron): a call whose last page just closed still gets its summary. */
export async function reapAll(deps: CallDeps): Promise<void> {
  const now = (deps.now ?? Date.now)();
  const live = (await deps.db.prepare(`SELECT * FROM calls WHERE ended_at IS NULL LIMIT 50`).all<CallRow>()).results ?? [];
  for (const c of live) await reap(deps, c, now).catch((e) => console.error("call reap", e));
}

export const CALL_RE = /^\/api\/boards\/([^/]+)\/call(?:\/(join|ping|leave|sfu|atteo))?$/;

/** The deps for a request (or the cron, with request null: no SFU, no voice). */
export function depsFor(env: Env, request: Request | null, viewer: { name: string; display_name?: string | null; via?: "agent" | "person" } | null): CallDeps {
  const fwd = (path: string, body: unknown) => {
    const h: Record<string, string> = { "content-type": "application/json" };
    const fake = request?.headers.get("x-dev-fake-voice");
    if (fake) h["x-dev-fake-voice"] = fake;
    return voice.route(new Request(new URL(path, request?.url ?? "http://localhost/"), { method: "POST", headers: h, body: JSON.stringify(body) }), env, path, viewer);
  };
  return {
    db: env.DB,
    sfu: request ? sfuFor(env, request) : null,
    voiceStart: (board) => fwd("/api/app/voice/session", { board, hands_free: true }),
    voiceEnd: (body) => fwd("/api/app/voice/session/end", body),
    post: async (board, author, input) => {
      const stub = env.BOARD.get(env.BOARD.idFromName(board)) as unknown as { post(user: string, input: Record<string, unknown>): Promise<{ seq: number }> };
      const e = await stub.post(author, { type: "note", text: input.text, reply_to: input.reply_to ?? null, data: input.data ?? null, via: "person", client: "call" });
      return e.seq;
    },
  };
}

/** The router's hook: /api/boards/:id/call…, or null when the path isn't a call route. */
export async function route(request: Request, env: Env, path: string, viewer: { name: string; display_name?: string | null; via?: "agent" | "person" } | null): Promise<Response | null> {
  const m = path.match(CALL_RE);
  if (!m) return null;
  if (!callsOn(env, request)) return err("not found", 404); // not until a Realtime app is set up
  if (!viewer) return err("sign in required", 401);
  if (viewer.via === "agent") return err("Calls are for people, in the web or the app.", 403);
  const board = m[1];
  if (!(await registry.isMember(env, board, viewer.name))) return err("board not found", 404);
  const row = (await registry.getBoard(env, board)) as { encrypted?: number; deleted_at?: number | null } | null;
  if (!row || row.deleted_at) return err("board not found", 404);
  if (row.encrypted) return err("Calls aren't on encrypted boards yet: the summary would be posted in the clear.", 403);
  const body = request.method === "POST" ? await request.json().catch(() => ({})) : null;
  return handle(request.method, board, m[2] ?? "", viewer.name, body, depsFor(env, request, viewer));
}
