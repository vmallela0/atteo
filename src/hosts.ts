// atteo host (docs/HOST.md; vedu #4805/#4807/#4815): a member's own machine attached to a board. Agents on the board
// ask to run commands; the machine's owner approves each one (or allowlists exact commands); the host long-polls for
// approved work and posts results. Everything lands in the board's log. Very dangerous by design.

import * as approvals from "./approvals";
import { randomSecret, sha256hex } from "./auth";
import { BOARD_OUTPUT, clampTimeout, cleanOutput, codeSpan, commandProblem, CWD_RE, CONFIRM_TTL_MS, consentScope, insideShares, MACHINE_RE, MAX_ALLOW, MAX_SHARES, MAX_WAITING, newConsentCode, normCode, normPath, ONLINE_MS, phraseOk, HOST_PHRASE, shareProblem } from "./hostCore";
import { mutersOf } from "./moderation";
import type { Env } from "./types";

/** An approved run must reach its host within this (an offline host doesn't run it days later, #4942). */
export const APPROVED_TTL_MS = 2 * 3600_000;
/** A running run with no result this long after its timeout: its host died (crash, kill -9, sleep) without saying (#5007). */
export const RUN_GRACE_MS = 60_000;
export const HOST_GONE = "its host went away while it ran";
const PICKUP_LATE = "its host didn't pick it up in time";
/** Per requester, per host (#4959): commands waiting at once, and asks in an hour. */
export const MAX_WAITING_PER_REQUESTER = 3;
export const MAX_RUNS_PER_HOUR = 20;

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
  network: number;
  created_at: number;
  last_seen: number;
  stopped_at: number | null;
  stopped_by: string | null;
  secret_hash?: string | null; // the daemon's own secret (hash): only it may poll and report (#4939)
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
    network: !!h.network, // the person chose --allow-network at start (jxn #4945)
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

// A code covers one board, one machine, and exactly the shares and allowlist the person was shown (#4917).
const codeHash = async (board: string, machine: string, code: string, scope: string) => sha256hex(`${board}|${machine}|${normCode(code)}|${scope}`);

/** The shares and allowlist a host asks for, checked (the same rules at consent and at registration). */
function scopeOf(b: { shares?: unknown; allow?: unknown; network?: unknown }): { shares: string[]; allow: string[]; network: boolean } {
  const raw = Array.isArray(b.shares) ? b.shares : [];
  if (!raw.length) throw new HostError("Share at least one folder (absolute path).");
  if (raw.length > MAX_SHARES) throw new HostError(`At most ${MAX_SHARES} shared folders.`);
  const shares: string[] = [];
  for (const s of raw) {
    const p = shareProblem(s);
    if (p) throw new HostError(p);
    shares.push(normPath(s)!);
  }
  const allow = (Array.isArray(b.allow) ? b.allow : []).filter((c): c is string => typeof c === "string" && !!c.trim());
  if (allow.length > MAX_ALLOW) throw new HostError(`At most ${MAX_ALLOW} allowlisted commands.`);
  for (const c of allow) {
    const p = commandProblem(c);
    if (p) throw new HostError(`Allowlist: ${p}`);
  }
  return { shares, allow, network: b.network === true };
}

/**
 * Step 1 of attaching, for the PERSON only (the route refuses agent and CLI tokens, as approvals do): typing the exact
 * phrase for one machine (the id `atteo host` printed in its link), having seen the folders it shares and the commands
 * it allowlists, mints a one-time code (10 minutes) for that machine and that scope only.
 */
