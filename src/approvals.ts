// Approvals: before an agent does something with side effects — especially because someone else asked on a board —
// it asks its own person, who approves or rejects (with a note), like reviewing a pull request. The server can't stop
// an agent from acting; this gives every agent a standard, visible way to ask and wait, and gives people one queue.

import { randomSecret } from "./auth";
import { egressRefusal, noteApprovalDecision, noteApprovalRequested, type Later } from "./observe";
import type { ApprovalRef, Env } from "./types";
import { offBoardSeq } from "./util";
import * as rules from "./approvalRules";

/** Undecided by then, a request is denied (timed out). expires_in (seconds) sets it per request. */
export const DEFAULT_EXPIRES_S = 24 * 3600; // people answer approvals in their own time; a permission hook passes a short expires_in (e.g. 600)
export const MAX_EXPIRES_S = 24 * 3600;
export const MAX_PENDING = 50;
export const MAX_COMMAND = 20_000;
/** Tools whose approvals only the server makes (#5371): an agent's own request_approval can't name them. */
export const RESERVED_TOOLS = new Set(["pact"]);

export interface Approval {
  id: string;
  user: string;
  client: string | null;
  board_id: string | null;
  seq: number | null;
  requested_by: string | null;
  title: string;
  details: string;
  tool: string | null; // from a permission hook: the tool (e.g. Bash, Edit)
  command: string | null; // …and its exact command or file, verbatim
  risk: "low" | "medium" | "high";
  session: string | null; // the agent session that asked (its name, e.g. "scout"), when it had one
  status: "pending" | "approved" | "rejected" | "expired";
  terminal_confirm?: { token: string; choices: string[]; decision: "approve" | "reject"; expires_at: number }; // person-facing number match, never its answer
  state: "pending" | "approved" | "rejected" | "expired"; // the same, computed live (a pending request past expires_at is expired)
  note: string | null;
  created_at: number;
  decided_at: number | null;
  expires_at: number;
  category?: rules.Category | null;
  amount?: number | null;
  rule_name?: string | null;
  rule_set_by?: string | null;
}

export class ApprovalError extends Error {}

const live = (a: Approval): Approval => {
  const status = a.status === "pending" && a.expires_at < Date.now() ? "expired" : a.status;
  return { ...a, session: a.session ?? null, status, state: status };
};

/** The person's push / inbox fields for an approval: "Approval needed" (the app maps kind to its notification category). */
export function pushFor(a: Pick<Approval, "id" | "title" | "client" | "session" | "board_id" | "risk"> & Partial<Pick<Approval, "user" | "requested_by">>): { kind: "approval_needed"; title: string; body: string; url: string; approval: string; board: string | null; risk: string; by?: string } {
  const by = a.requested_by && a.user && a.requested_by !== a.user ? a.requested_by : undefined; // another member's agent asks (#5000)
  return { kind: "approval_needed", title: "Approval needed", body: `${askerOf(a)} asks: ${a.title}`.slice(0, 160), url: `/approvals#${a.id}`, approval: a.id, board: a.board_id, risk: a.risk, ...(by ? { by } : {}) };
}

/** Who's asking, in words: another member's agent by name (never "Your agent" for someone else's, #4930). */
export function askerOf(a: Partial<Pick<Approval, "user" | "requested_by" | "session" | "client">>): string {
  return a.requested_by && a.user && a.requested_by !== a.user ? `${a.requested_by}'s agent` : a.session ?? a.client ?? "Your agent";
}

