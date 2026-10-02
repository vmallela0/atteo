// Usage: node scripts/stripe-smoke.mjs   (reads keys from secrets.txt; test mode only)
// End-to-end test purchase against production in Stripe TEST mode, with Stripe's test payment method (pm_card_visa):
// subscribe → prod webhook makes the user Pro → portal opens → cancel → back to Free.
import { readFileSync } from "node:fs";
const BASE = "https://agent-board.vedu-mallela.workers.dev";
const secrets = readFileSync("secrets.txt", "utf8");
const get = (label) => secrets.split("\n").find((l) => l.toLowerCase().startsWith(label))?.replace(/^[^-]*-\s*/, "").trim();
const SK = get("stripe secret key (test)"), ADMIN = get("agent board admin key");
const stripe = async (path, params, method = params ? "POST" : "GET") => {
  const r = await fetch(`https://api.stripe.com/v1/${path}`, { method, headers: { authorization: `Bearer ${SK}`, "stripe-version": "2024-06-20", "content-type": "application/x-www-form-urlencoded" }, body: params ? new URLSearchParams(params) : undefined });
  const j = await r.json(); if (!r.ok) throw new Error(`${path}: ${j.error?.message}`); return j;
};
const ops = (p, b) => fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": ADMIN, "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
const user = `e2e-stripe-${Date.now().toString(36).slice(-5)}`;
await ops("users", { name: user, email: `${user}@example.com`, verified: "true" });
const cookie = (await ops("sessions", { user })).cookie;
const plan = async () => ((await (await fetch(`${BASE}/me`, { headers: { cookie } })).text()).match(/You're on <b>([^<]+)<\/b>/) ?? [])[1];
console.log("before:", await plan());
// Checkout session from the app (the real upgrade button's endpoint)
const co = await (await fetch(`${BASE}/api/billing/checkout`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: '{"interval":"month"}' })).json();
console.log("checkout page:", co.url ? co.url.slice(0, 40) + "…" : co.error);
const customer = (await stripe(`customers?email=${encodeURIComponent(`${user}@example.com`)}`)).data[0]?.id;
const pm = await stripe(`payment_methods/pm_card_visa/attach`, { customer });
await stripe(`customers/${customer}`, { "invoice_settings[default_payment_method]": pm.id });
const price = (await stripe(`prices?lookup_keys[]=pro_monthly`)).data[0].id;
const sub = await stripe("subscriptions", { customer, "items[0][price]": price, "metadata[user]": user });
console.log("subscription:", sub.status, (sub.items.data[0].price.unit_amount / 100).toFixed(2), sub.items.data[0].price.currency);
for (let i = 0; i < 30 && !(await plan())?.startsWith("Pro"); i++) await new Promise((r) => setTimeout(r, 1000));
console.log("after webhook:", await plan());
const portal = await (await fetch(`${BASE}/api/billing/portal`, { method: "POST", headers: { cookie } })).json();
console.log("portal:", portal.url ? portal.url.slice(0, 40) + "…" : portal.error);
const inv = (await stripe(`invoices?subscription=${sub.id}`)).data[0];
console.log("invoice:", inv?.status, inv ? (inv.amount_paid / 100).toFixed(2) : "");
await stripe(`subscriptions/${sub.id}`, undefined, "DELETE");
for (let i = 0; i < 30 && (await plan()) !== "Free"; i++) await new Promise((r) => setTimeout(r, 1000));
console.log("after cancel:", await plan());
