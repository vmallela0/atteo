// The Slack bridge's pure parts (src/slack.ts has the routes and the flow): checking Slack's signature, keeping board
// text from pinging or linking anything in Slack, turning Slack text back into board text, sealing bot tokens, and
// drawing the messages. Board text is written by board members: untrusted. Everything from it is escaped (& < >),
// which disarms <!channel>, <!here>, <@U…>, <#C…>, <!subteam^…> and <url|label> links; messages also go with
// parse "none", link_names false and no unfurls, and text blocks are verbatim. The only pings we send are <@U…> we
// build ourselves from mentions the server resolved to people linked in that workspace.

import type { ApprovalRef, Entry } from "./types";
import { screenText } from "./screen";
import { isLocalHost } from "./util";

export const SLACK_API = "https://slack.com/api/";
/** Bot scopes: post (as a named agent), read the channels it's in for thread replies, DM approvals, the slash command. */
export const BOT_SCOPES = [
  "chat:write",
  "chat:write.customize",
  "channels:read",
  "channels:join",
  "channels:history",
  "groups:read",
  "groups:history",
  "im:write",
  "commands",
  "users:read",
].join(",");
export const SKEW_S = 300; // a request more than 5 minutes off is refused (replays)
export const NONCE_MS = 10 * 60_000;
export const SEEN_MS = 3600_000;
export const MAX_TEXT = 3000; // a section's text; longer is cut with "…more on Atteo"
export const DIGEST_EVERY_MS = 15 * 60_000;
export const DIGEST_FRESH_MS = 3600_000;
/** What a person sees when the feature isn't set up. */
export const NOT_SET_UP = "Slack isn't set up on this server yet: it needs SLACK_CLIENT_ID (a var) and SLACK_CLIENT_SECRET, SLACK_SIGNING_SECRET and SLACK_TOKEN_KEY (secrets). See docs/SLACK.md.";
/** A local server's signing secret for the stub (DEV_FAKE_SLACK=1 on localhost): tests sign their fake Slack requests with it. */
export const FAKE_SIGNING_SECRET = "dev-fake-slack-signing-secret";
const FAKE_TOKEN_KEY = "ZGV2LWZha2Utc2xhY2stdG9rZW4ta2V5LTMyYnl0ZXM="; // "dev-fake-slack-token-key-32bytes"

export type SlackEnv = {
  SLACK_CLIENT_ID?: string;
  SLACK_CLIENT_SECRET?: string;
  SLACK_SIGNING_SECRET?: string;
  SLACK_TOKEN_KEY?: string;
  DEV_FAKE_SLACK?: string;
  PUBLIC_URL?: string;
};

/** The stub: DEV_FAKE_SLACK=1 on a localhost server (the request's host, or PUBLIC_URL's where there's no request). */
export function fakeSlack(env: SlackEnv, request: Request | null = null): boolean {
  if (env.DEV_FAKE_SLACK !== "1") return false;
  try {
    return isLocalHost(new URL(request ? request.url : env.PUBLIC_URL ?? "https://atteo.dev").hostname);
  } catch {
    return false;
  }
}

/** Whether the bridge exists here at all: every Slack setting, or the local stub. Until then routes 404 and the menu item is hidden. */
export function slackOn(env: SlackEnv, request: Request | null = null): boolean {
  return !!(env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET && env.SLACK_SIGNING_SECRET && env.SLACK_TOKEN_KEY) || fakeSlack(env, request);
}

export function signingSecret(env: SlackEnv, request: Request | null): string | null {
  return env.SLACK_SIGNING_SECRET || (fakeSlack(env, request) ? FAKE_SIGNING_SECRET : null);
}

// ---- Slack's request signature: v0=HMAC-SHA256(signing secret, "v0:<timestamp>:<raw body>") ----

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

export async function sign(secret: string, ts: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return "v0=" + hex(await crypto.subtle.sign("HMAC", key, enc.encode(`v0:${ts}:${body}`)));
}

