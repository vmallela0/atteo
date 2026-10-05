// GitHub App notifications (GAPS P1 first slice): inbound GitHub webhooks become a board-note shape, and Atteo
// change cards become GitHub Checks / PR-comment payloads. Off until GITHUB_WEBHOOK_SECRET is set (inbound) and
// GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY (outbound). This slice verifies signatures, parses events, and formats
// payloads. It does not post to a board or call GitHub.

import { cardLine, type ChangeCard } from "./card";
import { pingExcerpt } from "./ping";
import { scanText } from "./secrets";
import type { Env } from "./types";

export const NOT_SET_UP = "GitHub app notifications aren't set up.";
export const MAX_WEBHOOK_BYTES = 1_000_000;
export const GITHUB_API = "https://api.github.com";

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

function timingSafeEqual(a: string, b: string): boolean {
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asStr(v: unknown, max = 300): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
}

function asNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : null;
}

/** Inbound is on when the GitHub App webhook secret is set (never in this PR; `wrangler secret put`). */
export function inboundEnabled(env: Pick<Env, "GITHUB_WEBHOOK_SECRET">): boolean {
  return !!env.GITHUB_WEBHOOK_SECRET?.trim();
}

/** Outbound posting needs the App id and private key. This slice never sends even when they are set. */
export function outboundEnabled(env: Pick<Env, "GITHUB_APP_ID" | "GITHUB_APP_PRIVATE_KEY">): boolean {
  return !!(env.GITHUB_APP_ID?.trim() && env.GITHUB_APP_PRIVATE_KEY?.trim());
}

