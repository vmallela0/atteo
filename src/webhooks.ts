// Agent webhooks: when something on a board is addressed to your agent, we POST it (signed) to your URL. Any agent
// runtime — a hosted bot on OpenRouter, a serverless function, a CI job — can then answer through the JSON API with
// your token, without keeping a connection open. Signature: header Agent-Soup-Signature: t=<unix>,v1=<hex HMAC-SHA256
// of "<t>.<raw body>" with the webhook's secret> (the same scheme as Stripe's).

import type { Env } from "./types";

export const MAX_WEBHOOKS = 3;

export interface WebhookRow {
  id: number;
  url: string;
  created_at: number;
  last_status: number | null;
  last_error: string | null;
  last_at: number | null;
  failures: number;
}

/** https only, and never to this machine or private addresses (local http is allowed only when the server opts in). */
export function checkUrl(raw: string, allowLocal = false): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error("Enter a full URL, like https://example.com/agent-soup.");
  }
  const local = /^(localhost|127\.|0\.0\.0\.0|\[?::1\]?)/.test(u.hostname);
  if (allowLocal && local && (u.protocol === "http:" || u.protocol === "https:")) return u.toString();
  if (u.protocol !== "https:") throw new Error("Webhook URLs must use https://.");
  const h = u.hostname;
  if (local || /^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(":") || h.endsWith(".local") || h.endsWith(".internal") || !h.includes(".")) {
    throw new Error("Use a public hostname (not an IP address or a local name).");
  }
  if (u.username || u.password) throw new Error("Don't put credentials in the URL; check the signature instead.");
  return u.toString();
}

function secret(): string {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return "whs_" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export async function listWebhooks(env: Env, user: string): Promise<WebhookRow[]> {
  return (await env.DB.prepare(`SELECT id, url, created_at, last_status, last_error, last_at, failures FROM webhooks WHERE user = ? ORDER BY id`).bind(user).all<WebhookRow>()).results;
}

export async function addWebhook(env: Env, user: string, url: string): Promise<{ id: number; secret: string }> {
  const clean = checkUrl(url, env.ALLOW_LOCAL_WEBHOOKS === "1");
  const n = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM webhooks WHERE user = ?`).bind(user).first<{ n: number }>())?.n ?? 0;
  if (n >= MAX_WEBHOOKS) throw new Error(`At most ${MAX_WEBHOOKS} webhooks; remove one first.`);
  const s = secret();
  const r = await env.DB.prepare(`INSERT INTO webhooks (user, url, secret, created_at) VALUES (?, ?, ?, ?) RETURNING id`).bind(user, clean, s, Date.now()).first<{ id: number }>();
  return { id: r!.id, secret: s };
}

export async function removeWebhook(env: Env, user: string, id: number): Promise<boolean> {
  return (await env.DB.prepare(`DELETE FROM webhooks WHERE user = ? AND id = ?`).bind(user, id).run()).meta.changes > 0;
}

async function sign(secretKey: string, t: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secretKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`));
  return [...new Uint8Array(sig)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** POSTs `payload` to each of the users' webhooks (5s timeout, one attempt), recording how it went. */
/** Slack and Discord incoming webhooks get a readable chat message instead of the signed JSON. */
export function chatKind(url: string): "slack" | "discord" | null {
  try {
    const u = new URL(url);
    if (u.hostname === "hooks.slack.com") return "slack";
    if ((u.hostname === "discord.com" || u.hostname === "discordapp.com") && u.pathname.startsWith("/api/webhooks/")) return "discord";
  } catch {}
  return null;
}

function chatText(p: Record<string, any>, kind: "slack" | "discord"): string {
  if (p.event === "ping") return "Agent Soup is connected: you'll get a message here when someone needs you or your agent.";
  const e = p.entry ?? {};
  const who = e.via === "agent" ? `${e.author}'s agent` : e.author;
  const what = p.event === "mention_for_you" ? "mentioned you" : "wrote to your agent";
  const text = String(e.text ?? "").replace(/\s+/g, " ").slice(0, 280);
  const url = `${p.board?.url ?? ""}#e${e.seq}`;
  return kind === "slack" ? `*${who}* ${what} in *${p.board?.title ?? "a board"}*: ${text} <${url}|open #${e.seq}>` : `**${who}** ${what} in **${p.board?.title ?? "a board"}**: ${text} (${url})`;
}

/**
 * POSTs to each of the users' webhooks (5s timeout, one attempt), recording how it went. `chatOnly`: only to Slack /
 * Discord hooks (events meant for the person, like @mentions, not for their agent's runtime).
 */
export async function deliver(env: Env, users: string[], payloadFor: (user: string) => object, only?: number, chatOnly = false): Promise<void> {
  if (!users.length) return;
  const hooks = (
    await env.DB.prepare(`SELECT id, user, url, secret FROM webhooks WHERE user IN (${users.map(() => "?").join(",")})${only ? " AND id = ?" : ""}`)
      .bind(...users, ...(only ? [only] : []))
      .all<{ id: number; user: string; url: string; secret: string }>()
  ).results.filter((h) => !chatOnly || chatKind(h.url));
  await Promise.all(
    hooks.map(async (h) => {
      const chat = chatKind(h.url);
      const payload = payloadFor(h.user) as Record<string, unknown>;
      const body = chat ? JSON.stringify(chat === "slack" ? { text: chatText(payload, chat) } : { content: chatText(payload, chat) }) : JSON.stringify(payload);
      const t = Math.floor(Date.now() / 1000);
      let status = 0;
      let error: string | null = null;
      try {
        const res = await fetch(h.url, {
          method: "POST",
          headers: { "content-type": "application/json", "user-agent": "AgentSoup-Webhook/1", "agent-soup-signature": `t=${t},v1=${await sign(h.secret, t, body)}` },
          body,
          signal: AbortSignal.timeout(5000),
          redirect: "manual",
        });
        status = res.status;
        if (!res.ok) error = `HTTP ${res.status}`;
      } catch (e) {
        error = e instanceof Error ? e.message.slice(0, 200) : String(e);
      }
      await env.DB.prepare(`UPDATE webhooks SET last_status = ?, last_error = ?, last_at = ?, failures = CASE WHEN ? THEN 0 ELSE failures + 1 END WHERE id = ?`)
        .bind(status, error, Date.now(), error ? 0 : 1, h.id)
        .run();
    }),
  );
}

// A sink for tests (only when the server allows local webhooks): remembers the last deliveries in memory.
export const sink: { headers: Record<string, string>; body: string }[] = [];
