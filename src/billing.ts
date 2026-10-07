// Billing: Free and Pro (Stripe subscriptions). Checkout and the customer portal are hosted by Stripe; a signed
// webhook keeps each person's plan in D1. Limits apply to the person who created a board.

import type { Env } from "./types";

export const PLANS = {
  free: { boards: 3, members: 5, label: "Free" },
  pro: { boards: Infinity, members: 50, label: "Pro" },
} as const;
export type Plan = keyof typeof PLANS;
export const PRICES = { month: { lookup: "pro_monthly", label: "$10 / month" }, year: { lookup: "pro_yearly", label: "$100 / year" } } as const;

/**
 * Free for now (jxn #5631, #5636): until paid plans start, everyone has Pro's limits and there's nothing to buy. Existing
 * Pro subscriptions keep working (webhook, Manage billing). FREE_FOR_NOW=0 turns the Free caps and Upgrade back on.
 */
export const freeForNow = (env: Pick<Env, "FREE_FOR_NOW">) => (env.FREE_FOR_NOW ?? "").trim() !== "0";

/** A plan's limits as they apply today: Pro's for everyone while Atteo is free for now. */
export const limitsOf = (env: Pick<Env, "FREE_FOR_NOW">, plan: Plan) => (freeForNow(env) ? PLANS.pro : PLANS[plan]);

/** The plans announced for later (landing FAQ, landing/src/home.ts): shown while free for now, nothing is charged. */
export const PLANNED = [
  { name: "Free", price: "$0", messages: "100 messages a day" },
  { name: "$10 / month", price: "$10", messages: "250 messages a day" },
  { name: "$20 / month", price: "$20", messages: "500 messages a day" },
  { name: "$50 / month", price: "$50", messages: "Unlimited messages" },
] as const;

const STRIPE_VERSION = "2024-06-20"; // pinned: the account's default API version is older

export class BillingError extends Error {}

export interface PlanState {
  plan: Plan;
  status: string | null;
  renews_at: number | null;
  cancel_at_end: boolean;
  customer: string | null;
  free_for_now?: boolean; // Atteo is free for now: no Upgrade, Pro's limits for everyone
}

export async function planOf(env: Env, user: string): Promise<PlanState> {
  const r = await env.DB.prepare(`SELECT plan, plan_status, plan_renews_at, plan_cancel_at_end, stripe_customer, email FROM users WHERE name = ?`)
    .bind(user)
    .first<{ plan: string | null; plan_status: string | null; plan_renews_at: number | null; plan_cancel_at_end: number; stripe_customer: string | null; email: string | null }>();
  // Operators always have Pro limits.
  const admins = (env.ADMIN_EMAIL ?? "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  const plan: Plan = r?.plan === "pro" || (!!r?.email && admins.includes(r.email.toLowerCase())) ? "pro" : "free";
  return { plan, status: r?.plan_status ?? null, renews_at: r?.plan_renews_at ?? null, cancel_at_end: !!r?.plan_cancel_at_end, customer: r?.stripe_customer ?? null, free_for_now: freeForNow(env) };
}

/** Throws a friendly error when a free account is at its board limit. */
export async function checkCanCreateBoard(env: Env, user: string, origin: string): Promise<void> {
  const p = await planOf(env, user);
  const limit = limitsOf(env, p.plan).boards;
  if (limit === Infinity) return;
  const n = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM boards WHERE created_by = ? AND archived_at IS NULL AND deleted_at IS NULL AND kind IS NULL`).bind(user).first<{ n: number }>())?.n ?? 0;
  if (n >= limit) {
    throw new BillingError(`The Free plan includes ${limit} active boards, and you have ${n}. Archive one, or upgrade to Pro for unlimited boards: ${origin}/me#billing`);
  }
}

/** Throws when a board (by its creator's plan) is full. */
export async function checkCanAddMember(env: Env, boardId: string, origin: string): Promise<void> {
  const b = await env.DB.prepare(`SELECT created_by, (SELECT COUNT(*) FROM members WHERE board_id = ?1) AS n FROM boards WHERE id = ?1`).bind(boardId).first<{ created_by: string; n: number }>();
  if (!b) return;
  const p = await planOf(env, b.created_by);
  const limit = limitsOf(env, p.plan).members;
  if (b.n >= limit) {
    throw new BillingError(
      p.plan === "free" && !p.free_for_now
        ? `This board is full: the Free plan allows ${limit} members per board. Its creator (${b.created_by}) can upgrade to Pro for up to ${PLANS.pro.members}: ${origin}/me#billing`
        : `This board is full (${limit} members).`,
    );
  }
}

// ---- Stripe API ----

async function stripe<T>(env: Env, path: string, params?: Record<string, string>, method = params ? "POST" : "GET"): Promise<T> {
  if (!env.STRIPE_SECRET_KEY) throw new BillingError("Billing isn't set up on this server.");
  const body = params ? new URLSearchParams(params).toString() : undefined;
  const url = `https://api.stripe.com/v1/${path}${method === "GET" && body ? `?${body}` : ""}`;
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "stripe-version": STRIPE_VERSION, ...(method !== "GET" ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
    body: method !== "GET" ? body : undefined,
  });
  const j = (await res.json()) as T & { error?: { message: string } };
  if (!res.ok) throw new BillingError(j.error?.message ?? `Stripe answered ${res.status}`);
  return j;
}

