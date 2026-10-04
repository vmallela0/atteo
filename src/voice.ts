// Talk to Atteo: POST /api/app/voice/session hands a signed-in person (web or app; never an agent) what it needs to open
// a speech-to-speech WebSocket straight to xAI's Grok Voice Agent API, without our key ever leaving the Worker:
//   - a short-lived client secret (POST https://api.x.ai/v1/realtime/client_secrets with our key → {value, expires_at};
//     docs.x.ai/developers/model-capabilities/audio/ephemeral-tokens and docs.x.ai/developers/rest-api-reference/inference/voice).
//     It only has to cover the connect: the socket stays open after it expires.
//   - the socket: new WebSocket(url, protocols) with protocols = ["xai-client-secret.<value>"] (or, off the browser,
//     Authorization: Bearer <value>). Then send {type: "session.update", session} with the `session` given here.
//   - push-to-talk (the default): turn_detection is null, so the app streams input_audio_buffer.append while the button
//     is held, then sends input_audio_buffer.commit + response.create. hands_free: true asks for server VAD instead.
//   - tools: the server never runs them. xAI sends response.function_call_arguments.done {name, call_id, arguments};
//     the app calls the Atteo API in tool_routes with its OWN token, answers with conversation.item.create
//     {item: {type: "function_call_output", call_id, output}} and then response.create. A route with confirm: true
//     (answer_approval) runs only after the person said yes out loud.
// Guardrails: a per-person rate limit on sessions (D1 rate_limits) and a per-person monthly minutes budget (D1
// voice_usage). Once the app holds the socket the Worker sees no frames, so a session is charged its full cap
// (max_seconds) up front and POST /api/app/voice/session/end {session_id, seconds} settles it down to what was used.
// A session the app never ends keeps its full cap. Without XAI_API_KEY the routes answer 503 {fallback: "device"}.

import { isOperator } from "./tts";
import type { Env } from "./types";
import * as registry from "./registry";
import { isLocalHost } from "./util";
import { monthOf, NOT_SET_UP, rateHit, VOICES, DEFAULT_VOICE, type Voice } from "./tts";

export const MODEL = "grok-voice-latest";
export const REALTIME_URL = `wss://api.x.ai/v1/realtime?model=${MODEL}`;
export const SECRET_TTL = 120; // seconds the client secret is good for: enough to connect, not to hoard
export const DEFAULT_BUDGET_MINUTES = 180; // per person per month: 3 h (the Max plan math, #1117/#1175)
export const DEFAULT_SESSION_MINUTES = 10; // one session's cap: charged up front, settled at the end
export const DEFAULT_PER_MINUTE = 6; // sessions a person may start per minute
export const SAMPLE_RATE = 24000;

export interface ClientSecret {
  value: string;
  expires_at: number; // unix seconds
}

/** Where speech-to-speech comes from. clientSecret() rejects with VoiceProviderError when the service fails. */
export interface VoiceProvider {
  name: string;
  clientSecret(ttlSeconds: number): Promise<ClientSecret>;
}

export class VoiceProviderError extends Error {}

// ---------- xAI ----------

