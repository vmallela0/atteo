// Read aloud: POST /api/app/tts turns a message (or a short text) into speech for a signed-in person (web or app; never an
// agent). The voice comes from a TtsProvider (xAI Grok voices today). Guardrails: a per-person monthly character
// budget (D1 tts_usage), a per-person rate limit (D1 rate_limits) and a 7-day cache by hash(voice+text), so a replay
// costs nothing. Without a provider key the route answers 503 and clients use the device's own voice.
// {board, seq, from: true} reads "<author>: <text>" ("theo's agent: …" for an agent's post): the app's voice call reads
// new messages aloud while it stands by (jxn #2071), and who said it is part of what's heard.

import { savedVoice } from "./social";
import type { Env } from "./types";
import * as registry from "./registry";
import { isLocalHost } from "./util";

export const MAX_TEXT = 2000; // characters per request (raw `text`; a board message is cleaned, then cut to this)
export const DEFAULT_BUDGET = 900_000; // characters per person per month ≈ 15 h of speech
export const DEFAULT_PER_MINUTE = 30;
export const CACHE_SECONDS = 7 * 24 * 3600;
export const VOICES = ["eve", "ara", "leo", "rex", "sal"] as const;
export type Voice = (typeof VOICES)[number];
export const DEFAULT_VOICE: Voice = "eve"; // xAI's own default
export const NOT_SET_UP = "Voice isn't set up yet";
const FORMAT = "mp3-24k-64k"; // part of the cache key: change it when the output format changes

export interface TtsAudio {
  body: ReadableStream<Uint8Array>;
  contentType: string;
}

/** A text-to-speech service. speak() rejects with TtsProviderError when the service fails. */
export interface TtsProvider {
  name: string;
  speak(text: string, voice: Voice): Promise<TtsAudio>;
}

export class TtsProviderError extends Error {}

// ---------- xAI ----------

/**
 * The one call to xAI's text-to-speech API (docs.x.ai/developers/model-capabilities/audio/text-to-speech and
 * docs.x.ai/developers/rest-api-reference/inference/voice): POST https://api.x.ai/v1/tts with a Bearer key and
 * {text, voice_id, language, output_format}. The guide says the answer is the audio bytes; the reference schema shows
 * JSON {audio: base64, content_type}; both are handled.
 */
