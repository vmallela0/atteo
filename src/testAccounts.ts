// Operator cleanup of leftover e2e/test accounts (names like e2e-*-gtpvc, *-test, test-1).
// List and dry-run are the default path. Deletes never touch WorkOS users, operators, or Stripe customers.

import * as registry from "./registry";
import type { Env } from "./types";
import { USER_RE, normalizeUser } from "./util";

/** Typed exactly, in full, to run a delete. Anything else stays a dry-run. */
export const DELETE_CONFIRM = "DELETE TEST ACCOUNTS";

export type TestAccountKind = "e2e" | "named-test" | "test-n";
export type SkipReason = "workos" | "operator" | "stripe";

export type TestUserRow = {
  name: string;
  email: string | null;
  workos_id: string | null;
  stripe_customer: string | null;
  first_seen: number;
  last_seen: number;
  boards: number;
};

export type ListedUser = {
  name: string;
  email: string | null;
  kind: TestAccountKind;
  first_seen: number;
  last_seen: number;
  boards: number;
};

export type ListedBoard = { id: string; title: string; created_by: string; members: string[] };

export type CleanupPreview = {
  users: ListedUser[];
  boards: ListedBoard[];
  skipped: { name: string; reason: SkipReason }[];
};

export type CleanupResult = CleanupPreview & {
  dry_run: boolean;
  deleted?: string[];
  deleted_boards?: string[];
};

const CANDIDATE_SQL = `SELECT name, email, workos_id, stripe_customer, first_seen, last_seen,
  (SELECT COUNT(*) FROM members m WHERE m.user = users.name) AS boards
 FROM users
 WHERE name LIKE 'e2e-%' OR name LIKE '%-test' OR name LIKE 'test-%'
 ORDER BY first_seen`;

const E2E_BOARDS_SQL = `SELECT b.id, b.title, b.created_by,
  (SELECT GROUP_CONCAT(user, ',') FROM members m WHERE m.board_id = b.id) AS members
 FROM boards b
 WHERE b.title LIKE 'e2e %' AND b.deleted_at IS NULL`;

/** Per-user D1 rows to drop before the users row. `?` is always that handle. */
export const USER_ROW_DELETES = [
  `DELETE FROM members WHERE user = ?`,
  `DELETE FROM device_logins WHERE approved_by = ?`,
  `DELETE FROM device_logins WHERE agent_login_id IN (SELECT id FROM agent_logins WHERE user = ?)`,
  `DELETE FROM agent_email_alerts WHERE user = ?`,
  `DELETE FROM agent_web_sessions WHERE login_id IN (SELECT id FROM agent_logins WHERE user = ?)`,
  `DELETE FROM agent_logins WHERE user = ?`,
  `DELETE FROM tokens WHERE user = ?`,
  `DELETE FROM sessions WHERE user = ?`,
  `DELETE FROM mcp_sessions WHERE user = ?`,
  `DELETE FROM agent_sessions WHERE user = ?`,
  `DELETE FROM agent_keys WHERE user = ?`,
  `DELETE FROM agent_profiles WHERE user = ?`,
  `DELETE FROM agent_caps WHERE user = ?`,
  `DELETE FROM agent_record WHERE user = ?`,
  `DELETE FROM agent_contacts WHERE a = ? OR b = ? OR requested_by = ?`,
  `DELETE FROM mailbox_leases WHERE user = ?`,
  `DELETE FROM notifications WHERE user = ?`,
  `DELETE FROM avatars WHERE user = ?`,
  `DELETE FROM account_audit WHERE user = ?`,
  `DELETE FROM standing_rules WHERE user = ?`,
  `DELETE FROM webhooks WHERE user = ?`,
  `DELETE FROM linear_issues WHERE board_id IN (SELECT board_id FROM linear_links WHERE created_by = ?)`,
  `DELETE FROM linear_links WHERE created_by = ?`,
  `DELETE FROM oauth_refresh_tokens WHERE user = ?`,
  `DELETE FROM oauth_requests WHERE user = ?`,
  `DELETE FROM oauth_codes WHERE user = ?`,
  `DELETE FROM pact_subjects WHERE user = ?`,
  `DELETE FROM pact_contexts WHERE user = ?`,
  `DELETE FROM pact_sends WHERE user = ?`,
  `DELETE FROM pact_prepared WHERE user = ?`,
  `DELETE FROM inbox_reminders WHERE user = ?`,
  `DELETE FROM tts_usage WHERE user = ?`,
  `DELETE FROM voice_usage WHERE user = ?`,
  `DELETE FROM voice_sessions WHERE user = ?`,
  `DELETE FROM notify_levels WHERE user = ?`,
  `DELETE FROM notify_prefs WHERE user = ?`,
  `DELETE FROM mutes WHERE user = ? OR muted = ?`,
  `DELETE FROM reports WHERE reporter = ? OR author = ?`,
  `DELETE FROM key_grants WHERE user = ?`,
  `DELETE FROM approval_terminal_confirms WHERE user = ?`,
  `DELETE FROM approval_confirm_starts WHERE user = ?`,
  `DELETE FROM approval_pins WHERE user = ?`,
  `DELETE FROM approval_pin_daily WHERE user = ?`,
  `DELETE FROM approvals WHERE user = ?`,
  `DELETE FROM reaction_usage WHERE user = ?`,
  `DELETE FROM push_devices WHERE user = ?`,
  `DELETE FROM friendships WHERE a = ? OR b = ? OR requested_by = ?`,
  `DELETE FROM invites WHERE invited_by = ? OR accepted_by = ?`,
  `DELETE FROM invite_links WHERE created_by = ?`,
  `DELETE FROM device_logins WHERE approved_by = ?`,
  `DELETE FROM users WHERE name = ?`,
];