/** The one call to xAI: a client secret for the realtime socket. The model rides on the socket URL, not here. */
export async function xaiClientSecret(key: string, ttlSeconds: number, fetcher: typeof fetch = fetch): Promise<ClientSecret> {
  let res: Response;
  try {
    res = await fetcher("https://api.x.ai/v1/realtime/client_secrets", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ expires_after: { seconds: ttlSeconds } }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new VoiceProviderError(`xAI realtime unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }
  const j = (await res.json().catch(() => null)) as { value?: unknown; expires_at?: unknown; client_secret?: { value?: unknown; expires_at?: unknown } } | null;
  if (!res.ok) throw new VoiceProviderError(`xAI client_secrets answered ${res.status}`);
  const s = j?.client_secret ?? j; // OpenAI-style {client_secret: {...}} too, in case the shape moves
  if (!s || typeof s.value !== "string" || !s.value) throw new VoiceProviderError("xAI client_secrets answered without a value");
  const exp = Number(s.expires_at);
  return { value: s.value, expires_at: Number.isFinite(exp) && exp > 0 ? Math.floor(exp) : Math.floor(Date.now() / 1000) + ttlSeconds };
}

export function xaiProvider(key: string, fetcher?: typeof fetch): VoiceProvider {
  return { name: "xai", clientSecret: (ttl) => xaiClientSecret(key, ttl, fetcher) };
}

/** No network: a canned secret. Only for local runs (see providerFor). */
export const fakeProvider: VoiceProvider = {
  name: "fake",
  clientSecret: async (ttl) => ({ value: `fake-client-secret-${crypto.randomUUID()}`, expires_at: Math.floor(Date.now() / 1000) + ttl }),
};

/**
 * The configured provider, or null (no key: the feature is off and clients use the device's own speech). On localhost
 * with DEV_FAKE_VOICE=1 in the local .dev.vars (never wrangler.jsonc) and no key, a request carrying
 * x-dev-fake-voice: 1 gets the fake provider, so e2e can see a whole session without xAI. A deployed Worker is never
 * reached as localhost.
 */
export function providerFor(env: Pick<Env, "XAI_API_KEY" | "DEV_FAKE_VOICE">, request?: Request): VoiceProvider | null {
  if (env.XAI_API_KEY) return xaiProvider(env.XAI_API_KEY);
  if (request && env.DEV_FAKE_VOICE === "1" && request.headers.get("x-dev-fake-voice") === "1" && isLocalHost(new URL(request.url).hostname)) return fakeProvider;
  return null;
}

// ---------- the session the app sends as session.update ----------

const oneLine = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f"“”]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** The voice front's system prompt: one short paragraph, plus the board they're on when there is one. */
export function instructionsFor(person: string, board: { id: string; title: string } | null): string {
  const who = oneLine(person, 60) || "the user";
  let s =
    `You are Atteo, ${who}'s voice assistant in Atteo, where their AI agents work alongside other people's agents on shared boards. ` +
    `Your name is Atteo: never call yourself Grok or any other model name. ` +
    `Speak naturally and keep every reply to one or two short sentences. Use your tools to act and to look things up, then say what matters in plain words; ` +
    `never read out raw logs, code, IDs or links. Before approving or denying anything, or doing anything destructive, say exactly what will happen and wait for a clear yes. ` +
    `If you're unsure what they mean, ask one short question. ` +
    `When they say "at agents", "at humans", "at all" or "at <name>" in something to post, write it as @agents, @humans, @all or @<name>.`;
  if (board) s += ` They have the board "${oneLine(board.title, 80)}" (${board.id}) open: use it when they don't name another.`;
  return s;
}

const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []) => ({
  type: "function" as const,
  name,
  description,
  parameters: { type: "object", properties, required, additionalProperties: false },
});
const boardProp = { type: "string", description: "A board id (b_…) from list_boards." };

/** Function tools, in xAI's (OpenAI Realtime) shape. The app runs each one: see TOOL_ROUTES. */
export const TOOLS = [
  fn("post_to_my_agent", "Send a message to the user's own agent: a request, a question or an instruction, in the user's words. Without a board it goes to their private chat with their agent.", {
    text: { type: "string", description: "What to tell the agent." },
    board: { ...boardProp, description: "Post on this board (addressed to the user's agent) instead of the private chat." },
  }, ["text"]),
  fn("read_board", "Read the latest messages on a board, to answer what's happening there. Summarise; don't read them out.", {
    board: { ...boardProp, description: "Which board; omit for the one the user has open." },
    since: { type: "integer", minimum: 0, description: "Only messages after this message number." },
  }),
  fn("mailbox_summary", "What's waiting for the user: messages and mentions addressed to them across their boards.", {}),
  fn("recap", "A short recap of what happened on a board since the user last read it (or since a message number).", {
    board: boardProp,
    since: { type: "integer", minimum: 0, description: "Recap from this message number; omit for since they last read." },
  }, ["board"]),
  fn("answer_approval", "Approve or deny an approval one of the user's agents asked for. Only call this after you said what it does and the user clearly said yes.", {
    approval_id: { type: "string", description: "The approval's id (ap_…)." },
    decision: { type: "string", enum: ["approve", "deny"] },
  }, ["approval_id", "decision"]),
  fn("list_boards", "The user's boards (names, ids, what's new), to find the one they mean.", {}),
];

/**
 * How the app runs each tool with its own token ({board} and the rest come from the call's arguments; board defaults to
 * the session's board). The server only describes them.
 */
export const TOOL_ROUTES: Record<string, { method: "GET" | "POST"; path: string; paths?: Record<string, string>; body?: Record<string, unknown>; confirm?: true; note?: string }> = {
  post_to_my_agent: {
    method: "POST",
    path: "/api/boards/{board}/entries",
    body: { type: "note", text: "{text}" },
    note: "No board: POST /api/me/agent-chat first and post to the board it returns. With a board: prefix the text with \"@<you>'s agent \".",
  },
  read_board: { method: "GET", path: "/api/boards/{board}/entries?after={since}&limit=30", note: "Oldest first after `since`. No since: use max(0, entry_count - 30), entry_count from GET /api/me/boards (after=0 would be the board's start)." },
  mailbox_summary: { method: "GET", path: "/api/mailbox?peek=1", note: "peek: hearing a summary doesn't mark mail delivered." },
  recap: { method: "GET", path: "/api/boards/{board}/recap?since={since}", note: "since omitted: last-read." },
  answer_approval: { method: "POST", path: "/api/approvals/{approval_id}/approve", paths: { approve: "/api/approvals/{approval_id}/approve", deny: "/api/approvals/{approval_id}/reject" }, confirm: true, note: "Pick the path by decision. Only after a spoken yes." },
  list_boards: { method: "GET", path: "/api/me/boards" },
};

export function sessionConfig(o: { person: string; board: { id: string; title: string } | null; voice: Voice; handsFree: boolean }) {
  return {
    instructions: instructionsFor(o.person, o.board),
    voice: o.voice,
    turn_detection: o.handsFree ? { type: "server_vad" } : null,
    audio: {
      // grok-transcribe gives the app live captions of what the person says, and the spoken "yes" for approvals
      // (conversation.item.input_audio_transcription.updated / .completed).
      input: { format: { type: "audio/pcm", rate: SAMPLE_RATE }, transcription: { model: "grok-transcribe" } },
      output: { format: { type: "audio/pcm", rate: SAMPLE_RATE } },
    },
    tools: TOOLS,
  };
}

// ---------- guardrails ----------

const posInt = (v: unknown, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : d;
};
export const budgetMinutesFor = (env: Pick<Env, "VOICE_MONTHLY_MINUTES">) => posInt(env.VOICE_MONTHLY_MINUTES, DEFAULT_BUDGET_MINUTES);
export const sessionMinutesFor = (env: Pick<Env, "VOICE_SESSION_MINUTES">) => posInt(env.VOICE_SESSION_MINUTES, DEFAULT_SESSION_MINUTES);
export const perMinuteFor = (env: Pick<Env, "VOICE_PER_MINUTE">) => posInt(env.VOICE_PER_MINUTE, DEFAULT_PER_MINUTE);
/** Everyone's live-voice minutes per month (vedu #1582: strict caps); "*" is the shared row in voice_usage. ~$30 at $0.05/min. */
export const DEFAULT_GLOBAL_MINUTES = 600;
export const globalMinutesFor = (env: Pick<Env, "VOICE_GLOBAL_MONTHLY_MINUTES">) => posInt(env.VOICE_GLOBAL_MONTHLY_MINUTES, DEFAULT_GLOBAL_MINUTES);
const ALL = "*";

const minutes = (seconds: number) => Math.round(seconds / 6) / 10; // one decimal

export async function usedSeconds(db: D1Database, user: string, now: number): Promise<number> {
  const r = await db.prepare(`SELECT seconds FROM voice_usage WHERE user = ? AND month = ?`).bind(user, monthOf(now)).first<{ seconds: number }>();
  return r?.seconds ?? 0;
}

/**
 * Starts a session: charges its cap to this month, all or nothing, and records it. Null: the cap would go past the
 * budget. A smaller last session is allowed when at least a minute is left.
 */
export async function reserveSession(db: D1Database, user: string, capSeconds: number, budgetSeconds: number, now: number, globalSeconds = Infinity): Promise<{ id: string; seconds: number } | null> {
  const month = monthOf(now);
  const left = Math.min(budgetSeconds - (await usedSeconds(db, user, now)), Number.isFinite(globalSeconds) ? globalSeconds - (await usedSeconds(db, ALL, now)) : Infinity);
  const seconds = Math.min(capSeconds, left);
  if (seconds < 60) return null;
  const id = `vs_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const [, upd] = await db.batch<{ seconds: number }>([
    db.prepare(`INSERT OR IGNORE INTO voice_usage (user, month, seconds, sessions) VALUES (?, ?, 0, 0)`).bind(user, month),
    db.prepare(`UPDATE voice_usage SET seconds = seconds + ?, sessions = sessions + 1 WHERE user = ? AND month = ? AND seconds + ? <= ? RETURNING seconds`).bind(seconds, user, month, seconds, budgetSeconds),
  ]);
  if (!(upd?.results?.length ?? 0)) return null;
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO voice_usage (user, month, seconds, sessions) VALUES (?, ?, 0, 0)`).bind(ALL, month),
    db.prepare(`UPDATE voice_usage SET seconds = seconds + ?, sessions = sessions + 1 WHERE user = ? AND month = ?`).bind(seconds, ALL, month),
  ]);
  await db.prepare(`INSERT INTO voice_sessions (id, user, month, reserved_s, used_s, created_at, ended_at) VALUES (?, ?, ?, ?, NULL, ?, NULL)`).bind(id, user, month, seconds, now).run();
  return { id, seconds };
}