export async function xaiSpeak(key: string, text: string, voice: Voice, fetcher: typeof fetch = fetch): Promise<TtsAudio> {
  let res: Response;
  try {
    res = await fetcher("https://api.x.ai/v1/tts", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ text, voice_id: voice, language: "auto", output_format: { codec: "mp3", sample_rate: 24000, bit_rate: 64000 } }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new TtsProviderError(`xAI TTS unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => {});
    throw new TtsProviderError(`xAI TTS answered ${res.status}`);
  }
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("json")) {
    const j = (await res.json().catch(() => null)) as { audio?: string; content_type?: string } | null;
    if (!j?.audio) throw new TtsProviderError("xAI TTS answered JSON without audio");
    const bytes = Uint8Array.from(atob(j.audio), (ch) => ch.charCodeAt(0));
    return { body: new Response(bytes).body!, contentType: j.content_type || "audio/mpeg" };
  }
  return { body: res.body, contentType: type.startsWith("audio/") ? type : "audio/mpeg" };
}

export function xaiProvider(key: string, fetcher?: typeof fetch): TtsProvider {
  return { name: "xai", speak: (text, voice) => xaiSpeak(key, text, voice, fetcher) };
}

/** No network: a short silent WAV. Only for local runs (see providerFor). */
export const fakeProvider: TtsProvider = {
  name: "fake",
  speak: async () => ({ body: new Response(silentWav(0.2)).body!, contentType: "audio/wav" }),
};

/** `seconds` of 8 kHz mono PCM16 silence as a WAV file. */
export function silentWav(seconds: number): Uint8Array {
  const n = Math.round(8000 * seconds);
  const out = new Uint8Array(44 + n * 2);
  const v = new DataView(out.buffer);
  const ascii = (o: number, s: string) => [...s].forEach((c, i) => (out[o + i] = c.charCodeAt(0)));
  ascii(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, 8000, true); // rate
  v.setUint32(28, 16000, true); // bytes per second
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits
  ascii(36, "data");
  v.setUint32(40, n * 2, true);
  return out;
}

/**
 * The configured provider, or null (no key: the feature is off and clients use the device voice). Like voice.ts: on
 * localhost with DEV_FAKE_VOICE=1 in the local .dev.vars (never wrangler.jsonc) and no key, a request carrying
 * x-dev-fake-voice: 1 gets the fake provider (the app's voice-call tests hear new messages read without xAI). A
 * deployed Worker is never reached as localhost.
 */
export function providerFor(env: Pick<Env, "XAI_API_KEY" | "DEV_FAKE_VOICE">, request?: Request): TtsProvider | null {
  if (env.XAI_API_KEY) return xaiProvider(env.XAI_API_KEY);
  if (request && env.DEV_FAKE_VOICE === "1" && request.headers.get("x-dev-fake-voice") === "1" && isLocalHost(new URL(request.url).hostname)) return fakeProvider;
  return null;
}

// ---------- text ----------

/** Markdown → something worth hearing: no code, no URLs, no markup. Speaks the text as written (no summarising). */
export function cleanForSpeech(input: string): string {
  let s = input.replace(/\r\n?/g, "\n");
  // Fenced code (an unclosed fence runs to the end).
  s = s.replace(/^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(?:^[ \t]*\1[ \t]*$|(?![\s\S]))/gm, "\n(code omitted)\n");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt: string) => (alt.trim() ? ` ${alt} ` : " "));
  s = s.replace(/\[([^\]]+)\]\((?:[^()\s]|\([^)]*\))*(?:\s+"[^"]*")?\)/g, "$1");
  s = s.replace(/<(https?:\/\/[^>\s]+)>/g, "$1");
  s = s.replace(/<\/?[a-zA-Z][^>]*>/g, " ");
  s = s.replace(/\bhttps?:\/\/[^\s<>()]+/g, (u) => {
    try {
      return new URL(u.replace(/[.,;:!?'"]+$/, "")).hostname.replace(/^www\./, "") + (u.match(/[.,;:!?]+$/)?.[0] ?? "");
    } catch {
      return "a link";
    }
  });
  const lines = s.split("\n").map((l) => {
    if (/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(l) && l.includes("|")) return ""; // table separator
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(l)) return ""; // horizontal rule
    l = l.replace(/^\s{0,3}#{1,6}\s+/, "").replace(/\s+#+\s*$/, ""); // heading
    l = l.replace(/^\s*(>\s?)+/, ""); // quote
    l = l.replace(/^\s*[-*+]\s+(\[[ xX]\]\s+)?/, ""); // bullet / checkbox
    if (/^\s*\|.*\|\s*$/.test(l)) l = l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()).filter(Boolean).join(", ");
    return l;
  });
  s = lines.join("\n");
  s = s.replace(/`([^`\n]+)`/g, "$1").replace(/`+/g, "");
  s = s.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2");
  s = s.replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, "$1$2");
  s = s.replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1$2");
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1");
  s = s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  s = s.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

/** At most `max` characters, ending at a sentence (or else a word) when one is near the end. */
export function capLength(s: string, max = MAX_TEXT): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sentence = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "), cut.lastIndexOf("\n"));
  if (sentence >= max * 0.6) return cut.slice(0, sentence + 1).trim();
  const word = cut.lastIndexOf(" ");
  return (word >= max * 0.6 ? cut.slice(0, word) : cut).trim();
}

/** A name on one line, as it's said. */
const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);

// ---------- guardrails ----------

export const monthOf = (now: number) => new Date(now).toISOString().slice(0, 7);

export function budgetFor(env: Pick<Env, "TTS_MONTHLY_CHARS">): number {
  const n = Number(env.TTS_MONTHLY_CHARS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_BUDGET;
}
/** Operators (env OPERATORS, comma-separated usernames; vedu #1584) skip the per-person and shared caps; their use still counts. */
export function isOperator(env: Pick<Env, "OPERATORS">, user: string): boolean {
  return String(env.OPERATORS ?? "").split(",").map((u) => u.trim().toLowerCase()).filter(Boolean).includes(user.toLowerCase());
}
/** All people together, per month (vedu #1582: strict caps). "*" is the shared row in tts_usage; no username can be "*". */
export const ALL = "*";
export const DEFAULT_GLOBAL_CHARS = 2_000_000; // ~$30/month of xAI TTS at $15 per 1M characters
export function globalBudgetFor(env: Pick<Env, "TTS_GLOBAL_MONTHLY_CHARS">): number {
  const n = Number(env.TTS_GLOBAL_MONTHLY_CHARS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_GLOBAL_CHARS;
}
export function perMinuteFor(env: Pick<Env, "TTS_PER_MINUTE">): number {
  const n = Number(env.TTS_PER_MINUTE);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_PER_MINUTE;
}

/** One request against the person's per-minute limit (fixed 60 s window in rate_limits, swept by the cron). `kind` keeps features apart (voice.ts uses "voice"). */
export async function rateHit(db: D1Database, user: string, limit: number, now: number, kind = "tts"): Promise<{ ok: boolean; retryAfter: number }> {
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, n, reset_at) VALUES (?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET n = CASE WHEN rate_limits.reset_at <= ? THEN 1 ELSE rate_limits.n + 1 END,
         reset_at = CASE WHEN rate_limits.reset_at <= ? THEN excluded.reset_at ELSE rate_limits.reset_at END
       RETURNING n, reset_at`,
    )
    .bind(`${kind}:${user}`, now + 60_000, now, now)
    .first<{ n: number; reset_at: number }>();
  return { ok: (row?.n ?? 1) <= limit, retryAfter: Math.max(1, Math.ceil(((row?.reset_at ?? now + 60_000) - now) / 1000)) };
}

export async function usedChars(db: D1Database, user: string, now: number): Promise<number> {
  const r = await db.prepare(`SELECT chars FROM tts_usage WHERE user = ? AND month = ?`).bind(user, monthOf(now)).first<{ chars: number }>();
  return r?.chars ?? 0;
}

/** Takes `n` characters from this month's budget, all or nothing. False: it would go past the budget. */
export async function reserve(db: D1Database, user: string, n: number, budget: number, now: number, globalBudget = Infinity): Promise<boolean> {
  const month = monthOf(now);
  if (Number.isFinite(globalBudget) && (await usedChars(db, ALL, now)) + n > globalBudget) return false; // everyone's month is spent
  const [, upd] = await db.batch<{ chars: number }>([
    db.prepare(`INSERT OR IGNORE INTO tts_usage (user, month, chars, requests) VALUES (?, ?, 0, 0)`).bind(user, month),
    db.prepare(`UPDATE tts_usage SET chars = chars + ?, requests = requests + 1 WHERE user = ? AND month = ? AND chars + ? <= ? RETURNING chars`).bind(n, user, month, n, budget),
  ]);
  if (!(upd?.results?.length ?? 0)) return false;
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO tts_usage (user, month, chars, requests) VALUES (?, ?, 0, 0)`).bind(ALL, month),
    db.prepare(`UPDATE tts_usage SET chars = chars + ?, requests = requests + 1 WHERE user = ? AND month = ?`).bind(n, ALL, month),
  ]);
  return true;
}

/** Gives characters back when the provider failed (nothing was spoken). */
export async function refund(db: D1Database, user: string, n: number, now: number): Promise<void> {
  await db.prepare(`UPDATE tts_usage SET chars = MAX(0, chars - ?), requests = MAX(0, requests - 1) WHERE user IN (?, ?) AND month = ?`).bind(n, user, ALL, monthOf(now)).run();
}

export async function cacheKey(voice: Voice, text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${FORMAT}\n${voice}\n${text}`));
  return `https://tts.atteo.invalid/v1/${[...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// ---------- the routes ----------

/** A board message to read: its text, and who wrote it (author; via "agent" for an agent's post). */
export type EntryText = { text: string; author?: string; via?: string | null } | { error: string; status: number };

export interface TtsDeps {
  db: D1Database;
  provider: TtsProvider | null;
  cache: Pick<Cache, "match" | "put"> | null; // caches.default in the Worker; null skips caching
  budget: number;
  /** The person's saved voice (display.voice), used when a request names none (vedu #1717). */
  defaultVoice?: Voice;
  /** Everyone's characters per month; Infinity for operators, who skip both caps (vedu #1584). */
  globalBudget?: number;
  perMinute: number;
  /** A board message's text for this person: checks membership and refuses encrypted boards. */
  entryText: (board: string, seq: number) => Promise<EntryText>;
  waitUntil?: (p: Promise<unknown>) => void;
  now?: () => number;
}

const err = (error: string, status: number, extra: Record<string, unknown> = {}, headers: HeadersInit = {}) => Response.json({ error, ...extra }, { status, headers });

/** POST /api/app/tts {text, voice?} or {board, seq, voice?, from?} → audio/mpeg. from: true reads "<author>: <text>". */
export async function speak(user: string, raw: unknown, deps: TtsDeps): Promise<Response> {
  const body = (raw && typeof raw === "object" ? raw : {}) as { text?: unknown; voice?: unknown; board?: unknown; seq?: unknown; from?: unknown };
  const voice = (body.voice == null || body.voice === "" ? (deps.defaultVoice ?? DEFAULT_VOICE) : String(body.voice).toLowerCase()) as Voice;
  if (!VOICES.includes(voice)) return err(`Unknown voice. Pick one of: ${VOICES.join(", ")}.`, 400);
  const hasText = body.text != null && body.text !== "";
  const hasRef = body.board != null || body.seq != null;
  if (hasText === hasRef) return err("Send either text, or board and seq (a message to read aloud).", 400);

  let text: string;
  if (hasText) {
    if (typeof body.text !== "string") return err("text must be a string.", 400);
    if (body.text.length > MAX_TEXT) return err(`Too long to read aloud: at most ${MAX_TEXT.toLocaleString("en-US")} characters.`, 400);
    text = cleanForSpeech(body.text);
  } else {
    const board = typeof body.board === "string" ? body.board : "";
    const seq = Number(body.seq);
    if (!/^b_[a-z0-9]{8,32}$/.test(board) || !Number.isInteger(seq) || seq < 1) return err("board must be a board id and seq a message number.", 400);
    const got = await deps.entryText(board, seq);
    if ("error" in got) return err(got.error, got.status, got.status === 400 ? { fallback: "device" } : {});
    text = capLength(cleanForSpeech(got.text));
    if (body.from === true && got.author && text.replace(/\(code omitted\)/g, "").trim()) {
      const who = oneLine(got.via === "agent" ? `${got.author}'s agent` : got.author);
      text = capLength(`${who}: ${text}`);
    }
  }
  if (!text.replace(/\(code omitted\)/g, "").trim()) return err("Nothing to read aloud there.", 400);
  if (!deps.provider) return err(NOT_SET_UP, 503, { fallback: "device" });

  const now = (deps.now ?? Date.now)();
  const rl = await rateHit(deps.db, user, deps.perMinute, now);
  if (!rl.ok) return err(`Too many read-alouds: at most ${deps.perMinute} a minute. Try again in ${rl.retryAfter}s.`, 429, {}, { "retry-after": String(rl.retryAfter) });

  const headers = { "content-type": "audio/mpeg", "cache-control": "private, no-store", "x-tts-chars": String(text.length), "x-tts-voice": voice };
  const key = await cacheKey(voice, text);
  const hit = deps.cache ? await deps.cache.match(key).catch(() => undefined) : undefined;
  if (hit?.body) return new Response(hit.body, { headers: { ...headers, "content-type": hit.headers.get("content-type") || "audio/mpeg", "x-tts-cache": "hit" } });

  if (!(await reserve(deps.db, user, text.length, deps.budget, now, deps.globalBudget ?? Infinity)))
    return err(`You've used this month's read-aloud allowance (${deps.budget.toLocaleString("en-US")} characters). It resets on the 1st; the device voice still works.`, 429, { fallback: "device" });
  let audio: TtsAudio;
  try {
    audio = await deps.provider.speak(text, voice);
  } catch (e) {
    await refund(deps.db, user, text.length, now).catch(() => {});
    console.warn("tts provider failed", e instanceof Error ? e.message : String(e));
    return err("The voice service didn't answer. Try again, or use the device voice.", 502, { fallback: "device" });
  }
  let out = audio.body;
  if (deps.cache) {
    const [a, b] = audio.body.tee();
    out = a;
    const put = deps.cache.put(key, new Response(b, { headers: { "content-type": audio.contentType, "cache-control": `public, max-age=${CACHE_SECONDS}` } })).catch((e) => console.warn("tts cache put failed", e instanceof Error ? e.message : String(e)));
    if (deps.waitUntil) deps.waitUntil(put);
  }
  return new Response(out, { headers: { ...headers, "content-type": audio.contentType, "x-tts-cache": "miss" } });
}