export function operatorsOf(env: { OPERATORS?: string }): Set<string> {
  return new Set(
    (env.OPERATORS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** e2e-foo, bar-test, or test-1 (and only those shapes). */
export function isTestAccountName(name: string): boolean {
  const n = name.trim().toLowerCase();
  if (!USER_RE.test(n)) return false;
  if (n.startsWith("e2e-")) return true;
  if (n.endsWith("-test")) return true;
  return /^test-[0-9]+$/.test(n);
}

export function testAccountKind(name: string): TestAccountKind | null {
  const n = name.trim().toLowerCase();
  if (!isTestAccountName(n)) return null;
  if (n.startsWith("e2e-")) return "e2e";
  if (/^test-[0-9]+$/.test(n)) return "test-n";
  return "named-test";
}

export function skipReason(
  row: { name: string; workos_id?: string | null; stripe_customer?: string | null },
  operators: Set<string>,
): SkipReason | null {
  const name = (row.name ?? "").trim().toLowerCase();
  if (!isTestAccountName(name)) return null;
  if (operators.has(name)) return "operator";
  if (row.workos_id) return "workos";
  if (row.stripe_customer) return "stripe";
  return null;
}

export function isDeletableTestUser(
  row: { name: string; workos_id?: string | null; stripe_customer?: string | null },
  operators: Set<string>,
): boolean {
  return isTestAccountName(row.name) && skipReason(row, operators) === null;
}

/** undefined = not specified (all matching); otherwise a list of handles. */
export function parseNames(raw: unknown): string[] | { error: string } | undefined {
  if (raw == null || raw === "") return undefined;
  const parts = Array.isArray(raw)
    ? raw.map((x) => String(x))
    : String(raw)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
  if (!parts.length) return { error: "names is empty" };
  const names: string[] = [];
  for (const p of parts) {
    const n = normalizeUser(p);
    if (!n) return { error: `invalid name: ${String(p).slice(0, 40)}` };
    names.push(n);
  }
  return names;
}

function listed(row: TestUserRow): ListedUser {
  return {
    name: row.name,
    email: row.email,
    kind: testAccountKind(row.name) ?? "e2e",
    first_seen: row.first_seen,
    last_seen: row.last_seen,
    boards: row.boards,
  };
}

function splitMembers(s: string | null | undefined): string[] {
  return (s ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

export async function preview(env: Env): Promise<CleanupPreview> {
  const operators = operatorsOf(env);
  const found = (await env.DB.prepare(CANDIDATE_SQL).all<TestUserRow>()).results;
  const users: ListedUser[] = [];
  const skipped: { name: string; reason: SkipReason }[] = [];
  const deletable = new Set<string>();
  for (const row of found) {
    if (!isTestAccountName(row.name)) continue;
    const why = skipReason(row, operators);
    if (why) {
      skipped.push({ name: row.name, reason: why });
      continue;
    }
    users.push(listed(row));
    deletable.add(row.name);
  }
  const boardRows = (await env.DB.prepare(E2E_BOARDS_SQL).all<{ id: string; title: string; created_by: string; members: string | null }>()).results;
  const boards: ListedBoard[] = [];
  for (const b of boardRows) {
    const members = splitMembers(b.members);
    if (!deletable.has(b.created_by)) continue;
    if (members.some((m) => !deletable.has(m))) continue;
    boards.push({ id: b.id, title: b.title, created_by: b.created_by, members });
  }
  return { users, boards, skipped };
}

function bindName(sql: string, name: string): string[] {
  return Array.from(sql.matchAll(/\?/g), () => name);
}

async function deleteUserRows(env: Env, name: string): Promise<void> {
  const stmts = USER_ROW_DELETES.map((sql) => env.DB.prepare(sql).bind(...bindName(sql, name)));
  for (let i = 0; i < stmts.length; i += 20) await env.DB.batch(stmts.slice(i, i + 20));
}

export type ApplyOpts = { dry_run?: unknown; confirm?: unknown; names?: unknown };

export async function apply(env: Env, opts: ApplyOpts): Promise<{ status: number; body: CleanupResult | { error: string } }> {
  const confirm = String(opts.confirm ?? "").trim();
  if (confirm && confirm !== DELETE_CONFIRM) return { status: 400, body: { error: `Type ${DELETE_CONFIRM} exactly to delete.` } };
  const dryRun = confirm !== DELETE_CONFIRM || opts.dry_run === true || opts.dry_run === "true";
  if (!dryRun && confirm !== DELETE_CONFIRM) return { status: 400, body: { error: `Type ${DELETE_CONFIRM} exactly to delete.` } };

  const parsed = parseNames(opts.names);
  if (parsed && "error" in parsed) return { status: 400, body: { error: parsed.error } };

  const pre = await preview(env);
  const byName = new Map(pre.users.map((u) => [u.name, u]));
  let selected = pre.users;
  let boards = pre.boards;
  if (parsed) {
    const missing: string[] = [];
    const picked: ListedUser[] = [];
    for (const n of parsed) {
      const u = byName.get(n);
      if (!u) missing.push(n);
      else picked.push(u);
    }
    if (missing.length) {
      const skipped = pre.skipped.filter((s) => missing.includes(s.name));
      const why = skipped.length ? skipped.map((s) => `${s.name} (${s.reason})`).join(", ") : missing.join(", ");
      return { status: 400, body: { error: `not a deletable test account: ${why}` } };
    }
    selected = picked;
    const allow = new Set(picked.map((u) => u.name));
    boards = pre.boards.filter((b) => allow.has(b.created_by) && b.members.every((m) => allow.has(m)));
  }

  if (dryRun) return { status: 200, body: { ...pre, users: selected, boards, dry_run: true } };

  const deleted_boards: string[] = [];
  for (const b of boards) {
    await registry.deleteBoard(env, b.id);
    deleted_boards.push(b.id);
  }
  const deleted: string[] = [];
  for (const u of selected) {
    await deleteUserRows(env, u.name);
    deleted.push(u.name);
  }
  return { status: 200, body: { users: selected, boards, skipped: pre.skipped, dry_run: false, deleted, deleted_boards } };
}
