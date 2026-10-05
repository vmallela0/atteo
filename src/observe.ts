// Operator counters for the trust and context paths, and a handful of product success events. In-process so a test
// sees the increment immediately, and flushed to usage_daily (the same table as the other ops counters) so /_ops and
// GET /api/ops/metrics can sum them across isolates. A few named counters — not an APM.
//
// How to read them (last 14 days, operators only):
//   /_ops → Trust and context · Product
//   GET /api/ops/metrics → observe · success
//   GET /api/ops/usage-daily → rows whose metric is paste, egress_block, context_pack, stale_notice,
//                              claim_review, approval or success
//
// paste            a write that landed on a board. key: person | agent
// egress_block     the secret filter refused a write before it was stored. key: the rule id (never the secret)
// context_pack     a summary handed to an agent on read.
//                  key served: how many packs
//                  key chars: total characters (average = chars / served)
//                  key truncated: packs that hit the summary cap
//                  key lt_1k | 1k_4k | 4k_8k | 8k_16k | 16k_plus: size bucket
// stale_notice     a disputed or retracted premise was checked for dependents.
//                  key invalidations: disputed/retracted premises
//                  key notices: invalidations that made at least one dependent stale
//                  key entries: total entries made stale
// claim_review     key verified | disputed: completed reviews of claims
// approval         key requested | approved | rejected, plus risk_low | risk_medium | risk_high for requests
// success          product activation. key: board_created | first_agent_post | invite_redeemed | friend_accepted
//                  first_agent_post is once per person (lifetime); the others count each event.
// Block rate is egress blocks ÷ (pastes + egress blocks); stale-notice rate is notices ÷ invalidations;
// verified-claim ratio is verified ÷ (verified + disputed). Test accounts (e2e-*) are left out.

import { blockedMessage, scanFields, scanText } from "./secrets";
import type { Env } from "./types";

/** A request context or a Durable Object: keeps the D1 write alive after the response. */
export interface Later {
  waitUntil(promise: Promise<any>): void;
}

const day = (ts = Date.now()) => new Date(ts).toISOString().slice(0, 10);

const local = new Map<string, number>(); // `${metric}\n${key}` → total since this isolate started (tests reset it)
const inflight = new Set<Promise<void>>();
const firstAgent = new Set<string>(); // people whose first agent post this isolate already recorded

/** Lifetime uniqueness for first_agent_post. Not a UTC day, so the 90-day sweep must leave these rows. */
export const SUCCESS_ONCE_DAY = "once";
export const SUCCESS_ONCE_METRIC = "success_once";
export const SUCCESS_METRIC = "success";
export const SUCCESS_KEYS = ["board_created", "first_agent_post", "invite_redeemed", "friend_accepted"] as const;
export type SuccessKey = (typeof SUCCESS_KEYS)[number];

/** This isolate's total for one counter. Tests read this; operators read usage_daily. */
export function counter(metric: string, key: string): number {
  return local.get(`${metric}\n${key}`) ?? 0;
}

/** Clears this isolate's totals. Tests only. */
export function resetCounters(): void {
  local.clear();
  firstAgent.clear();
}

/** Waits for the D1 writes this isolate has started. */
export async function settleCounts(): Promise<void> {
  while (inflight.size) await Promise.all([...inflight]);
}

/** Add `n` to a daily counter. The in-process total moves immediately; the D1 write is fire-and-forget via `later`. */
export function count(env: Env | null | undefined, later: Later | null | undefined, metric: string, key: string, n = 1): Promise<void> {
  if (!Number.isFinite(n) || n <= 0) return Promise.resolve();
  const add = Math.floor(n);
  const k = key.slice(0, 80);
  const id = `${metric}\n${k}`;
  local.set(id, (local.get(id) ?? 0) + add);
  const db = env?.DB;
  if (!db) return Promise.resolve();
  const p = db
    .prepare(`INSERT INTO usage_daily (day, metric, key, count) VALUES (?, ?, ?, ?) ON CONFLICT(day, metric, key) DO UPDATE SET count = count + excluded.count`)
    .bind(day(), metric, k, add)
    .run()
    .then(() => {})
    .catch(() => {});
  inflight.add(p);
  void p.finally(() => inflight.delete(p));
  later?.waitUntil(p);
  return p;
}

const skip = (user: string | null | undefined) => !!user && user.startsWith("e2e-");

/** A write landed on a board. `via` "person" counts as a person; everything else as an agent. */
export function notePaste(env: Env | null | undefined, later: Later | null | undefined, via: string | null | undefined, user?: string | null): Promise<void> {
  if (skip(user)) return Promise.resolve();
  return count(env, later, "paste", via === "person" ? "person" : "agent");
}

/** The secret filter refused a write. `rule` is the rule id, never the matched value. */
export function noteEgressBlock(env: Env | null | undefined, later: Later | null | undefined, rule: string): Promise<void> {
  return count(env, later, "egress_block", rule);
}

/**
 * If `fields` contain a secret, count the block and return the message to show. Null when they're clean.
 * Sync on purpose: callers throw or return the message, and `later` keeps the counter write alive.
 */