/** GET /api/app/tts/status: whether to show read-aloud, and how much of the month's allowance is left. */
export async function status(user: string, deps: Pick<TtsDeps, "db" | "provider" | "budget" | "now" | "defaultVoice">) {
  return {
    enabled: !!deps.provider,
    voice_default: deps.defaultVoice ?? DEFAULT_VOICE,
    voices: [...VOICES],
    used_chars: await usedChars(deps.db, user, (deps.now ?? Date.now)()),
    budget_chars: deps.budget,
  };
}

/**
 * The router's one hook: POST /api/app/tts and GET /api/app/tts/status, for people (web session or app token), never
 * agents. A client namespace: the board network doesn't depend on it, and another frontend can ignore it.
 */
export async function route(request: Request, env: Env, ctx: ExecutionContext, path: string, viewer: { name: string; via?: "agent" | "person" } | null): Promise<Response> {
  const method = request.method;
  if (!((path === "/api/app/tts" && method === "POST") || (path === "/api/app/tts/status" && method === "GET"))) return err("not found", 404);
  if (!viewer) return err("sign in required", 401);
  if (viewer.via === "agent") return err("Read aloud is for people, in the web or the app.", 403);
  const me = viewer.name;
  const provider = providerFor(env, request);
  const deps: TtsDeps = {
    defaultVoice: await savedVoice(env, me),
    db: env.DB,
    provider,
    cache: typeof caches !== "undefined" && provider !== fakeProvider ? caches.default : null, // the fake's silence is never cached
    budget: isOperator(env, me) ? Number.MAX_SAFE_INTEGER : budgetFor(env),
    globalBudget: isOperator(env, me) ? Infinity : globalBudgetFor(env),
    perMinute: perMinuteFor(env),
    waitUntil: (p) => ctx.waitUntil(p),
    entryText: async (bid, seq) => {
      if (!(await registry.isMember(env, bid, me))) return { error: "board not found", status: 404 };
      const b = await registry.getBoard(env, bid);
      if (!b) return { error: "board not found", status: 404 };
      if ((b as { encrypted?: number }).encrypted) return { error: "End-to-end encrypted boards can't be read aloud by the server: it can't read them. Use the device voice.", status: 400 };
      const g = await env.BOARD.get(env.BOARD.idFromName(bid)).get(seq, { user: me, person: true }).catch(() => null); // people only (checked above): their own people-only messages too
      if (!g || g.replies.some((r) => r.retracts === seq)) return { error: "That message isn't there.", status: 404 };
      return { text: g.entry.text, author: g.entry.author, via: g.entry.via };
    },
  };
  if (path === "/api/app/tts/status") return Response.json({ ...(await status(me, deps)), operator: isOperator(env, me) }, { headers: { "cache-control": "no-store" } });
  return speak(me, await request.json().catch(() => null), deps);
}
