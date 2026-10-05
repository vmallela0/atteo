// CSP violation reports (jxn's agent #2636). The pages send Content-Security-Policy-Report-Only first; browsers post what
// the policy would have blocked to /api/csp-report, in either the old report-uri shape ({"csp-report": {...}}) or the
// Reporting API's ([{type: "csp-violation", body: {...}}]). Each one is counted per day as "directive blocked" in
// usage_daily (metric "csp"), so the ops console can show what enforcing would break. Nothing else is stored: no page
// URL path beyond its route, no user, no sample.
import type { Env } from "./types";
import * as usage from "./usage";

export interface CspHit {
  directive: string;
  blocked: string;
}

const MAX_PER_REQUEST = 20;
const MAX_BODY = 64 * 1024;

/** "https://cdn.x.com/a.js?v=1" → "https://cdn.x.com"; keywords (inline, eval, data, blob…) stay as they are. */
export function blockedKey(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return "(none)";
  if (/^[a-z-]+$/i.test(s)) return s.toLowerCase(); // inline, eval, wasm-eval, trusted-types-policy…
  try {
    const u = new URL(s);
    if (u.protocol === "http:" || u.protocol === "https:" || u.protocol === "ws:" || u.protocol === "wss:") return u.origin;
    return u.protocol.replace(/:$/, ""); // data, blob, about…
  } catch {
    return s.slice(0, 40);
  }
}

const directiveKey = (raw: unknown): string => {
  const s = typeof raw === "string" ? raw.trim().split(/\s+/)[0] : "";
  return /^[a-z-]{1,40}$/.test(s) ? s : "(unknown)";
};

/** Both report shapes → hits; anything else → []. Capped, so one request can't count thousands. */
export function parseReports(body: unknown): CspHit[] {
  const out: CspHit[] = [];
  const push = (r: Record<string, unknown> | null | undefined) => {
    if (!r || typeof r !== "object" || out.length >= MAX_PER_REQUEST) return;
    out.push({
      directive: directiveKey(r["effective-directive"] ?? r["effectiveDirective"] ?? r["violated-directive"] ?? r["violatedDirective"]),
      blocked: blockedKey(r["blocked-uri"] ?? r["blockedURL"] ?? r["blockedURI"]),
    });
  };
  if (Array.isArray(body)) {
    for (const r of body) if (r && typeof r === "object" && (r as { type?: unknown }).type === "csp-violation") push((r as { body?: Record<string, unknown> }).body);
  } else if (body && typeof body === "object" && "csp-report" in body) {
    push((body as { "csp-report": Record<string, unknown> })["csp-report"]);
  }
  return out;
}

// Per-isolate rate limit: a misbehaving page (or someone scripting it) can't fill the counters.
const WINDOW = 60_000;
const PER_WINDOW = 30;
const seen = new Map<string, { at: number; n: number }>();
export function allow(ip: string, now = Date.now()): boolean {
  const r = seen.get(ip);
  if (!r || now - r.at > WINDOW) {
    if (seen.size > 5000) seen.clear();
    seen.set(ip, { at: now, n: 1 });
    return true;
  }
  r.n++;
  return r.n <= PER_WINDOW;
}

/** POST /api/csp-report: no sign-in (browsers send it themselves), 204 always, counted when allowed. */
export async function handleReport(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get("cf-connecting-ip") ?? "local";
  const len = Number(request.headers.get("content-length") ?? 0);
  if (len > MAX_BODY || !allow(ip)) return new Response(null, { status: 204 });
  const text = (await request.text().catch(() => "")).slice(0, MAX_BODY);
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    return new Response(null, { status: 204 });
  }
  const hits = parseReports(body);
  await Promise.all(hits.map((h) => usage.track(env, "csp", `${h.directive} ${h.blocked}`)));
  return new Response(null, { status: 204 });
}