/** Gives a whole session back (the provider failed: nothing was said). */
async function refundSession(db: D1Database, user: string, id: string, seconds: number, now: number): Promise<void> {
  await db.batch([
    db.prepare(`UPDATE voice_usage SET seconds = MAX(0, seconds - ?), sessions = MAX(0, sessions - 1) WHERE user IN (?, ?) AND month = ?`).bind(seconds, user, ALL, monthOf(now)),
    db.prepare(`DELETE FROM voice_sessions WHERE id = ? AND user = ?`).bind(id, user),
  ]);
}

/** Settles a session to the seconds it used (0..its cap), once. Null: not this person's, or already ended. */
export async function endSession(db: D1Database, user: string, id: string, reported: number, now: number): Promise<{ used: number; refunded: number } | null> {
  const row = await db
    .prepare(`UPDATE voice_sessions SET used_s = MIN(reserved_s, MAX(0, ?)), ended_at = ? WHERE id = ? AND user = ? AND ended_at IS NULL RETURNING month, reserved_s, used_s`)
    .bind(Math.ceil(reported), now, id, user)
    .first<{ month: string; reserved_s: number; used_s: number }>();
  if (!row) return null;
  const refunded = row.reserved_s - row.used_s;
  if (refunded > 0) await db.prepare(`UPDATE voice_usage SET seconds = MAX(0, seconds - ?) WHERE user IN (?, ?) AND month = ?`).bind(refunded, user, ALL, row.month).run();
  return { used: row.used_s, refunded };
}

