// GitHub App notifications (GAPS P1): inbound GitHub webhooks become a board-note shape, and Atteo change cards
// become GitHub Checks / PR comments. Off until GITHUB_WEBHOOK_SECRET is set (inbound) and GITHUB_APP_ID +
// GITHUB_APP_PRIVATE_KEY (outbound). Inbound verifies and parses; it posts a quiet bot notice only when a repo→board
// map is configured (GITHUB_REPO_BOARDS or github_repo_boards). Without a map, it still only echoes. Outbound posts a
// Check run (and a PR comment when the card has a pull link) when those App secrets exist; without them it never fetches.

import { GITHUB_BOT } from "./bugBoard";
import { cardLine, type ChangeCard } from "./card";
import { pingExcerpt } from "./ping";
import * as registry from "./registry";
import { scanText } from "./secrets";
import type { Env } from "./types";
import { BOARD_RE } from "./util";

export const NOT_SET_UP = "GitHub app notifications aren't set up.";
export const MAX_WEBHOOK_BYTES = 1_000_000;
export const GITHUB_API = "https://api.github.com";
export { GITHUB_BOT };

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

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

/** Outbound posting needs the App id and private key. Unset: `postGithubChange` returns without fetching. */
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

/** Verifies and parses an inbound GitHub App webhook. Does not write to a board (see `postInboundNote`). */
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

/** `owner/name` lowercased, or null if it isn't a GitHub repo slug. */
export function normalizeRepo(raw: string | null | undefined): string | null {
  const repo = raw?.trim() ?? "";
  return REPO.test(repo) ? repo.toLowerCase() : null;
}

/**
 * Env map: JSON `{"owner/name":"b_…"}` or `owner/name=b_…` / `owner/name:b_…` pairs (comma or newline).
 * Invalid entries are dropped. Unset or empty → no mappings from env.
 */
export function parseRepoBoardMap(raw: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  const text = raw?.trim() ?? "";
  if (!text) return out;
  const add = (repo: string, board: string) => {
    const r = normalizeRepo(repo);
    const b = board.trim();
    if (r && BOARD_RE.test(b)) out.set(r, b);
  };
  if (text.startsWith("{")) {
    try {
      const json = JSON.parse(text) as unknown;
      if (json && typeof json === "object" && !Array.isArray(json)) {
        for (const [k, v] of Object.entries(json as Record<string, unknown>)) if (typeof v === "string") add(k, v);
      }
    } catch {
      return out;
    }
    return out;
  }
  for (const part of text.split(/[,\n]/)) {
    const piece = part.trim();
    if (!piece || piece.startsWith("#")) continue;
    const m = piece.match(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\s*[=:]\s*(b_[a-z0-9]{8,32})$/);
    if (m) add(m[1], m[2]);
  }
  return out;
}

export type GithubRepoMapEnv = Pick<Env, "GITHUB_REPO_BOARDS"> & { DB?: D1Database };

/** Env wins for that repo; otherwise the D1 row. No map → null (inbound stays echo-only). */
export async function boardIdForRepo(env: GithubRepoMapEnv, repo: string | null | undefined): Promise<string | null> {
  const key = normalizeRepo(repo);
  if (!key) return null;
  const fromEnv = parseRepoBoardMap(env.GITHUB_REPO_BOARDS).get(key);
  if (fromEnv) return fromEnv;
  if (!env.DB) return null;
  const row = await env.DB.prepare("SELECT board_id FROM github_repo_boards WHERE repo = ?").bind(key).first<{ board_id: string }>();
  const id = row?.board_id?.trim() ?? "";
  return BOARD_RE.test(id) ? id : null;
}

/** Operator/test helper: record a mapping. Refuses a missing board. Does not store GitHub payloads. */
export async function upsertRepoBoard(env: Env, repo: string, boardId: string): Promise<{ repo: string; board: string }> {
  const key = normalizeRepo(repo);
  if (!key) throw new Error("repo is owner/name (e.g. vmallela0/atteo).");
  const board = boardId.trim();
  if (!BOARD_RE.test(board)) throw new Error("board is a board id (b_…).");
  const row = await registry.getBoard(env, board);
  if (!row || row.deleted_at) throw new Error("board not found.");
  await env.DB.prepare(
    `INSERT INTO github_repo_boards (repo, board_id, created_at) VALUES (?, ?, ?)
     ON CONFLICT(repo) DO UPDATE SET board_id = excluded.board_id`,
  )
    .bind(key, board, Date.now())
    .run();
  return { repo: key, board };
}

export async function deleteRepoBoard(env: Env, repo: string): Promise<boolean> {
  const key = normalizeRepo(repo);
  if (!key) throw new Error("repo is owner/name (e.g. vmallela0/atteo).");
  const r = await env.DB.prepare("DELETE FROM github_repo_boards WHERE repo = ?").bind(key).run();
  return (r.meta?.changes ?? 0) > 0;
}

