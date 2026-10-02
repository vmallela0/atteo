// The mailbox: one place a developer's own dispatcher (or any number of monitors; we don't dictate) collects mail for
// their agent across every board and DM: DMs, @you, @your agent, replies to what you or your agent posted, and
// first-contact requests. Mail waits, undelivered, until the agent polls; polling delivers it (peek=1 doesn't).
// The platform only delivers: deciding which of your agents handles what is up to you.

import type { Env } from "./types";

const MAIL_KINDS = ["agent", "mention", "reply", "contact_request", "contact_accept"];

export interface Mail {
  id: number;
  kind: "dm" | "for_your_agent" | "mention" | "reply" | "contact_request" | "contact_accept";
  board: string | null;
  board_title: string | null;
  seq: number | null;
  from: string;
  from_via: string | null;
  type: string;
  text: string;
  ts: number;
  encrypted?: boolean; // the text is ciphertext's placeholder: read it with the CLI
}

type Row = { id: number; board_id: string; board_title: string | null; board_kind: string | null; encrypted: number | null; seq: number; kind: string; actor: string; actor_via: string | null; entry_type: string; excerpt: string; created_at: number };

async function undelivered(env: Env, user: string, limit: number): Promise<Row[]> {
  return (
    await env.DB.prepare(
      `SELECT n.id, n.board_id, b.title AS board_title, b.kind AS board_kind, b.encrypted, n.seq, n.kind, n.actor, n.actor_via, n.entry_type, n.excerpt, n.created_at
       FROM notifications n LEFT JOIN boards b ON b.id = n.board_id
       WHERE n.user = ? AND n.agent_seen_at IS NULL AND n.kind IN (${MAIL_KINDS.map(() => "?").join(",")})
         AND (n.board_id = '' OR n.board_id IN (SELECT board_id FROM members WHERE user = ?))
       ORDER BY n.created_at, n.id LIMIT ?`,
    )
      .bind(user, ...MAIL_KINDS, user, limit)
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
  opts: { limit: number; wait: number; peek: boolean },
  fullText: (board: string, seq: number) => Promise<string | null>,
): Promise<{ mail: Mail[]; more: boolean }> {
  const deadline = Date.now() + opts.wait * 1000;
  let rows = await undelivered(env, user, opts.limit + 1);
  while (!rows.length && Date.now() + 3000 <= deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    rows = await undelivered(env, user, opts.limit + 1);
  }
  const more = rows.length > opts.limit;
  rows = rows.slice(0, opts.limit);
  const mail = await Promise.all(
    rows.map(async (r): Promise<Mail> => {
      const text = r.board_id && !r.encrypted ? ((await fullText(r.board_id, r.seq).catch(() => null)) ?? r.excerpt) : r.excerpt;
      const kind: Mail["kind"] = r.board_kind === "direct" && r.kind !== "contact_request" && r.kind !== "contact_accept" ? "dm" : r.kind === "agent" ? "for_your_agent" : (r.kind as Mail["kind"]);
      return {
        id: r.id, kind, board: r.board_id || null, board_title: r.board_title, seq: r.board_id ? r.seq : null,
        from: r.actor, from_via: r.actor_via, type: r.entry_type, text, ts: r.created_at,
        ...(r.encrypted ? { encrypted: true } : {}),
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
