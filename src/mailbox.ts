// The mailbox: one place a developer's own dispatcher (or any number of monitors; we don't dictate) collects mail for
// their agent across every board and DM: DMs, @you, @your agent, replies to what you or your agent posted, and
// first-contact requests. Mail waits, undelivered, until the agent reads it; a waiting read is pushed awake.
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
import { discordLabel, linearLabel, notionLabel } from "./state";
import { sendCountAlert } from "./agentEmail";

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

/** Undelivered mail, shared with test/queryPlans.test.ts. `direct`:
 *  only mail on direct-message boards (a standby watcher's peek, kinds=dm: other mail nobody drains can't crowd its page
 *  out, #5695). */
const undeliveredSql = (direct: boolean) => `SELECT n.id, n.board_id, b.title AS board_title, b.kind AS board_kind, b.encrypted, n.seq, n.kind, n.actor, n.actor_via, n.entry_type, n.excerpt, n.created_at, n.to_session, s.name AS to_session_name, n.data
       FROM notifications n LEFT JOIN boards b ON b.id = n.board_id LEFT JOIN agent_sessions s ON s.id = n.to_session
       WHERE n.user = ? AND n.agent_seen_at IS NULL AND n.kind IN (${MAIL_KINDS.map(() => "?").join(",")})${direct ? " AND b.kind = 'direct'" : ""}
         AND (n.board_id = '' OR n.board_id IN (SELECT board_id FROM members WHERE user = ?))
         AND (n.to_session = ? OR (n.to_session IS NULL AND (n.data IS NULL OR n.data NOT LIKE '{"each":%' OR instr(n.data, '"' || ? || '"') > 0)))
       ORDER BY n.created_at, n.id LIMIT ?`;
/** Mail for each of your running agents ("@agents" on your agent chat, board.ts notify): one row naming their sessions
 *  ("" is a session-less caller such as a dispatcher), shown to each until that one takes it. */
const EACH = `data LIKE '{"each":%'`;
export const UNDELIVERED_SQL = undeliveredSql(false);
export const UNDELIVERED_DIRECT_SQL = undeliveredSql(true);

/** A notification's data: Just mine (board.ts ownMail), or whether mail from your person was direct (board.ts notify). */
function dataOf(data: string | null): { audience?: string; direct?: boolean; linear?: string; discord?: string; notion?: string } {
  if (!data) return {};
  try {
    return JSON.parse(data) as { audience?: string; direct?: boolean; linear?: string; discord?: string; notion?: string };
  } catch {
    return {};
  }
}

/** `session`: the agent session asking (its own mail plus everyone's); none: mail for any of your agents only. */
async function undelivered(env: Env, user: string, limit: number, session: string | null, direct = false): Promise<Row[]> {
  return (
    await env.DB.prepare(direct ? UNDELIVERED_DIRECT_SQL : UNDELIVERED_SQL)
      .bind(user, ...MAIL_KINDS, user, session ?? "", session ?? "", limit)
      .all<Row>()
  ).results;
}

/** A peeking or held wait checks for a later row without re-reading its backlog. The id handles posts in the same ms. */
export const NEWER_MAIL_SQL = `SELECT 1 AS x FROM notifications WHERE user = ? AND agent_seen_at IS NULL AND created_at >= ? AND (created_at > ? OR id > ?) LIMIT 1`;

// A peek (or a read while another session holds the drain lease) never takes the mail, so the same rows come back every
// time. In prod one such loop asked about 14 times a minute for days and re-read ~80 rows each time (#4340). Each
// isolate remembers the newest mail it already showed to a peeking/held caller; a wait from that caller then holds until
// something newer arrives (or mail for its own session), instead of returning the same mail at once.
const shown = new Map<string, { at: number; id: number }>();
const shownKey = (user: string, session: string | null, held: boolean) => `${user}\n${session ?? ""}\n${held ? "h" : "p"}`;
const newestRow = (rows: Row[]) => rows.reduce((a, r) => r.created_at > a.at || (r.created_at === a.at && r.id > a.id) ? { at: r.created_at, id: r.id } : a, { at: -1, id: -1 });
const later = (a: { at: number; id: number }, b: { at: number; id: number }) => a.at > b.at || (a.at === b.at && a.id > b.id);

