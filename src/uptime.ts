// Public uptime page: GET /status (HTML) and GET /status.json.
// Reuses the /health/deep probes (D1 and one Durable Object) but returns only coarse words.
// Error text, the probe board id, tokens, and account data stay off this response.

import { pageSecurity } from "./ui";

/** Same unused board name /health/deep has always probed. A "Board not found" reply means the Durable Object answered. */
const HEALTH_BOARD = "b_healthcheck0";
/** Fixed R2 key. head() only; the bytes are never read or returned. */
const FILES_PROBE_KEY = "_atteo/status-probe";

export interface StatusEnv {
  DB: {
    prepare(query: string): { first(): Promise<unknown> };
  };
  BOARD: {
    idFromName(name: string): unknown;
    get(id: unknown): { info(): unknown };
  };
  FILES?: {
    head(key: string): Promise<unknown>;
  };
}

export type CheckWord = "ok" | "down";
export type StatusWord = "ok" | "degraded" | "down";

export interface StatusReport {
  status: StatusWord;
  checks: {
    worker: "ok";
    database: CheckWord;
    boards: CheckWord;
    files?: CheckWord;
  };
}

function detail(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.slice(0, 200);
}

/** Operator probe shared with /health/deep. Values are "ok" or a short error string (not for the public page). */
export async function deepChecks(env: StatusEnv): Promise<{ boards: string; database: string }> {
  let boards = "down";
  let database = "down";
  try {
    await env.BOARD.get(env.BOARD.idFromName(HEALTH_BOARD)).info();
    boards = "ok";
  } catch (e) {
    const m = detail(e);
    boards = /Board not found/.test(m) ? "ok" : m;
  }
  try {
    await env.DB.prepare("SELECT 1 AS x").first();
    database = "ok";
  } catch (e) {
    database = detail(e);
  }
  return { boards, database };
}

function coarse(v: string): CheckWord {
  return v === "ok" ? "ok" : "down";
}

/** "ok" when the binding answered, "down" when it failed, "absent" when FILES is not bound. */
async function filesCheck(env: StatusEnv): Promise<CheckWord | "absent"> {
  const bucket = env.FILES;
  if (bucket == null) return "absent";
  try {
    await bucket.head(FILES_PROBE_KEY);
    return "ok";
  } catch {
    return "down";
  }
}

export function rollup(checks: StatusReport["checks"]): StatusWord {
  if (checks.database === "down" || checks.boards === "down") return "down";
  if (checks.files === "down") return "degraded";
  return "ok";
}

export async function publicStatus(env: StatusEnv): Promise<StatusReport> {
  try {
    const deep = await deepChecks(env);
    const files = await filesCheck(env);
    const checks: StatusReport["checks"] = {
      worker: "ok",
      database: coarse(deep.database),
      boards: coarse(deep.boards),
      ...(files === "absent" ? {} : { files }),
    };
    return { status: rollup(checks), checks };
  } catch {
    return { status: "down", checks: { worker: "ok", database: "down", boards: "down" } };
  }
}

export function statusHttp(status: StatusWord): number {
  return status === "ok" ? 200 : 503;
}

/** JSON for /status.json, Accept: application/json, or ?format=json. HTML otherwise. */
export function statusWantsJson(request: Request, path: string): boolean {
  if (path === "/status.json") return true;
  const format = new URL(request.url).searchParams.get("format");
  if (format === "json") return true;
  const accept = (request.headers.get("accept") ?? "").toLowerCase();
  if (!accept.includes("application/json")) return false;
  if (accept.includes("text/html")) return false;
  return true;
}

function checkRows(checks: StatusReport["checks"]): string {
  const rows: [string, CheckWord][] = [
    ["worker", checks.worker],
    ["database", checks.database],
    ["boards", checks.boards],
  ];
  if (checks.files) rows.push(["files", checks.files]);
  return rows.map(([name, value]) => `<li data-check="${name}">${name}: ${value}</li>`).join("");
}

function htmlDocument(report: StatusReport): string {
  const status = report.status;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Status · Atteo</title></head><body>
<h1 id="atteo-status" data-status="${status}">status: ${status}</h1>
<ul>${checkRows(report.checks)}</ul>
<p>Public uptime check. Worker liveness and coarse dependency health. No account or board data.</p>
</body></html>`;
}

function jsonResponse(report: StatusReport): Response {
  return Response.json(report, {
    status: statusHttp(report.status),
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

function htmlResponse(report: StatusReport): Response {
  const security = pageSecurity();
  const headers = new Headers(security.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(htmlDocument(report), { status: statusHttp(report.status), headers });
}

/** GET/HEAD /status and /status.json. No sign-in. */
export async function handlePublicStatus(request: Request, env: StatusEnv, path: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return Response.json(
      { error: "Method not allowed" },
      { status: 405, headers: { allow: "GET, HEAD", "cache-control": "no-store" } },
    );
  }
  const report = await publicStatus(env);
  const res = statusWantsJson(request, path) ? jsonResponse(report) : htmlResponse(report);
  if (request.method === "HEAD") return new Response(null, { status: res.status, headers: res.headers });
  return res;
}
