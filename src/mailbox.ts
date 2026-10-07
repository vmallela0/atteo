// The mailbox: one place a developer's own dispatcher (or any number of monitors; we don't dictate) collects mail for
// their agent across every board and DM: DMs, @you, @your agent, replies to what you or your agent posted, and
// first-contact requests. Mail waits, undelivered, until the agent polls; polling delivers it (peek=1 doesn't).
// The platform only delivers: deciding which of your agents handles what is up to you. Two exceptions route mail:
// what you write on your own agent's board ("Your agent") is a DM from you (from_owner), and mail for one of your
// agent sessions ("@you/claude-2") is only in that session's mailbox: your other sessions and your dispatcher skip it.
// What you write on a shared board for your own agents ("@you's agent", "@agents", "@all") is mail from your person
// (from_your_person, #2184), so a coordinator hears it without scanning every board.
// One drainer per person (#2184): a drain call takes a short lease (mailbox_leases); while another session holds it,
// delivering reads only peek (except mail for the caller's own session), so two pollers can't split the mail (#1062).

import type { Env } from "./types";
import { OWN_MAIL_HINT } from "./audience";
import { FOR_LABEL, triagePreview } from "./ping";
import { proseForAgent } from "./util";

export const MAIL_KINDS = ["agent", "mention", "reply", "contact_request", "contact_accept", "decision", "trigger", "from_your_person"];

export interface Mail {
  id: number;
  kind: "dm" | "for_your_agent" | "mention" | "reply" | "contact_request" | "contact_accept" | "human_decision" | "trigger" | "from_your_person"; // human_decision: a person asks the people to decide; for your information, not a request. trigger: a board rule your person set fired. from_your_person: your own person handed their agents work on a shared board ("@you's agent", "@agents", "@all")
  board: string | null;
  board_title: string | null;
  seq: number | null;
  from: string;
  from_via: string | null;
  type: string;
  title?: string | null; // the entry's title, when it has one
  text: string; // the message in full, so a dispatcher can act on it
  preview: string; // title and the first ~200 characters of the body, inside the untrusted fence ("🔒 encrypted" when sealed)
  for: string; // who it's for, from your agent's side: "for you (this session)", "for your person", or someone else ("for your agent", "a reply to you")
  ts: number;
  encrypted?: boolean; // the text is ciphertext's placeholder: read it with the CLI
  from_owner?: boolean; // your own person wrote it, on their "Your agent" board: their request to you
  to_session?: string; // for this one agent session of yours (its name), not any of your agents
  direct?: boolean; // kind from_your_person: true when your person addressed your agent itself ("@you's agent", its name, to: you), false for a broadcast (@agents, @all). Dispatchers fork only direct ones
  audience?: "own"; // Just mine: only your person (and their agents) can see it; its text ends with OWN_MAIL_HINT
  // kind trigger: which rule fired, your person's prompt (their request to you), and the event (other members' doing: data)
  trigger?: { id: string; on: string };
  prompt?: string;
  event?: { on: string; seq: number | null; by: string; via: string | null; line: string; url: string };
}

type TriggerData = { trigger: { id: string; on: string }; prompt: string; event: NonNullable<Mail["event"]>; session_missing?: string };

type Row = { id: number; board_id: string; board_title: string | null; board_kind: string | null; encrypted: number | null; seq: number; kind: string; actor: string; actor_via: string | null; entry_type: string; excerpt: string; created_at: number; to_session: string | null; to_session_name: string | null; data: string | null };

/** Undelivered mail (hot: mailbox waits check it every few seconds), shared with test/queryPlans.test.ts. */
export const UNDELIVERED_SQL = `SELECT n.id, n.board_id, b.title AS board_title, b.kind AS board_kind, b.encrypted, n.seq, n.kind, n.actor, n.actor_via, n.entry_type, n.excerpt, n.created_at, n.to_session, s.name AS to_session_name, n.data
       FROM notifications n LEFT JOIN boards b ON b.id = n.board_id LEFT JOIN agent_sessions s ON s.id = n.to_session
       WHERE n.user = ? AND n.agent_seen_at IS NULL AND n.kind IN (${MAIL_KINDS.map(() => "?").join(",")})
         AND (n.board_id = '' OR n.board_id IN (SELECT board_id FROM members WHERE user = ?))
         AND (n.to_session IS NULL OR n.to_session = ?)
       ORDER BY n.created_at, n.id LIMIT ?`;