/** A board calls this after the D1 notification write. One DO notification per person, regardless of mail kind. */
export async function notifyMailboxes(env: Env, users: Iterable<string>): Promise<void> {
  const unique = [...new Set(users)];
  const results = await Promise.allSettled(unique.map((user) => env.MAILBOX_SIGNAL.get(env.MAILBOX_SIGNAL.idFromName(user)).notify()));
  await Promise.allSettled(unique.map((user) => sendCountAlert(env, user)));
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) throw failed.reason;
}

/** Attach before the first D1 read: a notification racing that read is either in its result or buffered here. */
async function openWake(env: Env, user: string): Promise<{ wait(ms: number, signal?: AbortSignal): Promise<void>; close(): void } | null> {
  if (!env.MAILBOX_SIGNAL) return null; // unit fixtures and older local bindings use the safety poll
  try {
    const socket = (await env.MAILBOX_SIGNAL.get(env.MAILBOX_SIGNAL.idFromName(user)).fetch("https://mailbox/wait", { headers: { Upgrade: "websocket" } })).webSocket;
    if (!socket) return null;
    socket.accept();
    let pending = false, closed = false;
    const listeners = new Set<() => void>();
    const wake = () => { pending = true; for (const listener of listeners) listener(); };
    const lost = () => { closed = true; wake(); };
    socket.addEventListener("message", wake);
    socket.addEventListener("close", lost);
    socket.addEventListener("error", lost);
    return {
      wait(ms, signal) {
        if (pending || signal?.aborted) { pending = false; return Promise.resolve(); }
        return new Promise<void>((resolve) => {
          // Once the socket is gone nothing wakes this wait: poll every 3 s as before push (alt-b #5832).
          const timer = setTimeout(done, closed ? Math.min(ms, 3_000) : ms);
          function done() {
            clearTimeout(timer);
            listeners.delete(done);
            signal?.removeEventListener("abort", done);
            pending = false;
            resolve();
          }
          listeners.add(done);
          signal?.addEventListener("abort", done);
        });
      },
      close() { try { socket.close(1000, "done"); } catch {} },
    };
  } catch { return null; }
}

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
 * request until mail arrives. A per-person DO wakes it after the D1 write; a slow poll recovers missed signals.
 * Delivers what it returns unless `peek`. `signal` ends a superseded wait early.
 */
