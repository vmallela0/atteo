// A terminal may ask for a decision, but only a person session can complete its number match.
// The optional PIN is a separate, rate-limited knowledge factor for ordinary (non-high-risk) approvals.
import { randomSecret } from "./auth";
import * as approvals from "./approvals";
import type { Env } from "./types";
import { offBoardSeq } from "./util";
import { sendApprovalAlert } from "./apns";

export const CONFIRM_MS = 120_000;
export const CONFIRM_START_WINDOW_MS = 10 * 60_000;
export const PIN_WINDOW_MS = 15 * 60_000;
export const PIN_ITERATIONS = 310_000;
export type Confirm = { approval_id: string; user: string; token: string; code: string; choices: string; decision: "approve" | "reject"; status: "pending" | "approved" | "denied"; created_at: number; expires_at: number };
export type PublicConfirm = { token: string; choices: string[]; decision: "approve" | "reject"; expires_at: number };
type PinRow = { user: string; salt: string; hash: string; attempts: number; window_start: number; locked_until: number; lockouts: number; disabled_at: number | null };

export class TerminalApprovalError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
const fromHex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], x => parseInt(x, 16));
const number = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 10_000).padStart(4, "0");
/** Three distinct four-digit numbers, one matching the terminal's code. */
export function numberChoices(): { code: string; choices: string[] } {
  const code = number();
  const choices = new Set([code]);
  while (choices.size < 3) choices.add(number());
  const out = [...choices];
  const i = crypto.getRandomValues(new Uint8Array(1))[0] % 3;
  [out[0], out[i]] = [out[i], out[0]];
  return { code, choices: out };
}

/** Keep the person's inbox and phone notification feed in step with every new confirm or failed PIN. */
export async function alertPerson(env: Env, user: string, approval: approvals.Approval, kind: "terminal_confirm" | "approval_pin_failed", detail: string, later: ExecutionContext | null = null): Promise<void> {
  const push = { kind, title: kind === "terminal_confirm" ? "Confirm terminal approval" : "Approval PIN failed", body: detail.slice(0, 160), url: `/approvals#${approval.id}`, approval: approval.id, board: approval.board_id, risk: approval.risk };
  await env.DB.prepare(`INSERT OR IGNORE INTO notifications (user, board_id, seq, kind, actor, actor_via, entry_type, excerpt, created_at, data) VALUES (?, '', ?, 'people_only', ?, 'agent', ?, ?, ?, ?)`)
    .bind(user, offBoardSeq(), user, kind, detail.slice(0, 160), Date.now(), JSON.stringify({ push })).run();
  const send = sendApprovalAlert(env, user, push.title, push.body, push.url).catch(e => console.error("approval push failed", e));
  if (later) later.waitUntil(send); else await send;
}

export async function startConfirm(env: Env, user: string, id: string, decision: "approve" | "reject", source: string, later: ExecutionContext | null = null): Promise<{ token: string; code: string; expires_at: number }> {
  const a = await approvals.getApproval(env, user, id);
  if (!a) throw new TerminalApprovalError("No such approval.", 404);
  if (a.status !== "pending") throw new TerminalApprovalError("This approval is no longer pending.", 409);
  const { code, choices } = numberChoices();
  const token = randomSecret("tc_", 24);
  const now = Date.now();
  const expires = Math.min(a.expires_at, now + CONFIRM_MS);
  // Count starts, including replacements and confirms for other approvals. The conditional insert
  // makes concurrent starts from the same session/token share the same rolling limit.
  const started = await env.DB.prepare(`INSERT INTO approval_confirm_starts (user, source, created_at)
    SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM approval_confirm_starts WHERE user = ? AND source = ? AND created_at > ?) < 5`)
    .bind(user, source, now, user, source, now - CONFIRM_START_WINDOW_MS).run();
  if (!started.meta.changes) throw new TerminalApprovalError("Too many terminal confirmations. Try again in 10 minutes.", 429);
  await env.DB.prepare(`DELETE FROM approval_confirm_starts WHERE created_at <= ?`).bind(now - CONFIRM_START_WINDOW_MS).run();
  await env.DB.prepare(`INSERT INTO approval_terminal_confirms (approval_id, user, token, code, choices, decision, status, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    ON CONFLICT(approval_id) DO UPDATE SET user=excluded.user, token=excluded.token, code=excluded.code, choices=excluded.choices, decision=excluded.decision, status='pending', created_at=excluded.created_at, expires_at=excluded.expires_at`)
    .bind(id, user, token, code, JSON.stringify(choices), decision, now, expires).run();
  await alertPerson(env, user, a, "terminal_confirm", `${approvals.askerOf(a)} asks you to ${decision === "approve" ? "approve" : "deny"}: ${a.title}`, later);
  return { token, code, expires_at: expires };
}