export async function confirm(env: Env, board: string, owner: string, phrase: unknown, machine: unknown, scope: { shares?: unknown; allow?: unknown; network?: unknown } = {}): Promise<{ code: string; expires_at: number }> {
  if (!phraseOk(phrase)) throw new HostError(`To attach a machine, type exactly: ${HOST_PHRASE}`, 400);
  if (typeof machine !== "string" || !MACHINE_RE.test(machine)) throw new HostError("Open the link atteo host printed on that machine: it names the machine this code is for.", 400);
  const { shares, allow, network } = scopeOf(scope);
  await boardOk(env, board);
  const code = newConsentCode(crypto.getRandomValues(new Uint8Array(10)));
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO host_confirms (token_hash, board_id, owner, machine, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(await codeHash(board, machine, code, consentScope(shares, allow, network)), board, owner, machine, now, now + CONFIRM_TTL_MS)
    .run();
  return { code, expires_at: now + CONFIRM_TTL_MS };
}

/** The daemon's secret: shown once at registration, only its hash kept; the host's own endpoints need it (#4939). */
export async function secretOk(h: HostRow, given: string | null): Promise<boolean> {
  return !!h.secret_hash && !!given && (await sha256hex(given)) === h.secret_hash;
}

/** Step 2 (atteo host, with the owner's login): register that machine with the code from step 1. One code, one machine, once. */
export async function register(env: Env, board: string, owner: string, b: { code?: unknown; machine?: unknown; name?: unknown; shares?: unknown; allow?: unknown; network?: unknown }): Promise<{ host: HostRow; secret: string }> {
  await boardOk(env, board);
  const now = Date.now();
  const { shares, allow, network } = scopeOf(b);
  const machine = typeof b.machine === "string" && MACHINE_RE.test(b.machine) ? b.machine : "";
  // The code was minted for these exact shares and allowlist: asking for more than the person saw doesn't match.
  const hash = machine && normCode(b.code) ? await codeHash(board, machine, String(b.code), consentScope(shares, allow, network)) : "";
  const live = await env.DB.prepare(`SELECT 1 AS ok FROM host_confirms WHERE token_hash = ? AND board_id = ? AND owner = ? AND machine = ? AND used_at IS NULL AND expires_at > ?`).bind(hash, board, owner, machine, now).first();
  const noToken = () => new HostError(`That code isn't valid for this machine and these folders (codes work once, for 10 minutes, on the machine whose link minted them, for the folders and commands shown there). Run atteo host again and confirm in your browser.`, 403);
  if (!live) throw noToken();
  const name = (typeof b.name === "string" ? b.name : "").replace(/[^\w .@-]/g, "").trim().slice(0, 40) || "machine";
  // Spent only now, once the request is good: one token, one machine (a second use, or a race, gets 403).
  const used = await env.DB.prepare(`UPDATE host_confirms SET used_at = ? WHERE token_hash = ? AND board_id = ? AND owner = ? AND machine = ? AND used_at IS NULL AND expires_at > ?`).bind(now, hash, board, owner, machine, now).run();
  if (!used.meta.changes) throw noToken();
  const secret = randomSecret("hs_", 24);
  const h: HostRow = { id: randomSecret("h_", 9), board_id: board, owner, name, shares: JSON.stringify(shares), allow: JSON.stringify(allow), network: network ? 1 : 0, created_at: now, last_seen: now, stopped_at: null, stopped_by: null, secret_hash: await sha256hex(secret) };
  await env.DB.prepare(`INSERT INTO hosts (id, board_id, owner, name, shares, allow, network, created_at, last_seen, secret_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(h.id, board, owner, name, h.shares, h.allow, h.network, now, now, h.secret_hash).run();
  return { host: h, secret };
}

export async function getHost(env: Env, board: string, id: string): Promise<HostRow | null> {
  return env.DB.prepare(`SELECT * FROM hosts WHERE id = ? AND board_id = ?`).bind(id, board).first<HostRow>();
}

/** A board's hosts: live ones, plus the ones stopped in the last day (so a Stop is visible). */
export async function listHosts(env: Env, board: string): Promise<HostRow[]> {
  return (await env.DB.prepare(`SELECT * FROM hosts WHERE board_id = ? AND (stopped_at IS NULL OR stopped_at > ?) ORDER BY created_at DESC LIMIT 50`).bind(board, Date.now() - 86_400_000).all<HostRow>()).results;
}

/**
 * The kill switch: the host's owner or the board's owner. Every run not finished is dropped (waiting ones, and a running
 * one: the daemon kills it within ~2 s), and the approvals still waiting for them are closed as denied, so Approve can't
 * say "Approved" for something that will never run (#4931). Returns the stopped hosts, the dropped runs (one audit line
 * each, #4942) and the closed approvals (their cards update live).
 */
export async function stop(env: Env, board: string, id: string, by: string, boardOwner: string | null): Promise<{ hosts: HostRow[]; dropped: RunRow[]; closed: approvals.Approval[] }> {
  const targets = id === "all" ? (await listHosts(env, board)).filter((h) => !h.stopped_at) : [await getHost(env, board, id)].filter((h): h is HostRow => !!h);
  if (id !== "all" && !targets.length) throw new HostError("No such host.", 404);
  const mine = targets.filter((h) => h.owner === by || by === boardOwner);
  if (!mine.length && targets.length) throw new HostError("Only the machine's owner or the board's owner can stop it.", 403);
  const now = Date.now();
  const dropped: RunRow[] = [];
  const closed: approvals.Approval[] = [];
  for (const h of mine) {
    if (h.stopped_at) continue;
    const open = (await env.DB.prepare(`SELECT * FROM host_runs WHERE host_id = ? AND status IN ('pending', 'approved', 'running')`).bind(h.id).all<RunRow>()).results;
    await env.DB.batch([
      env.DB.prepare(`UPDATE hosts SET stopped_at = ?, stopped_by = ? WHERE id = ? AND stopped_at IS NULL`).bind(now, by, h.id),
      env.DB.prepare(`UPDATE host_runs SET status = 'stopped', finished_at = ?, note = CASE status WHEN 'running' THEN 'host stopped while it ran' ELSE 'host stopped' END WHERE host_id = ? AND status IN ('pending', 'approved', 'running')`).bind(now, h.id),
    ]);
    for (const r of open) {
      dropped.push({ ...r, status: "stopped", finished_at: now, note: r.status === "running" ? "host stopped while it ran" : "host stopped" });
      if (r.status !== "pending" || !r.approval_id) continue;
      const moved = await env.DB.prepare(`UPDATE approvals SET status = 'rejected', note = 'host stopped', decided_at = ? WHERE id = ? AND user = ? AND status = 'pending'`).bind(now, r.approval_id, h.owner).run();
      if (moved.meta.changes) {
        const a = await approvals.getApproval(env, h.owner, r.approval_id);
        if (a) closed.push(a);
      }
    }
    h.stopped_at = now;
    h.stopped_by = by;
  }
  return { hosts: mine, dropped, closed };
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
  clock = Date.now(), // the request's clock: real time, except a local test's x-dev-now (src/util.ts requestNow)
): Promise<{ run: RunRow; host: HostRow; approval: approvals.Approval | null }> {
  const host = await getHost(env, board, hostId);
  if (!host) throw new HostError("No such host.", 404);
  if (host.stopped_at) throw new HostError(`${host.name} was stopped by ${host.stopped_by}.`, 409);
  await boardOk(env, board); // archived or deleted since: nothing runs (#4951)
  if (Date.now() - host.last_seen > ONLINE_MS) throw new HostError(`${host.name} is offline (its owner's atteo host isn't running).`, 409);
  // Someone the owner muted here can't fill their inbox with run approvals (#4941).
  if (by !== host.owner && (await mutersOf(env.DB, board, by)).has(host.owner)) throw new HostError(`${host.owner} muted you on this board, so you can't ask their machine to run anything.`, 403);
  const problem = commandProblem(b.command);
  if (problem) throw new HostError(problem);
  const command = b.command as string;
  const shares = parse(host.shares);
  if (b.cwd != null && b.cwd !== "" && (typeof b.cwd !== "string" || !CWD_RE.test(b.cwd))) throw new HostError("cwd can only use letters, digits, spaces and _ . / -");
  const cwd = b.cwd == null || b.cwd === "" ? shares[0] : normPath(b.cwd);
  if (!cwd || !insideShares(cwd, shares)) throw new HostError(`cwd must be inside a folder ${host.name} shares: ${shares.join(", ")}`);
  const counts = await env.DB.prepare(
    `SELECT SUM(CASE WHEN ${LIVE} THEN 1 ELSE 0 END) AS waiting,
            SUM(CASE WHEN ${LIVE} AND requested_by = ?1 THEN 1 ELSE 0 END) AS mine,
            SUM(CASE WHEN requested_by = ?1 AND created_at > ?2 THEN 1 ELSE 0 END) AS hour
       FROM host_runs WHERE host_id = ?3`,
  ).bind(by, clock - 3600_000, host.id, clock - APPROVED_TTL_MS, clock - RUN_GRACE_MS).first<{ waiting: number | null; mine: number | null; hour: number | null }>();
  // The owner is never locked out of their own machine by members' asks (3+3+3+1, #5010).
  if (by !== host.owner && (counts?.waiting ?? 0) >= MAX_WAITING) throw new HostError(`${host.name} already has ${MAX_WAITING} commands waiting.`, 429);
  // One member can't fill the queue for everyone, or flood the owner (#4959).
  if ((counts?.mine ?? 0) >= MAX_WAITING_PER_REQUESTER) throw new HostError(`You already have ${MAX_WAITING_PER_REQUESTER} commands waiting on ${host.name}. Wait for those first.`, 429);
  if ((counts?.hour ?? 0) >= MAX_RUNS_PER_HOUR) throw new HostError(`You've asked ${host.name} for ${MAX_RUNS_PER_HOUR} runs in the last hour. Try again later.`, 429);
  const timeout = clampTimeout(b.timeout_s);
  // An allowlisted command skips approval only in the first shared folder (where it was allowlisted for): anywhere else
  // the owner approves it like any other (#4920).
  const allowed = parse(host.allow).includes(command) && cwd === shares[0];
  let approval: approvals.Approval | null = null;
  if (!allowed) {
    try {
      approval = await approvals.requestApproval(env, host.owner, {
        client: "atteo host",
        board_id: board,
        requested_by: by,
        // The title says where; the exact command is shown in full on the card, never only in a cut title (#4926).
        title: `${by === host.owner ? "Your agent" : `${by}'s agent`} asks to run a command on ${host.name}, in ${codeSpan(cwd)}`,
        details: `${by} asks to run this on your machine "${host.name}", in ${codeSpan(cwd)} (stops after ${timeout}s). It runs as you, sandboxed to the shared folders. Approve only if you'd type it yourself.`,
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
/** An approved run nobody picked up within APPROVED_TTL_MS, or a running one long past its timeout, is closed as expired. */
async function lapse(env: Env, r: RunRow, now = Date.now()): Promise<{ run: RunRow; closed: boolean }> {
  const late = r.status === "approved" ? r.created_at < now - APPROVED_TTL_MS : r.status === "running" && (r.started_at ?? r.created_at) + r.timeout_s * 1000 + RUN_GRACE_MS < now;
  if (!late) return { run: r, closed: false };
  const note = r.status === "approved" ? PICKUP_LATE : HOST_GONE;
  const moved = await env.DB.prepare(`UPDATE host_runs SET status = 'expired', finished_at = ?, note = ? WHERE id = ? AND status = ?`).bind(now, note, r.id, r.status).run();
  return { run: { ...r, status: "expired", finished_at: now, note }, closed: !!moved.meta.changes };
}

async function settle(env: Env, owner: string, r: RunRow, clock = Date.now()): Promise<{ run: RunRow; closed: boolean }> {
  if (r.status === "approved" || r.status === "running") return lapse(env, r, clock);
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
export async function runNow(env: Env, board: string, host: HostRow, id: string, waitMs = 0, clock?: number): Promise<{ run: RunRow; closed: RunRow | null } | null> {
  const until = Date.now() + Math.min(waitMs, 25_000);
  let closed: RunRow | null = null;
  for (;;) {
    const got = await getRun(env, board, host.id, id);
    if (!got) return null;
    const s = await settle(env, host.owner, got, clock ?? Date.now());
    if (s.closed) closed = s.run;
    if (TERMINAL.has(s.run.status) || Date.now() >= until) return { run: s.run, closed };
    await new Promise((res) => setTimeout(res, 1000));
  }
}

/**
 * The host's poll (only its owner's login): marks it online, settles approvals, and hands over the oldest approved run
 * (now running), or {stop} when the host was stopped, the board is gone, or the owner left it. Holds up to `waitMs`.
 */
export async function next(env: Env, board: string, host: HostRow, waitMs: number, clock?: number): Promise<{ stop?: string; run?: RunRow; settled: RunRow[] }> {
  const settled: RunRow[] = [];
  const until = Date.now() + Math.min(waitMs, 25_000);
  for (;;) {
    const h = await getHost(env, board, host.id);
    if (!h || h.stopped_at) return { stop: h?.stopped_by ? `stopped by ${h.stopped_by}` : "stopped", settled };
    const member = await env.DB.prepare(`SELECT 1 AS ok FROM members m JOIN boards b ON b.id = m.board_id WHERE m.board_id = ? AND m.user = ? AND b.deleted_at IS NULL AND b.archived_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > ?)`).bind(board, h.owner, Date.now()).first();
    if (!member) {
      const got = await stop(env, board, h.id, h.owner, null);
      settled.push(...got.dropped);
      return { stop: "you're no longer on this board, or it was archived or deleted", settled };
    }
    await env.DB.prepare(`UPDATE hosts SET last_seen = ? WHERE id = ?`).bind(Date.now(), h.id).run();
    const pending = (await env.DB.prepare(`SELECT * FROM host_runs WHERE host_id = ? AND status = 'pending' ORDER BY created_at LIMIT 20`).bind(h.id).all<RunRow>()).results;
    for (const p of pending) {
      const s = await settle(env, h.owner, p);
      if (s.closed) settled.push(s.run);
    }
    const now = Date.now();
    // An approved run that waited too long for its host is closed, not run whenever the host comes back (#4942); one
    // left running by a host that died is closed too (#5007).
    const stale = (await env.DB.prepare(`SELECT * FROM host_runs WHERE host_id = ? AND status IN ('approved', 'running') LIMIT 50`).bind(h.id).all<RunRow>()).results;
    for (const s of stale) {
      const l = await lapse(env, s, clock ?? now);
      if (l.closed) settled.push(l.run);
    }
    const r = await env.DB.prepare(`SELECT * FROM host_runs WHERE host_id = ? AND status = 'approved' AND created_at >= ? ORDER BY created_at LIMIT 1`).bind(h.id, (clock ?? now) - APPROVED_TTL_MS).first<RunRow>();
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

/** Still waiting or running, in SQL: not an approved run past its pickup TTL or a running one its host abandoned (?4, ?5). */
const LIVE = "(status = 'pending' OR (status = 'approved' AND created_at >= ?4) OR (status = 'running' AND COALESCE(started_at, created_at) + timeout_s * 1000 >= ?5))";

const fenceOut = (s: string) => "```\n" + s.replace(/```/g, "ʼʼʼ") + "\n```";

/**
 * The board's audit line for a run that finished (or was refused): who asked, what, where, and how it went. The command
 * is the requester's text, so it is only ever shown inside a fence, with the requester named before it: it can't
 * break out and read as the machine owner's own words (#4938).
 */
export function auditText(h: Pick<HostRow, "name" | "owner">, r: RunRow): string {
  const asked = r.requested_by === h.owner ? `${h.owner}'s own agent` : `${r.requested_by}'s agent (not ${h.owner})`;
  const cmd = r.command.length > 1000 ? r.command.slice(0, 1000) + `\n… (${r.command.length - 1000} more characters)` : r.command;
  const head = `🖥 Machine log · ${h.name} (${h.owner}'s machine) · in ${codeSpan(r.cwd)} · asked by ${asked}:\n${fenceOut(cmd)}`;
  if (r.status === "rejected") return `${head}\n⛔ Denied by ${h.owner}${r.note ? ` (note: ${JSON.stringify(r.note.replace(/\s+/g, " ").slice(0, 200))})` : ""}.`;
  if (r.status === "expired" && r.note === HOST_GONE) return `${head}
⛔ No result: its host went away while it ran (it may have run part or all of it).`;
  if (r.status === "expired") return `${head}\n⛔ Not run: ${r.note && r.note !== "no decision in time" ? r.note : "no decision in time"}.`;
  if (r.status === "stopped") return `${head}\n⛔ ${r.note === "host stopped while it ran" ? "Killed: the host was stopped while it ran." : "Dropped: the host was stopped."}`;
  const how = r.timed_out ? `stopped after ${r.timeout_s}s (timeout)` : r.note && r.status === "failed" ? `not run: ${r.note}` : `exit ${r.exit_code}`;
  const out = (r.output ?? "").trim();
  const shown = out.length > BOARD_OUTPUT ? out.slice(0, BOARD_OUTPUT) + `\n… (${out.length - BOARD_OUTPUT} more characters; the requester can read the rest)` : out;
  return `${head}\n${r.status === "done" ? "✓" : "✗"} ${how}${r.approval_id ? ` · approved by ${h.owner}` : " · allowlisted"}${shown ? `\n${fenceOut(shown)}` : ""}`;
}

export const attachText = (h: HostRow) =>
  `⚠️ ${h.owner} attached a machine to this board: ${h.name} (shares ${parse(h.shares).join(", ")}). Agents here can ask to run commands on it; ${h.owner} approves each one${parse(h.allow).length ? ` (except ${parse(h.allow).length} allowlisted command${parse(h.allow).length === 1 ? "" : "s"})` : ""}. Stop it from the side panel, the app, or atteo host stop.`;
export const stopText = (h: HostRow, by: string) => `⛔ ${by} stopped ${h.name} (${h.owner}'s machine). Nothing more runs on it.`;