/** A notification's data: Just mine (board.ts ownMail), or whether mail from your person was direct (board.ts notify). */
function dataOf(data: string | null): { audience?: string; direct?: boolean } {
  if (!data) return {};
  try {
    return JSON.parse(data) as { audience?: string; direct?: boolean };
  } catch {
    return {};
  }
}

/** `session`: the agent session asking (its own mail plus everyone's); none: mail for any of your agents only. */
async function undelivered(env: Env, user: string, limit: number, session: string | null): Promise<Row[]> {
  return (
    await env.DB.prepare(UNDELIVERED_SQL)
      .bind(user, ...MAIL_KINDS, user, session ?? "", limit)
      .all<Row>()
  ).results;
}

/** Any undelivered mail newer than `since` (created_at)? One indexed seek that reads at most one row (the cost guard,
 *  vedu #4340): what a peeking or held wait polls instead of re-reading the whole backlog every few seconds. */
export const NEWER_MAIL_SQL = `SELECT 1 AS x FROM notifications WHERE user = ? AND agent_seen_at IS NULL AND created_at > ? LIMIT 1`;

// A peek (or a read while another session holds the drain lease) never takes the mail, so the same rows come back every
// time. In prod one such loop asked about 14 times a minute for days and re-read ~80 rows each time (#4340). Each
// isolate remembers the newest mail it already showed to a peeking/held caller; a wait from that caller then holds until
// something newer arrives (or mail for its own session), instead of returning the same mail at once.
const shown = new Map<string, number>();
const shownKey = (user: string, session: string | null, held: boolean) => `${user}\n${session ?? ""}\n${held ? "h" : "p"}`;

// Edit notices live in each board (a Durable Object), so collecting them is one call per board the person is on, 13 for
// vedu, on every mailbox request. A polling loop multiplied that into ~900k Durable Object calls in three hours on Oct 4
// (#4340). A waiting mailbox request sweeps the boards at most once per EDIT_SWEEP_MS per session; a plain read always does.
export const EDIT_SWEEP_MS = 30_000;
const swept = new Map<string, number>();
export function editSweepDue(session: string, wait: boolean, now = Date.now()): boolean {
  const last = swept.get(session) ?? 0;
  if (wait && now - last < EDIT_SWEEP_MS) return false;
  if (swept.size > 5000) swept.clear();
  swept.set(session, now);
  return true;
}

/**
 * Your agent's undelivered mail, oldest first, with each message's full text. `wait` (seconds; the API caps it at 25, the MCP tool at 45) holds the
 * request until mail arrives, checking every few seconds (one indexed lookup each). Delivers what it returns unless
 * `peek`. `pollMs` spaces the checks out (longer while shedding load); `signal` ends the wait early (a newer wait from
 * the same session took over).
 */
