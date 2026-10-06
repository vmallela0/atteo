// atteo host (docs/HOST.md; vedu #4805/#4807/#4815): a member's own machine attached to a board. Agents on the board
// ask to run commands; the machine's owner approves each one (or allowlists exact commands); the host long-polls for
// approved work and posts results. Everything lands in the board's log. Very dangerous by design.

import * as approvals from "./approvals";
import { randomSecret, sha256hex } from "./auth";
import { BOARD_OUTPUT, clampTimeout, cleanOutput, commandProblem, CONFIRM_TTL_MS, insideShares, MAX_ALLOW, MAX_SHARES, MAX_WAITING, normPath, ONLINE_MS, phraseOk, HOST_PHRASE } from "./hostCore";
import type { Env } from "./types";

export class HostError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export interface HostRow {
  id: string;
  board_id: string;
  owner: string;
  name: string;
  shares: string;
  allow: string;
  created_at: number;
  last_seen: number;
  stopped_at: number | null;
  stopped_by: string | null;
}

export interface RunRow {
  id: string;
  host_id: string;
  board_id: string;
  requested_by: string;
  command: string;
  cwd: string;
  timeout_s: number;
  approval_id: string | null;
  status: "pending" | "approved" | "running" | "done" | "failed" | "rejected" | "expired" | "stopped";
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  exit_code: number | null;
  output: string | null;
  truncated: number;
  timed_out: number;
  note: string | null;
}

const TERMINAL = new Set(["done", "failed", "rejected", "expired", "stopped"]);
const parse = (s: string): string[] => {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
};

/** What members see of a host (the allowlist is the owner's business, but it's shown so nobody is surprised). */
export function hostView(h: HostRow, now = Date.now()) {
  return {
    id: h.id,
    name: h.name,
    owner: h.owner,
    shares: parse(h.shares),
    allow: parse(h.allow),
    online: !h.stopped_at && now - h.last_seen < ONLINE_MS,
    last_seen: h.last_seen,
    stopped_at: h.stopped_at,
    stopped_by: h.stopped_by,
    created_at: h.created_at,
  };
}

export function runView(r: RunRow) {
  return {
    id: r.id,
    host: r.host_id,
    requested_by: r.requested_by,
    command: r.command,
    cwd: r.cwd,
    timeout_s: r.timeout_s,
    approval: r.approval_id,
    status: r.status,
    created_at: r.created_at,
    started_at: r.started_at,
    finished_at: r.finished_at,
    exit_code: r.exit_code,
    output: r.output,
    truncated: !!r.truncated,
    timed_out: !!r.timed_out,
    note: r.note,
  };
}

/** Boards a host may attach to: not end-to-end encrypted (the audit must be readable), not archived. */
async function boardOk(env: Env, board: string): Promise<void> {
  const b = await env.DB.prepare(`SELECT encrypted, archived_at FROM boards WHERE id = ? AND deleted_at IS NULL`).bind(board).first<{ encrypted: number | null; archived_at: number | null }>();
  if (!b) throw new HostError("board not found", 404);
  if (b.encrypted) throw new HostError("Hosts can't attach to an end-to-end encrypted board: their audit trail must be readable.", 409);
  if (b.archived_at) throw new HostError("This board is archived.", 409);
}

