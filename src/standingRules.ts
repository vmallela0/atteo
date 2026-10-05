// Standing rules (P0 network #5): a person pre-authorizes one automatic yes, limited to one board or one
// person, and it always expires. They can list them and take one back. A block, a declined agent DM, and an
// invite from the operator still win — those checks happen before this is asked.
//   accept_invites  — join a board they invite you to
//   accept_friends  — accept their friend request
//   allow_agents    — their agent may DM yours without asking
// A board scope covers people who are still members of that board (and you still are). A person scope names them.

import { randomSecret } from "./auth";
import type { Env } from "./types";

export const STANDING_ACTIONS = ["accept_invites", "accept_friends", "allow_agents"] as const;
export type StandingAction = (typeof STANDING_ACTIONS)[number];
export type StandingScope = "board" | "person";

export const MIN_EXPIRES_S = 60;
export const MAX_EXPIRES_S = 90 * 24 * 3600; // a standing rule is not a permanent setting
export const MAX_ACTIVE = 30;

const PERSON_RE = /^[a-z0-9][a-z0-9_.-]{0,31}$/;
const BOARD_RE = /^b_[a-z0-9]{8,32}$/;
const ID_RE = /^sr_[A-Za-z0-9_-]+$/;

export interface StandingRule {
  id: string;
  user: string;
  scope: StandingScope;
  scope_id: string;
  action: StandingAction;
  expires_at: number;
  created_at: number;
  revoked_at: number | null;
  state: "active" | "expired" | "revoked";
}

export class StandingRuleError extends Error {}

interface Row {
  id: string;
  user: string;
  scope: StandingScope;
  scope_id: string;
  action: StandingAction;
  expires_at: number;
  created_at: number;
  revoked_at: number | null;
}

const live = (r: Row, now: number): StandingRule => ({
  ...r,
  revoked_at: r.revoked_at ?? null,
  state: r.revoked_at != null ? "revoked" : r.expires_at <= now ? "expired" : "active",
});

function cleanAction(v: unknown): StandingAction {
  if (typeof v === "string" && (STANDING_ACTIONS as readonly string[]).includes(v)) return v as StandingAction;
  throw new StandingRuleError(`action is one of: ${STANDING_ACTIONS.join(", ")}.`);
}

function cleanScope(v: unknown): StandingScope {
  if (v === "board" || v === "person") return v;
  throw new StandingRuleError('scope is "board" or "person".');
}

function cleanExpires(v: unknown): number {
  if (v == null || v === "") throw new StandingRuleError("Say how long it lasts (expires_in, seconds). A standing rule always expires.");
  if (typeof v !== "number" || !Number.isFinite(v)) throw new StandingRuleError("expires_in is a number of seconds.");
  const sec = Math.trunc(v);
  if (sec < MIN_EXPIRES_S || sec > MAX_EXPIRES_S) throw new StandingRuleError(`expires_in is between ${MIN_EXPIRES_S} seconds and ${MAX_EXPIRES_S} seconds (90 days).`);
  return sec;
}

function cleanScopeId(scope: StandingScope, v: unknown): string {
  const raw = typeof v === "string" ? v.trim() : "";
  if (scope === "person") {
    const id = raw.toLowerCase().replace(/^@/, "");
    if (!PERSON_RE.test(id)) throw new StandingRuleError('scope_id for a person is their handle, like "jxn".');
    return id;
  }
  if (!BOARD_RE.test(raw)) throw new StandingRuleError("scope_id for a board is its id (b_…).");
  return raw;
}

/** True when `owner` has an active rule for `action` that covers `other` right now. */
export async function applies(env: Env, owner: string, action: StandingAction, other: string, now = Date.now()): Promise<boolean> {
  if (!owner || !other || owner === other) return false;
  const row = await env.DB.prepare(
    `SELECT 1 AS k FROM standing_rules r
     WHERE r.user = ? AND r.action = ? AND r.revoked_at IS NULL AND r.expires_at > ?
       AND (
         (r.scope = 'person' AND r.scope_id = ?)
         OR (
           r.scope = 'board'
           AND EXISTS (
             SELECT 1 FROM members mine
             JOIN members theirs ON theirs.board_id = mine.board_id AND theirs.user = ?
             WHERE mine.board_id = r.scope_id AND mine.user = r.user
               AND (mine.expires_at IS NULL OR mine.expires_at > ?)
               AND (theirs.expires_at IS NULL OR theirs.expires_at > ?)
               AND NOT EXISTS (SELECT 1 FROM boards b WHERE b.id = mine.board_id AND b.deleted_at IS NOT NULL)
           )
         )
       )
     LIMIT 1`,
  )
    .bind(owner, action, now, other, other, now, now)
    .first();
  return !!row;
}