export async function publicConfirm(env: Env, user: string, id: string, now = Date.now()): Promise<PublicConfirm | null> {
  const c = await env.DB.prepare(`SELECT * FROM approval_terminal_confirms WHERE approval_id = ? AND user = ? AND status = 'pending' AND expires_at > ?`).bind(id, user, now).first<Confirm>();
  return c ? { token: c.token, choices: JSON.parse(c.choices) as string[], decision: c.decision, expires_at: c.expires_at } : null;
}

export async function attachConfirms(env: Env, user: string, list: approvals.Approval[]): Promise<(approvals.Approval & { terminal_confirm?: PublicConfirm })[]> {
  if (!list.length) return list;
  const rows = (await env.DB.prepare(`SELECT * FROM approval_terminal_confirms WHERE user = ? AND status = 'pending' AND expires_at > ?`).bind(user, Date.now()).all<Confirm>()).results;
  const byId = new Map(rows.map(c => [c.approval_id, { token: c.token, choices: JSON.parse(c.choices) as string[], decision: c.decision, expires_at: c.expires_at }]));
  return list.map(a => a.status === "pending" && byId.has(a.id) ? { ...a, terminal_confirm: byId.get(a.id)! } : a);
}

/** A wrong pick consumes the confirm. The approval itself stays pending so the person can decide it normally. */
export async function completeConfirm(env: Env, user: string, id: string, token: string, choice: string): Promise<{ status: "approved" | "denied"; approval?: approvals.Approval }> {
  const c = await env.DB.prepare(`SELECT * FROM approval_terminal_confirms WHERE approval_id = ? AND user = ?`).bind(id, user).first<Confirm>();
  if (!c || c.token !== token || c.status !== "pending" || c.expires_at <= Date.now()) throw new TerminalApprovalError("This terminal confirmation was replaced, expired or already answered.", 409);
  if (!JSON.parse(c.choices).includes(choice)) throw new TerminalApprovalError("Pick one of the three numbers shown.");
  const correct = choice === c.code;
  if (!correct) {
    const changed = await env.DB.prepare(`UPDATE approval_terminal_confirms SET status = 'denied' WHERE approval_id = ? AND user = ? AND token = ? AND status = 'pending' AND expires_at > ? AND EXISTS (SELECT 1 FROM approvals a WHERE a.id = ? AND a.user = ? AND a.status = 'pending' AND a.expires_at > ?)`)
      .bind(id, user, c.token, Date.now(), id, user, Date.now()).run();
    if (!changed.meta.changes) throw new TerminalApprovalError("This terminal confirmation was replaced or expired.", 409);
    return { status: "denied" };
  }
  const a = await approvals.decide(env, user, id, c.decision === "approve", "", null, "terminal_confirm", c.token);
  await env.DB.prepare(`UPDATE approval_terminal_confirms SET status = ? WHERE approval_id = ? AND user = ? AND token = ? AND status = 'pending'`)
    .bind(c.decision === "approve" ? "approved" : "denied", id, user, c.token).run();
  return { status: c.decision === "approve" ? "approved" : "denied", approval: a };
}

export async function pollConfirm(env: Env, user: string, id: string, token: string, ms = 0): Promise<{ status: "pending" | "approved" | "denied" | "expired" | "replaced" }> {
  const until = Date.now() + Math.min(Math.max(ms, 0), 25_000);
  for (;;) {
    const c = await env.DB.prepare(`SELECT * FROM approval_terminal_confirms WHERE approval_id = ? AND user = ?`).bind(id, user).first<Confirm>();
    if (!c || c.token !== token) return { status: "replaced" };
    const a = await approvals.getApproval(env, user, id);
    if (!a || a.status !== "pending") return { status: a?.status === "approved" ? "approved" : "denied" };
    if (c.status !== "pending") return { status: c.status };
    if (c.expires_at <= Date.now()) return { status: "expired" };
    if (Date.now() >= until) return { status: "pending" };
    await new Promise(r => setTimeout(r, Math.max(50, Math.min(1_000, until - Date.now(), c.expires_at - Date.now()))));
  }
}