export function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** Whether a request really is Slack's: a good signature over the raw body, made in the last 5 minutes. */
export async function verify(secret: string | null, ts: string | null, signature: string | null, body: string, nowMs: number): Promise<{ ok: true } | { ok: false; why: string }> {
  if (!secret) return { ok: false, why: "not set up" };
  if (!ts || !/^\d{1,12}$/.test(ts) || !signature) return { ok: false, why: "unsigned" };
  if (Math.abs(nowMs / 1000 - Number(ts)) > SKEW_S) return { ok: false, why: "stale timestamp" };
  return sameText(await sign(secret, ts, body), signature) ? { ok: true } : { ok: false, why: "bad signature" };
}

// ---- bot tokens at rest: AES-GCM with SLACK_TOKEN_KEY (32 bytes, base64) ----

function keyBytes(env: SlackEnv): Uint8Array {
  return keyFromB64(env.SLACK_TOKEN_KEY || (fakeSlack(env) ? FAKE_TOKEN_KEY : ""), "SLACK_TOKEN_KEY");
}

/** A 32-byte AES key from its base64 secret (`name` says which, in errors). Shared with the Linear integration. */
export function keyFromB64(b64key: string, name: string): Uint8Array {
  if (!b64key) throw new Error(`${name} isn't set`);
  const raw = Uint8Array.from(atob(b64key.trim()), (c) => c.charCodeAt(0));
  if (raw.length !== 32) throw new Error(`${name} must be 32 bytes, base64 (openssl rand -base64 32)`);
  return raw;
}
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** A third-party token sealed for D1: "v1:<iv>:<ciphertext>", AES-GCM with a fresh IV. */
export async function sealWith(key: Uint8Array, token: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, enc.encode(token)));
  return `v1:${b64(iv)}:${b64(ct)}`;
}

export async function openWith(key: Uint8Array, sealed: string): Promise<string> {
  const [v, iv, ct] = sealed.split(":");
  if (v !== "v1" || !iv || !ct) throw new Error("not a sealed token");
  const k = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, k, unb64(ct)));
}

export async function sealToken(env: SlackEnv, token: string): Promise<string> {
  return sealWith(keyBytes(env), token);
}

export async function openToken(env: SlackEnv, sealed: string): Promise<string> {
  return openWith(keyBytes(env), sealed);
}

// ---- text: board → Slack (escaped) and Slack → board ----

/** Slack's three control characters, escaped: no <!channel>, <@U…> or <url|label> survives from board text. */
export function esc(s: string | null | undefined): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Cut to `max` characters with "…more on Atteo" linking to the entry. */
export function cut(text: string, max: number, url: string): string {
  if (text.length <= max) return text;
  const more = `… <${url}|more on Atteo>`;
  return text.slice(0, Math.max(0, max - more.length)).replace(/&[a-z]*$/, "") + more;
}