export function egressRefusal(env: Env | null | undefined, later: Later | null | undefined, fields: Record<string, string | null | undefined>): string | null {
  const hit = scanFields(fields);
  if (!hit) return null;
  void noteEgressBlock(env, later, hit.rule);
  return blockedMessage(hit);
}

/** Same as `egressRefusal` for one string (a decision note, a file, a title). */
export function egressRefusalText(env: Env | null | undefined, later: Later | null | undefined, text: string, field = "text"): string | null {
  const hit = text ? scanText(text, field) : null;
  if (!hit) return null;
  void noteEgressBlock(env, later, hit.rule);
  return blockedMessage(hit);
}

export const PACK_BUCKETS = ["lt_1k", "1k_4k", "4k_8k", "8k_16k", "16k_plus"] as const;
export type PackBucket = (typeof PACK_BUCKETS)[number];

const BUCKET_LABEL: Record<PackBucket, string> = {
  lt_1k: "Under 1,000 characters",
  "1k_4k": "1,000–3,999 characters",
  "4k_8k": "4,000–7,999 characters",
  "8k_16k": "8,000–15,999 characters",
  "16k_plus": "16,000 characters or more",
};

/** Which size bucket a pack's character length falls in. */
export function packBucket(chars: number): PackBucket {
  if (chars < 1_000) return "lt_1k";
  if (chars < 4_000) return "1k_4k";
  if (chars < 8_000) return "4k_8k";
  if (chars < 16_000) return "8k_16k";
  return "16k_plus";
}

const TRUNCATED = "[summary truncated]";

/** An agent was handed a context pack (the board summary on read). `user` skips test accounts. */
export function noteContextPack(env: Env | null | undefined, later: Later | null | undefined, text: string, user?: string | null): void {
  if (skip(user)) return;
  const chars = text.length;
  void count(env, later, "context_pack", "served");
  void count(env, later, "context_pack", "chars", chars);
  void count(env, later, "context_pack", packBucket(chars));
  if (text.includes(TRUNCATED)) void count(env, later, "context_pack", "truncated");
}

/** A premise was disputed or retracted; count whether that produced stale notices and how many entries they cover. */
export function noteStaleNotice(env: Env | null | undefined, later: Later | null | undefined, entries: number, user?: string | null): void {
  if (skip(user)) return;
  void count(env, later, "stale_notice", "invalidations");
  if (entries > 0) {
    void count(env, later, "stale_notice", "notices");
    void count(env, later, "stale_notice", "entries", entries);
  }
}

/** A claim review completed. The verified-claim ratio is verified ÷ all completed reviews. */
export function noteClaimReview(env: Env | null | undefined, later: Later | null | undefined, outcome: "verified" | "disputed", user?: string | null): Promise<void> {
  if (skip(user)) return Promise.resolve();
  return count(env, later, "claim_review", outcome);
}

/** An approval request was created. Risk is counted separately without copying any request text. */
export function noteApprovalRequested(env: Env | null | undefined, later: Later | null | undefined, risk: "low" | "medium" | "high", user?: string | null): void {
  if (skip(user)) return;
  void count(env, later, "approval", "requested");
  void count(env, later, "approval", `risk_${risk}`);
}

/** A person approved or rejected a pending request. */
export function noteApprovalDecision(env: Env | null | undefined, later: Later | null | undefined, outcome: "approved" | "rejected", user?: string | null): Promise<void> {
  if (skip(user)) return Promise.resolve();
  return count(env, later, "approval", outcome);
}

/** A collaboration board was created (not a DM or "Your agent"). */
export function noteBoardCreated(env: Env | null | undefined, later: Later | null | undefined, user?: string | null): Promise<void> {
  if (skip(user)) return Promise.resolve();
  return count(env, later, SUCCESS_METRIC, "board_created");
}

/** An invite link was used, or an email invitation was accepted, and that person joined. */
export function noteInviteRedeemed(env: Env | null | undefined, later: Later | null | undefined, user?: string | null): Promise<void> {
  if (skip(user)) return Promise.resolve();
  return count(env, later, SUCCESS_METRIC, "invite_redeemed");
}

/** A pending friend request became a friendship (accepted by the person or by a standing rule). */
export function noteFriendAccepted(env: Env | null | undefined, later: Later | null | undefined, user?: string | null, other?: string | null): Promise<void> {
  if (skip(user) || skip(other)) return Promise.resolve();
  return count(env, later, SUCCESS_METRIC, "friend_accepted");
}

/**
 * A person's agent posted for the first time. Later posts by the same person are ignored. Uniqueness is a
 * usage_daily row on SUCCESS_ONCE_DAY (kept across the 90-day sweep); the daily success counter only moves once.
 */