export async function requestApproval(
  env: Env,
  user: string,
  r: { client?: string | null; session?: string | null; board_id?: string | null; seq?: number | null; requested_by?: string | null; title: string; details: string; risk?: string; tool?: string | null; command?: string | null; expires_in?: number | null; category?: rules.Category | null; amount?: number | null },
  later: Later | null = null,
  serverPrepared = false,
  forceAsk = false,
): Promise<Approval> {
  // The command is kept exactly as sent (never trimmed or cut): it's what the person approves.
  const command = typeof r.command === "string" && r.command.trim() ? r.command : null;
  if (command && command.length > MAX_COMMAND) throw new ApprovalError(`command is over ${MAX_COMMAND} characters; it's stored verbatim, so it isn't cut. Ask in the terminal instead.`);
  const tool = r.tool?.replace(/\s+/g, " ").trim().slice(0, 60) || null;
  if (tool && RESERVED_TOOLS.has(tool.toLowerCase()) && !serverPrepared) throw new ApprovalError(`"${tool}" approvals are made by Atteo itself (for PACT: agents {action: "call"}), not by request_approval.`);
  // Cut to 160, and visibly so: the full command is on the card, never only in the title (#4926).
  const full = ((r.title ?? "").trim() || (command ? `${tool ?? "Run"}: ${command}` : "")).replace(/\s+/g, " ").trim();
  const title = full.length > 160 ? full.slice(0, 159) + "…" : full;
  const details = (r.details ?? "").trim().slice(0, 20_000);
  if (!title) throw new ApprovalError("Say what you want to do (title).");
  if (!details && !command) throw new ApprovalError("Show exactly what will happen (details, or command): the command, the diff, or the steps.");
  const blocked = egressRefusal(env, later, { title, details, command });
  if (blocked) throw new ApprovalError(blocked);
  if (r.category && !r.board_id) throw new ApprovalError("Join a board to use an approval rule.");
  if (!r.category && r.amount != null) throw new ApprovalError("amount needs category spending.");
  const matched = r.category ? await rules.check(env, r.board_id!, user, r.category, r.amount) : null;
  if (matched?.outcome === "block") throw new ApprovalError(`Blocked by board rule: ${matched.reason} (set by ${matched.rule.set_by}). Don't do it.`);
  const auto = !forceAsk && matched?.outcome === "auto";
  if (!auto) {
    const pending = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM approvals WHERE user = ? AND status = 'pending' AND expires_at > ?`).bind(user, Date.now()).first<{ n: number }>())?.n ?? 0;
    if (pending >= MAX_PENDING) throw new ApprovalError(`Your user already has ${MAX_PENDING} approvals waiting. Wait for them to catch up.`);
  }
  const risk = (["low", "medium", "high"] as const).find((x) => x === r.risk) ?? "medium";
  const ttl = Math.max(1, Math.min(MAX_EXPIRES_S, Math.trunc(r.expires_in ?? DEFAULT_EXPIRES_S) || DEFAULT_EXPIRES_S));
  const a: Approval = {
    id: randomSecret("ap_", 9),
    user,
    client: r.client?.slice(0, 40) ?? null,
    board_id: r.board_id ?? null,
    seq: r.seq ?? null,
    requested_by: r.requested_by ?? null,
    title,
    details,
    tool,
    command,
    risk,
    session: r.session?.slice(0, 40) ?? null,
    status: auto ? "approved" : "pending",
    state: auto ? "approved" : "pending",
    note: auto ? `Approved by rule: ${matched!.reason} (set by ${matched!.rule.set_by}).` : null,
    created_at: Date.now(),
    decided_at: auto ? Date.now() : null,
    expires_at: Date.now() + ttl * 1000,
    category: r.category ?? null,
    amount: r.amount ?? null,
    rule_name: auto ? matched!.reason : null,
    rule_set_by: auto ? matched!.rule.set_by : null,
  };
  const cappedSpend = auto && r.category === "spending" && matched!.rule.threshold! > 0;
  const day = Math.floor(a.created_at / 86_400_000) * 86_400_000;
  const insert = `INSERT INTO approvals (id, user, client, board_id, seq, requested_by, title, details, tool, command, risk, status, created_at, expires_at, session, note, decided_at, decided_via, category, amount, rule_name, rule_set_by) ${cappedSpend ? `SELECT ${Array(22).fill("?").join(", ")} WHERE (SELECT COALESCE(ROUND(SUM(amount * 100)), 0) FROM approvals WHERE board_id = ? AND user = ? AND category = 'spending' AND status = 'approved' AND decided_via = 'rule' AND created_at >= ? AND created_at < ?) + ? <= ?` : `VALUES (${Array(22).fill("?").join(", ")})`}`;
  const writes = [
    env.DB.prepare(
      insert,
    ).bind(a.id, user, a.client, a.board_id, a.seq, a.requested_by, title, details, tool, command, risk, a.status, a.created_at, a.expires_at, a.session, a.note, a.decided_at, auto ? "rule" : null, a.category, a.amount, a.rule_name, a.rule_set_by, ...(cappedSpend ? [r.board_id, user, day, day + 86_400_000, Math.round(r.amount! * 100), Math.round(matched!.rule.threshold! * 100)] : [])),
    // Shows in the person's inbox (and badge / browser notification) right away; data carries the push-ready fields.
    ...(!auto ? [env.DB.prepare(`INSERT OR IGNORE INTO notifications (user, board_id, seq, kind, actor, actor_via, entry_type, excerpt, created_at, data) VALUES (?, '', ?, 'approval', ?, 'agent', 'approval', ?, ?, ?)`).bind(
      user,
      offBoardSeq(),
      user,
      `${askerOf(a)} asks: ${title}`.slice(0, 160),
      a.created_at,
      JSON.stringify({ push: pushFor(a) }),
    )] : [env.DB.prepare(`INSERT INTO audit (board_id, actor, action, target, detail, ts) SELECT ?, ?, 'approval_by_rule', ?, ?, ? WHERE EXISTS (SELECT 1 FROM approvals WHERE id = ?)`).bind(
      r.board_id, user, a.id, `${a.rule_name}; set by ${a.rule_set_by}; category ${a.category}${a.amount == null ? "" : `; $${a.amount.toFixed(2)}`}`, a.created_at, a.id,
    )]),
  ];
  const written = await env.DB.batch(writes);
  if (cappedSpend && !written[0].meta.changes) return requestApproval(env, user, r, later, serverPrepared, true);
  if (!auto) noteApprovalRequested(env, later, risk, user);
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

/**
 * Only the agent's own person decides: `user` is the signed-in person (a browser session, or the Atteo app's token),
 * never an agent's token (the route refuses those), and an approval is found only under the person it belongs to, so
 * another member gets "No such approval". A request that timed out stays denied.
 */
/** `via`: where it was decided, for the audit trail: null (the web, the app) or "slack:<team>/<user>" (src/slack.ts). */
export async function decide(env: Env, user: string, id: string, approve: boolean, note: string, later: Later | null = null, via: string | null = null, terminalToken: string | null = null): Promise<Approval> {
  const a = await getApproval(env, user, id);
  if (!a) throw new ApprovalError("No such approval.");
  if (a.status !== "pending") throw new ApprovalError(a.status === "expired" ? "Already denied (timed out)." : `Already ${a.status}.`);
  const n = note.trim().slice(0, 500) || null;
  const now = Date.now();
  const guard = terminalToken ? ` AND EXISTS (SELECT 1 FROM approval_terminal_confirms c WHERE c.approval_id = approvals.id AND c.user = ? AND c.token = ? AND c.status = 'pending' AND c.expires_at > ?)` : "";
  const r = await env.DB.prepare(`UPDATE approvals SET status = ?, note = ?, decided_at = ?, decided_via = ? WHERE id = ? AND user = ? AND status = 'pending' AND expires_at > ?${guard}`)
    .bind(approve ? "approved" : "rejected", n, now, via, id, user, now, ...(terminalToken ? [user, terminalToken, now] : []))
    .run();
  if (!r.meta.changes) throw new ApprovalError("Already decided or timed out.");
  const status = approve ? "approved" : "rejected";
  void noteApprovalDecision(env, later, status, user);
  return { ...a, status, state: status, note: n, decided_at: now };
}

export const APPROVAL_STATES = ["pending", "approved", "rejected", "expired", "all"] as const;

/** Your approvals on one board (the board's inline cards), newest first: pending (default), a decided state, or all. */
export async function listBoardApprovals(env: Env, user: string, board: string, state: (typeof APPROVAL_STATES)[number] = "pending"): Promise<Approval[]> {
  const now = Date.now();
  const q =
    state === "pending"
      ? env.DB.prepare(`SELECT * FROM approvals WHERE user = ? AND board_id = ? AND status = 'pending' AND expires_at > ? ORDER BY created_at DESC LIMIT 100`).bind(user, board, now)
      : state === "expired"
        ? env.DB.prepare(`SELECT * FROM approvals WHERE user = ? AND board_id = ? AND status = 'pending' AND expires_at <= ? ORDER BY created_at DESC LIMIT 100`).bind(user, board, now)
        : state === "all"
          ? env.DB.prepare(`SELECT * FROM approvals WHERE user = ? AND board_id = ? ORDER BY created_at DESC LIMIT 100`).bind(user, board)
          : env.DB.prepare(`SELECT * FROM approvals WHERE user = ? AND board_id = ? AND status = ? ORDER BY created_at DESC LIMIT 100`).bind(user, board, state);
  return (await q.all<Approval>()).results.map(live);
}

/** pending | approved | denied, for a hook to act on: rejected and timed out (expired) are both denied. */
export function decision(a: Approval): { decision: "pending" | "approved" | "denied"; reason?: "rejected" | "timed out" } {
  if (a.status === "approved") return { decision: "approved" };
  if (a.status === "rejected") return { decision: "denied", reason: "rejected" };
  if (a.status === "expired") return { decision: "denied", reason: "timed out" };
  return { decision: "pending" };
}

/** Waits up to `ms` for a decision (polling D1 every 2s, and at the deadline); returns the approval as it stands. */
export async function waitForDecision(env: Env, user: string, id: string, ms: number): Promise<Approval | null> {
  const until = Date.now() + Math.min(ms, 50_000);
  for (;;) {
    const a = await getApproval(env, user, id);
    if (!a || a.status !== "pending" || Date.now() >= until) return a;
    // Wake for the deadline or the request's own expiry, whichever comes first.
    await new Promise((r) => setTimeout(r, Math.max(50, Math.min(2000, until - Date.now(), a.expires_at - Date.now() + 10))));
  }
}

/** What a board's approval entry (and its live event) carries: everything but the details. */
/** Details sealed to the person's own devices (an approval on an end-to-end encrypted board, #5542): a v1 envelope the
 *  server can't read, so pages say so instead of showing it; the board page and the app open it on a device that can. */
export const isSealedDetails = (d: string | null | undefined): boolean => !!d && d.startsWith('{"v":1');
export const SEALED_DETAILS_NOTE = "🔒 Encrypted for your devices: open it on the board in a browser or app that holds your key.";
export const shownDetails = (d: string): string => (isSealedDetails(d) ? SEALED_DETAILS_NOTE : d);

export function refOf(a: Approval): ApprovalRef {
  return { id: a.id, user: a.user, status: a.state, title: a.title, tool: a.tool, command: a.command, risk: a.risk, expires_at: a.expires_at, note: a.note, session: a.session, about: a.seq, created_at: a.created_at, decided_at: a.decided_at, requested_by: a.requested_by ?? null, category: a.category, amount: a.amount, rule_name: a.rule_name, rule_set_by: a.rule_set_by };
}