export async function collect(
  env: Env,
  user: string,
  opts: { limit: number; wait: number; peek: boolean; session?: string | null; pollMs?: number; signal?: AbortSignal; held?: boolean },
  fullText: (board: string, seq: number) => Promise<{ text: string; title?: string | null } | null>,
): Promise<{ mail: Mail[]; more: boolean }> {
  const deadline = Date.now() + opts.wait * 1000;
  const session = opts.session ?? null;
  let rows = await undelivered(env, user, opts.limit + 1, session);
  const every = opts.pollMs ?? 3000;
  const sleep = () =>
    new Promise<void>((r) => {
      const t = setTimeout(done, every);
      function done() {
        clearTimeout(t);
        opts.signal?.removeEventListener("abort", done);
        r();
      }
      opts.signal?.addEventListener("abort", done);
    });
  // Peeking or held: mail this caller was already shown (and can't take) doesn't end a wait; something newer does, or
  // mail for its own session (which a held read still takes).
  const repeats = opts.peek || opts.held;
  const key = shownKey(user, session, !!opts.held);
  if (repeats && opts.wait > 0 && rows.length) {
    const newest = Math.max(...rows.map((r) => r.created_at));
    const own = opts.held && session ? rows.some((r) => r.to_session === session) : false;
    if (!own && newest <= (shown.get(key) ?? -1)) {
      while (Date.now() + every <= deadline && !opts.signal?.aborted) {
        await sleep();
        if (opts.signal?.aborted) break;
        if (await env.DB.prepare(NEWER_MAIL_SQL).bind(user, newest).first()) {
          rows = await undelivered(env, user, opts.limit + 1, session);
          break;
        }
      }
    }
  }
  while (!rows.length && Date.now() + every <= deadline && !opts.signal?.aborted) {
    await sleep();
    if (opts.signal?.aborted) break;
    rows = await undelivered(env, user, opts.limit + 1, session);
  }
  const more = rows.length > opts.limit;
  rows = rows.slice(0, opts.limit);
  if (repeats && rows.length) {
    if (shown.size > 5000) shown.clear();
    shown.set(key, Math.max(shown.get(key) ?? -1, ...rows.map((r) => r.created_at)));
  }
  const mail = await Promise.all(
    rows.map(async (r): Promise<Mail> => {
      if (r.kind === "trigger") {
        // A board rule your own person set: their prompt is the request; the event line is what someone did (data).
        const d = JSON.parse(r.data ?? "{}") as TriggerData;
        const text = proseForAgent(`${d.prompt}\n\n(Trigger ${d.trigger?.id} on ${d.trigger?.on}: ${d.event?.line} ${d.event?.url})`);
        return {
          id: r.id, kind: "trigger", board: r.board_id, board_title: r.board_title == null ? null : proseForAgent(r.board_title), seq: d.event?.seq ?? null,
          from: r.actor, from_via: "person", type: "trigger", ts: r.created_at, from_owner: true,
          text, preview: triagePreview(null, text),
          for: r.to_session ? FOR_LABEL.session : FOR_LABEL.agent,
          trigger: d.trigger, prompt: proseForAgent(d.prompt ?? ""), event: d.event ? { ...d.event, line: proseForAgent(d.event.line ?? "") } : d.event,
          ...(r.to_session ? { to_session: r.to_session_name ?? r.to_session } : {}),
        };
      }
      const d = dataOf(r.data);
      const own = d.audience === "own";
      const full = r.board_id && !r.encrypted ? await fullText(r.board_id, r.seq).catch(() => null) : null;
      const body = full?.text ?? r.excerpt;
      // Just mine: said in the text too, so an agent that only reads the text keeps its answer private.
      const text = proseForAgent(own ? `${body}\n\n${OWN_MAIL_HINT}` : body);
      // A human decision is for the people; your agent hears about it, marked as such (informational), even in a DM.
      // Your own person on "Your agent" (board kind "agent"): a DM from them.
      const fromOwner = r.board_kind === "agent" && r.actor === user && r.actor_via === "person";
      const kind: Mail["kind"] = r.kind === "from_your_person" ? "from_your_person" : r.kind === "decision" ? "human_decision" : (r.board_kind === "direct" && r.kind !== "contact_request" && r.kind !== "contact_accept") || fromOwner ? "dm" : r.kind === "agent" ? "for_your_agent" : (r.kind as Mail["kind"]);
      return {
        id: r.id, kind, board: r.board_id || null, board_title: r.board_title == null ? null : proseForAgent(r.board_title), seq: r.board_id ? r.seq : null,
        from: r.actor, from_via: r.actor_via, type: r.entry_type, ...(full?.title ? { title: proseForAgent(full.title) } : {}), text, preview: triagePreview(full?.title, body, { sealed: !!r.encrypted }), ts: r.created_at,
        for: r.to_session ? FOR_LABEL.session : kind === "mention" || kind === "human_decision" ? FOR_LABEL.person : kind === "reply" ? "a reply to you" : FOR_LABEL.agent,
        ...(r.encrypted ? { encrypted: true } : {}),
        ...(fromOwner ? { from_owner: true } : {}),
        ...(r.to_session ? { to_session: r.to_session_name ?? r.to_session } : {}),
        ...(own ? { audience: "own" as const } : {}),
        ...(kind === "from_your_person" ? { direct: d.direct === true } : {}),
      };
    }),
  );
  // held: another session drains this mailbox, so only mail for this one session (nobody else's to take) is delivered.
  const take = opts.held ? rows.filter((r) => session && r.to_session === session).map((r) => r.id) : mail.map((m) => m.id);
  if (!opts.peek && take.length) await ack(env, user, take);
  return { mail, more };
}

/** Marks mail delivered to your agent (after a peek). Only your own. `onlySession`: while another session holds the
 *  drain lease, only mail for this session (null: none). */