export interface GithubNoticeStub {
  join: (user: string) => Promise<unknown>;
  notice: (
    user: string,
    title: string,
    text: string,
    opts: { via?: "agent" | "person" | null; client?: string | null; session?: string | null; data?: unknown; idem?: string | null },
  ) => Promise<{ seq: number }>;
}

const githubReady = new Set<string>();

/** Test hook: forget which boards already have the GitHub bot. */
export function resetGithubBoardCache() {
  githubReady.clear();
}

/**
 * Puts the sign-in-less `github` member on an existing board. Never creates a board. Throws if a person already
 * holds the bot's name.
 */
export async function ensureGithubBot(env: Env, boardId: string, stub: GithubNoticeStub): Promise<void> {
  if (githubReady.has(boardId)) return;
  const bot = await registry.userByName(env, GITHUB_BOT);
  if (!bot) {
    await registry.createUser(env, { name: GITHUB_BOT, email: null, workos_id: null, display_name: "GitHub" }).catch(async (e) => {
      if (!(await registry.userByName(env, GITHUB_BOT))) throw e;
    });
  } else if (bot.email || bot.workos_id) {
    throw new Error(`The GitHub bot's name "${GITHUB_BOT}" belongs to a person; inbound notes are off until ops renames it.`);
  }
  await registry.addMember(env, boardId, GITHUB_BOT, { role: "contributor", added_by: "system" });
  await stub.join(GITHUB_BOT);
  githubReady.add(boardId);
}

export type InboundPostResult = { posted: false; reason: string } | { posted: true; board: string; seq: number };

type BoardFlags = { kind?: string | null; encrypted?: number | null };

/**
 * Posts a verified `applied: "note"` as a quiet board notice from the GitHub bot. No map, missing/encrypted/archived
 * board, or a person holding the bot name: `{ posted: false }` and no write. Never stores the raw GitHub body.
 */
export async function postInboundNote(
  env: Env,
  note: BoardGithubNote,
  deps: { stub: (env: Env, id: string) => GithubNoticeStub; ensure?: (env: Env, board: string, stub: GithubNoticeStub) => Promise<void> },
): Promise<InboundPostResult> {
  const repo = typeof note.data.github.repo === "string" ? note.data.github.repo : null;
  const boardId = await boardIdForRepo(env, repo);
  if (!boardId) return { posted: false, reason: "no repo map" };
  const row = (await registry.getBoard(env, boardId)) as (Awaited<ReturnType<typeof registry.getBoard>> & BoardFlags) | null;
  if (!row || row.deleted_at) return { posted: false, reason: "board not found" };
  if (row.archived_at) return { posted: false, reason: "board is archived" };
  if (row.encrypted) return { posted: false, reason: "board is encrypted" };
  if (row.kind === "direct" || row.kind === "agent") return { posted: false, reason: "not a collaboration board" };
  const stub = deps.stub(env, boardId);
  await (deps.ensure ?? ensureGithubBot)(env, boardId, stub);
  const delivery = note.data.github.delivery;
  const idem = typeof delivery === "string" && delivery ? `github:${delivery}` : null;
  const entry = await stub.notice(GITHUB_BOT, note.title, note.text, {
    via: "person",
    client: "github",
    session: null,
    data: note.data,
    idem,
  });
  return { posted: true, board: boardId, seq: entry.seq };
}

export type GithubOutboundKind = "check_run" | "issue_comment";
export type GithubHttp = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** A GitHub REST call we would make; `ready` is false when a required field is missing. */
export interface GithubOutbound {
  kind: GithubOutboundKind;
  repo: string;
  method: "POST" | "PATCH";
  path: string;
  url: string;
  body: Record<string, unknown>;
  ready: boolean;
  reason?: string;
}

const SHA40 = /^[0-9a-f]{40}$/i;

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
  return out.map((p) => {
    if (!p.ready) return p;
    const secret = scanPayload(p);
    return secret ? { ...p, ready: false, reason: secret } : p;
  });
}

export interface GithubCallResult {
  kind: GithubOutboundKind;
  method: "POST" | "PATCH";
  path: string;
  status: number;
  id?: number;
}

export interface GithubPostResult {
  posted: boolean;
  reason?: string;
  payloads: GithubOutbound[];
  calls?: GithubCallResult[];
}

export type GithubAppEnv = Pick<Env, "GITHUB_APP_ID" | "GITHUB_APP_PRIVATE_KEY" | "GITHUB_APP_INSTALLATION_ID">;