// ---------- the routes ----------

export interface VoiceDeps {
  db: D1Database;
  provider: VoiceProvider | null;
  budgetMinutes: number;
  /** Everyone's minutes per month; Infinity for operators (vedu #1584). */
  globalMinutes?: number;
  sessionMinutes: number;
  perMinute: number;
  /** The board for this person, or an error (not a member). */
  board: (id: string) => Promise<{ id: string; title: string } | null>;
  now?: () => number;
}

const err = (error: string, status: number, extra: Record<string, unknown> = {}, headers: HeadersInit = {}) => Response.json({ error, ...extra }, { status, headers: { "cache-control": "no-store", ...headers } });

/** POST /api/app/voice/session {board?, voice?, hands_free?} → what the app opens the socket with. */
export async function createSession(user: { name: string; display_name?: string | null }, raw: unknown, deps: VoiceDeps): Promise<Response> {
  const body = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as { board?: unknown; voice?: unknown; hands_free?: unknown };
  const voice = (body.voice == null || body.voice === "" ? DEFAULT_VOICE : String(body.voice).toLowerCase()) as Voice;
  if (!VOICES.includes(voice)) return err(`Unknown voice. Pick one of: ${VOICES.join(", ")}.`, 400);
  if (body.hands_free != null && typeof body.hands_free !== "boolean") return err("hands_free must be true or false.", 400);
  let board: { id: string; title: string } | null = null;
  if (body.board != null && body.board !== "") {
    if (typeof body.board !== "string" || !/^b_[a-z0-9]{8,32}$/.test(body.board)) return err("board must be a board id.", 400);
    board = await deps.board(body.board);
    if (!board) return err("board not found", 404);
  }

  const now = (deps.now ?? Date.now)();
  const rl = await rateHit(deps.db, user.name, deps.perMinute, now, "voice");
  if (!rl.ok) return err(`Too many voice sessions: at most ${deps.perMinute} a minute. Try again in ${rl.retryAfter}s.`, 429, {}, { "retry-after": String(rl.retryAfter) });
  if (!deps.provider) return err(NOT_SET_UP, 503, { fallback: "device" });

  const budgetS = deps.budgetMinutes * 60;
  const s = await reserveSession(deps.db, user.name, deps.sessionMinutes * 60, budgetS, now, (deps.globalMinutes ?? Infinity) * 60);
  if (!s) return err(`You've used this month's voice time (${deps.budgetMinutes} minutes). It resets on the 1st; typing and the device voice still work.`, 429, { fallback: "device" });
  let secret: ClientSecret;
  try {
    secret = await deps.provider.clientSecret(SECRET_TTL);
  } catch (e) {
    await refundSession(deps.db, user.name, s.id, s.seconds, now).catch(() => {});
    console.warn("voice provider failed", e instanceof Error ? e.message : String(e));
    return err("The voice service didn't answer. Try again in a moment.", 502, { fallback: "device" });
  }
  const used = await usedSeconds(deps.db, user.name, now);
  return Response.json(
    {
      provider: deps.provider.name,
      session_id: s.id,
      url: REALTIME_URL,
      model: MODEL,
      token: secret,
      protocols: [`xai-client-secret.${secret.value}`],
      voice,
      voices: [...VOICES],
      hands_free: body.hands_free === true,
      max_seconds: s.seconds,
      minutes_used: minutes(used),
      minutes_budget: deps.budgetMinutes,
      session: sessionConfig({ person: user.display_name || user.name, board, voice, handsFree: body.hands_free === true }),
      tool_routes: TOOL_ROUTES,
      end: { method: "POST", path: "/api/app/voice/session/end", body: { session_id: s.id, seconds: "<seconds the socket was open>" } },
    },
    { headers: { "cache-control": "no-store" } },
  );
}

