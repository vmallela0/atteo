// The mailbox: one place a developer's own dispatcher (or any number of monitors; we don't dictate) collects mail for
// their agent across every board and DM: DMs, @you, @your agent, replies to what you or your agent posted, and
// first-contact requests. Mail waits, undelivered, until the agent polls; polling delivers it (peek=1 doesn't).
// The platform only delivers: deciding which of your agents handles what is up to you. Two exceptions route mail:
// what you write on your own agent's board ("Your agent") is a DM from you (from_owner), and mail for one of your
// agent sessions ("@you/claude-2") is only in that session's mailbox: your other sessions and your dispatcher skip it.

import type { Env } from "./types";

const MAIL_KINDS = ["agent", "mention", "reply", "contact_request", "contact_accept", "decision"];

export interface Mail {
  id: number;
  kind: "dm" | "for_your_agent" | "mention" | "reply" | "contact_request" | "contact_accept" | "human_decision"; // human_decision: a person asks the people to decide; for your information, not a request
  board: string | null;
  board_title: string | null;
  seq: number | null;
  from: string;
  from_via: string | null;
  type: string;
  text: string;
  ts: number;
  encrypted?: boolean; // the text is ciphertext's placeholder: read it with the CLI
  from_owner?: boolean; // your own person wrote it, on their "Your agent" board: their request to you
  to_session?: string; // for this one agent session of yours (its name), not any of your agents
}

type Row = { id: number; board_id: string; board_title: string | null; board_kind: string | null; encrypted: number | null; seq: number; kind: string; actor: string; actor_via: string | null; entry_type: string; excerpt: string; created_at: number; to_session: string | null; to_session_name: string | null };

/** `session`: the agent session asking (its own mail plus everyone's); none: mail for any of your agents only. */
async function undelivered(env: Env, user: string, limit: number, session: string | null): Promise<Row[]> {
  return (
    await env.DB.prepare(
      `SELECT n.id, n.board_id, b.title AS board_title, b.kind AS board_kind, b.encrypted, n.seq, n.kind, n.actor, n.actor_via, n.entry_type, n.excerpt, n.created_at, n.to_session, s.name AS to_session_name
       FROM notifications n LEFT JOIN boards b ON b.id = n.board_id LEFT JOIN agent_sessions s ON s.id = n.to_session
       WHERE n.user = ? AND n.agent_seen_at IS NULL AND n.kind IN (${MAIL_KINDS.map(() => "?").join(",")})
         AND (n.board_id = '' OR n.board_id IN (SELECT board_id FROM members WHERE user = ?))
         AND (n.to_session IS NULL OR n.to_session = ?)
       ORDER BY n.created_at, n.id LIMIT ?`,
    )
      .bind(user, ...MAIL_KINDS, user, session ?? "", limit)
      .all<Row>()
  ).results;
}

/**
 * Your agent's undelivered mail, oldest first, with each message's full text. `wait` (seconds, ≤25) holds the
 * request until mail arrives, checking every few seconds (one indexed lookup each). Delivers what it returns unless
 * `peek`.
 */
export async function collect(
  env: Env,
  user: string,
  opts: { limit: number; wait: number; peek: boolean; session?: string | null },
  fullText: (board: string, seq: number) => Promise<string | null>,
): Promise<{ mail: Mail[]; more: boolean }> {
  const deadline = Date.now() + opts.wait * 1000;
  const session = opts.session ?? null;
  let rows = await undelivered(env, user, opts.limit + 1, session);
  while (!rows.length && Date.now() + 3000 <= deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    rows = await undelivered(env, user, opts.limit + 1, session);
  }
  const more = rows.length > opts.limit;
  rows = rows.slice(0, opts.limit);
  const mail = await Promise.all(
    rows.map(async (r): Promise<Mail> => {
      const text = r.board_id && !r.encrypted ? ((await fullText(r.board_id, r.seq).catch(() => null)) ?? r.excerpt) : r.excerpt;
      // A human decision is for the people; your agent hears about it, marked as such (informational), even in a DM.
      // Your own person on "Your agent" (board kind "agent"): a DM from them.
      const fromOwner = r.board_kind === "agent" && r.actor === user && r.actor_via === "person";
      const kind: Mail["kind"] = r.kind === "decision" ? "human_decision" : (r.board_kind === "direct" && r.kind !== "contact_request" && r.kind !== "contact_accept") || fromOwner ? "dm" : r.kind === "agent" ? "for_your_agent" : (r.kind as Mail["kind"]);
      return {
        id: r.id, kind, board: r.board_id || null, board_title: r.board_title, seq: r.board_id ? r.seq : null,
        from: r.actor, from_via: r.actor_via, type: r.entry_type, text, ts: r.created_at,
        ...(r.encrypted ? { encrypted: true } : {}),
        ...(fromOwner ? { from_owner: true } : {}),
        ...(r.to_session ? { to_session: r.to_session_name ?? r.to_session } : {}),
      };
    }),
  );
  if (!opts.peek && mail.length) await ack(env, user, mail.map((m) => m.id));
  return { mail, more };
}

/** Marks mail delivered to your agent (after a peek). Only your own. */
export async function ack(env: Env, user: string, ids: number[]): Promise<number> {
  const clean = [...new Set(ids.filter((n) => Number.isInteger(n) && n > 0))].slice(0, 90);
  if (!clean.length) return 0;
  const r = await env.DB.prepare(`UPDATE notifications SET agent_seen_at = ? WHERE user = ? AND agent_seen_at IS NULL AND id IN (${clean.map(() => "?").join(",")})`)
    .bind(Date.now(), user, ...clean)
    .run();
  return r.meta.changes ?? 0;
}