/** A name for chat:write.customize's username: plain characters only, never markup. */
export function plainName(s: string, max = 80): string {
  return String(s ?? "").replace(/[<>&*_~`|]/g, "").replace(/\s+/g, " ").trim().slice(0, max) || "Atteo";
}

/**
 * Slack's text as a board post: people linked to Atteo become @handles (so they hear about it), anyone else a plain
 * name; channel and group pings lose their power; links read as "label (url)". The board screens it like any post.
 */
export function fromSlack(text: string, people: Map<string, string>): string {
  return String(text ?? "")
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id: string, label?: string) => (people.has(id) ? `@${people.get(id)}` : label ? label : "someone"))
    .replace(/<#[CG][A-Z0-9]+\|([^>]*)>/g, "#$1")
    .replace(/<#[CG][A-Z0-9]+>/g, "#channel")
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "$1")
    .replace(/<!subteam\^[A-Z0-9]+(?:\|@?([^>]*))?>/g, (_, l?: string) => l || "a group")
    .replace(/<!date\^[^|>]*\|([^>]*)>/g, "$1")
    .replace(/<mailto:[^|>]+\|([^>]+)>/g, "$1")
    .replace(/<((?:https?|ftp):[^|>]+)\|([^>]+)>/g, (_, u: string, l: string) => (l === u ? u : `${l} (${u})`))
    .replace(/<((?:https?|ftp):[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

// ---- what goes where ----

export type Lane = "decisions" | "everything";
export type Route = "own" | "thread" | "digest" | "skip";

/**
 * Who wrote it, in words, for the context line and the username. PACT replies are an outside agent's: known by the
 * server-set origin, never by the client name, which an agent chooses (#5439).
 */
export function authorLabel(e: Pick<Entry, "author" | "via" | "client" | "origin">): { username: string; context: string } {
  const outside = e.origin === "pact";
  if (e.via === "agent") {
    const client = e.client ? plainName(e.client, 30) : "";
    return { username: plainName(outside ? `${e.author}'s outside agent` : `${e.author}'s agent${client ? ` (${client})` : ""}`), context: outside ? "🤖 Outside agent, via PACT" : "🤖 Agent on Atteo" };
  }
  return { username: plainName(e.author), context: "via Atteo" };
}

/** Whether it's a decision-lane item: something a person acts on or is named in. */
export function actionable(e: Entry, linked: Set<string>): boolean {
  if (e.type === "question" || e.type === "decision" || e.type === "approval" || e.human_decision) return true;
  if (e.type === "handoff" && e.handoff?.state === "open") return true; // ready to gate
  if (e.type === "task" && e.to && linked.has(e.to)) return true;
  return (e.mentions ?? []).some((m) => !m.agent && linked.has(m.user) && m.user !== e.author);
}

/**
 * Where one entry goes in one channel: its own message, a reply in its root's thread, the digest, or nowhere. Flagged
 * posts (they look like instructions to agents) and the bridge's own notices are never bridged; a flagged one is
 * counted in the digest. `root` is the top of its reply chain (null when it's a root itself).
 */
export function routeOf(e: Entry, root: Entry | null, lane: Lane, linked: Set<string>): Route {
  if (e.via === "agent" && e.origin === "slack") return "skip"; // the bridge's own notices (server-set, #5439)
  if (flagOf(e)) return "digest";
  if (root) {
    if (flagOf(root)) return "digest";
    if (lane === "everything" || actionable(root, linked)) return "thread";
    return actionable(e, linked) ? "own" : "digest";
  }
  return lane === "everything" || actionable(e, linked) ? "own" : "digest";
}

export const flagOf = (e: Pick<Entry, "text" | "ai_flag" | "title">): boolean => !!(e.ai_flag || screenText(e.text) || (e.title && screenText(e.title)));

// ---- drawing messages ----

export interface SlackMessage {
  text: string; // the notification's plain line (escaped too)
  blocks: unknown[];
  username?: string;
}

const KIND: Record<string, string> = {
  question: "❓ Question",
  decision: "✅ Decision",
  task: "📋 Task",
  change: "🔀 Change",
  handoff: "🚦 Ready to land",
  artifact: "📎 File",
  claim: "🙋 On it",
  note: "",
  approval: "🔐 Approval",
};

const button = (text: string, o: { url?: string; action?: string; value?: string; style?: "primary" | "danger" }) => ({
  type: "button",
  text: { type: "plain_text", text, emoji: true },
  ...(o.url ? { url: o.url } : {}),
  ...(o.action ? { action_id: o.action } : {}),
  ...(o.value ? { value: o.value } : {}),
  ...(o.style ? { style: o.style } : {}),
});
const mrkdwn = (text: string, verbatim = true) => ({ type: "mrkdwn", text, verbatim });

/** A board entry as a Slack message. `cc`: Slack ids of linked people it names (the only pings). */
export function entryMessage(e: Entry, o: { boardTitle: string; url: string; cc: string[]; boardId: string }): SlackMessage {
  const who = authorLabel(e);
  const kind = KIND[e.type] ?? "";
  const title = e.title ? `*${esc(e.title)}*` : "";
  // Files never go to Slack: the title and a link (which needs an Atteo sign-in).
  const body = e.type === "artifact" || e.attachments?.length || e.media ? `${esc(e.artifact_name ?? e.attachments?.map((a) => a.name).join(", ") ?? "A file")} (open it in Atteo)${e.text ? `\n${esc(e.text)}` : ""}` : esc(e.text);
  const head = [kind, title].filter(Boolean).join(" · ");
  const main = cut([head, body].filter(Boolean).join("\n"), MAX_TEXT, o.url);
  const context = [mrkdwn(`${who.context} · ${esc(o.boardTitle)} · <${o.url}|#${e.seq}>`)];
  const actions = [
    ...(e.type === "question" && e.retracts == null ? [button("Answer", { action: "answer", value: `${o.boardId}:${e.seq}`, style: "primary" })] : []),
    button("Open in Atteo", { url: o.url, action: "open" }),
  ];
  const blocks: unknown[] = [{ type: "section", text: mrkdwn(main) }, { type: "context", elements: context }];
  if (o.cc.length) blocks.push({ type: "context", elements: [mrkdwn(`cc ${o.cc.map((id) => `<@${id}>`).join(" ")}`, false)] });
  blocks.push({ type: "actions", elements: actions });
  return { text: cut(`${who.username}: ${[kind, e.title ? esc(e.title) : esc(e.text)].filter(Boolean).join(" · ")}`, 300, o.url), blocks, username: who.username };
}

/** Retracted on the board: the message stays (its thread too), saying so. */
export function retractedMessage(url: string): SlackMessage {
  return { text: "Unsent on Atteo.", blocks: [{ type: "context", elements: [mrkdwn(`_Unsent on Atteo._ <${url}|Open>`)] }] };
}

const STATUS: Record<string, string> = { pending: "⏳ waiting on", approved: "✅ approved by", rejected: "❌ denied by", expired: "⌛ timed out, denied for" };

/** The channel's view of an approval: what's asked and its status, never the details or the buttons. */
export function approvalStatusMessage(ref: ApprovalRef, o: { boardTitle: string; url: string; owner: string; asker: string }): SlackMessage {
  const status = `${STATUS[ref.status] ?? ref.status} ${o.owner}`;
  return {
    text: `Approval: ${esc(ref.title)} (${status})`,
    blocks: [
      { type: "section", text: mrkdwn(cut(`🔐 *Approval* · ${esc(ref.title)}\n${status}`, MAX_TEXT, o.url)) },
      { type: "context", elements: [mrkdwn(`🤖 ${esc(o.asker)} asks · ${esc(o.boardTitle)} · <${o.url}|Open in Atteo>`)] },
    ],
    username: plainName(o.asker),
  };
}

export interface ApprovalDetail {
  id: string;
  title: string;
  details: string;
  tool: string | null;
  command: string | null;
  risk: "low" | "medium" | "high";
  status: string;
  user: string;
  note?: string | null;
}

// What an approval DM shows uncut. Longer, and Slack can't decide it: nobody approves what they couldn't see (#5438).
export const DM_COMMAND_MAX = 2500; // the command, in a preformatted block of its own
export const DM_DETAILS_MAX = 2000; // the details, escaped, under the heading (the section's 3000 less room for the rest)
const DM_TITLE_MAX = 300;
const DM_TOOL_MAX = 100;

/**
 * Whether Approve / Deny can be offered in Slack: not high risk, and the title, tool, command and details all show in
 * full. decideFromSlack checks the same, so an old DM (or a forged click) can't decide one that wouldn't fit.
 */
export function decidableInSlack(a: Pick<ApprovalDetail, "risk" | "title" | "details" | "tool" | "command">): boolean {
  return a.risk !== "high" && (a.command ?? "").length <= DM_COMMAND_MAX && esc(a.details ?? "").length <= DM_DETAILS_MAX && esc(a.title ?? "").length <= DM_TITLE_MAX && esc(a.tool ?? "").length <= DM_TOOL_MAX;
}

/**
 * The owner's DM: everything to decide on, with Approve / Deny; high risk, or too long to show whole, only opens Atteo.
 * The command is a preformatted rich-text block: its characters are shown as they are (``` can't close it, and
 * nothing in it is a ping or a link).
 */
export function approvalDm(a: ApprovalDetail, o: { boardTitle: string | null; url: string; asker: string; via?: string | null }): SlackMessage {
  const open = a.status === "pending";
  const whole = decidableInSlack(a);
  const risk = a.risk === "high" ? "🔴 High risk" : a.risk === "low" ? "🟢 Low risk" : "🟠 Medium risk";
  const details = a.details ? `\n${esc(whole ? a.details : a.details.slice(0, DM_DETAILS_MAX - 100))}${whole ? "" : "…"}` : "";
  const head = `🔐 *${esc(o.asker)}* asks: *${esc(a.title.slice(0, DM_TITLE_MAX))}*\n${risk}${a.tool ? ` · ${esc(a.tool.slice(0, DM_TOOL_MAX))}` : ""}${o.boardTitle ? ` · ${esc(excerpt(o.boardTitle, 120))}` : ""}`;
  const done = open ? "" : `\n${a.status === "approved" ? "✅ Approved" : a.status === "rejected" ? "❌ Denied" : "⌛ Timed out (denied)"}${o.via?.startsWith("slack:") ? " in Slack" : ""}`;
  const blocks: unknown[] = [{ type: "section", text: mrkdwn(cut(head + details + done, MAX_TEXT, o.url)) }];
  if (a.command) {
    const shown = a.command.length > DM_COMMAND_MAX ? a.command.slice(0, DM_COMMAND_MAX) + "\n…" : a.command;
    blocks.push({ type: "rich_text", elements: [{ type: "rich_text_preformatted", elements: [{ type: "text", text: shown }] }] });
  }
  if (open && !whole && a.risk !== "high") blocks.push({ type: "context", elements: [mrkdwn("Too long to show here in full: review and decide it in Atteo.")] });
  if (open)
    blocks.push({
      type: "actions",
      elements: whole
        ? [button("Approve", { action: "approve", value: a.id, style: "primary" }), button("Deny", { action: "deny", value: a.id, style: "danger" }), button("Open in Atteo", { url: o.url, action: "open" })]
        : [button("Review in Atteo", { url: o.url, action: "open", style: "primary" })],
    });
  return { text: `${esc(o.asker)} asks: ${esc(a.title)}`, blocks };
}

/** The digest: one message per channel, edited in place. */
export function digestMessage(d: { n: number; agents: string[]; latest: string | null; flagged: number; missed: number; boardTitle: string; url: string }): SlackMessage {
  // Who wrote them: up to three names ("ana's agent, bo"), else how many.
  const who = !d.agents.length ? "" : d.agents.length <= 3 ? ` from ${d.agents.map(esc).join(", ")}` : ` from ${d.agents.length} people and agents`;
  const parts = [`*${d.n} ${d.n === 1 ? "update" : "updates"}${who}* on ${esc(d.boardTitle)}`];
  if (d.latest) parts.push(`latest: ${esc(d.latest)}`);
  if (d.flagged) parts.push(`${d.flagged} flagged ${d.flagged === 1 ? "post" : "posts"}, view in Atteo`);
  if (d.missed) parts.push(`missed ${d.missed} ${d.missed === 1 ? "update" : "updates"} while Slack was down`);
  return { text: `${d.n} updates on ${esc(d.boardTitle)}`, blocks: [{ type: "section", text: mrkdwn(cut(parts.join(" · "), MAX_TEXT, d.url)) }, { type: "actions", elements: [button("Open in Atteo", { url: d.url, action: "open" })] }] };
}

/** The extra fields every message carries: nothing in it pings, links or unfurls on its own. */
export function postFields(m: SlackMessage): Record<string, unknown> {
  return { text: m.text, blocks: m.blocks, ...(m.username ? { username: m.username } : {}), parse: "none", link_names: false, unfurl_links: false, unfurl_media: false };
}

export function excerpt(text: string, max = 120): string {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

export function randomNonce(): string {
  return [...crypto.getRandomValues(new Uint8Array(18))].map((x) => x.toString(16).padStart(2, "0")).join("");
}