async function customerFor(env: Env, user: string, fresh = false): Promise<string> {
  const u = await env.DB.prepare(`SELECT email, stripe_customer FROM users WHERE name = ?`).bind(user).first<{ email: string | null; stripe_customer: string | null }>();
  if (u?.stripe_customer && !fresh) return u.stripe_customer;
  const c = await stripe<{ id: string }>(env, "customers", { ...(u?.email ? { email: u.email } : {}), "metadata[user]": user, description: `Atteo: ${user}` });
  await env.DB.prepare(`UPDATE users SET stripe_customer = ? WHERE name = ?`).bind(c.id, user).run();
  return c.id;
}

/** A hosted Checkout page for Pro (monthly or yearly). */
export async function checkoutUrl(env: Env, user: string, interval: "month" | "year", origin: string): Promise<string> {
  if (freeForNow(env)) throw new BillingError("Atteo is free for now, so there's nothing to buy yet.");
  const prices = await stripe<{ data: { id: string }[] }>(env, "prices", { "lookup_keys[]": PRICES[interval].lookup, active: "true" }, "GET");
  if (!prices.data[0]) throw new BillingError("The Pro price isn't set up yet (run scripts/stripe-setup.sh).");
  const session = async (customer: string) =>
    stripe<{ url: string }>(env, "checkout/sessions", {
      mode: "subscription",
      customer,
    client_reference_id: user,
      "line_items[0][price]": prices.data[0].id,
      "line_items[0][quantity]": "1",
      "subscription_data[metadata][user]": user,
      allow_promotion_codes: "true",
      success_url: `${origin}/me?billing=done#billing`,
      cancel_url: `${origin}/me#billing`,
    });
  try {
    return (await session(await customerFor(env, user))).url;
  } catch (e) {
    // The stored customer was deleted in Stripe (or never existed there): start over with a new one.
    if (e instanceof BillingError && /No such customer/.test(e.message)) return (await session(await customerFor(env, user, true))).url;
    throw e;
  }
}

/** Stripe's customer portal: change plan interval, cancel, update the card, download invoices. */
export async function portalUrl(env: Env, user: string, origin: string): Promise<string> {
  const p = await planOf(env, user);
  if (!p.customer) throw new BillingError("There's no billing account yet. Upgrade first.");
  const s = await stripe<{ url: string }>(env, "billing_portal/sessions", { customer: p.customer, return_url: `${origin}/me#billing` });
  return s.url;
}

// ---- webhook ----

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

/** Verifies a Stripe-Signature header (t=…,v1=…) over the raw body; rejects anything older than 5 minutes. */
export async function verifySignature(payload: string, header: string | null, secret: string, now = Date.now()): Promise<boolean> {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=", 2) as [string, string]));
  const t = Number(parts.t);
  const sigs = header.split(",").filter((kv) => kv.startsWith("v1=")).map((kv) => kv.slice(3));
  if (!t || !sigs.length || Math.abs(now / 1000 - t) > 300) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = hex(await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${payload}`)));
  return sigs.some((s) => s.length === expected.length && timingSafeEqual(s, expected));
}

function timingSafeEqual(a: string, b: string): boolean {
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

interface Subscription {
  id: string;
  customer: string;
  status: string;
  cancel_at_period_end: boolean;
  current_period_end: number;
  metadata?: { user?: string };
}

/** Applies a verified webhook event. Returns what changed (for logs/tests). */
export async function applyEvent(env: Env, event: { type: string; data: { object: Record<string, unknown> } }): Promise<string> {
  const o = event.data.object;
  if (event.type === "checkout.session.completed") {
    const user = o.client_reference_id as string | undefined;
    if (user && o.customer) await env.DB.prepare(`UPDATE users SET stripe_customer = ? WHERE name = ?`).bind(o.customer, user).run();
    return `checkout for ${user ?? "?"}`;
  }
  if (event.type.startsWith("customer.subscription.")) {
    const s = o as unknown as Subscription;
    const active = ["active", "trialing", "past_due"].includes(s.status) && event.type !== "customer.subscription.deleted";
    const byMeta = s.metadata?.user;
    const r = await env.DB.prepare(
      `UPDATE users SET plan = ?, plan_status = ?, plan_renews_at = ?, plan_cancel_at_end = ?, stripe_subscription = ?, stripe_customer = ?
       WHERE ${byMeta ? "name = ?" : "stripe_customer = ?"}`,
    )
      .bind(active ? "pro" : "free", event.type === "customer.subscription.deleted" ? "canceled" : s.status, s.current_period_end * 1000, s.cancel_at_period_end ? 1 : 0, s.id, s.customer, byMeta ?? s.customer)
      .run();
    return `${byMeta ?? s.customer}: ${active ? "pro" : "free"} (${s.status}), ${r.meta.changes} updated`;
  }
  return "ignored";
}