export function noteFirstAgentPost(env: Env | null | undefined, later: Later | null | undefined, user?: string | null): Promise<void> {
  if (!user || skip(user) || firstAgent.has(user)) return Promise.resolve();
  const db = env?.DB;
  if (!db) {
    firstAgent.add(user);
    return count(env, later, SUCCESS_METRIC, "first_agent_post");
  }
  const who = user.slice(0, 80);
  const p = db
    .prepare(`INSERT OR IGNORE INTO usage_daily (day, metric, key, count) VALUES (?, ?, ?, 1)`)
    .bind(SUCCESS_ONCE_DAY, SUCCESS_ONCE_METRIC, who)
    .run()
    .then((r) => {
      firstAgent.add(user);
      if (r.meta.changes) return count(env, later, SUCCESS_METRIC, "first_agent_post");
    })
    .then(() => {})
    .catch(() => {});
  inflight.add(p);
  void p.finally(() => inflight.delete(p));
  later?.waitUntil(p);
  return p;
}

export interface Observability {
  days: number;
  paste: { person: number; agent: number; total: number };
  egress_blocks: { total: number; by_rule: { rule: string; count: number }[] };
  /** Egress blocks ÷ (pastes + blocks) over the window. Null when nothing was written or refused. */
  block_rate: number | null;
  context_pack: {
    served: number;
    chars: number;
    avg_chars: number | null;
    truncated: number;
    buckets: { key: PackBucket; label: string; count: number }[];
  };
  stale_notices: { invalidations: number; notices: number; entries: number; rate: number | null };
  claim_reviews: { verified: number; disputed: number; total: number; verified_ratio: number | null };
  approvals: { requested: number; approved: number; rejected: number; by_risk: { low: number; medium: number; high: number } };
}

export interface SuccessMetrics {
  days: number;
  board_created: number;
  first_agent_post: number;
  invite_redeemed: number;
  friend_accepted: number;
}

/** Product activation counters for the last `n` UTC days. */
export async function successMetrics(env: Env, n = 14): Promise<SuccessMetrics> {
  const since = day(Date.now() - (n - 1) * 86_400_000);
  const rows = (
    await env.DB.prepare(`SELECT key, SUM(count) AS c FROM usage_daily WHERE day >= ? AND metric = ? GROUP BY key`)
      .bind(since, SUCCESS_METRIC)
      .all<{ key: string; c: number }>()
  ).results;
  const sum = (key: SuccessKey) => rows.reduce((n, r) => (r.key === key ? n + r.c : n), 0);
  return {
    days: n,
    board_created: sum("board_created"),
    first_agent_post: sum("first_agent_post"),
    invite_redeemed: sum("invite_redeemed"),
    friend_accepted: sum("friend_accepted"),
  };
}

/** The trust and context counters for the last `n` UTC days, summed across isolates. */
export async function observability(env: Env, n = 14): Promise<Observability> {
  const since = day(Date.now() - (n - 1) * 86_400_000);
  const rows = (
    await env.DB.prepare(
      `SELECT metric, key, SUM(count) AS c FROM usage_daily WHERE day >= ? AND metric IN ('paste', 'egress_block', 'context_pack', 'stale_notice', 'claim_review', 'approval') GROUP BY metric, key`,
    )
      .bind(since)
      .all<{ metric: string; key: string; c: number }>()
  ).results;
  const sum = (metric: string, key?: string) => rows.reduce((n, r) => (r.metric === metric && (key == null || r.key === key) ? n + r.c : n), 0);
  const person = sum("paste", "person");
  const agent = sum("paste", "agent");
  const pasteTotal = sum("paste");
  const blocks = rows
    .filter((r) => r.metric === "egress_block")
    .map((r) => ({ rule: r.key, count: r.c }))
    .sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule));
  const blockTotal = blocks.reduce((n, r) => n + r.count, 0);
  const attempts = pasteTotal + blockTotal;
  const served = sum("context_pack", "served");
  const chars = sum("context_pack", "chars");
  const invalidations = sum("stale_notice", "invalidations");
  const notices = sum("stale_notice", "notices");
  const verified = sum("claim_review", "verified");
  const disputed = sum("claim_review", "disputed");
  const reviews = verified + disputed;
  return {
    days: n,
    paste: { person, agent, total: pasteTotal },
    egress_blocks: { total: blockTotal, by_rule: blocks },
    block_rate: attempts ? blockTotal / attempts : null,
    context_pack: {
      served,
      chars,
      avg_chars: served ? chars / served : null,
      truncated: sum("context_pack", "truncated"),
      buckets: PACK_BUCKETS.map((key) => ({ key, label: BUCKET_LABEL[key], count: sum("context_pack", key) })),
    },
    stale_notices: {
      invalidations,
      notices,
      entries: sum("stale_notice", "entries"),
      rate: invalidations ? notices / invalidations : null,
    },
    claim_reviews: {
      verified,
      disputed,
      total: reviews,
      verified_ratio: reviews ? verified / reviews : null,
    },
    approvals: {
      requested: sum("approval", "requested"),
      approved: sum("approval", "approved"),
      rejected: sum("approval", "rejected"),
      by_risk: {
        low: sum("approval", "risk_low"),
        medium: sum("approval", "risk_medium"),
        high: sum("approval", "risk_high"),
      },
    },
  };
}