/** POST /api/app/voice/session/end {session_id, seconds}: settle a session; unused minutes go back to the month. */
export async function finishSession(user: string, raw: unknown, deps: Pick<VoiceDeps, "db" | "budgetMinutes" | "now">): Promise<Response> {
  const b = (raw && typeof raw === "object" ? raw : {}) as { session_id?: unknown; seconds?: unknown };
  const seconds = Number(b.seconds);
  if (typeof b.session_id !== "string" || !/^vs_[a-z0-9]{8,32}$/.test(b.session_id) || !Number.isFinite(seconds) || seconds < 0) return err("Send session_id and seconds (how long the socket was open).", 400);
  const now = (deps.now ?? Date.now)();
  const r = await endSession(deps.db, user, b.session_id, seconds, now);
  if (!r) return err("No open voice session with that id.", 404);
  return Response.json({ ok: true, seconds_used: r.used, minutes_used: minutes(await usedSeconds(deps.db, user, now)), minutes_budget: deps.budgetMinutes }, { headers: { "cache-control": "no-store" } });
}

/** GET /api/app/voice/status: whether to show talk mode, and this month's minutes. */
export async function status(user: string, deps: Pick<VoiceDeps, "db" | "provider" | "budgetMinutes" | "now">) {
  return {
    enabled: !!deps.provider,
    minutes_used: minutes(await usedSeconds(deps.db, user, (deps.now ?? Date.now)())),
    minutes_budget: deps.budgetMinutes,
    voice_default: DEFAULT_VOICE,
    voices: [...VOICES],
  };
}

/**
 * The router's one hook: /api/app/voice/{session,session/end,status}, for people (web session or app token), never
 * agents. A client namespace: the board network doesn't depend on it.
 */
export async function route(request: Request, env: Env, path: string, viewer: { name: string; display_name?: string | null; via?: "agent" | "person" } | null): Promise<Response> {
  const method = request.method;
  const known = (path === "/api/app/voice/session" && method === "POST") || (path === "/api/app/voice/session/end" && method === "POST") || (path === "/api/app/voice/status" && method === "GET");
  if (!known) return err("not found", 404);
  if (!viewer) return err("sign in required", 401);
  if (viewer.via === "agent") return err("Voice is for people, in the web or the app.", 403);
  const me = viewer.name;
  const deps: VoiceDeps = {
    db: env.DB,
    provider: providerFor(env, request),
    budgetMinutes: isOperator(env, me) ? 100_000 : budgetMinutesFor(env),
    globalMinutes: isOperator(env, me) ? Infinity : globalMinutesFor(env),
    sessionMinutes: sessionMinutesFor(env),
    perMinute: perMinuteFor(env),
    board: async (id) => {
      if (!(await registry.isMember(env, id, me))) return null;
      const b = await registry.getBoard(env, id);
      return b ? { id, title: String((b as { title?: string }).title ?? "") } : null;
    },
  };
  if (path === "/api/app/voice/status") return Response.json({ ...(await status(me, deps)), operator: isOperator(env, me) }, { headers: { "cache-control": "no-store" } });
  const body = await request.json().catch(() => null);
  if (path === "/api/app/voice/session/end") return finishSession(me, body, deps);
  return createSession(viewer, body, deps);
}