export async function collect(
  env: Env,
  user: string,
  opts: { limit: number; wait: number; peek: boolean; session?: string | null; pollMs?: number; signal?: AbortSignal; held?: boolean; direct?: boolean },
  fullText: (board: string, seq: number) => Promise<{ text: string; title?: string | null } | null>,
): Promise<{ mail: Mail[]; more: boolean }> {
  const deadline = Date.now() + opts.wait * 1000;
  const session = opts.session ?? null;
  const wake = opts.wait > 0 ? await openWake(env, user) : null;
  let rows: Row[];
  let more = false;
  try {
    rows = await undelivered(env, user, opts.limit + 1, session, !!opts.direct);
    const every = opts.pollMs ?? (wake ? 30_000 : 3_000); // no wake socket: the old 3 s poll (alt-b #5832)
    const sleep = (ms: number) =>
      new Promise<void>((r) => {
        const t = setTimeout(done, ms);
        function done() {
          clearTimeout(t);
          opts.signal?.removeEventListener("abort", done);
          r();
        }
        opts.signal?.addEventListener("abort", done);
      });
    const waitForChange = () => {
      const ms = Math.min(every, Math.max(0, deadline - Date.now()));
      return wake?.wait(ms, opts.signal) ?? sleep(ms);
    };
    // Peeking or held: mail this caller was already shown (and can't take) doesn't end a wait; something newer does,
    // or mail for its own session (which a held read still takes).
    const repeats = opts.peek || opts.held;
    const key = shownKey(user, session, !!opts.held);
    if (repeats && opts.wait > 0 && rows.length) {
      const newest = newestRow(rows);
      const own = opts.held && session ? rows.some((r) => r.to_session === session) : false;
      if (!own && !later(newest, shown.get(key) ?? { at: -1, id: -1 })) {
        while (Date.now() < deadline && !opts.signal?.aborted) {
          await waitForChange();
          if (opts.signal?.aborted) break;
          if (await env.DB.prepare(NEWER_MAIL_SQL).bind(user, newest.at, newest.at, newest.id).first()) {
            rows = await undelivered(env, user, opts.limit + 1, session, !!opts.direct);
            break;
          }
        }
      }
    }
    while (!rows.length && Date.now() < deadline && !opts.signal?.aborted) {
      await waitForChange();
      if (opts.signal?.aborted) break;
      rows = await undelivered(env, user, opts.limit + 1, session, !!opts.direct);
    }
    more = rows.length > opts.limit;
    rows = rows.slice(0, opts.limit);
    if (repeats && rows.length) {
      if (shown.size > 5000) shown.clear();
      const newest = newestRow(rows);
      if (later(newest, shown.get(key) ?? { at: -1, id: -1 })) shown.set(key, newest);
    }
  } finally {
    wake?.close();
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
        // A Linear comment or Discord message (src/linear.ts, src/discord.ts) is someone outside Atteo, through the linker's link: never their own words.
        // A Notion import (src/notion.ts) is a page from outside Atteo, labelled by its title.
        from: d.linear != null ? linearLabel({ author: d.linear }, r.actor) : d.discord != null ? discordLabel({ author: d.discord }, r.actor) : d.notion != null ? notionLabel({ title: d.notion }, r.actor) : r.actor, from_via: r.actor_via, type: r.entry_type, ...(full?.title ? { title: proseForAgent(full.title) } : {}), text, preview: triagePreview(full?.title, body, { sealed: !!r.encrypted }), ts: r.created_at,
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
  const take = opts.held ? rows.filter((r) => session && (r.to_session === session || r.data?.startsWith('{"each":'))).map((r) => r.id) : mail.map((m) => m.id);
  if (!opts.peek && take.length) await ack(env, user, take, undefined, session);
  return { mail, more };
}

/** Marks mail delivered to your agent (after a peek). Only your own. `onlySession`: while another session holds the
 *  drain lease, only mail for this session (null: none). `session`: the session taking it (none: a dispatcher, ""), which
 *  takes its part of mail for each of your agents (EACH); that row is delivered once the last of them has. */
export async function ack(env: Env, user: string, ids: number[], onlySession?: string | null, session?: string | null): Promise<number> {
  const clean = [...new Set(ids.filter((n) => Number.isInteger(n) && n > 0))].slice(0, 90);
  if (!clean.length) return 0;
  const inIds = `id IN (${clean.map(() => "?").join(",")})`;
  const now = Date.now();
  let changes = 0;
  {
    const part = session ?? "";
    const took = await env.DB.prepare(`UPDATE notifications SET data = json_set(data, '$.each', json((SELECT json_group_array(value) FROM json_each(notifications.data, '$.each') WHERE value != ?))) WHERE user = ? AND agent_seen_at IS NULL AND ${EACH} AND ${inIds} AND instr(data, '"' || ? || '"') > 0`).bind(part, user, ...clean, part).run();
    changes += took.meta.changes ?? 0;
    if (took.meta.changes) await env.DB.prepare(`UPDATE notifications SET agent_seen_at = ? WHERE user = ? AND agent_seen_at IS NULL AND ${EACH} AND ${inIds} AND json_array_length(data, '$.each') = 0`).bind(now, user, ...clean).run();
  }
  if (onlySession === null) return changes;
  const r = await env.DB.prepare(`UPDATE notifications SET agent_seen_at = ? WHERE user = ? AND agent_seen_at IS NULL AND (data IS NULL OR NOT ${EACH})${onlySession ? " AND to_session = ?" : ""} AND ${inIds}`)
    .bind(now, user, ...(onlySession ? [onlySession] : []), ...clean)
    .run();
  return changes + (r.meta.changes ?? 0);
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