/** Verifies `X-Hub-Signature-256: sha256=<hex>` over the raw body (GitHub's HMAC-SHA256 of the payload). */
export async function verifySignature(payload: string, header: string | null, secret: string): Promise<boolean> {
  if (!header || !secret) return false;
  const m = header.trim().match(/^sha256=([0-9a-fA-F]{64})$/);
  if (!m) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = hex(await crypto.subtle.sign("HMAC", key, enc.encode(payload)));
  const got = m[1].toLowerCase();
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export interface GithubHeaders {
  event: string | null;
  signature: string | null;
  delivery: string | null;
}

/** Compact GitHub facts we keep (never the raw body: it can be huge and can carry secrets). */
export interface GithubDelivery {
  event: string;
  action: string | null;
  delivery: string | null;
  installation: number | null;
  repo: string | null;
  sender: string | null;
  url: string | null;
}

/** What would be posted on a board once inbound posting is wired. */
export interface BoardGithubNote {
  type: "note";
  title: string;
  text: string;
  data: { github: Record<string, string | number | null> };
}

export type WebhookResult =
  | { status: 503; error: string }
  | { status: 400; error: string }
  | { status: 413; error: string }
  | { status: 200; ok: true; applied: string; note?: BoardGithubNote };

const PR_ACTIONS = new Set(["opened", "closed", "reopened", "synchronize", "ready_for_review", "converted_to_draft"]);

function deliveryOf(event: string, payload: Record<string, unknown>, headers: GithubHeaders): GithubDelivery {
  const repo = asObj(payload.repository);
  const sender = asObj(payload.sender);
  const inst = asObj(payload.installation);
  const pr = asObj(payload.pull_request);
  const issue = asObj(payload.issue);
  const suite = asObj(payload.check_suite);
  const url =
    asStr(pr?.html_url, 500) ??
    asStr(issue?.html_url, 500) ??
    asStr(suite?.html_url, 500) ??
    asStr(payload.compare, 500) ??
    (asStr(repo?.html_url, 400) ? `${asStr(repo?.html_url, 400)}` : null);
  return {
    event,
    action: asStr(payload.action, 40),
    delivery: asStr(headers.delivery, 80),
    installation: asNum(inst?.id),
    repo: asStr(repo?.full_name, 200),
    sender: asStr(sender?.login, 80),
    url,
  };
}

function note(title: string, text: string, d: GithubDelivery, extra: Record<string, string | number | null> = {}): BoardGithubNote | null {
  const body = pingExcerpt(text);
  if (scanText(body) || scanText(title)) return null;
  return {
    type: "note",
    title,
    text: body,
    data: {
      github: {
        event: d.event,
        action: d.action,
        delivery: d.delivery,
        installation: d.installation,
        repo: d.repo,
        sender: d.sender,
        url: d.url,
        ...extra,
      },
    },
  };
}

function prLabel(payload: Record<string, unknown>): { n: number | null; title: string; merged: boolean } {
  const pr = asObj(payload.pull_request);
  const n = asNum(payload.number) ?? asNum(pr?.number);
  return { n, title: asStr(pr?.title, 200) ?? "", merged: pr?.merged === true };
}

/**
 * Maps a verified GitHub event to a board note, or null to ignore it (unknown event, noisy action, or the text
 * looked like a secret). Ping and installation events are handled by `handleWebhook` without a note.
 */
export function boardNoteFromGithub(event: string, payload: unknown, headers: GithubHeaders = { event, signature: null, delivery: null }): BoardGithubNote | null {
  const p = asObj(payload);
  if (!p) return null;
  const d = deliveryOf(event, p, headers);
  const who = d.sender ?? "someone";
  const repo = d.repo ?? "a repository";

  if (event === "pull_request") {
    const action = d.action;
    if (!action || !PR_ACTIONS.has(action)) return null;
    const { n, title, merged } = prLabel(p);
    const num = n != null ? `#${n}` : "a PR";
    const named = title ? ` "${title}"` : "";
    if (action === "closed" && merged) return note("PR merged", `${who} merged ${num}${named} on ${repo}${d.url ? `: ${d.url}` : "."}`, d, { number: n, merged: 1 });
    const verb =
      action === "synchronize" ? "pushed to" : action === "ready_for_review" ? "marked ready" : action === "converted_to_draft" ? "converted to draft" : action;
    const titleWord = action === "synchronize" ? "PR updated" : action === "closed" ? "PR closed" : action === "opened" ? "PR opened" : action === "reopened" ? "PR reopened" : "PR update";
    return note(titleWord, `${who} ${verb} ${num}${named} on ${repo}${d.url ? `: ${d.url}` : "."}`, d, { number: n });
  }

  if (event === "pull_request_review") {
    if (d.action !== "submitted") return null;
    const review = asObj(p.review);
    const { n, title } = prLabel(p);
    const num = n != null ? `#${n}` : "a PR";
    const named = title ? ` "${title}"` : "";
    const state = (asStr(review?.state, 20) ?? "commented").toLowerCase().replace(/_/g, " ");
    return note("PR review", `${who} ${state} ${num}${named} on ${repo}${d.url ? `: ${d.url}` : "."}`, d, { number: n, state });
  }

  if (event === "issue_comment") {
    if (d.action !== "created") return null;
    const issue = asObj(p.issue);
    if (!issue || issue.pull_request == null) return null;
    const n = asNum(issue?.number);
    const num = n != null ? `#${n}` : "a PR";
    const named = asStr(issue?.title, 200);
    return note("PR comment", `${who} commented on ${num}${named ? ` "${named}"` : ""} on ${repo}${d.url ? `: ${d.url}` : "."}`, d, { number: n });
  }

  if (event === "check_suite") {
    if (d.action !== "completed") return null;
    const suite = asObj(p.check_suite);
    const conclusion = (asStr(suite?.conclusion, 40) ?? "unknown").toLowerCase();
    const sha = asStr(suite?.head_sha, 40);
    return note("Checks done", `${who}'s checks on ${repo} finished ${conclusion}${sha ? ` at ${sha.slice(0, 12)}` : ""}${d.url ? `: ${d.url}` : "."}`, d, {
      conclusion,
      sha,
    });
  }

  if (event === "push") {
    const ref = asStr(p.ref, 200) ?? "";
    const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    if (!branch) return null;
    const commits = Array.isArray(p.commits) ? p.commits.length : 0;
    return note("Push", `${who} pushed ${commits} commit${commits === 1 ? "" : "s"} to ${branch} on ${repo}${d.url ? `: ${d.url}` : "."}`, d, {
      ref: branch,
      commits,
    });
  }

  return null;
}

function eventName(headers: GithubHeaders): string | null {
  const e = headers.event?.trim().toLowerCase();
  return e && /^[a-z][a-z0-9_]{0,63}$/.test(e) ? e : null;
}

/** Verifies and parses an inbound GitHub App webhook. Never writes to a board. */
export async function handleWebhook(env: Pick<Env, "GITHUB_WEBHOOK_SECRET">, raw: string, headers: GithubHeaders): Promise<WebhookResult> {
  const secret = env.GITHUB_WEBHOOK_SECRET?.trim() ?? "";
  if (!secret) return { status: 503, error: NOT_SET_UP };
  if (enc.encode(raw).length > MAX_WEBHOOK_BYTES) return { status: 413, error: "payload too large" };
  if (!(await verifySignature(raw, headers.signature, secret))) return { status: 400, error: "bad signature" };
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { status: 400, error: "invalid json" };
  }
  const event = eventName(headers);
  if (!event) return { status: 400, error: "missing X-GitHub-Event" };
  if (event === "ping") return { status: 200, ok: true, applied: "ping" };
  if (event === "installation") {
    const action = asStr(asObj(payload)?.action, 40) ?? "updated";
    return { status: 200, ok: true, applied: `installation:${action}` };
  }
  const mapped = boardNoteFromGithub(event, payload, headers);
  if (!mapped) return { status: 200, ok: true, applied: "ignored" };
  return { status: 200, ok: true, applied: "note", note: mapped };
}