export interface GithubPostOpts {
  /** Tests inject a mock; production uses global fetch. Never called when credentials are missing. */
  fetch?: GithubHttp;
  /** Skip the PR comment even when the card has a pull link. */
  comment?: boolean;
  /** Existing Check run id to PATCH; otherwise we look one up by `external_id`, then POST. */
  checkRunId?: number;
}

const JWT_MAX_AGE = 9 * 60;
const GH_HEADERS = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "Atteo-GitHubApp/1",
} as const;

const b64url = (b: Uint8Array) => {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

function derLen(n: number): Uint8Array {
  if (n < 128) return Uint8Array.of(n);
  if (n < 256) return Uint8Array.of(0x81, n);
  return Uint8Array.of(0x82, (n >> 8) & 255, n & 255);
}

function wrapPkcs1(pkcs1: Uint8Array): Uint8Array {
  const alg = Uint8Array.of(0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00);
  const ver = Uint8Array.of(0x02, 0x01, 0x00);
  const octLen = derLen(pkcs1.length);
  const innerLen = ver.length + alg.length + 1 + octLen.length + pkcs1.length;
  const seqLen = derLen(innerLen);
  const out = new Uint8Array(1 + seqLen.length + innerLen);
  let i = 0;
  out[i++] = 0x30;
  out.set(seqLen, i);
  i += seqLen.length;
  out.set(ver, i);
  i += ver.length;
  out.set(alg, i);
  i += alg.length;
  out[i++] = 0x04;
  out.set(octLen, i);
  i += octLen.length;
  out.set(pkcs1, i);
  return out;
}

function pemBody(pem: string, label: string): Uint8Array | null {
  const escaped = pem.includes("\\n") && !pem.includes("\n") ? pem.replace(/\\n/g, "\n") : pem;
  const m = escaped.match(new RegExp(`-----BEGIN ${label}-----([A-Za-z0-9+/=\\s]+)-----END ${label}-----`));
  if (!m) return null;
  try {
    const bin = atob(m[1].replace(/\s+/g, ""));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** PKCS#8 or PKCS#1 PEM (GitHub's download) → bytes Web Crypto can import. */
export function pemToPkcs8(pem: string): Uint8Array | null {
  const pkcs8 = pemBody(pem, "PRIVATE KEY");
  if (pkcs8) return pkcs8;
  const pkcs1 = pemBody(pem, "RSA PRIVATE KEY");
  return pkcs1 ? wrapPkcs1(pkcs1) : null;
}

async function importAppKey(pem: string): Promise<CryptoKey | null> {
  const der = pemToPkcs8(pem);
  if (!der) return null;
  try {
    return await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  } catch {
    return null;
  }
}

/** Short-lived App JWT (RS256). `iat` is 60s in the past for clock skew; `exp` is under GitHub's 10-minute cap. */
export async function signAppJwt(appId: string, pem: string, now = Date.now()): Promise<string | null> {
  const key = await importAppKey(pem);
  if (!key) return null;
  const iat = Math.floor(now / 1000) - 60;
  const header = b64url(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = b64url(enc.encode(JSON.stringify({ iat, exp: iat + JWT_MAX_AGE, iss: /^\d+$/.test(appId) ? Number(appId) : appId })));
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(`${header}.${payload}`)));
  return `${header}.${payload}.${b64url(sig)}`;
}

function scanPayload(p: GithubOutbound): string | null {
  const strings: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") strings.push(v);
    else if (v && typeof v === "object") for (const x of Object.values(v as Record<string, unknown>)) walk(x);
  };
  walk(p.body);
  for (const s of strings) if (scanText(s)) return "outbound text looked like a secret";
  return null;
}

function jsonObj(v: unknown): Record<string, unknown> | null {
  return asObj(v);
}

async function ghFetch(
  fetchImpl: GithubHttp,
  url: string,
  token: string,
  method: "GET" | "POST" | "PATCH",
  body?: Record<string, unknown>,
): Promise<{ status: number; json: unknown }> {
  const res = await fetchImpl(url, {
    method,
    headers: {
      ...GH_HEADERS,
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
    redirect: "manual",
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function installationIdFor(
  env: GithubAppEnv,
  jwt: string,
  repo: string,
  fetchImpl: GithubHttp,
): Promise<number | null> {
  const fromEnv = asNum(env.GITHUB_APP_INSTALLATION_ID?.trim());
  if (fromEnv != null && fromEnv > 0) return fromEnv;
  const r = await ghFetch(fetchImpl, `${GITHUB_API}/repos/${repo}/installation`, jwt, "GET");
  const id = asNum(jsonObj(r.json)?.id);
  return r.status < 300 && id != null ? id : null;
}

async function installationToken(jwt: string, installation: number, fetchImpl: GithubHttp): Promise<string | null> {
  const r = await ghFetch(fetchImpl, `${GITHUB_API}/app/installations/${installation}/access_tokens`, jwt, "POST");
  const token = asStr(jsonObj(r.json)?.token, 400);
  return r.status < 300 && token ? token : null;
}

async function existingCheckRun(token: string, repo: string, sha: string, externalId: string, fetchImpl: GithubHttp): Promise<number | null> {
  const r = await ghFetch(fetchImpl, `${GITHUB_API}/repos/${repo}/commits/${sha}/check-runs?check_name=Atteo`, token, "GET");
  const runs = jsonObj(r.json)?.check_runs;
  if (!Array.isArray(runs)) return null;
  for (const raw of runs) {
    const run = asObj(raw);
    if (run && asStr(run.external_id, 200) === externalId) {
      const id = asNum(run.id);
      if (id != null) return id;
    }
  }
  return null;
}

/**
 * When App credentials are set, mints an installation token and POSTs (or PATCHes) a Check run, plus a PR comment
 * when the card has a GitHub pull link. Missing credentials: returns immediately and never fetches. Outbound text is
 * only the change-card line, seq, author, and board URL — never diffs, tokens, or other board text. A later slice
 * will call this from a change-card post; this slice does not hook that path, and production configs do not set the
 * secrets.
 */
export async function postGithubChange(
  env: GithubAppEnv,
  card: ChangeCard,
  ctx: ChangeNotifyCtx,
  opts: GithubPostOpts = {},
): Promise<GithubPostResult> {
  const payloads = githubChangeNotification(card, ctx);
  if (!outboundEnabled(env)) return { posted: false, reason: "GitHub App credentials aren't set", payloads };

  const toSend = payloads
    .filter((p) => p.ready && (opts.comment !== false || p.kind !== "issue_comment"))
    .map((p) => {
      const secret = scanPayload(p);
      return secret ? { ...p, ready: false, reason: secret } : p;
    });
  const ready = toSend.filter((p) => p.ready);
  if (!ready.length) {
    const reason = toSend.find((p) => p.reason)?.reason ?? payloads.find((p) => p.reason)?.reason ?? "nothing ready to post";
    return { posted: false, reason, payloads: toSend.length ? toSend : payloads };
  }

  const appId = env.GITHUB_APP_ID!.trim();
  const jwt = await signAppJwt(appId, env.GITHUB_APP_PRIVATE_KEY!);
  if (!jwt) return { posted: false, reason: "GitHub App private key isn't usable", payloads };

  const fetchImpl = opts.fetch ?? fetch;
  const repo = ready[0].repo;
  let installation: number | null;
  try {
    installation = await installationIdFor(env, jwt, repo, fetchImpl);
  } catch {
    return { posted: false, reason: "GitHub installation lookup failed", payloads };
  }
  if (installation == null) return { posted: false, reason: "GitHub App isn't installed on this repository", payloads };

  let token: string | null;
  try {
    token = await installationToken(jwt, installation, fetchImpl);
  } catch {
    return { posted: false, reason: "GitHub installation token failed", payloads };
  }
  if (!token) return { posted: false, reason: "GitHub installation token failed", payloads };

  const calls: GithubCallResult[] = [];
  const sent: GithubOutbound[] = [];
  for (const p of ready) {
    try {
      let method: "POST" | "PATCH" = "POST";
      let path = p.path;
      let url = p.url;
      let body = p.body;
      if (p.kind === "check_run") {
        const sha = asStr(p.body.head_sha, 40);
        const externalId = asStr(p.body.external_id, 200);
        const known = opts.checkRunId ?? (sha && externalId ? await existingCheckRun(token, p.repo, sha, externalId, fetchImpl) : null);
        if (known != null) {
          method = "PATCH";
          path = `/repos/${p.repo}/check-runs/${known}`;
          url = `${GITHUB_API}${path}`;
          const { head_sha: _sha, ...rest } = p.body;
          body = rest;
        }
      }
      const r = await ghFetch(fetchImpl, url, token, method, body);
      const id = asNum(jsonObj(r.json)?.id) ?? undefined;
      calls.push({ kind: p.kind, method, path, status: r.status, ...(id != null ? { id } : {}) });
      sent.push({ ...p, method, path, url, body, ready: r.status < 300, reason: r.status < 300 ? undefined : `GitHub answered ${r.status}` });
    } catch {
      calls.push({ kind: p.kind, method: p.method, path: p.path, status: 0 });
      sent.push({ ...p, ready: false, reason: "GitHub request failed" });
    }
  }

  const posted = calls.some((c) => c.status >= 200 && c.status < 300);
  const failed = sent.find((p) => !p.ready);
  return {
    posted,
    reason: posted ? undefined : (failed?.reason ?? "GitHub request failed"),
    payloads: [...sent, ...toSend.filter((p) => !p.ready)],
    calls,
  };
}