/** Step 1 of attaching: the exact phrase buys a one-time token (10 minutes) that registering a host spends. */
export async function confirm(env: Env, board: string, owner: string, phrase: unknown): Promise<{ token: string; expires_at: number }> {
  if (!phraseOk(phrase)) throw new HostError(`To attach a machine, type exactly: ${HOST_PHRASE}`, 400);
  await boardOk(env, board);
  const token = randomSecret("hc_", 18);
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO host_confirms (token_hash, board_id, owner, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`).bind(await sha256hex(token), board, owner, now, now + CONFIRM_TTL_MS).run();
  return { token, expires_at: now + CONFIRM_TTL_MS };
}

/** Step 2: register the machine with an unused token from step 1 (one token, one machine). */
export async function register(env: Env, board: string, owner: string, b: { token?: unknown; name?: unknown; shares?: unknown; allow?: unknown }): Promise<HostRow> {
  await boardOk(env, board);
  const now = Date.now();
  const hash = typeof b.token === "string" ? await sha256hex(b.token) : "";
  const live = await env.DB.prepare(`SELECT 1 AS ok FROM host_confirms WHERE token_hash = ? AND board_id = ? AND owner = ? AND used_at IS NULL AND expires_at > ?`).bind(hash, board, owner, now).first();
  const noToken = () => new HostError(`Attaching a machine needs a fresh confirmation: type exactly "${HOST_PHRASE}" (atteo host asks; on the web, Attach a machine).`, 403);
  if (!live) throw noToken();
  const shares = (Array.isArray(b.shares) ? b.shares : []).map((s) => normPath(s)).filter((s): s is string => !!s);
  if (!shares.length) throw new HostError("Share at least one folder (absolute path).");
  if (shares.length > MAX_SHARES) throw new HostError(`At most ${MAX_SHARES} shared folders.`);
  if (shares.includes("/")) throw new HostError("Sharing / (the whole machine) isn't allowed. Share a project folder.");
  const allow = (Array.isArray(b.allow) ? b.allow : []).filter((c): c is string => typeof c === "string" && !!c.trim());
  if (allow.length > MAX_ALLOW) throw new HostError(`At most ${MAX_ALLOW} allowlisted commands.`);
  for (const c of allow) {
    const p = commandProblem(c);
    if (p) throw new HostError(`Allowlist: ${p}`);
  }
  const name = (typeof b.name === "string" ? b.name : "").replace(/[^\w .@-]/g, "").trim().slice(0, 40) || "machine";
  // Spent only now, once the request is good: one token, one machine (a second use, or a race, gets 403).
  const used = await env.DB.prepare(`UPDATE host_confirms SET used_at = ? WHERE token_hash = ? AND board_id = ? AND owner = ? AND used_at IS NULL AND expires_at > ?`).bind(now, hash, board, owner, now).run();
  if (!used.meta.changes) throw noToken();
  const h: HostRow = { id: randomSecret("h_", 9), board_id: board, owner, name, shares: JSON.stringify(shares), allow: JSON.stringify(allow), created_at: now, last_seen: now, stopped_at: null, stopped_by: null };
  await env.DB.prepare(`INSERT INTO hosts (id, board_id, owner, name, shares, allow, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(h.id, board, owner, name, h.shares, h.allow, now, now).run();
  return h;
}

export async function getHost(env: Env, board: string, id: string): Promise<HostRow | null> {
  return env.DB.prepare(`SELECT * FROM hosts WHERE id = ? AND board_id = ?`).bind(id, board).first<HostRow>();
}

/** A board's hosts: live ones, plus the ones stopped in the last day (so a Stop is visible). */
export async function listHosts(env: Env, board: string): Promise<HostRow[]> {
  return (await env.DB.prepare(`SELECT * FROM hosts WHERE board_id = ? AND (stopped_at IS NULL OR stopped_at > ?) ORDER BY created_at DESC LIMIT 50`).bind(board, Date.now() - 86_400_000).all<HostRow>()).results;
}

/** The kill switch: the host's owner or the board's owner. Waiting runs are dropped; the host exits at its next poll. */
export async function stop(env: Env, board: string, id: string, by: string, boardOwner: string | null): Promise<HostRow[]> {
  const targets = id === "all" ? (await listHosts(env, board)).filter((h) => !h.stopped_at) : [await getHost(env, board, id)].filter((h): h is HostRow => !!h);
  if (id !== "all" && !targets.length) throw new HostError("No such host.", 404);
  const mine = targets.filter((h) => h.owner === by || by === boardOwner);
  if (!mine.length && targets.length) throw new HostError("Only the machine's owner or the board's owner can stop it.", 403);
  const now = Date.now();
  for (const h of mine) {
    if (h.stopped_at) continue;
    await env.DB.batch([
      env.DB.prepare(`UPDATE hosts SET stopped_at = ?, stopped_by = ? WHERE id = ? AND stopped_at IS NULL`).bind(now, by, h.id),
      env.DB.prepare(`UPDATE host_runs SET status = 'stopped', finished_at = ?, note = 'host stopped' WHERE host_id = ? AND status IN ('pending', 'approved')`).bind(now, h.id),
    ]);
    h.stopped_at = now;
    h.stopped_by = by;
  }
  return mine;
}

export async function getRun(env: Env, board: string, host: string, id: string): Promise<RunRow | null> {
  return env.DB.prepare(`SELECT * FROM host_runs WHERE id = ? AND host_id = ? AND board_id = ?`).bind(id, host, board).first<RunRow>();
}

/** Ask to run a command. Allowlisted (exact) → straight to the host; otherwise an approval for the owner. */
export async function request(
  env: Env,
  board: string,
  hostId: string,
  by: string,
  b: { command?: unknown; cwd?: unknown; timeout_s?: unknown },
): Promise<{ run: RunRow; host: HostRow; approval: approvals.Approval | null }> {
  const host = await getHost(env, board, hostId);
  if (!host) throw new HostError("No such host.", 404);
  if (host.stopped_at) throw new HostError(`${host.name} was stopped by ${host.stopped_by}.`, 409);
  if (Date.now() - host.last_seen > ONLINE_MS) throw new HostError(`${host.name} is offline (its owner's atteo host isn't running).`, 409);
  const problem = commandProblem(b.command);
  if (problem) throw new HostError(problem);
  const command = b.command as string;
  const shares = parse(host.shares);
  const cwd = b.cwd == null || b.cwd === "" ? shares[0] : normPath(b.cwd);
  if (!cwd || !insideShares(cwd, shares)) throw new HostError(`cwd must be inside a folder ${host.name} shares: ${shares.join(", ")}`);
  const waiting = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM host_runs WHERE host_id = ? AND status IN ('pending', 'approved', 'running')`).bind(host.id).first<{ n: number }>())?.n ?? 0;
  if (waiting >= MAX_WAITING) throw new HostError(`${host.name} already has ${MAX_WAITING} commands waiting.`, 429);
  const timeout = clampTimeout(b.timeout_s);
  const allowed = parse(host.allow).includes(command);
  let approval: approvals.Approval | null = null;
  if (!allowed) {
    try {
      approval = await approvals.requestApproval(env, host.owner, {
        client: "atteo host",
        board_id: board,
        requested_by: by,
        title: `Run on ${host.name}: ${command}`,
        details: `${by} asks to run this on your machine "${host.name}", in ${cwd} (stops after ${timeout}s). It runs as you, with your files in that folder. Approve only if you'd type it yourself.`,
        tool: `Host ${host.name}`,
        command,
        risk: "high",
        expires_in: 3600,
      });
    } catch (e) {
      throw new HostError(e instanceof Error ? e.message : String(e));
    }
  }
  const run: RunRow = {
    id: randomSecret("hr_", 9),
    host_id: host.id,
    board_id: board,
    requested_by: by,
    command,
    cwd,
    timeout_s: timeout,
    approval_id: approval?.id ?? null,
    status: allowed ? "approved" : "pending",
    created_at: Date.now(),
    started_at: null,
    finished_at: null,
    exit_code: null,
    output: null,
    truncated: 0,
    timed_out: 0,
    note: allowed ? "allowlisted" : null,
  };
  await env.DB.prepare(`INSERT INTO host_runs (id, host_id, board_id, requested_by, command, cwd, timeout_s, approval_id, status, created_at, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(run.id, host.id, board, by, command, cwd, timeout, run.approval_id, run.status, run.created_at, run.note)
    .run();
  return { run, host, approval };
}

/** A pending run follows its approval: approved → waits for the host; rejected or timed out → closed. */
async function settle(env: Env, owner: string, r: RunRow): Promise<{ run: RunRow; closed: boolean }> {
  if (r.status !== "pending" || !r.approval_id) return { run: r, closed: false };
  const a = await approvals.getApproval(env, owner, r.approval_id);
  if (!a || a.status === "pending") return { run: r, closed: false };
  const status = a.status === "approved" ? "approved" : a.status === "rejected" ? "rejected" : "expired";
  const now = Date.now();
  const note = status === "approved" ? null : a.note ?? (status === "expired" ? "no decision in time" : null);
  // Only the call that moves it gets closed=true, so its audit line is posted once.
  const moved = await env.DB.prepare(`UPDATE host_runs SET status = ?, note = ?, finished_at = ? WHERE id = ? AND status = 'pending'`).bind(status, note, status === "approved" ? null : now, r.id).run();
  return { run: { ...r, status, note, finished_at: status === "approved" ? null : now }, closed: !!moved.meta.changes && status !== "approved" };
}

/** A run as it stands now (its approval checked), for whoever asked; `waitMs` holds until it finishes. `closed`: a denial this call recorded. */
export async function runNow(env: Env, board: string, host: HostRow, id: string, waitMs = 0): Promise<{ run: RunRow; closed: RunRow | null } | null> {
  const until = Date.now() + Math.min(waitMs, 25_000);
  let closed: RunRow | null = null;
  for (;;) {
    const got = await getRun(env, board, host.id, id);
    if (!got) return null;
    const s = await settle(env, host.owner, got);
    if (s.closed) closed = s.run;
    if (TERMINAL.has(s.run.status) || Date.now() >= until) return { run: s.run, closed };
    await new Promise((res) => setTimeout(res, 1000));
  }
}

/**
 * The host's poll (only its owner's login): marks it online, settles approvals, and hands over the oldest approved run
 * (now running), or {stop} when the host was stopped, the board is gone, or the owner left it. Holds up to `waitMs`.
 */
export async function next(env: Env, board: string, host: HostRow, waitMs: number): Promise<{ stop?: string; run?: RunRow; settled: RunRow[] }> {
  const settled: RunRow[] = [];
  const until = Date.now() + Math.min(waitMs, 25_000);
  for (;;) {
    const h = await getHost(env, board, host.id);
    if (!h || h.stopped_at) return { stop: h?.stopped_by ? `stopped by ${h.stopped_by}` : "stopped", settled };
    const member = await env.DB.prepare(`SELECT 1 AS ok FROM members m JOIN boards b ON b.id = m.board_id WHERE m.board_id = ? AND m.user = ? AND b.deleted_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > ?)`).bind(board, h.owner, Date.now()).first();
    if (!member) {
      await stop(env, board, h.id, h.owner, null);
      return { stop: "you're no longer on this board (or it was deleted)", settled };
    }
    await env.DB.prepare(`UPDATE hosts SET last_seen = ? WHERE id = ?`).bind(Date.now(), h.id).run();
    const pending = (await env.DB.prepare(`SELECT * FROM host_runs WHERE host_id = ? AND status = 'pending' ORDER BY created_at LIMIT 20`).bind(h.id).all<RunRow>()).results;
    for (const p of pending) {
      const s = await settle(env, h.owner, p);
      if (s.closed) settled.push(s.run);
    }
    const now = Date.now();
    const r = await env.DB.prepare(`SELECT * FROM host_runs WHERE host_id = ? AND status = 'approved' ORDER BY created_at LIMIT 1`).bind(h.id).first<RunRow>();
    if (r) {
      const took = await env.DB.prepare(`UPDATE host_runs SET status = 'running', started_at = ? WHERE id = ? AND status = 'approved'`).bind(now, r.id).run();
      if (took.meta.changes) return { run: { ...r, status: "running", started_at: now }, settled };
    }
    if (settled.length || Date.now() >= until) return { settled };
    await new Promise((res) => setTimeout(res, 1500));
  }
}

/** The host reports a finished run (only for a run it was handed). Output is redacted and capped again here. */
export async function finish(env: Env, board: string, host: HostRow, id: string, b: { exit_code?: unknown; output?: unknown; timed_out?: unknown; error?: unknown }): Promise<RunRow> {
  const r = await getRun(env, board, host.id, id);
  if (!r) throw new HostError("No such run.", 404);
  if (r.status !== "running") throw new HostError(`That run is ${r.status}, not running.`, 409);
  const out = cleanOutput(b.output);
  const exit = Number.isInteger(b.exit_code) ? (b.exit_code as number) : null;
  const err = typeof b.error === "string" && b.error.trim() ? cleanOutput(b.error, 500).text : null;
  const status = err || exit !== 0 || b.timed_out === true ? "failed" : "done";
  const now = Date.now();
  await env.DB.prepare(`UPDATE host_runs SET status = ?, finished_at = ?, exit_code = ?, output = ?, truncated = ?, timed_out = ?, note = ? WHERE id = ? AND status = 'running'`)
    .bind(status, now, exit, out.text, out.truncated ? 1 : 0, b.timed_out === true ? 1 : 0, err, id)
    .run();
  return { ...r, status, finished_at: now, exit_code: exit, output: out.text, truncated: out.truncated ? 1 : 0, timed_out: b.timed_out === true ? 1 : 0, note: err };
}

const fenceOut = (s: string) => "```\n" + s.replace(/```/g, "ʼʼʼ") + "\n```";

/** The board's audit line for a run that finished (or was refused): who asked, what, where, and how it went. */
export function auditText(h: Pick<HostRow, "name" | "owner">, r: RunRow): string {
  const head = `🖥 ${h.name} (${h.owner}'s machine) · ${r.requested_by} asked: \`${r.command.replace(/`/g, "ʼ").slice(0, 300)}\` in ${r.cwd}`;
  if (r.status === "rejected") return `${head}\n⛔ Denied by ${h.owner}${r.note ? `: "${r.note}"` : ""}.`;
  if (r.status === "expired") return `${head}\n⛔ Denied: no decision in time.`;
  if (r.status === "stopped") return `${head}\n⛔ Dropped: the host was stopped.`;
  const how = r.timed_out ? `stopped after ${r.timeout_s}s (timeout)` : r.note && r.status === "failed" ? `not run: ${r.note}` : `exit ${r.exit_code}`;
  const out = (r.output ?? "").trim();
  const shown = out.length > BOARD_OUTPUT ? out.slice(0, BOARD_OUTPUT) + `\n… (${out.length - BOARD_OUTPUT} more characters; the requester can read the rest)` : out;
  return `${head}\n${r.status === "done" ? "✓" : "✗"} ${how}${r.approval_id ? ` · approved by ${h.owner}` : " · allowlisted"}${shown ? `\n${fenceOut(shown)}` : ""}`;
}

export const attachText = (h: HostRow) =>
  `⚠️ ${h.owner} attached a machine to this board: ${h.name} (shares ${parse(h.shares).join(", ")}). Agents here can ask to run commands on it; ${h.owner} approves each one${parse(h.allow).length ? ` (except ${parse(h.allow).length} allowlisted command${parse(h.allow).length === 1 ? "" : "s"})` : ""}. Stop it from the side panel, the app, or atteo host stop.`;
export const stopText = (h: HostRow, by: string) => `⛔ ${by} stopped ${h.name} (${h.owner}'s machine). Nothing more runs on it.`;
