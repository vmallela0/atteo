// Approvals: before an agent does something with side effects — especially because someone else asked on a board —
// it asks its own person, who approves or rejects (with a note), like reviewing a pull request. The server can't stop
// an agent from acting; this gives every agent a standard, visible way to ask and wait, and gives people one queue.

import { randomSecret } from "./auth";
import { blockedMessage, scanFields } from "./secrets";
import type { Env } from "./types";

export const APPROVAL_TTL_MS = 24 * 3600 * 1000;
export const MAX_PENDING = 50;

export interface Approval {
  id: string;
  user: string;
  client: string | null;
  board_id: string | null;
  seq: number | null;
  requested_by: string | null;
  title: string;
  details: string;
  risk: "low" | "medium" | "high";
  status: "pending" | "approved" | "rejected" | "expired";
  note: string | null;
  created_at: number;
  decided_at: number | null;
  expires_at: number;
}

export class ApprovalError extends Error {}

const live = (a: Approval): Approval => (a.status === "pending" && a.expires_at < Date.now() ? { ...a, status: "expired" } : a);

export async function requestApproval(
  env: Env,
  user: string,
  r: { client?: string | null; board_id?: string | null; seq?: number | null; requested_by?: string | null; title: string; details: string; risk?: string },
): Promise<Approval> {
  const title = (r.title ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
  const details = (r.details ?? "").trim().slice(0, 20_000);
  if (!title) throw new ApprovalError("Say what you want to do (title).");
  if (!details) throw new ApprovalError("Show exactly what will happen (details): the command, the diff, or the steps.");
  const hit = scanFields({ title, details });
  if (hit) throw new ApprovalError(blockedMessage(hit));
  const pending = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM approvals WHERE user = ? AND status = 'pending' AND expires_at > ?`).bind(user, Date.now()).first<{ n: number }>())?.n ?? 0;
  if (pending >= MAX_PENDING) throw new ApprovalError(`Your user already has ${MAX_PENDING} approvals waiting. Wait for them to catch up.`);
  const risk = (["low", "medium", "high"] as const).find((x) => x === r.risk) ?? "medium";
  const a: Approval = {
    id: randomSecret("ap_", 9),
    user,
    client: r.client?.slice(0, 40) ?? null,
    board_id: r.board_id ?? null,
    seq: r.seq ?? null,
    requested_by: r.requested_by ?? null,
    title,
    details,
    risk,
    status: "pending",
    note: null,
    created_at: Date.now(),
    decided_at: null,
    expires_at: Date.now() + APPROVAL_TTL_MS,
  };
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO approvals (id, user, client, board_id, seq, requested_by, title, details, risk, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).bind(a.id, user, a.client, a.board_id, a.seq, a.requested_by, title, details, risk, a.created_at, a.expires_at),
    // Shows in the person's inbox (and badge / browser notification) right away.
    env.DB.prepare(`INSERT OR IGNORE INTO notifications (user, board_id, seq, kind, actor, actor_via, entry_type, excerpt, created_at) VALUES (?, '', ?, 'approval', ?, 'agent', 'approval', ?, ?)`).bind(
      user,
      -a.created_at - Math.floor(Math.random() * 1000),
      user,
      `${a.client ?? "Your agent"} asks: ${title}`.slice(0, 160),
      a.created_at,
    ),
  ]);
  return a;
}

export async function getApproval(env: Env, user: string, id: string): Promise<Approval | null> {
  const a = await env.DB.prepare(`SELECT * FROM approvals WHERE id = ? AND user = ?`).bind(id, user).first<Approval>();
  return a ? live(a) : null;
}

export async function listApprovals(env: Env, user: string, which: "pending" | "all" = "pending"): Promise<Approval[]> {
  const rows =
    which === "pending"
      ? await env.DB.prepare(`SELECT * FROM approvals WHERE user = ? AND status = 'pending' AND expires_at > ? ORDER BY created_at DESC LIMIT 100`).bind(user, Date.now()).all<Approval>()
      : await env.DB.prepare(`SELECT * FROM approvals WHERE user = ? ORDER BY created_at DESC LIMIT 100`).bind(user).all<Approval>();
  return rows.results.map(live);
}

/** Only the person (a browser session or their own CLI) decides; never an agent through MCP. */
export async function decide(env: Env, user: string, id: string, approve: boolean, note: string): Promise<Approval> {
  const a = await getApproval(env, user, id);
  if (!a) throw new ApprovalError("No such approval.");
  if (a.status !== "pending") throw new ApprovalError(`Already ${a.status}.`);
  const n = note.trim().slice(0, 500) || null;
  await env.DB.prepare(`UPDATE approvals SET status = ?, note = ?, decided_at = ? WHERE id = ? AND user = ? AND status = 'pending'`).bind(approve ? "approved" : "rejected", n, Date.now(), id, user).run();
  return { ...a, status: approve ? "approved" : "rejected", note: n, decided_at: Date.now() };
}

/** Waits up to `ms` for a decision (polling D1 every second); returns the approval as it stands. */
export async function waitForDecision(env: Env, user: string, id: string, ms: number): Promise<Approval | null> {
  const until = Date.now() + Math.min(ms, 50_000);
  for (;;) {
    const a = await getApproval(env, user, id);
    if (!a || a.status !== "pending" || Date.now() >= until) return a;
    await new Promise((r) => setTimeout(r, 1000));
  }
}