export function validPin(pin: unknown): pin is string { return typeof pin === "string" && /^\d{6,}$/.test(pin) && pin.length <= 32; }
async function hashPin(pin: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  return hex(new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: fromHex(salt), iterations: PIN_ITERATIONS }, key, 256)));
}
export async function pinState(env: Env, user: string): Promise<{ enabled: boolean; locked_until: number; lockouts: number }> {
  const row = await env.DB.prepare(`SELECT * FROM approval_pins WHERE user = ?`).bind(user).first<PinRow>();
  return { enabled: !!row && !row.disabled_at, locked_until: row?.locked_until ?? 0, lockouts: row?.lockouts ?? 0 };
}
/** Person session only; setting a new PIN is also the reset after three lockouts. */
export async function setPin(env: Env, user: string, pin: string): Promise<void> {
  if (!validPin(pin)) throw new TerminalApprovalError("Use 6 to 32 digits for the approval PIN.");
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await hashPin(pin, salt);
  await env.DB.prepare(`INSERT INTO approval_pins (user, salt, hash, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user) DO UPDATE SET salt=excluded.salt, hash=excluded.hash, attempts=0, window_start=0, locked_until=0, lockouts=0, disabled_at=NULL, updated_at=excluded.updated_at`)
    .bind(user, salt, hash, Date.now()).run();
}
export async function removePin(env: Env, user: string): Promise<void> { await env.DB.prepare(`DELETE FROM approval_pins WHERE user = ?`).bind(user).run(); }

/** Five bad guesses in a rolling 15-minute window lock the PIN for 15 minutes; three locks disable it. */
export function failedPinState(row: Pick<PinRow, "attempts" | "window_start" | "lockouts">, now: number) {
  const fresh = now - row.window_start >= PIN_WINDOW_MS;
  const attempts = (fresh ? 0 : row.attempts) + 1;
  const lockouts = row.lockouts + (attempts >= 5 ? 1 : 0);
  return { attempts: attempts >= 5 ? 0 : attempts, window_start: fresh || attempts >= 5 ? now : row.window_start, locked_until: attempts >= 5 ? now + PIN_WINDOW_MS : 0, lockouts, disabled_at: lockouts >= 3 ? now : null };
}

export async function decideWithPin(env: Env, user: string, id: string, pin: string, later: ExecutionContext | null = null): Promise<approvals.Approval> {
  const a = await approvals.getApproval(env, user, id);
  if (!a) throw new TerminalApprovalError("No such approval.", 404);
  if (a.status !== "pending") throw new TerminalApprovalError("This approval is no longer pending.", 409);
  if (a.risk === "high" || a.client === "atteo host" || !!a.tool?.startsWith("Host ") || a.category === "deploy_production" || a.category === "spending" || a.category === "outbound_external") throw new TerminalApprovalError("This approval requires confirmation on the web or phone.", 403);
  if (typeof pin !== "string" || pin.length > 32) throw new TerminalApprovalError("The approval PIN must be at most 32 digits.");
  for (let tries = 0; tries < 4; tries++) {
    const row = await env.DB.prepare(`SELECT * FROM approval_pins WHERE user = ?`).bind(user).first<PinRow>();
    if (!row || row.disabled_at) throw new TerminalApprovalError("Approval PIN is off. Set or reset it in Account settings.", 403);
    const now = Date.now();
    if (row.locked_until > now) throw new TerminalApprovalError("Approval PIN is locked for 15 minutes.", 429);
    const equal = validPin(pin) && await hashPin(pin, row.salt) === row.hash;
    const next = equal ? { attempts: 0, window_start: 0, locked_until: 0, lockouts: row.lockouts, disabled_at: null } : failedPinState(row, now);
    const changed = await env.DB.prepare(`UPDATE approval_pins SET attempts=?, window_start=?, locked_until=?, lockouts=?, disabled_at=? WHERE user=? AND salt=? AND attempts=? AND window_start=? AND locked_until=? AND lockouts=? AND disabled_at IS NULL`)
      .bind(next.attempts, next.window_start, next.locked_until, next.lockouts, next.disabled_at, user, row.salt, row.attempts, row.window_start, row.locked_until, row.lockouts).run();
    if (!changed.meta.changes) continue;
    if (equal) return approvals.decide(env, user, id, true, "", null, "approval_pin");
    await alertPerson(env, user, a, "approval_pin_failed", `A wrong approval PIN was entered for: ${a.title}`, later);
    if (next.disabled_at) throw new TerminalApprovalError("Approval PIN was disabled after three lockouts. Reset it in Account settings.", 429);
    if (next.locked_until) throw new TerminalApprovalError("Approval PIN is locked for 15 minutes after five failed tries.", 429);
    throw new TerminalApprovalError("Wrong approval PIN.", 403);
  }
  throw new TerminalApprovalError("Please try again.", 409);
}
