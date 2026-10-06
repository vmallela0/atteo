// One repo → board map for the GitHub App (docs/github-app.md). Board owners set it from
// Members & access; inbound notes and Checks read the same table when those slices run.
// This module does not post to a board and does not call api.github.com.
// D1 stores owner/name, the board id, and an optional installation id — never a token or a key.

import * as registry from "./registry";
import type { Env } from "./types";
import { BOARD_RE } from "./util";

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SECRET_KEY = /^(token|access_token|private_key|pem|secret|webhook_secret|authorization|password|client_secret|github_token)$/i;
const SECRET_MSG = "Don't send GitHub tokens or keys. Only owner/repo and an optional installation id are stored.";
const OWNER_MSG = "Only the board's owners can connect a repository.";

export interface BoardGithubLink {
  repo: string | null;
  installation_id: number | null;
}

/** `owner/name` lowercased, or null if it isn't a GitHub repo slug. */
export function normalizeRepo(raw: string | null | undefined): string | null {
  const repo = raw?.trim() ?? "";
  if (!repo || repo.length > 200) return null;
  return REPO.test(repo) ? repo.toLowerCase() : null;
}

/**
 * Env map: JSON `{"owner/name":"b_…"}` or `owner/name=b_…` / `owner/name:b_…` pairs (comma or newline).
 * Invalid entries are dropped. Unset or empty → no mappings from env.
 * Same shape as the inbound-notes slice. Not a secret; leave it unset in hosted wrangler.jsonc.
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

function looksLikeCredential(s: string): boolean {
  const t = s.trim();
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(t)) return true;
  if (/\b(ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]/.test(t)) return true;
  return false;
}

function rejectSecrets(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const walk = (value: unknown, depth: number): string | null => {
    if (depth > 4) return SECRET_MSG;
    if (typeof value === "string") return looksLikeCredential(value) ? SECRET_MSG : null;
    if (!value || typeof value !== "object") return null;
    if (Array.isArray(value)) {
      for (const item of value) {
        const hit = walk(item, depth + 1);
        if (hit) return hit;
      }
      return null;
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(k)) return SECRET_MSG;
      const hit = walk(v, depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  return walk(body, 0);
}

function parseInstallation(v: unknown): { ok: true; id: number | null } | { ok: false; error: string } {
  if (v == null || v === "") return { ok: true, id: null };
  if (typeof v === "number" && Number.isInteger(v) && v > 0 && v <= Number.MAX_SAFE_INTEGER) return { ok: true, id: v };
  if (typeof v === "string" && /^\d{1,15}$/.test(v.trim())) {
    const n = Number(v.trim());
    if (Number.isSafeInteger(n) && n > 0) return { ok: true, id: n };
  }
  return { ok: false, error: "installation_id is a positive integer, or omit it." };
}

async function readLink(env: Env, boardId: string): Promise<BoardGithubLink> {
  const row = await env.DB.prepare("SELECT repo, installation_id FROM github_repo_boards WHERE board_id = ? ORDER BY created_at DESC LIMIT 1")
    .bind(boardId)
    .first<{ repo: string; installation_id: number | null }>();
  if (!row) return { repo: null, installation_id: null };
  const id = row.installation_id;
  return { repo: row.repo, installation_id: typeof id === "number" && id > 0 ? id : null };
}

async function ownerOf(env: Env, boardId: string, user: string): Promise<{ status: number; error: string } | { board: registry.BoardRow }> {
  if (!BOARD_RE.test(boardId)) return { status: 404, error: "board not found" };
  const board = await registry.getBoard(env, boardId);
  if (!board || board.deleted_at) return { status: 404, error: "board not found" };
  const role = await registry.memberRole(env, boardId, user);
  if (!role) return { status: 404, error: "board not found" };
  if (role !== "owner" && board.created_by !== user) return { status: 403, error: OWNER_MSG };
  const kind = (board as { kind?: string | null }).kind;
  if (kind === "direct" || kind === "agent") return { status: 400, error: "Direct messages and your agent chat don't connect to a repository." };
  return { board };
}

/** The board's saved link (D1). Owners only. */
export async function boardGithubHttp(
  env: Env,
  method: string,
  boardId: string,
  user: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const gate = await ownerOf(env, boardId, user);
  if ("status" in gate) return { status: gate.status, body: { error: gate.error } };
  if (method === "GET") return { status: 200, body: { ...(await readLink(env, boardId)) } };
  if (method === "DELETE") return clear(env, boardId, user);
  if (method === "PUT" || method === "POST") return set(env, boardId, user, body);
  return { status: 405, body: { error: "method not allowed" } };
}

async function clear(env: Env, boardId: string, user: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const prev = await readLink(env, boardId);
  const r = await env.DB.prepare("DELETE FROM github_repo_boards WHERE board_id = ?").bind(boardId).run();
  if ((r.meta?.changes ?? 0) > 0) await registry.audit(env, boardId, user, "github_unlinked", prev.repo, null);
  return { status: 200, body: { repo: null, installation_id: null } };
}

async function set(env: Env, boardId: string, user: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const secret = rejectSecrets(body);
  if (secret) return { status: 400, body: { error: secret } };
  if (!body || typeof body !== "object" || Array.isArray(body)) return { status: 400, body: { error: "expected a JSON object" } };
  const raw = body as { repo?: unknown; installation_id?: unknown };
  if (raw.repo == null || (typeof raw.repo === "string" && !raw.repo.trim())) return clear(env, boardId, user);
  if (typeof raw.repo !== "string") return { status: 400, body: { error: "repo is owner/name (for example acme/app)." } };
  const key = normalizeRepo(raw.repo);
  if (!key) return { status: 400, body: { error: "repo is owner/name (for example acme/app)." } };
  const inst = parseInstallation(raw.installation_id);
  if (!inst.ok) return { status: 400, body: { error: inst.error } };
  const taken = await env.DB.prepare("SELECT board_id FROM github_repo_boards WHERE repo = ?").bind(key).first<{ board_id: string }>();
  if (taken && taken.board_id !== boardId) return { status: 409, body: { error: "That repository is already connected to another board." } };
  await env.DB.prepare("DELETE FROM github_repo_boards WHERE board_id = ? AND repo != ?").bind(boardId, key).run();
  await env.DB.prepare(
    `INSERT INTO github_repo_boards (repo, board_id, created_at, installation_id) VALUES (?, ?, ?, ?)
     ON CONFLICT(repo) DO UPDATE SET board_id = excluded.board_id, installation_id = excluded.installation_id`,
  )
    .bind(key, boardId, Date.now(), inst.id)
    .run();
  await registry.audit(env, boardId, user, "github_linked", key, inst.id == null ? null : `installation ${inst.id}`);
  return { status: 200, body: { repo: key, installation_id: inst.id } };
}