export type GithubOutboundKind = "check_run" | "issue_comment";

/** A GitHub REST call we would make; `ready` is false when a required field is missing. */
export interface GithubOutbound {
  kind: GithubOutboundKind;
  repo: string;
  method: "POST";
  path: string;
  url: string;
  body: Record<string, unknown>;
  ready: boolean;
  reason?: string;
}

const SHA40 = /^[0-9a-f]{40}$/i;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function prNumberFromUrl(url: string | null | undefined): number | null {
  const m = url?.trim().match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/i);
  return m ? Number(m[1]) : null;
}

export interface ChangeNotifyCtx {
  seq: number;
  author: string;
  boardId: string;
  boardUrl: string;
  /** Full 40-character head SHA when known; change cards often only store 12. */
  headSha?: string | null;
}

function shaOf(card: ChangeCard, ctx: ChangeNotifyCtx): string | null {
  const explicit = ctx.headSha?.trim();
  if (explicit && SHA40.test(explicit)) return explicit.toLowerCase();
  const fromCard = card.commits[0]?.sha?.trim();
  if (fromCard && SHA40.test(fromCard)) return fromCard.toLowerCase();
  return fromCard || null;
}

function conclusionOf(ci: ChangeCard["ci"]): "success" | "failure" | "neutral" {
  if (ci === "passing") return "success";
  if (ci === "failing") return "failure";
  return "neutral";
}

/** GitHub Check Run and (when a PR link exists) issue-comment payloads for a change card. Does not send. */
export function githubChangeNotification(card: ChangeCard, ctx: ChangeNotifyCtx): GithubOutbound[] {
  const out: GithubOutbound[] = [];
  const repo = card.repo?.trim() ?? "";
  const line = cardLine(card);
  const summary = [`Change card #${ctx.seq} by ${ctx.author}`, line, ctx.boardUrl].filter(Boolean).join("\n");
  if (!REPO.test(repo)) {
    return [{ kind: "check_run", repo: repo || "unknown", method: "POST", path: "/repos/{owner}/{repo}/check-runs", url: `${GITHUB_API}/repos/{owner}/{repo}/check-runs`, body: {}, ready: false, reason: "card.repo must be owner/name" }];
  }
  const sha = shaOf(card, ctx);
  const checkReady = !!sha && SHA40.test(sha);
  out.push({
    kind: "check_run",
    repo,
    method: "POST",
    path: `/repos/${repo}/check-runs`,
    url: `${GITHUB_API}/repos/${repo}/check-runs`,
    body: {
      name: "Atteo",
      head_sha: checkReady ? sha : sha ?? "",
      status: "completed",
      conclusion: conclusionOf(card.ci),
      details_url: ctx.boardUrl,
      external_id: `atteo:${ctx.boardId}:${ctx.seq}`,
      output: { title: line.slice(0, 1024), summary: summary.slice(0, 65_535) },
    },
    ready: checkReady,
    reason: checkReady ? undefined : "live posting needs the full 40-character head sha",
  });
  const n = prNumberFromUrl(card.pr_url);
  if (n) {
    out.push({
      kind: "issue_comment",
      repo,
      method: "POST",
      path: `/repos/${repo}/issues/${n}/comments`,
      url: `${GITHUB_API}/repos/${repo}/issues/${n}/comments`,
      body: { body: `Atteo change card #${ctx.seq}: ${line}\n${ctx.boardUrl}` },
      ready: true,
    });
  }
  return out;
}

export interface GithubPostResult {
  posted: false;
  reason: string;
  payloads: GithubOutbound[];
}

/**
 * Outbound stub: formats payloads but never calls GitHub. Even with App credentials set, posting waits on a later
 * slice (installation token + JWT).
 */
export function postGithubChange(
  env: Pick<Env, "GITHUB_APP_ID" | "GITHUB_APP_PRIVATE_KEY">,
  card: ChangeCard,
  ctx: ChangeNotifyCtx,
): GithubPostResult {
  const payloads = githubChangeNotification(card, ctx);
  if (!outboundEnabled(env)) return { posted: false, reason: "GitHub App credentials aren't set", payloads };
  return { posted: false, reason: "outbound posting isn't wired yet", payloads };
}