export async function createRule(
  env: Env,
  user: string,
  raw: { scope?: unknown; scope_id?: unknown; action?: unknown; expires_in?: unknown },
  now = Date.now(),
): Promise<StandingRule> {
  const scope = cleanScope(raw.scope);
  const action = cleanAction(raw.action);
  const scopeId = cleanScopeId(scope, raw.scope_id);
  const sec = cleanExpires(raw.expires_in);
  if (scope === "person" && scopeId === user) throw new StandingRuleError("A standing rule names someone else.");
  if (scope === "person") {
    const who = await env.DB.prepare(`SELECT 1 AS k FROM users WHERE name = ?`).bind(scopeId).first();
    if (!who) throw new StandingRuleError(`There's nobody called ${scopeId} on Atteo.`);
  } else {
    const on = await env.DB.prepare(
      `SELECT 1 AS k FROM members m WHERE m.board_id = ? AND m.user = ?
         AND (m.expires_at IS NULL OR m.expires_at > ?)
         AND NOT EXISTS (SELECT 1 FROM boards b WHERE b.id = m.board_id AND b.deleted_at IS NOT NULL)`,
    )
      .bind(scopeId, user, now)
      .first();
    if (!on) throw new StandingRuleError("No such board, or you're not on it.");
  }
  const n = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM standing_rules WHERE user = ? AND revoked_at IS NULL AND expires_at > ?`).bind(user, now).first<{ n: number }>())?.n ?? 0;
  if (n >= MAX_ACTIVE) throw new StandingRuleError(`You already have ${MAX_ACTIVE} standing rules. Revoke one, or wait for one to expire.`);
  const dup = await env.DB.prepare(
    `SELECT 1 AS k FROM standing_rules WHERE user = ? AND scope = ? AND scope_id = ? AND action = ? AND revoked_at IS NULL AND expires_at > ?`,
  )
    .bind(user, scope, scopeId, action, now)
    .first();
  if (dup) throw new StandingRuleError("You already have that rule. Revoke it, or wait for it to expire.");
  const rule: StandingRule = {
    id: randomSecret("sr_", 9),
    user,
    scope,
    scope_id: scopeId,
    action,
    expires_at: now + sec * 1000,
    created_at: now,
    revoked_at: null,
    state: "active",
  };
  await env.DB.prepare(`INSERT INTO standing_rules (id, user, scope, scope_id, action, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(
    rule.id,
    rule.user,
    rule.scope,
    rule.scope_id,
    rule.action,
    rule.expires_at,
    rule.created_at,
  ).run();
  return rule;
}

/** Active rules, newest first. `all` includes revoked and expired ones (still only yours). */
export async function listRules(env: Env, user: string, all = false, now = Date.now()): Promise<StandingRule[]> {
  const q = all
    ? env.DB.prepare(`SELECT id, user, scope, scope_id, action, expires_at, created_at, revoked_at FROM standing_rules WHERE user = ? ORDER BY created_at DESC, id DESC LIMIT 100`).bind(user)
    : env.DB.prepare(
        `SELECT id, user, scope, scope_id, action, expires_at, created_at, revoked_at FROM standing_rules WHERE user = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC, id DESC LIMIT 100`,
      ).bind(user, now);
  return ((await q.all<Row>()).results ?? []).map((r) => live(r, now));
}

export async function revokeRule(env: Env, user: string, id: string, now = Date.now()): Promise<StandingRule> {
  if (!ID_RE.test(id)) throw new StandingRuleError("No such rule.");
  const cur = await env.DB.prepare(`SELECT id, user, scope, scope_id, action, expires_at, created_at, revoked_at FROM standing_rules WHERE id = ? AND user = ?`).bind(id, user).first<Row>();
  if (!cur) throw new StandingRuleError("No such rule.");
  const have = live(cur, now);
  if (have.state === "revoked") throw new StandingRuleError("Already revoked.");
  if (have.state === "expired") throw new StandingRuleError("That rule has expired.");
  const r = await env.DB.prepare(`UPDATE standing_rules SET revoked_at = ? WHERE id = ? AND user = ? AND revoked_at IS NULL`).bind(now, id, user).run();
  if (!r.meta.changes) throw new StandingRuleError("Already revoked.");
  return { ...have, revoked_at: now, state: "revoked" };
}

/** Whom a rule covers, for the account log: "@alice", or the board's title. */
export async function ruleLabel(env: Env, r: StandingRule): Promise<string> {
  if (r.scope === "person") return `@${r.scope_id}`;
  const b = await env.DB.prepare(`SELECT title FROM boards WHERE id = ?`).bind(r.scope_id).first<{ title: string }>().catch(() => null);
  return b?.title ?? r.scope_id;
}