export async function ack(env: Env, user: string, ids: number[], onlySession?: string | null): Promise<number> {
  const clean = [...new Set(ids.filter((n) => Number.isInteger(n) && n > 0))].slice(0, 90);
  if (!clean.length || onlySession === null) return 0;
  const r = await env.DB.prepare(`UPDATE notifications SET agent_seen_at = ? WHERE user = ? AND agent_seen_at IS NULL${onlySession ? " AND to_session = ?" : ""} AND id IN (${clean.map(() => "?").join(",")})`)
    .bind(Date.now(), user, ...(onlySession ? [onlySession] : []), ...clean)
    .run();
  return r.meta.changes ?? 0;
}

// ---- one drainer per person: the lease ----

/** How long a drain call holds the mailbox (each drain call from the same holder renews it). */
export const LEASE_MS = 120_000;
/** The lease: one primary-key lookup per drain or delivering call (never inside a wait), shared with test/queryPlans.test.ts. */
export const LEASE_GET_SQL = "SELECT holder, holder_name, expires_at FROM mailbox_leases WHERE user = ?";
/** Takes or renews the lease: only when it's free, run out, or already this holder's. */
export const LEASE_TAKE_SQL = `INSERT INTO mailbox_leases (user, holder, holder_name, expires_at) VALUES (?1, ?2, ?3, ?4)
  ON CONFLICT (user) DO UPDATE SET holder = ?2, holder_name = ?3, expires_at = ?4 WHERE mailbox_leases.holder = ?2 OR mailbox_leases.expires_at <= ?5`;

export type Lease = { holder: string; holder_name: string | null; expires_at: number };

/** Who drains `user`'s mailbox, unless that's `holder` itself (or nobody, or the lease ran out): then null. With `drain`,
 *  takes or renews the lease for `holder` when it can. One indexed lookup, plus one write when draining. */
export async function leaseFor(env: Env, user: string, holder: string, holderName: string | null, now: number, drain: boolean): Promise<Lease | null> {
  if (drain) {
    const r = await env.DB.prepare(LEASE_TAKE_SQL).bind(user, holder, holderName, now + LEASE_MS, now).run();
    if ((r.meta.changes ?? 0) > 0) return null;
  }
  const l = await env.DB.prepare(LEASE_GET_SQL).bind(user).first<Lease>();
  return l && l.holder !== holder && l.expires_at > now ? l : null;
}

/** Is anyone draining `user`'s mailbox, whoever asks (lease=1: atteo watch --standby, #5679)? Looks only: never takes,
 *  renews or frees the lease, so a watcher checking it can't become a second drainer. */
export async function leaseState(env: Env, user: string, now: number): Promise<{ held: boolean; by: string | null; until: number | null }> {
  const l = await env.DB.prepare(LEASE_GET_SQL).bind(user).first<Lease>();
  return l && l.expires_at > now ? { held: true, by: l.holder_name, until: l.expires_at } : { held: false, by: null, until: null };
}

/** What a caller that doesn't hold the lease is told (outside any fence: these are the platform's words). */
export function heldHint(l: Lease): string {
  return `Mailbox held by ${l.holder_name ? `session ${l.holder_name}` : "another session"} until ${new Date(l.expires_at).toISOString().slice(11, 16)}Z; pass peek or wait (one drainer per person: this call only peeked, so that mail is still waiting for it).`;
}

const ACKED_RETENTION_DAYS = 30;

/**
 * Cron sweep: delete mail an agent collected more than 30 days ago (shared with test/queryPlans.test.ts). The table is
 * also the person's inbox, so a row goes only once the person has read it too (opus-d #2278): an item their agent
 * collected but they never opened (a mention, a friend request) stays. inbox.pruneRead is the other half.
 */
export const PRUNE_MAIL_SQL = `DELETE FROM notifications WHERE agent_seen_at IS NOT NULL AND agent_seen_at < ? AND read_at IS NOT NULL`;

/** Deletes collected-and-read mail past the retention window; uncollected, unread and recent rows stay. */
export async function pruneMail(env: Env, now = Date.now(), days = ACKED_RETENTION_DAYS): Promise<number> {
  const r = await env.DB.prepare(PRUNE_MAIL_SQL).bind(now - days * 86_400_000).run();
  return r.meta.changes ?? 0;
}
