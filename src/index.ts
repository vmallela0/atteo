// Worker entry: MCP endpoint, sign-in, web pages, JSON API, and the operator console (/_ops).

import * as a2a from "./a2a";
import * as usage from "./usage";
import * as oauth from "./oauth";
import { consentPage } from "./oauthPage";
import * as approvals from "./approvals";
import { approvalsPage } from "./approvalsPage";
import * as access from "./access";
import * as social from "./social";
import * as webhooks from "./webhooks";
import * as avatars from "./avatars";
import SKILL_MD from "../skills/agent-soup/SKILL.md";
import { openapi } from "./openapi";
import * as billing from "./billing";
import { blockedMessage, scanFields } from "./secrets";
import * as inbox from "./inbox";
import * as auth from "./auth";
import { handleMcp } from "./mcp";
import * as device from "./device";
import { EMAIL_RE, sendInvite } from "./invite";
import { mayMention, parseMentions, type Mention } from "./mentions";
import * as registry from "./registry";
import {
  adminPage,
  boardPage,
  devicePage,
  entryHtml,
  homePage,
  landingPage,
  logRow,
  mePage,
  messagePage,
  notFound,
  summaryHtml,
  welcomePage,
  type AdminData,
  type SideBoard,
  type Viewer,
  legalPage,
  profilePage,
  peoplePage,
} from "./html";
import type { Entry, Env } from "./types";
import { FAVICON_SVG, page, renderText } from "./ui";
import { BOARD_RE, connectCommand, esc, newBoardId, normalizeUser, parseBoardMeta } from "./util";

import * as Sentry from "@sentry/cloudflare";
export { Board } from "./board";
import { MAX_IMAGE } from "./board";

const OPS_PATH = "/_ops";

function boardStub(env: Env, id: string) {
  return env.BOARD.get(env.BOARD.idFromName(id));
}

function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(data, { status, headers });
}

function redirect(to: string, headers: HeadersInit = {}): Response {
  return new Response(null, { status: 303, headers: { Location: to, ...headers } });
}

/** Constant-time comparison for the ops automation key. */
function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

interface Ctx {
  request: Request;
  env: Env;
  ctx: ExecutionContext;
  url: URL;
  session: auth.Session | null;
  viewer: Viewer | null;
}

async function loadViewer(env: Env, session: auth.Session | null, request?: Request, path = ""): Promise<Viewer | null> {
  // The JSON API also takes a personal token (Authorization: Bearer ab_…), as agents use for MCP. Never for pages.
  const bearer = request?.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  // Account-level actions (tokens, billing, ops) stay browser-only, so a leaked token can't mint more or change plans.
  const accountOnly = /^\/api\/(ops|tokens|billing|webhooks)(\/|$)/.test(path);
  if (!session?.user && bearer && path.startsWith("/api/") && !accountOnly) {
    const name = await auth.userForToken(env, bearer);
    const u = name ? await registry.userByName(env, name) : null;
    return u ? { name: u.name, email: u.email ?? "", display_name: u.display_name, admin: false, via: "agent" } : null;
  }
  if (!session?.user) return null;
  // Usually already joined in by getSession; look the member up only if it wasn't.
  const u = session.u_name ? { name: session.u_name, email: session.u_email ?? null, display_name: session.u_display_name ?? null } : await registry.userByName(env, session.user);
  if (!u) return null;
  return {
    name: u.name,
    email: u.email ?? session.email,
    display_name: u.display_name,
    admin: !!session.email_verified && auth.isAdminEmail(env, session.email),
  };
}

function hasOpsKey(c: Ctx): boolean {
  const k = c.request.headers.get("x-admin-key");
  return !!c.env.ADMIN_KEY && !!k && safeEqual(k, c.env.ADMIN_KEY);
}

const isOps = (c: Ctx) => !!c.viewer?.admin || hasOpsKey(c);

async function sideBoards(env: Env, user: string): Promise<SideBoard[]> {
  return (await registry.boardsForUser(env, user)).filter((b) => !b.archived_at).map((b) => ({ id: b.id, title: b.title, kind: (b as { kind?: string | null }).kind ?? null }));
}

/** Members (and operators) can see a board; everyone else gets a 404 so board ids don't leak. */
async function canSee(c: Ctx, boardId: string): Promise<boolean> {
  if (!BOARD_RE.test(boardId)) return false;
  const a = await registry.boardAccess(c.env, boardId, c.viewer?.name ?? null);
  if (!a.exists) return false;
  return isOps(c) || a.member;
}

/** Plan limits apply to people (origin given); the ops API creates boards without them. */
async function createBoard(env: Env, title: string, user: string, origin?: string, opts: { encrypted?: boolean } = {}) {
  if (origin) await billing.checkCanCreateBoard(env, user, origin);
  const id = newBoardId();
  const info = await boardStub(env, id).init(id, title, user, opts);
  await registry.recordBoard(env, info);
  await registry.addMember(env, id, user, { role: "owner" });
  if (opts.encrypted) await env.DB.prepare(`UPDATE boards SET encrypted = 1 WHERE id = ?`).bind(id).run();
  // Organization policy: boards made by people at a domain with a retention cap start with it.
  const u = await registry.userByName(env, user);
  const pol = u?.email ? await orgPolicy(env, u.email) : null;
  if (pol?.max_retention_days) await env.DB.prepare(`UPDATE boards SET retention_days = ? WHERE id = ?`).bind(pol.max_retention_days, id).run();
  return info;
}

function suggestName(email: string, display: string | null): string {
  const base = (email.split("@")[0] || display || "me").toLowerCase().replace(/[^a-z0-9_.-]/g, "").replace(/^[^a-z0-9]+/, "");
  return normalizeUser(base.slice(0, 32)) ?? "me";
}

async function freeName(env: Env, base: string): Promise<string> {
  if (!(await registry.userByName(env, base))) return base;
  for (let i = 2; i < 100; i++) {
    const n = `${base.slice(0, 29)}${i}`;
    if (!(await registry.userByName(env, n))) return n;
  }
  return `${base.slice(0, 24)}${crypto.randomUUID().slice(0, 6)}`;
}

function safeReturn(to: string | null | undefined): string {
  return to && to.startsWith("/") && !to.startsWith("//") ? to : "/";
}

// ---------- auth routes ----------

async function authLogin(c: Ctx): Promise<Response> {
  if (!c.env.WORKOS_CLIENT_ID || !c.env.WORKOS_API_KEY) {
    return messagePage("Sign-in isn't configured", "WORKOS_CLIENT_ID / WORKOS_API_KEY are missing on this deployment.", { status: 500 });
  }
  const state = auth.randomSecret("", 18);
  const ret = safeReturn(c.url.searchParams.get("return"));
  const hint = c.url.searchParams.get("login_hint") ?? undefined;
  const to = auth.authorizeUrl(c.env, `${c.url.origin}/auth/callback`, state, {
    loginHint: hint,
    screenHint: c.url.searchParams.get("signup") ? "sign-up" : undefined,
  });
  return redirect(to, { "Set-Cookie": auth.cookieHeader(c.url, auth.OAUTH_COOKIE, `${state}|${ret}`, 600) });
}

export interface OrgPolicy {
  domain: string;
  require_sso: number;
  max_retention_days: number | null;
  allow_outside_members: number;
}

async function orgPolicy(env: Env, email: string): Promise<OrgPolicy | null> {
  const domain = email.split("@")[1]?.toLowerCase();
  return domain ? env.DB.prepare(`SELECT domain, require_sso, max_retention_days, allow_outside_members FROM org_policies WHERE domain = ?`).bind(domain).first<OrgPolicy>() : null;
}

/** "Sign in with SSO": find the organization for a work email's domain and send the person to its identity provider. */
async function authSso(c: Ctx): Promise<Response> {
  const email = (c.url.searchParams.get("email") ?? "").trim().toLowerCase();
  if (!email) {
    return page(
      "Sign in with SSO · Agent Soup",
      `<div class="card pad" style="max-width:420px;margin:48px auto 0"><h1 style="font-size:18px">Sign in with SSO</h1><p class="small muted">Use your work email; we'll send you to your company's sign-in.</p>
<form method="get" action="/auth/sso" class="stack" style="--gap:10px;margin-top:12px"><input class="input" type="email" name="email" required placeholder="you@company.com" autofocus><button class="btn primary">Continue</button></form>
<p class="xs faint" style="margin-top:12px"><a href="/auth/login">Other ways to sign in</a></p></div>`,
      { narrow: true },
    );
  }
  const org = await auth.ssoOrganizationFor(c.env, email);
  if (!org) return messagePage("No SSO for that domain", `${email.split("@")[1]} hasn't set up single sign-on with Agent Soup. Sign in the usual way.`, { status: 404, action: { href: `/auth/login?login_hint=${encodeURIComponent(email)}`, label: "Sign in" } });
  const state = auth.randomSecret("", 18);
  const ret = safeReturn(c.url.searchParams.get("return"));
  const to = auth.authorizeUrl(c.env, `${c.url.origin}/auth/callback`, state, { organizationId: org.id, loginHint: email });
  return redirect(to, { "Set-Cookie": auth.cookieHeader(c.url, auth.OAUTH_COOKIE, `${state}|${ret}`, 600) });
}

async function authCallback(c: Ctx): Promise<Response> {
  const fail = (text: string) => messagePage("Sign-in didn't complete", text, { status: 400, action: { href: "/auth/login", label: "Try again" } });
  const err = c.url.searchParams.get("error_description") ?? c.url.searchParams.get("error");
  if (err) return fail(`WorkOS said: ${err}`);
  const code = c.url.searchParams.get("code");
  const sentState = c.url.searchParams.get("state");
  // Flows that start on WorkOS's side (an invitation email, AuthKit's own pages) arrive without our state.
  // Restart from /auth/login: AuthKit already has a session, so it bounces straight back with a proper state.
  if (!sentState) return redirect("/auth/login");
  const [state, ret] = (auth.readCookie(c.request, auth.OAUTH_COOKIE) ?? "").split("|");
  if (!code || !state || state !== sentState) return fail("The sign-in link expired or was opened in a different browser. Start again.");

  let wu: auth.WorkosUser;
  try {
    wu = await auth.authenticateCode(c.env, code);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  const verified = !!wu.email_verified;
  const display = [wu.first_name, wu.last_name].filter(Boolean).join(" ") || null;
  // Organization policy: people from a domain that requires SSO must come in through their identity provider.
  const policy = await orgPolicy(c.env, wu.email);
  if (policy?.require_sso && wu.authentication_method !== "SSO") {
    return messagePage("Use your company's sign-in", `${wu.email.split("@")[1]} requires single sign-on. Sign in with SSO instead.`, { status: 403, action: { href: `/auth/sso?email=${encodeURIComponent(wu.email)}`, label: "Sign in with SSO" } });
  }

  // Known account → by WorkOS id. Otherwise a pre-made user row with this *verified* email (e.g. a migrated beta user).
  let user = await registry.userByWorkosId(c.env, wu.id);
  if (user) await registry.setEmailVerified(c.env, user.name, wu.email, verified);
  if (!user && verified) {
    const unlinked = await registry.unlinkedUserByEmail(c.env, wu.email);
    if (unlinked) {
      await registry.linkWorkos(c.env, unlinked.name, wu.id, wu.email, display, verified);
      user = await registry.userByName(c.env, unlinked.name);
    }
  }
  const session = await auth.createSession(c.env, {
    user: user?.name ?? null,
    workos_id: wu.id,
    email: wu.email,
    email_verified: verified,
    display_name: display,
  });
  const headers = new Headers();
  headers.append("Set-Cookie", auth.cookieHeader(c.url, auth.SESSION_COOKIE, session, 30 * 24 * 3600));
  headers.append("Set-Cookie", auth.cookieHeader(c.url, auth.OAUTH_COOKIE, "", 0));

  if (!user) {
    headers.set("Location", `/welcome?return=${encodeURIComponent(safeReturn(ret))}`);
    return new Response(null, { status: 303, headers });
  }
  // Invitations wait for an answer: home lists them with Accept / Decline.
  headers.set("Location", safeReturn(ret));
  return new Response(null, { status: 303, headers });
}

async function welcome(c: Ctx): Promise<Response> {
  const s = c.session;
  if (!s) return redirect("/auth/login");
  if (s.user) return redirect("/");
  const suggestion = await freeName(c.env, suggestName(s.email, s.display_name));
  if (c.request.method === "GET") return welcomePage(s.email, suggestion);
  if (c.request.method !== "POST") return notFound();

  const name = normalizeUser(String((await c.request.formData()).get("name") ?? ""));
  if (!name) return welcomePage(s.email, suggestion, "Use 1–32 lowercase letters, numbers, dot, dash or underscore, starting with a letter or number.");
  if (await registry.userByName(c.env, name)) return welcomePage(s.email, name, `"${name}" is taken. Try another.`);
  if (await registry.userByWorkosId(c.env, s.workos_id)) return redirect("/");
  await registry.createUser(c.env, { name, email: s.email, email_verified: !!s.email_verified, workos_id: s.workos_id, display_name: s.display_name });
  await auth.setSessionUser(c.env, s.id_hash, name);
  return redirect(safeReturn(c.url.searchParams.get("return")));
}

// ---------- ops data ----------

async function opsData(env: Env): Promise<AdminData> {
  const [boards, users, invites] = await Promise.all([registry.allBoards(env), registry.allUsers(env), registry.allInvites(env)]);
  const snaps = await Promise.all(
    boards.slice(0, 25).map(async (b) => {
      try {
        const s = await boardStub(env, b.id).snapshot(Math.max(0, b.entry_count - 30));
        return s.entries.map((e) => ({ ...e, board_id: b.id, board_title: b.title }));
      } catch {
        return [];
      }
    }),
  );
  const recent = snaps.flat().sort((a, b) => b.ts - a.ts || b.seq - a.seq).slice(0, 100);
  const memberRows = await env.DB.prepare(`SELECT m.user, b.id, b.title FROM members m JOIN boards b ON b.id = m.board_id ORDER BY b.title`).all<{
    user: string;
    id: string;
    title: string;
  }>();
  const tokenRows = await env.DB.prepare(
    `SELECT user, SUM(CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END) AS active, MAX(last_used) AS last FROM tokens GROUP BY user`,
  ).all<{ user: string; active: number; last: number | null }>();
  const access = new Map<string, AdminData["access"][number]>();
  for (const u of users) access.set(u.name, { user: u.name, boards: [], active_tokens: 0, last_token_use: null });
  for (const r of memberRows.results) access.get(r.user)?.boards.push({ id: r.id, title: r.title });
  for (const t of tokenRows.results) {
    const a = access.get(t.user);
    if (a) {
      a.active_tokens = t.active;
      a.last_token_use = t.last;
    }
  }
  return { boards, users, invites, recent, totalEntries: boards.reduce((n, b) => n + b.entry_count, 0), access: [...access.values()], metrics: await usage.metrics(env).catch(() => undefined) };
}

// ---------- router ----------

const handler = {
  /** Every 5 minutes: memberships whose time ran out are removed (access checks already ignore them). */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Boards with a retention period: blank what's older.
    const keep = (await env.DB.prepare(`SELECT id, retention_days FROM boards WHERE retention_days IS NOT NULL`).all<{ id: string; retention_days: number }>()).results;
    for (const b of keep) ctx.waitUntil(boardStub(env, b.id).prune(Date.now() - b.retention_days * 86_400_000).catch(() => 0));
    for (const m of await registry.expiredMembers(env)) {
      ctx.waitUntil(
        (async () => {
          await registry.removeMember(env, m.board_id, m.user);
          await boardStub(env, m.board_id).removeMember(m.user).catch(() => {});
          await registry.audit(env, m.board_id, "system", "expired", m.user);
        })().catch(() => {}),
      );
    }
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method;

    try {
      if (path === "/mcp") return await handleMcp(request, env, ctx);
      if (path === "/health") return json({ ok: true, version: env.CF_VERSION_METADATA?.id ?? null });
      if (path === "/health/deep") {
        // Touches storage the way real requests do: a board (Durable Object) and the database.
        const checks: Record<string, string> = {};
        try {
          await boardStub(env, "b_healthcheck0").info();
          checks.boards = "ok";
        } catch (e) {
          const m = e instanceof Error ? e.message : String(e);
          checks.boards = /Board not found/.test(m) ? "ok" : m.slice(0, 200);
        }
        try {
          await env.DB.prepare("SELECT 1 AS x").first();
          checks.database = "ok";
        } catch (e) {
          checks.database = (e instanceof Error ? e.message : String(e)).slice(0, 200);
        }
        const ok = Object.values(checks).every((v) => v === "ok");
        return json({ ok, version: env.CF_VERSION_METADATA?.id ?? null, checks }, ok ? 200 : 503, { "cache-control": "no-store" });
      }
      // ---- A2A: an Agent Card and a JSON-RPC endpoint for agents that don't speak MCP ----
      if (path === "/.well-known/agent-card.json" || path === "/.well-known/agent.json") return json(a2a.agentCard(url.origin), 200, { "access-control-allow-origin": "*" });
      if (path === "/a2a" && method === "POST") {
        const tok = auth.bearer(request);
        const who = tok ? (await auth.resolveToken(env, tok, ctx)).user : null;
        const rpcErr = (id: unknown, code: number, message: string, status = 200) => json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, status);
        if (!who) return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Send a personal token: Authorization: Bearer <token>" } }), { status: 401, headers: { "content-type": "application/json", "WWW-Authenticate": `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource"` } });
        const rpc = (await request.json().catch(() => null)) as { id?: unknown; method?: string; params?: Record<string, any> } | null;
        if (!rpc?.method) return rpcErr(null, -32600, "Invalid request");
        const ok = (result: unknown) => json({ jsonrpc: "2.0", id: rpc.id ?? null, result });
        try {
          if (rpc.method === "message/send") {
            const msg = rpc.params?.message as a2a.A2AMessage | undefined;
            const text = a2a.textOf(msg);
            const to = String(msg?.metadata?.to ?? "").toLowerCase().replace(/^@/, "");
            const want = String(msg?.metadata?.board ?? "").trim();
            if (!text) return rpcErr(rpc.id, -32602, "message needs a text part");
            if (!to || !want) return rpcErr(rpc.id, -32602, 'Put {"board": "<id or name>", "to": "<member>"} in message.metadata');
            const mine = await registry.boardsForUser(env, who);
            const board = mine.find((b) => b.id === want) ?? mine.find((b) => b.title.toLowerCase() === want.toLowerCase()) ?? mine.find((b) => b.title.toLowerCase().includes(want.toLowerCase()));
            if (!board) return rpcErr(rpc.id, -32602, `You're not on a board called "${want}".`);
            if ((await registry.memberRole(env, board.id, who)) === "viewer") return rpcErr(rpc.id, -32602, "Your role on that board is viewer.");
            const hit = scanFields({ text });
            if (hit) return rpcErr(rpc.id, -32602, blockedMessage(hit));
            const e = await boardStub(env, board.id).post(who, { type: "question", to, text, via: "agent", client: "A2A agent" });
            ctx.waitUntil(registry.bumpBoard(env, board.id, e.seq).catch(() => {}));
            return ok(a2a.task(a2a.taskId(board.id, e.seq), "working", undefined, { metadata: { board: board.id, seq: e.seq, url: `${url.origin}/b/${board.id}#e${e.seq}` } }));
          }
          if (rpc.method === "tasks/get" || rpc.method === "tasks/cancel") {
            const t = a2a.parseTaskId(rpc.params?.id);
            if (!t || !(await registry.isMember(env, t.board, who))) return rpcErr(rpc.id, -32001, "Task not found");
            const stub = boardStub(env, t.board);
            const r = await stub.get(t.seq).catch(() => null);
            if (!r || r.entry.author !== who) return rpcErr(rpc.id, -32001, "Task not found");
            const id = a2a.taskId(t.board, t.seq);
            if (rpc.method === "tasks/cancel") {
              await stub.post(who, { type: "note", retracts: t.seq, text: "Withdrawn by the asking agent.", via: "agent", client: "A2A agent" }).catch(() => {});
              return ok(a2a.task(id, "canceled"));
            }
            if (r.replies.some((x) => x.retracts === t.seq)) return ok(a2a.task(id, "canceled"));
            const answer = r.replies.find((x) => x.author !== who && x.retracts == null && (x.reply_to === t.seq || x.resolves.includes(t.seq)));
            if (!answer) return ok(a2a.task(id, "working"));
            const by = answer.via === "agent" ? `${answer.author}'s agent` : answer.author;
            // The answer is another member's words: hand it over as data.
            return ok(a2a.task(id, "completed", answer.text, { metadata: { answered_by: by, untrusted: true, seq: answer.seq } }));
          }
          return rpcErr(rpc.id, -32601, `Method not found: ${rpc.method}. Supported: message/send, tasks/get, tasks/cancel.`);
        } catch (e) {
          return rpcErr(rpc.id, -32603, e instanceof Error ? e.message : String(e));
        }
      }

      if (path === "/terms" || path === "/privacy") return legalPage(path.slice(1) as "terms" | "privacy");
      if (path === "/openapi.json") return json(openapi(url.origin), 200, { "access-control-allow-origin": "*", "cache-control": "public, max-age=300" });
      if (path === "/skill.md") return new Response(SKILL_MD, { headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "public, max-age=300" } });
      if (path === "/favicon.svg" || path === "/favicon.ico") {
        return new Response(FAVICON_SVG, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } });
      }

      const session = await auth.getSession(request, env);
      const viewer = await loadViewer(env, session, request, path);
      const pv = (): "agent" | "person" => viewer?.via ?? "person"; // who wrote it: a person on the web, or an agent via token
      if (viewer && viewer.via !== "agent") ctx.waitUntil(Promise.resolve(social.markSeen(env, viewer.name, "web")).catch(() => {}));
      if (viewer && viewer.via !== "agent" && !viewer.name.startsWith("e2e-")) ctx.waitUntil(Promise.resolve(usage.track(env, "active_person", viewer.name, true)).catch(() => {}));
      const c: Ctx = { request, env, ctx, url, session, viewer };
      const needLogin = () =>
        method === "GET" && !path.startsWith("/api/") ? redirect(`/auth/login?return=${encodeURIComponent(url.pathname + url.search)}`) : json({ error: "sign in required" }, 401);

      // ---- MCP OAuth: discovery, client registration, sign-in + approve, code → token ----
      const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization, mcp-protocol-version", "access-control-allow-methods": "GET, POST, OPTIONS" };
      if ((path.startsWith("/.well-known/oauth-") || path.startsWith("/oauth/")) && method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
      if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") return json(oauth.protectedResource(url.origin), 200, cors);
      if (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/openid-configuration") return json(oauth.authorizationServer(url.origin), 200, cors);
      if (path === "/oauth/register" && method === "POST") {
        try {
          return json(await oauth.register(env, (await request.json().catch(() => ({}))) as Record<string, unknown>), 201, cors);
        } catch (e) {
          return json({ error: e instanceof oauth.OAuthError ? e.code : "invalid_client_metadata", error_description: e instanceof Error ? e.message : String(e) }, 400, cors);
        }
      }
      if (path === "/oauth/token" && method === "POST") {
        const ct = request.headers.get("content-type") ?? "";
        const f = ct.includes("json") ? ((await request.json().catch(() => ({}))) as Record<string, string>) : Object.fromEntries(new URLSearchParams(await request.text()));
        try {
          return json(await oauth.exchange(env, f), 200, { ...cors, "cache-control": "no-store" });
        } catch (e) {
          return json({ error: e instanceof oauth.OAuthError ? e.code : "invalid_request", error_description: e instanceof Error ? e.message : String(e) }, 400, cors);
        }
      }
      if (path === "/oauth/authorize" && method === "GET") {
        if (!viewer || viewer.via === "agent") return redirect(`/auth/login?return=${encodeURIComponent(url.pathname + url.search)}`);
        try {
          const r = await oauth.startAuthorize(env, viewer.name, url.searchParams);
          return consentPage(viewer, r.id, r.client.name, new URL(r.redirect).host);
        } catch (e) {
          return messagePage("Can't connect", e instanceof Error ? e.message : String(e), { viewer, status: 400, action: { href: "/", label: "Your boards" } });
        }
      }
      if (path === "/oauth/authorize" && method === "POST") {
        if (!viewer || viewer.via === "agent") return needLogin();
        const f = new URLSearchParams(await request.text());
        try {
          return redirect(await oauth.finishAuthorize(env, viewer.name, f.get("request_id") ?? "", f.get("allow") === "1"));
        } catch (e) {
          return messagePage("Can't connect", e instanceof Error ? e.message : String(e), { viewer, status: 400, action: { href: "/", label: "Your boards" } });
        }
      }

      // ---- auth ----
      if (path === "/auth/login" && method === "GET") return authLogin(c);
      if (path === "/auth/callback" && method === "GET") return authCallback(c);
      if (path === "/auth/sso" && method === "GET") return authSso(c);
      if (path === "/welcome") return welcome(c);
      if (path === "/auth/logout" && method === "POST") {
        await auth.deleteSession(request, env);
        return redirect("/", { "Set-Cookie": auth.cookieHeader(url, auth.SESSION_COOKIE, "", 0) });
      }

      // ---- CLI login (device flow) ----
      if (path === "/api/device/start" && method === "POST") {
        const body = (await request.json().catch(() => ({}))) as { client?: string };
        return json(await device.startDeviceLogin(env, url.origin, String(body.client ?? "Agent Soup CLI")));
      }
      if (path === "/api/device/token" && method === "POST") {
        const body = (await request.json().catch(() => ({}))) as { device_code?: string };
        if (!body.device_code) return json({ error: "device_code required" }, 400);
        const r = await device.pollDeviceLogin(env, body.device_code);
        return json(r, r.status === "ok" ? 200 : r.status === "pending" ? 428 : 400);
      }
      if (path === "/device" && method === "GET") {
        if (!viewer) return needLogin();
        const code = device.normalizeUserCode(url.searchParams.get("code"));
        const d = code ? await device.deviceByUserCode(env, code) : null;
        const side = await sideBoards(env, viewer.name);
        return devicePage(viewer, side, code, d);
      }
      if (path === "/api/device/decide" && method === "POST") {
        if (!viewer) return needLogin();
        const body = (await request.json().catch(() => ({}))) as { user_code?: string; approve?: boolean | string };
        const code = device.normalizeUserCode(body.user_code);
        if (!code) return json({ error: "That code doesn't look right. It's 8 letters, like BCDF-GHJK." }, 400);
        const approve = body.approve === true || body.approve === "true";
        const r = await device.decideDeviceLogin(env, code, viewer.name, approve);
        if (r === "not_found") return json({ error: "No sign-in is waiting for that code." }, 404);
        if (r === "expired") return json({ error: "That code expired. Run agent-soup login again." }, 410);
        if (r === "already") return json({ error: "That code was already used." }, 409);
        return json({ ok: true, approved: approve, message: approve ? "Approved. You can go back to your terminal." : "Denied. Nothing was signed in." });
      }

      // ---- pages ----
      if (path === "/" && method === "GET") {
        if (session && !session.user) return redirect("/welcome");
        if (!viewer) return landingPage();
        const me = await registry.userByName(env, viewer.name);
        const [side, boards, invitations, status] = await Promise.all([
          sideBoards(env, viewer.name),
          registry.boardsOverview(env, viewer.name),
          me ? registry.invitationsFor(env, me) : [],
          registry.agentStatus(env, viewer.name),
        ]);
        return homePage(viewer, side, boards, invitations, { connected: status.connected, onThisBoard: false });
      }

      if (path === "/boards" && method === "POST") {
        if (!viewer) return needLogin();
        const form = await request.formData();
        const title = String(form.get("title") ?? "").trim().slice(0, 120);
        if (!title) return redirect("/?new=1");
        try {
          const info = await createBoard(env, title, viewer.name, url.origin, { encrypted: form.get("encrypted") === "1" || form.get("encrypted") === "on" });
          return redirect(`/b/${info.id}`);
        } catch (e) {
          const plan = e instanceof billing.BillingError;
          return messagePage(plan ? "Free plan limit" : "Board not created", e instanceof Error ? e.message.replace(/: https?:\S+$/, ".") : String(e), {
            viewer,
            status: plan ? 402 : 400,
            action: plan ? { href: "/me#billing", label: "See plans" } : { href: "/?new=1", label: "Try again" },
          });
        }
      }

      let m = path.match(/^\/(b|join)\/([^/]+)$/);
      if (m && method === "GET") {
        if (m[1] === "join") return redirect(`/b/${m[2]}`);
        if (!viewer) return needLogin();
        if (!(await canSee(c, m[2]))) return notFound(viewer);
        const [snap, members, invites, side, live, status] = await Promise.all([
          boardStub(env, m[2]).snapshot(0, { latest: 300 }),
          registry.boardMembers(env, m[2]),
          registry.pendingInvites(env, m[2]),
          sideBoards(env, viewer.name),
          registry.agentsOnBoard(env, m[2]),
          registry.agentStatus(env, viewer.name),
        ]);
        const withAgents = members.map((x) => ({ ...x, agent_seen: live[x.user] ?? null }));
        // People who already have an account show by name, so a friend invited by name never has their email shown.
        const named = await Promise.all(invites.map(async (i) => ((await registry.userByEmail(env, i.email))?.name ?? null)));
        const shown = invites.map((i, k) => (named[k] ? { ...i, email: named[k]!, email_status: "waiting to accept" } : i));
        return boardPage(viewer, side, snap.info, withAgents, snap.entries, shown, { connected: status.connected, onThisBoard: !!live[viewer.name] }, snap.summary);
      }

      // ---- inbox: mentions of you, posts for your agent, replies to you ----
      if (path === "/inbox" && method === "GET") {
        if (!viewer) return needLogin();
        const [side, items] = await Promise.all([sideBoards(env, viewer.name), inbox.listInbox(env, viewer.name)]);
        return inbox.inboxPage(viewer, side, items);
      }
      if (path === "/api/inbox" && method === "GET") {
        if (!viewer) return needLogin();
        return json({ items: await inbox.listInbox(env, viewer.name, 50) });
      }
      if (path === "/api/inbox/count" && method === "GET") {
        if (!viewer) return needLogin();
        return json(await inbox.inboxCount(env, viewer.name), 200, { "cache-control": "no-store" });
      }
      if (path === "/api/inbox/read" && method === "POST") {
        if (!viewer) return needLogin();
        const body = (await request.json().catch(() => ({}))) as { all?: unknown; board?: string; ids?: unknown };
        const ids = Array.isArray(body.ids) ? body.ids.map(Number) : undefined;
        const n = await inbox.markRead(env, viewer.name, { all: body.all === true || body.all === "1", board: typeof body.board === "string" ? body.board : undefined, ids });
        return json({ ok: true, read: n });
      }

      // ---- billing: Stripe Checkout and portal (hosted), webhook keeps plans in sync ----
      if (path === "/stripe/webhook" && method === "POST") {
        const raw = await request.text();
        if (!(await billing.verifySignature(raw, request.headers.get("stripe-signature"), env.STRIPE_WEBHOOK_SECRET ?? ""))) return json({ error: "bad signature" }, 400);
        try {
          return json({ ok: true, applied: await billing.applyEvent(env, JSON.parse(raw)) });
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }
      if ((path === "/api/billing/checkout" || path === "/api/billing/portal") && method === "POST") {
        if (!viewer) return needLogin();
        const body = (await request.json().catch(() => ({}))) as { interval?: string };
        try {
          const to =
            path === "/api/billing/portal"
              ? await billing.portalUrl(env, viewer.name, url.origin)
              : await billing.checkoutUrl(env, viewer.name, body.interval === "year" ? "year" : "month", url.origin);
          return json({ url: to });
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }

      // ---- agent webhooks (signed POSTs when something is addressed to your agent) ----
      if (path === "/__webhook-sink" && env.ALLOW_LOCAL_WEBHOOKS === "1") {
        if (method === "POST") {
          webhooks.sink.push({ headers: Object.fromEntries(request.headers), body: await request.text() });
          if (webhooks.sink.length > 50) webhooks.sink.shift();
          return json({ ok: true });
        }
        return json({ deliveries: webhooks.sink });
      }
      if (path === "/api/webhooks" && (method === "GET" || method === "POST")) {
        if (!viewer || viewer.via === "agent") return needLogin();
        if (method === "GET") return json({ webhooks: await webhooks.listWebhooks(env, viewer.name) });
        const body = (await request.json().catch(() => ({}))) as { url?: string };
        try {
          return json({ ok: true, ...(await webhooks.addWebhook(env, viewer.name, String(body.url ?? ""))) }, 201);
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }
      m = path.match(/^\/api\/webhooks\/(\d+)(\/test)?$/);
      if (m && (method === "DELETE" || (method === "POST" && m[2]))) {
        if (!viewer || viewer.via === "agent") return needLogin();
        const hid = parseInt(m[1], 10);
        if (method === "DELETE") return (await webhooks.removeWebhook(env, viewer.name, hid)) ? json({ ok: true }) : json({ error: "not found" }, 404);
        const mine = (await webhooks.listWebhooks(env, viewer.name)).find((w) => w.id === hid);
        if (!mine) return json({ error: "not found" }, 404);
        await webhooks.deliver(env, [viewer.name], (u) => ({ event: "ping", note: "A test delivery from Agent Soup.", you: u }), hid);
        return json({ ok: true, webhook: (await webhooks.listWebhooks(env, viewer.name)).find((w) => w.id === hid) });
      }

      // ---- sealed secrets: public keys per CLI login; envelopes only their recipient can fetch ----
      if (path === "/api/me/keys" && (method === "GET" || method === "POST")) {
        if (!viewer) return needLogin();
        if (method === "GET") return json({ keys: (await env.DB.prepare(`SELECT id, public_key, label, created_at FROM agent_keys WHERE user = ? AND revoked_at IS NULL ORDER BY created_at`).bind(viewer.name).all()).results });
        const b = (await request.json().catch(() => ({}))) as { public_key?: string; label?: string };
        const pk = String(b.public_key ?? "");
        if (!/^[A-Za-z0-9+/]{43}=$/.test(pk)) return json({ error: "public_key must be a base64 X25519 key (32 bytes)." }, 400);
        const existing = await env.DB.prepare(`SELECT id FROM agent_keys WHERE user = ? AND public_key = ? AND revoked_at IS NULL`).bind(viewer.name, pk).first<{ id: string }>();
        if (existing) return json({ ok: true, id: existing.id });
        const n = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM agent_keys WHERE user = ? AND revoked_at IS NULL`).bind(viewer.name).first<{ n: number }>())?.n ?? 0;
        if (n >= 10) return json({ error: "At most 10 machines; remove one first." }, 400);
        const kid = crypto.randomUUID().slice(0, 8);
        await env.DB.prepare(`INSERT INTO agent_keys (id, user, public_key, label, created_at) VALUES (?, ?, ?, ?, ?)`).bind(kid, viewer.name, pk, String(b.label ?? "").slice(0, 60) || null, Date.now()).run();
        return json({ ok: true, id: kid }, 201);
      }
      let km = path.match(/^\/api\/keys\/([a-z0-9][a-z0-9_.-]{0,31})$/);
      if (km && method === "GET") {
        if (!viewer) return needLogin();
        // Anyone you share a board with (sealing needs a shared board anyway).
        const shared = await env.DB.prepare(`SELECT 1 AS x FROM members m1 JOIN members m2 ON m1.board_id = m2.board_id WHERE m1.user = ? AND m2.user = ? LIMIT 1`).bind(viewer.name, km[1]).first();
        if (!shared && km[1] !== viewer.name) return json({ error: "You don't share a board with them." }, 404);
        return json({ keys: (await env.DB.prepare(`SELECT id, public_key, label, created_at FROM agent_keys WHERE user = ? AND revoked_at IS NULL`).bind(km[1]).all()).results });
      }
      km = path.match(/^\/api\/boards\/(b_[a-z0-9]+)\/keys$/);
      if (km && method === "GET") {
        if (!viewer) return needLogin();
        if (!(await registry.isMember(env, km[1], viewer.name))) return json({ error: "board not found" }, 404);
        const rows = (await env.DB.prepare(`SELECT k.id, k.user, k.public_key FROM agent_keys k JOIN members m ON m.user = k.user WHERE m.board_id = ? AND k.revoked_at IS NULL`).bind(km[1]).all<{ id: string; user: string; public_key: string }>()).results;
        const members = (await registry.boardMembers(env, km[1])).map((x) => x.user);
        return json({ keys: rows, without_keys: members.filter((u) => !rows.some((r) => r.user === u)) });
      }
      km = path.match(/^\/api\/boards\/(b_[a-z0-9]+)\/sealed(?:\/(\d+))?$/);
      if (km) {
        if (!viewer) return needLogin();
        if (!(await registry.isMember(env, km[1], viewer.name))) return json({ error: "board not found" }, 404);
        const stub = boardStub(env, km[1]);
        try {
          if (method === "POST" && !km[2]) {
            const b = (await request.json().catch(() => ({}))) as { to?: string; note?: string; payload?: string; type?: string; reply_to?: number };
            const note = String(b.note ?? "");
            const hit = scanFields({ note });
            if (hit) return json({ error: blockedMessage(hit) }, 400);
            if ((await registry.memberRole(env, km[1], viewer.name)) === "viewer") return json({ error: "Your role on this board is viewer." }, 403);
            const e = await stub.postSealed(viewer.name, { to: b.to ? String(b.to) : null, note, payload: String(b.payload ?? ""), type: b.type, reply_to: Number(b.reply_to) || null }, { via: pv(), client: viewer.via === "agent" ? "agent-soup CLI" : null });
            ctx.waitUntil(registry.bumpBoard(env, km[1], e.seq).catch(() => {}));
            return json({ ok: true, entry: e }, 201);
          }
          if (method === "GET" && km[2]) return json(await stub.sealedFor(viewer.name, parseInt(km[2], 10)));
          if (method === "GET" && !km[2]) return json({ entries: await stub.sealedAfter(parseInt(url.searchParams.get("after") ?? "0", 10) || 0) });
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
        return json({ error: "not found" }, 404);
      }

      // ---- approvals: agents ask their person before side effects; decisions only from a browser ----
      if (path === "/approvals" && method === "GET") {
        if (!viewer) return needLogin();
        const [side, list] = await Promise.all([sideBoards(env, viewer.name), approvals.listApprovals(env, viewer.name, "all")]);
        const titles = Object.fromEntries(side.map((b) => [b.id, b.title]));
        ctx.waitUntil(env.DB.prepare(`UPDATE notifications SET read_at = ? WHERE user = ? AND kind = 'approval' AND read_at IS NULL`).bind(Date.now(), viewer.name).run().catch(() => {}));
        return approvalsPage(viewer, side, list, titles);
      }
      let am = path.match(/^\/api\/approvals(?:\/(ap_[A-Za-z0-9_-]+))?(?:\/(approve|reject))?$/);
      if (am) {
        if (!viewer) return needLogin();
        try {
          if (method === "GET" && !am[1]) return json({ approvals: await approvals.listApprovals(env, viewer.name, url.searchParams.get("all") ? "all" : "pending") });
          if (method === "GET" && am[1] && !am[2]) {
            const a = await approvals.getApproval(env, viewer.name, am[1]);
            return a ? json({ approval: a }) : json({ error: "not found" }, 404);
          }
          if (method === "POST" && am[1] && am[2]) {
            // A token (an agent, or the CLI an agent could run) never decides: only the person in a browser.
            if (viewer.via === "agent") return json({ error: `Approve or reject in the browser: ${url.origin}/approvals#${am[1]}` }, 403);
            const b = (await request.json().catch(() => ({}))) as { note?: string };
            return json({ ok: true, approval: await approvals.decide(env, viewer.name, am[1], am[2] === "approve", String(b.note ?? "")) });
          }
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
        return json({ error: "not found" }, 404);
      }

      // ---- social: people, friends, presence, direct boards ----
      if (path === "/people" && method === "GET") {
        if (!viewer) return needLogin();
        const [side, friends] = await Promise.all([sideBoards(env, viewer.name), social.friendsOf(env, viewer.name)]);
        return peoplePage(viewer, side, friends);
      }
      let um = path.match(/^\/u\/([a-z0-9][a-z0-9_.-]{0,31})$/);
      if (um && method === "GET") {
        if (!viewer) return needLogin();
        const [side, p] = await Promise.all([sideBoards(env, viewer.name), social.person(env, viewer.name, um[1])]);
        if (!p) return notFound(viewer);
        return profilePage(viewer, side, p, social.presenceLabel(p.presence));
      }
      if (path === "/api/me/profile" && (method === "GET" || method === "POST")) {
        if (!viewer) return needLogin();
        if (method === "GET") return json({ profile: await social.profile(env, viewer.name) });
        const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const hit = scanFields({ bio: typeof b.bio === "string" ? b.bio : null, display_name: typeof b.display_name === "string" ? b.display_name : null });
        if (hit) return json({ error: blockedMessage(hit) }, 400);
        try {
          return json({ ok: true, profile: await social.setProfile(env, viewer.name, b) });
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }
      if (path.startsWith("/api/people") || path.startsWith("/api/friends") || path.startsWith("/api/direct/")) {
        if (!viewer) return needLogin();
        const me = viewer.name;
        const err = (e: unknown) => json({ error: e instanceof Error ? e.message : String(e) }, e instanceof social.SocialError ? 400 : 500);
        try {
          if (path === "/api/people" && method === "GET") return json({ people: await social.findPeople(env, me, url.searchParams.get("q") ?? "") });
          let pm = path.match(/^\/api\/people\/([a-z0-9][a-z0-9_.-]{0,31})$/);
          if (pm && method === "GET") {
            const p = await social.person(env, me, pm[1]);
            return p ? json({ person: p, presence: social.presenceLabel(p.presence) }) : json({ error: "not found" }, 404);
          }
          if (path === "/api/friends" && method === "GET") return json(await social.friendsOf(env, me));
          if (path === "/api/friends/request" && method === "POST") {
            const b = (await request.json().catch(() => ({}))) as { user?: string; note?: string };
            const note = String(b.note ?? "").trim();
            const hit = scanFields({ note });
            if (hit) return json({ error: blockedMessage(hit) }, 400);
            return json({ ok: true, relation: await social.requestFriend(env, me, String(b.user ?? ""), note) });
          }
          pm = path.match(/^\/api\/friends\/([a-z0-9][a-z0-9_.-]{0,31})\/(accept|decline|remove|block|unblock)$/);
          if (pm && method === "POST") {
            if (pm[2] === "accept") return json({ ok: true, relation: await social.acceptFriend(env, me, pm[1]) });
            if (pm[2] === "block") await social.blockPerson(env, me, pm[1]);
            else await social.removeFriend(env, me, pm[1]);
            return json({ ok: true });
          }
          pm = path.match(/^\/api\/direct\/([a-z0-9][a-z0-9_.-]{0,31})$/);
          if (pm && method === "POST") {
            const d = await social.directBoard(env, me, pm[1], (bid, title, creator) => boardStub(env, bid).init(bid, title, creator));
            const p = await social.person(env, me, pm[1]);
            return json({ ok: true, board: d.id, title: d.title, created: d.created, presence: p ? social.presenceLabel(p.presence) : "offline", online: p ? social.isOnline(p.presence) : false });
          }
        } catch (e) {
          return err(e);
        }
        return json({ error: "not found" }, 404);
      }

      // ---- profile pictures (people and their agents) ----
      m = path.match(/^\/avatar\/([a-z0-9][a-z0-9_.-]{0,31})$/);
      if (m && method === "GET") return avatars.avatarResponse(env, m[1], url.searchParams.get("k") === "agent" ? "agent" : "person");
      m = path.match(/^\/demo-avatar\/([a-z]{1,16})$/);
      if (m && method === "GET") return avatars.demoAvatarResponse(m[1], url.searchParams.get("k") === "agent" ? "agent" : "person");
      if (path === "/api/me/avatar" && (method === "POST" || method === "DELETE")) {
        if (!viewer || viewer.via === "agent") return json({ error: "Change pictures from your account page." }, 401);
        const kind = url.searchParams.get("kind") === "agent" ? "agent" : "person";
        try {
          if (method === "DELETE") await avatars.removeAvatar(env, viewer.name, kind);
          else await avatars.setAvatar(env, viewer.name, kind, await request.arrayBuffer());
          return json({ ok: true, kind });
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }

      if (path === "/me" && method === "GET") {
        if (!viewer) return needLogin();
        const [side, tokens, plan, hooks, prof] = await Promise.all([
          sideBoards(env, viewer.name),
          auth.listTokens(env, viewer.name),
          billing.planOf(env, viewer.name),
          webhooks.listWebhooks(env, viewer.name),
          social.profile(env, viewer.name),
        ]);
        return mePage(viewer, side, tokens, plan, !!env.STRIPE_SECRET_KEY, hooks, prof);
      }

      if (path === OPS_PATH && method === "GET") {
        if (!viewer?.admin) return notFound(viewer); // indistinguishable from a missing page unless you're an operator
        const [side, data] = await Promise.all([sideBoards(env, viewer.name), opsData(env)]);
        return adminPage(viewer, side, data);
      }

      // ---- rename / archive / restore a board (its creator, or an operator) ----
      m = path.match(/^\/api\/boards\/([^/]+)\/(rename|archive)$/);
      if (m && method === "POST") {
        if (!viewer && !hasOpsKey(c)) return needLogin();
        const board = BOARD_RE.test(m[1]) ? await registry.getBoard(env, m[1]) : null;
        if (!board || !(await canSee(c, m[1]))) return json({ error: "board not found" }, 404);
        if (!isOps(c) && board.created_by !== viewer?.name && (await registry.memberRole(env, board.id, viewer?.name ?? "")) !== "owner") return json({ error: "Only the board's owners can do that." }, 403);
        const body = (await request.json().catch(() => ({}))) as { title?: string; archived?: boolean | string };
        ctx.waitUntil(registry.audit(env, board.id, viewer?.name ?? "ops", m[2] === "rename" ? "renamed" : body.archived === true || body.archived === "true" ? "archived" : "restored", null, m[2] === "rename" ? String(body.title ?? "").slice(0, 120) : null).catch(() => {}));
        try {
          if (m[2] === "rename") {
            const info = await boardStub(env, board.id).rename(String(body.title ?? ""));
            await registry.renameBoard(env, board.id, info.title);
            return json({ ok: true, title: info.title, message: `Renamed to "${info.title}".` });
          }
          const on = body.archived === true || body.archived === "true";
          await boardStub(env, board.id).setArchived(on);
          await registry.setBoardArchived(env, board.id, on);
          return json({ ok: true, archived: on, message: on ? `Archived "${board.title}". It's read-only until restored.` : `Restored "${board.title}".` });
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }

      // ---- delete a board (its creator, or an operator); confirm by typing the title ----
      m = path.match(/^\/api\/boards\/([^/]+)\/delete$/);
      if (m && method === "POST") {
        if (!viewer && !hasOpsKey(c)) return needLogin();
        const board = BOARD_RE.test(m[1]) ? await registry.getBoard(env, m[1]) : null;
        if (!board || !(await canSee(c, m[1]))) return json({ error: "board not found" }, 404);
        if (!isOps(c) && board.created_by !== viewer?.name) return json({ error: "Only the board's creator can delete it." }, 403);
        const body = (await request.json().catch(() => ({}))) as { confirm?: string };
        if (String(body.confirm ?? "").trim() !== board.title) return json({ error: "Type the board's name exactly to confirm." }, 400);
        await registry.deleteBoard(env, board.id); // access ends here
        await boardStub(env, board.id).destroy(); // then the data
        return json({ ok: true, message: `Deleted "${board.title}".` });
      }

      // ---- access: viewers can read but not change anything on a board ----
      m = path.match(/^\/api\/boards\/(b_[a-z0-9]+)\/(.+)$/);
      if (m && method !== "GET" && viewer && !hasOpsKey(c) && !/^members\/[^/]+\/remove$/.test(m[2]) && m[2] !== "ws" && m[2] !== "seen") { // read receipts aren't changes
        if ((await registry.memberRole(env, m[1], viewer.name)) === "viewer") return json({ error: "You can view this board but not change it (your role is viewer). Ask an owner for contributor access." }, 403);
      }

      // ---- access management: roles, expiry, invite links, audit log ----
      m = path.match(/^\/api\/boards\/(b_[a-z0-9]+)\/(members|links|audit)(?:\/([^/]+))?$/);
      if (m && !(m[2] === "members" && method === "POST" && /\/remove$/.test(path))) {
        if (!viewer) return needLogin();
        const [, id, what, arg] = m;
        const myRole = await registry.memberRole(env, id, viewer.name);
        if (!myRole) return json({ error: "board not found" }, 404);
        const board = await registry.getBoard(env, id);
        const owner = myRole === "owner" || board?.created_by === viewer.name;
        try {
          if (what === "members" && method === "GET" && !arg) return json({ members: await registry.boardMembers(env, id), you: myRole });
          if (what === "audit" && method === "GET") return json({ audit: await registry.auditLog(env, id) });
          if (!owner) return json({ error: "Only the board's owners can manage access." }, 403);
          if (what === "members" && method === "POST" && arg) {
            const body = (await request.json().catch(() => ({}))) as { role?: string; expires_days?: number | string | null };
            if (arg === board?.created_by && body.role && body.role !== "owner") return json({ error: "The board's creator stays an owner." }, 400);
            if (!(await registry.memberRole(env, id, arg))) return json({ error: `${arg} isn't a member.` }, 404);
            const change: { role?: registry.Role; expires_at?: number | null } = {};
            if (body.role !== undefined) change.role = access.parseRole(body.role);
            if (body.expires_days !== undefined) {
              const d = Number(body.expires_days);
              change.expires_at = !body.expires_days || d <= 0 ? null : Date.now() + Math.min(365, Math.floor(d)) * 86_400_000;
            }
            await registry.setMemberAccess(env, id, arg, change);
            await registry.audit(env, id, viewer.name, "access_changed", arg, [change.role ? `role ${change.role}` : "", change.expires_at !== undefined ? (change.expires_at ? `until ${new Date(change.expires_at).toISOString().slice(0, 10)}` : "no end date") : ""].filter(Boolean).join(", "));
            return json({ ok: true, members: await registry.boardMembers(env, id) });
          }
          if (what === "links" && method === "GET") return json({ links: await access.listLinks(env, id) });
          if (what === "links" && method === "POST" && !arg) return json(await access.createLink(env, id, viewer.name, (await request.json().catch(() => ({}))) as Record<string, unknown>, url.origin), 201);
          if (what === "links" && method === "DELETE" && arg) return (await access.revokeLink(env, id, arg, viewer.name)) ? json({ ok: true }) : json({ error: "not found" }, 404);
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
        return json({ error: "not found" }, 404);
      }
      m = path.match(/^\/i\/(il_[A-Za-z0-9_-]+)$/);
      if (m && method === "GET") {
        if (!viewer) return needLogin();
        try {
          return redirect(`/b/${await access.redeemLink(env, m[1], viewer.name, url.origin)}`);
        } catch (e) {
          return messagePage("Invite link", e instanceof Error ? e.message.replace(/: https?:\S+$/, ".") : String(e), { viewer, status: 410, action: { href: "/", label: "Your boards" } });
        }
      }

      // ---- membership: the board's creator removes people; anyone else can leave ----
      m = path.match(/^\/api\/boards\/([^/]+)\/members\/([^/]+)\/remove$/);
      if (m && method === "POST") {
        if (!viewer) return needLogin();
        const [, id, who] = m;
        const board = BOARD_RE.test(id) ? await registry.getBoard(env, id) : null;
        if (!board || !(await registry.isMember(env, id, viewer.name))) return json({ error: "board not found" }, 404);
        const self = who === viewer.name;
        if (self && board.created_by === viewer.name) return json({ error: "You created this board, so you can't leave it." }, 400);
        if (!self && board.created_by !== viewer.name && (await registry.memberRole(env, id, viewer.name)) !== "owner") return json({ error: "Only the board's owners can remove people." }, 403);
        if (!self && who === board.created_by) return json({ error: "The board's creator can't be removed." }, 403);
        if (!(await registry.isMember(env, id, who))) return json({ error: `${who} isn't a member.` }, 404);
        await registry.removeMember(env, id, who);
        await boardStub(env, id).removeMember(who);
        ctx.waitUntil(registry.audit(env, id, viewer.name, self ? "left" : "removed", who).catch(() => {}));
        return json({ ok: true, left: self, message: self ? "You left the board." : `Removed ${who}.` });
      }

      // ---- board API (members; operators can read) ----
      // ---- live updates: WebSocket to the board's Durable Object (hibernates while idle) ----
      m = path.match(/^\/api\/boards\/([^/]+)\/ws$/);
      if (m && method === "GET") {
        if (request.headers.get("Upgrade") !== "websocket") return json({ error: "expected a WebSocket upgrade" }, 426);
        // Browsers authenticate with the session cookie; the CLI with its bearer token.
        const tok = auth.bearer(request);
        const who = viewer?.name ?? (tok ? (await auth.resolveToken(env, tok, ctx)).user : null);
        if (!who) return json({ error: "sign in required" }, 401);
        const role = await registry.memberRole(env, m[1], who);
        if (!role) return json({ error: "board not found" }, 404);
        return boardStub(env, m[1]).fetch(new Request(`https://board/ws?user=${encodeURIComponent(who)}&role=${role}`, request));
      }

      // ---- the signed-in person's boards (CLI uses its bearer token) ----
      if (path === "/api/me/boards" && method === "GET") {
        const tok = auth.bearer(request);
        const who = viewer?.name ?? (tok ? (await auth.resolveToken(env, tok, ctx)).user : null);
        if (!who) return json({ error: "sign in required" }, 401);
        // The watcher checks in here every few minutes: that's how friends see "answers in the background".
        const watching = request.headers.get("x-agent-soup-watch");
        if (watching) ctx.waitUntil(Promise.resolve(social.markSeen(env, who, "watch", watching === "respond")).catch(() => {}));
        const boards = await registry.boardsForUser(env, who);
        return json({ user: who, boards: boards.map((b) => ({ id: b.id, title: b.title, entry_count: b.entry_count, last_activity: b.last_activity, encrypted: !!(b as { encrypted?: number }).encrypted })) });
      }

      // ---- files: upload any file (members, from the web) and serve stored ones (anyone who can see the board) ----
      m = path.match(/^\/api\/boards\/([^/]+)\/(image|upload)$/);
      if (m) {
        const [, id, what] = m;
        if (!viewer && !hasOpsKey(c)) return needLogin();
        if (!(await canSee(c, id))) return json({ error: "board not found" }, 404);
        const stub = boardStub(env, id);
        if (what === "image" && method === "GET") {
          const v = url.searchParams.get("version");
          const img = await stub.image(url.searchParams.get("name") ?? "", v ? parseInt(v, 10) : undefined);
          if (!img) return new Response("Not found", { status: 404 });
          // Images are served inert (their own type, no sniffing, no script); everything else only as a download.
          const isImg = img.mime.startsWith("image/");
          const fname = (url.searchParams.get("name") ?? "file").replace(/[^\w.\- ]+/g, "_");
          return new Response(img.bytes, {
            headers: {
              "content-type": isImg ? img.mime : "application/octet-stream",
              "x-content-type-options": "nosniff",
              "content-security-policy": "default-src 'none'; sandbox",
              "content-disposition": isImg ? "inline" : `attachment; filename="${fname}"`,
              "cache-control": v ? "private, max-age=31536000, immutable" : "private, no-cache",
            },
          });
        }
        if (what === "upload" && method === "POST") {
          if (!viewer || !(await registry.isMember(env, id, viewer.name))) return json({ error: "Only members can post." }, 403);
          if (Number(request.headers.get("content-length") ?? 0) > MAX_IMAGE) return json({ error: `That file is too large (max ${MAX_IMAGE / 1e6} MB).` }, 413);
          const bytes = await request.arrayBuffer();
          const q = (k: string) => url.searchParams.get(k);
          const text = (q("text") ?? "").slice(0, 4000);
          const { mentions } = mayMention(text) ? parseMentions(text, (await registry.boardMembers(env, id)).map((x) => x.user), viewer.name, pv()) : { mentions: [] };
          try {
            const entry = await stub.postFile(viewer.name, { name: q("name") ?? "", bytes, width: Number(q("w")) || null, height: Number(q("h")) || null, text, mentions, via: pv() });
            ctx.waitUntil(Promise.all([registry.touch(env, viewer.name, id), registry.bumpBoard(env, id, entry.seq)]).catch(() => {}));
            return json({ ok: true, entry }, 201);
          } catch (e) {
            return json({ error: e instanceof Error ? e.message : String(e) }, 400);
          }
        }
        return json({ error: "not found" }, 404);
      }

      // ---- shared documents (members; operators can read) ----
      m = path.match(/^\/api\/boards\/([^/]+)\/(doc|docs|files|doc-history)$/);
      if (m) {
        const [, id, what] = m;
        if (!viewer && !hasOpsKey(c)) return needLogin();
        if (!(await canSee(c, id))) return json({ error: "board not found" }, 404);
        const stub = boardStub(env, id);
        const name = url.searchParams.get("name") ?? "";
        try {
          if ((what === "docs" || what === "files") && method === "GET") return json({ docs: await stub.docs() });
          if (what === "doc-history" && method === "GET") return json({ versions: await stub.docHistory(name) });
          if (what === "doc" && method === "GET") {
            const v = url.searchParams.get("version");
            const d = await stub.docRead(name, v ? parseInt(v, 10) : undefined);
            // Prose (Markdown, plain text) is rendered; anything else (logs, code, JSON…) shows as it is, in monospace.
            const prose = !/\.[a-z0-9]+$/i.test(d.name) || /\.(md|markdown|txt)$/i.test(d.name);
            return json({ ...d, html: prose ? renderText(d.content) : `<pre class="doc-code mono">${esc(d.content)}</pre>` });
          }
          if (what === "doc" && method === "POST") {
            if (!viewer || !(await registry.isMember(env, id, viewer.name))) return json({ error: "Only members can edit." }, 403);
            const body = (await request.json().catch(() => ({}))) as {
              action?: string;
              name?: string;
              content?: string;
              base_version?: number | string;
              old_str?: string;
              new_str?: string;
              summary?: string;
            };
            const opts = { via: pv(), summary: body.summary ?? null };
            const r =
              body.action === "edit"
                ? await stub.docEdit(viewer.name, String(body.name ?? ""), String(body.old_str ?? ""), String(body.new_str ?? ""), opts)
                : await stub.docWrite(viewer.name, String(body.name ?? ""), String(body.content ?? ""), Number(body.base_version ?? -1), opts);
            if (r.conflict) return json({ error: `Someone saved v${r.current} while you were editing. Copy your changes, reload, and apply them again.`, current: r.current }, 409);
            ctx.waitUntil(registry.bumpBoard(env, id, r.note).catch(() => {}));
            return json({ ok: true, version: r.version, message: `Saved v${r.version}` });
          }
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
        return json({ error: "not found" }, 404);
      }

      // ---- react to an entry (toggle); GET lists every reaction on the board ----
      m = path.match(/^\/api\/boards\/([^/]+)\/(?:entries\/(\d+)\/react|reactions)$/);
      if (m && (method === "POST" || method === "GET")) {
        if (!viewer) return needLogin();
        if (!(await registry.isMember(env, m[1], viewer.name))) return json({ error: "board not found" }, 404);
        const stub = boardStub(env, m[1]);
        if (method === "GET" && !m[2]) return json({ reactions: await stub.reactions() });
        if (method === "POST" && m[2]) {
          const body = (await request.json().catch(() => ({}))) as { emoji?: string };
          try {
            return json(await stub.react(viewer.name, parseInt(m[2], 10), String(body.emoji ?? "")));
          } catch (e) {
            return json({ error: e instanceof Error ? e.message : String(e) }, 400);
          }
        }
        return json({ error: "not found" }, 404);
      }

      // ---- board details (any member edits) and search across your boards ----
      m = path.match(/^\/api\/boards\/(b_[a-z0-9]+)\/retention$/);
      if (m && method === "POST") {
        if (!viewer) return needLogin();
        const board = await registry.getBoard(env, m[1]);
        if (!board || ((await registry.memberRole(env, m[1], viewer.name)) !== "owner" && board.created_by !== viewer.name)) return json({ error: "Only the board's owners can set how long it keeps messages." }, 403);
        const b = (await request.json().catch(() => ({}))) as { days?: number | string | null };
        const days = b.days == null || b.days === "" || Number(b.days) === 0 ? null : Math.floor(Number(b.days));
        if (days != null && (!Number.isFinite(days) || days < 1 || days > 3650)) return json({ error: "days must be 1–3650, or empty to keep everything." }, 400);
        const creator = await registry.userByName(env, board.created_by);
        const pol = creator?.email ? await orgPolicy(env, creator.email) : null;
        if (pol?.max_retention_days && (days == null || days > pol.max_retention_days)) return json({ error: `${pol.domain} keeps messages at most ${pol.max_retention_days} days.` }, 400);
        await env.DB.prepare(`UPDATE boards SET retention_days = ? WHERE id = ?`).bind(days, m[1]).run();
        await registry.audit(env, m[1], viewer.name, "retention", null, days ? `keep ${days} days` : "keep everything");
        const pruned = days ? await boardStub(env, m[1]).prune(Date.now() - days * 86_400_000) : 0;
        return json({ ok: true, retention_days: days, pruned });
      }
      m = path.match(/^\/api\/boards\/([^/]+)\/meta$/);
      if (m && method === "POST") {
        if (!viewer) return needLogin();
        if (!(await registry.isMember(env, m[1], viewer.name))) return json({ error: "board not found" }, 404);
        try {
          const meta = parseBoardMeta(await request.json().catch(() => ({})));
          const hit = scanFields({ description: meta.description, tags: meta.tags.join(" "), links: meta.links.map((l) => `${l.label} ${l.url}`).join("\n") });
          if (hit) return json({ error: blockedMessage(hit) }, 400);
          await registry.setBoardMeta(env, m[1], meta);
          return json({ ok: true, meta });
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }
      if (path === "/api/boards/search" && method === "GET") {
        if (!viewer) return needLogin();
        const q = (url.searchParams.get("q") ?? "").trim().slice(0, 200);
        if (!q) return json({ boards: [], hits: [] });
        const all = await registry.boardsOverview(env, viewer.name);
        const needle = q.toLowerCase();
        const boards = all
          .filter((b) => [b.title, b.description ?? "", b.tags ?? ""].join(" ").toLowerCase().includes(needle))
          .map((b) => b.id);
        // Content: ranked search inside the 25 most recently active boards, in parallel.
        const hits = (
          await Promise.all(
            all.slice(0, 25).map(async (b) => {
              try {
                const r = await boardStub(env, b.id).rankedSearch(q, { limit: 3 });
                return [
                  ...r.files.slice(0, 2).map((f) => ({ board: b.id, title: b.title, kind: "file", name: f.name, version: f.version, snippet: f.snippet })),
                  ...r.entries.map((x) => ({ board: b.id, title: b.title, kind: "entry", seq: x.entry.seq, author: x.entry.author, via: x.entry.via ?? null, snippet: x.snippet || x.entry.text.slice(0, 160) })),
                ];
              } catch {
                return [];
              }
            }),
          )
        ).flat();
        return json({ boards, hits: hits.slice(0, 40) }, 200, { "cache-control": "no-store" });
      }

      // ---- claims: every claim's status, evidence and check (the CLI's verify reads this) ----
      m = path.match(/^\/api\/boards\/([^/]+)\/claims$/);
      if (m && method === "GET") {
        if (!viewer) return needLogin();
        if (!(await registry.isMember(env, m[1], viewer.name))) return json({ error: "board not found" }, 404);
        return json({ claims: await boardStub(env, m[1]).claims() }, 200, { "cache-control": "no-store" });
      }

      // ---- voice: short-lived relay (TURN) credentials so calls connect on networks that block peer-to-peer ----
      m = path.match(/^\/api\/boards\/([^/]+)\/voice\/ice$/);
      if (m && method === "GET") {
        if (!viewer) return needLogin();
        if (!(await registry.isMember(env, m[1], viewer.name))) return json({ error: "board not found" }, 404);
        return json({ iceServers: await voiceIceServers(env) }, 200, { "cache-control": "no-store" });
      }

      // ---- claims (web): verify, dispute or add evidence as a person (status arrives with updates) ----
      m = path.match(/^\/api\/boards\/([^/]+)\/claims\/(\d+)$/);
      if (m) {
        if (!viewer) return needLogin();
        if (!(await registry.isMember(env, m[1], viewer.name))) return json({ error: "board not found" }, 404);
        const stub = boardStub(env, m[1]);
        if (method === "POST") {
          const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
          const s = (k: string) => (typeof b[k] === "string" && (b[k] as string).trim() ? (b[k] as string).trim() : undefined);
          const action = (["evidence", "verify", "dispute", "check"] as const).find((a) => a === b.action);
          if (!action) return json({ error: "action must be evidence, verify, dispute or check." }, 400);
          try {
            const message = await stub.claimAct(viewer.name, parseInt(m[2], 10), { action, evidence_seq: typeof b.evidence_seq === "number" ? b.evidence_seq : undefined, url: s("url"), note: s("note"), reason: s("reason"), command: s("command"), commit: s("commit") }, { via: pv() });
            return json({ ok: true, message });
          } catch (e) {
            return json({ error: e instanceof Error ? e.message : String(e) }, 400);
          }
        }
        return json({ error: "not found" }, 404);
      }

      // ---- tasks board (web): list, and act on one task as a person ----
      m = path.match(/^\/api\/boards\/([^/]+)\/tasks(?:\/(\d+))?$/);
      if (m) {
        if (!viewer) return needLogin();
        if (!(await registry.isMember(env, m[1], viewer.name))) return json({ error: "board not found" }, 404);
        const stub = boardStub(env, m[1]);
        if (method === "GET" && !m[2]) return json({ tasks: await stub.tasks() });
        if (method === "GET" && m[2]) {
          try {
            const seq = parseInt(m[2], 10);
            const [task, history] = await Promise.all([stub.taskGet(seq), stub.taskHistory(seq)]);
            return json({ task, history });
          } catch (e) {
            return json({ error: e instanceof Error ? e.message : String(e) }, 404);
          }
        }
        if (method === "POST" && !m[2]) {
          const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
          try {
            const t = await stub.taskCreate(
              viewer.name,
              { title: String(b.title ?? ""), body: typeof b.body === "string" ? b.body : "", priority: (["high", "medium", "low"] as const).find((p) => p === b.priority) ?? null },
              { via: pv() },
            );
            ctx.waitUntil(registry.bumpBoard(env, m[1], t.seq).catch(() => {}));
            return json({ ok: true, task: t }, 201);
          } catch (e) {
            return json({ error: e instanceof Error ? e.message : String(e) }, 400);
          }
        }
        if (method === "POST" && m[2]) {
          const seq = parseInt(m[2], 10);
          const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
          const s = (k: string) => (typeof b[k] === "string" ? (b[k] as string).trim() : undefined);
          const opts = { via: pv() };
          try {
            let t;
            if (b.action === "edit")
              t = await stub.taskEdit(
                viewer.name,
                seq,
                {
                  title: typeof b.title === "string" ? b.title : undefined,
                  body: typeof b.body === "string" ? b.body : undefined,
                  base_version: typeof b.base_version === "number" ? b.base_version : undefined,
                  summary: s("summary"),
                },
                opts,
              );
            else if (b.action === "claim") t = await stub.taskClaim(viewer.name, seq, Number(b.minutes) || 60, opts);
            else if (b.action === "release") t = await stub.taskRelease(viewer.name, seq, opts);
            else if (b.action === "stop") t = await stub.taskStop(viewer.name, seq, s("reason") ?? "", opts);
            else if (b.action === "update") {
              const due = s("due");
              t = await stub.taskUpdate(
                viewer.name,
                seq,
                {
                  status: s("status") as "todo" | "doing" | "blocked" | "done" | undefined,
                  assignee: b.assignee === undefined ? undefined : s("assignee") || null,
                  assignee_agent: b.assignee_is_person === true ? false : true,
                  due: due === undefined ? undefined : due === "" ? null : Date.parse(due + "T23:59:00Z") || undefined,
                  priority: b.priority === undefined ? undefined : ((s("priority") as "high" | "medium" | "low") || null),
                  note: s("note") ?? null,
                },
                opts,
              );
            } else return json({ error: "action must be claim, release, update or stop" }, 400);
            ctx.waitUntil(registry.bumpBoard(env, m[1], 0).catch(() => {}));
            return json({ ok: true, task: t });
          } catch (e) {
            return json({ error: e instanceof Error ? e.message : String(e) }, 400);
          }
        }
        return json({ error: "not found" }, 404);
      }

      // ---- review a change card as a person (approve / request_changes / comment) ----
      m = path.match(/^\/api\/boards\/([^/]+)\/entries\/(\d+)\/review$/);
      if (m && method === "POST") {
        if (!viewer) return needLogin();
        if (!(await registry.isMember(env, m[1], viewer.name))) return json({ error: "board not found" }, 404);
        const body = (await request.json().catch(() => ({}))) as { verdict?: string; note?: string };
        try {
          const r = await boardStub(env, m[1]).review(viewer.name, parseInt(m[2], 10), String(body.verdict ?? "") as "approve", String(body.note ?? ""), { via: pv() });
          ctx.waitUntil(registry.bumpBoard(env, m[1], r.entry.seq).catch(() => {}));
          return json({ ok: true, entry: r.entry, state: r.state }, 201);
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }

      // ---- retract an entry (its author or the board's creator) ----
      m = path.match(/^\/api\/boards\/([^/]+)\/entries\/(\d+)\/retract$/);
      if (m && method === "POST") {
        if (!viewer) return needLogin();
        if (!(await registry.isMember(env, m[1], viewer.name))) return json({ error: "board not found" }, 404);
        const body = (await request.json().catch(() => ({}))) as { reason?: string };
        const seq = parseInt(m[2], 10);
        try {
          const entry = await boardStub(env, m[1]).post(viewer.name, {
            type: "note",
            text: String(body.reason ?? "").trim() || `Unsent #${seq}.`,
            retracts: seq,
            via: pv(),
          });
          ctx.waitUntil(registry.bumpBoard(env, m[1], entry.seq).catch(() => {}));
          return json({ ok: true, entry }, 201);
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }

      m = path.match(/^\/api\/boards\/([^/]+)\/(updates|entries|invites|seen|search)(?:\/(\d+))?$/);
      if (m) {
        const [, id, what, seqStr] = m;
        if (!viewer && !hasOpsKey(c)) return needLogin();
        if (!(await canSee(c, id))) return json({ error: "board not found" }, 404);
        const stub = boardStub(env, id);

        if (what === "updates" && method === "GET") {
          const after = Math.max(0, parseInt(url.searchParams.get("after") ?? "0", 10) || 0);
          // Long-poll (wait=seconds) so an open board tab costs one request per change or per ~25s, not one every few seconds.
          const waitSec = Math.min(25, Math.max(0, parseInt(url.searchParams.get("wait") ?? "0", 10) || 0));
          if (waitSec) await stub.waitForAny(after, waitSec * 1000);
          // Only entries after `after` (up to 1000 per call; the client advances and asks again), roots resolved in the DO.
          const [snap, members0, live] = await Promise.all([stub.snapshot(after), registry.boardMembers(env, id), registry.agentsOnBoard(env, id)]);
          const members = members0.map((x) => ({ ...x, agent_seen: live[x.user] ?? null }));
          const fresh = snap.entries;
          const roots = await stub.rootsFor(fresh.map((e) => e.seq));
          const canRetract = (e: Entry) => !!viewer && (e.author === viewer.name || snap.info.created_by === viewer.name);
          return json({
            entries: fresh.map((e) => ({
              seq: e.seq,
              root: roots[e.seq] ?? e.seq,
              retracts: e.retracts,
              html: entryHtml(e, id, true, { canRetract: canRetract(e) }),
              row: logRow(e),
              reactions: snap.reactions[e.seq] ?? [],
              ...(e.type === "change" ? { reviews: snap.reviews[e.seq] ?? [] } : {}),
              ...(snap.claims[e.seq] ? { claim: snap.claims[e.seq] } : {}),
            })),
            ...(after === 0 ? { reactions: snap.reactions } : {}),
            reviews: snap.reviews, // every card's current verdicts (small), so open tabs can update cards above the fold
            claims: snap.claims, // every claim's status and every stale entry, same idea
            reads: snap.reads, // how far each member has seen, as a person and through their agent (read receipts)
            summary: summaryHtml([], viewer?.name ?? "", members, snap.summary, { boardId: id, creator: snap.info.created_by }),
            count: snap.info.entry_count,
            last: fresh.length ? fresh[fresh.length - 1].seq : after,
          });
        }
        if (what === "entries" && !seqStr && method === "GET" && url.searchParams.has("after")) {
          // Plain JSON for SDKs and scripts: entries after N (oldest first), optionally waiting up to 25s for new ones.
          const after = Math.max(0, parseInt(url.searchParams.get("after") ?? "0", 10) || 0);
          const waitSec = Math.min(25, Math.max(0, parseInt(url.searchParams.get("wait") ?? "0", 10) || 0));
          if (waitSec) await stub.waitForAny(after, waitSec * 1000);
          const snap = await stub.snapshot(after);
          const list = snap.entries.slice(0, Math.min(500, parseInt(url.searchParams.get("limit") ?? "200", 10) || 200));
          return json({ entries: list, last: list.length ? list[list.length - 1].seq : after });
        }
        if (what === "entries" && !seqStr && method === "GET") {
          // Earlier entries for "Load earlier messages", rendered like live updates.
          const before = parseInt(url.searchParams.get("before") ?? "0", 10) || null;
          const page = await stub.page(before, parseInt(url.searchParams.get("limit") ?? "100", 10) || 100);
          const seqs = page.map((e) => e.seq);
          const [isOwner, roots, reactions] = await Promise.all([
            viewer ? registry.memberRole(env, id, viewer.name).then((r) => r === "owner") : false,
            stub.rootsFor(seqs),
            stub.reactionsFor(seqs),
          ]);
          return json({
            first: page.length ? page[0].seq : 0,
            entries: page.map((e) => ({
              seq: e.seq,
              root: roots[e.seq] ?? e.seq,
              html: entryHtml(e, id, true, { canRetract: !!viewer && (e.author === viewer.name || isOwner) }),
              row: logRow(e),
              reactions: reactions[e.seq] ?? [],
            })),
          });
        }
        if (what === "entries" && seqStr && method === "GET") {
          try {
            return json(await stub.get(parseInt(seqStr, 10)));
          } catch (e) {
            return json({ error: e instanceof Error ? e.message : String(e) }, 404);
          }
        }
        if (what === "entries" && !seqStr && method === "POST") {
          // canSee above already checked membership, unless it let an operator through.
          if (!viewer || (isOps(c) && !(await registry.isMember(env, id, viewer.name)))) return json({ error: "Only members can post." }, 403);
          const body = (await request.json().catch(() => ({}))) as { text?: string; type?: string; to?: string; reply_to?: string | number };
          const type = (["note", "question", "task", "decision", "claim"] as const).find((t) => t === body.type) ?? "note";
          let to = body.to ? normalizeUser(body.to) : null;
          const text = String(body.text ?? "");
          const { mentions }: { mentions: Mention[] } = mayMention(text) ? parseMentions(text, (await registry.boardMembers(env, id)).map((x) => x.user), viewer.name, pv()) : { mentions: [] };
          // Replying: to an agent's post, the reply goes to that agent; to a person's post, it mentions them.
          const replyTo = Number(body.reply_to) > 0 ? Math.floor(Number(body.reply_to)) : null;
          if (replyTo) {
            const parent = await stub.get(replyTo).catch(() => null);
            if (!parent) return json({ error: `Entry #${replyTo} does not exist on this board.` }, 400);
            const p = parent.entry;
            if (p.author !== viewer.name) {
              if (p.via === "person") {
                if (!mentions.some((m) => m.user === p.author)) mentions.push({ user: p.author, agent: false });
              } else to ??= p.author;
            }
          }
          try {
            const entry = await stub.post(viewer.name, { type, text, to, mentions, reply_to: replyTo, via: pv() });
            ctx.waitUntil(Promise.all([registry.touch(env, viewer.name, id), registry.bumpBoard(env, id, entry.seq)]).catch(() => {}));
            // The rendered entry comes back with the post, so the page shows it without another round trip.
            const root = replyTo ? ((await stub.rootsFor([entry.seq]))[entry.seq] ?? entry.seq) : entry.seq;
            return json({ ok: true, entry, update: { seq: entry.seq, root, retracts: entry.retracts, html: entryHtml(entry, id, true, { canRetract: true }), row: logRow(entry), reactions: [] } }, 201);
          } catch (e) {
            return json({ error: e instanceof Error ? e.message : String(e) }, 400);
          }
        }
        // Chat search (the board page's Ctrl+F): ranked full text, optionally only one person's or one agent's posts, or one type.
        if (what === "search" && method === "GET") {
          const q = (url.searchParams.get("q") ?? "").trim().slice(0, 200);
          const from = normalizeUser(url.searchParams.get("from") ?? "");
          const agent = url.searchParams.get("agent"); // "1": that member's agent, "0": the person, absent: either
          const type = url.searchParams.get("type") || undefined;
          const scope = url.searchParams.get("in") ?? "all"; // "chat" leaves files out
          const r = q ? await stub.rankedSearch(q, { author: from ?? undefined, type, limit: 60 }) : { entries: (await stub.search("", { author: from ?? undefined, type, limit: 60 })).map((entry) => ({ entry, snippet: "" })), files: [] };
          const keep = (e: Entry) => agent == null || (agent === "1" ? e.via === "agent" : e.via !== "agent");
          return json({
            entries: r.entries
              .filter((x) => keep(x.entry))
              .map((x) => ({ seq: x.entry.seq, ts: x.entry.ts, author: x.entry.author, via: x.entry.via ?? null, type: x.entry.type, title: x.entry.title ?? null, snippet: x.snippet || x.entry.text.slice(0, 200) })),
            files: scope === "chat" || from || type ? [] : r.files,
          }, 200, { "cache-control": "no-store" });
        }
        // Read receipts: the board page reports the newest entry its person has had on screen.
        if (what === "seen" && method === "POST") {
          if (!viewer || !(await registry.isMember(env, id, viewer.name))) return json({ error: "Only members can mark entries seen." }, 403);
          const body = (await request.json().catch(() => ({}))) as { seq?: number };
          await stub.seen(viewer.name, Number(body.seq) || 0);
          return json({ ok: true });
        }
        if (what === "invites" && method === "POST") {
          if (viewer && !viewer.admin && !(await registry.isMember(env, id, viewer.name))) return json({ error: "Only members can invite." }, 403);
          const body = (await request.json().catch(() => ({}))) as { email?: string; to?: string; role?: string; expires_days?: string | number };
          const to = String(body.to ?? body.email ?? "").trim();
          const role = body.role === "viewer" ? "viewer" : "contributor"; // owners are promoted after they join
          const expiresDays = Number(body.expires_days) > 0 ? Math.min(365, Math.floor(Number(body.expires_days))) : null;
          // A name instead of an email invites a friend; their email stays private (the reply names them, never the address).
          if (viewer && to && !to.includes("@")) {
            const name = normalizeUser(to.replace(/^@/, ""));
            const friend = name && (await social.friendsOf(env, viewer.name)).friends.find((f) => f.name === name);
            const u = friend ? await registry.userByName(env, friend.name) : null;
            if (!u?.email) return json({ error: `You can invite friends by name; for anyone else, use their email.` }, 400);
            const r = await sendInvite(env, url.origin, { boardId: id, email: u.email, invitedBy: viewer.name, role, expiresDays });
            return json({ ok: r.ok, added: r.added, message: r.message.split(` (${u.email.toLowerCase()})`).join("").split(u.email.toLowerCase()).join(u.name) });
          }
          if (!EMAIL_RE.test(to)) return json({ error: "Enter a valid email address." }, 400);
          return json(await sendInvite(env, url.origin, { boardId: id, email: to, invitedBy: viewer?.name ?? "ops", role, expiresDays }));
        }
        return json({ error: "not found" }, 404);
      }

      // ---- invitations (accept / decline) ----
      m = path.match(/^\/api\/invitations\/([^/]+)\/(accept|decline)$/);
      if (m && method === "POST") {
        if (!viewer) return needLogin();
        const me = await registry.userByName(env, viewer.name);
        if (!me) return needLogin();
        let ok: boolean;
        try {
          ok = m[2] === "accept" ? await registry.acceptInvitation(env, me, m[1], url.origin) : await registry.declineInvitation(env, me, m[1]);
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 402);
        }
        if (!ok) return json({ error: "No open invitation to that board for your verified email." }, 404);
        return json({ ok: true, board: m[1], message: m[2] === "accept" ? "Joined" : "Declined" });
      }

      // ---- personal tokens ----
      if (path === "/api/tokens" && method === "POST") {
        if (!viewer) return needLogin();
        const body = (await request.json().catch(() => ({}))) as { board?: string; label?: string };
        const board = body.board && (await canSee(c, body.board)) ? body.board : null;
        const t = await auth.createToken(env, viewer.name, String(body.label ?? "").slice(0, 80) || "Agent");
        return json(
          {
            id: t.id,
            token: t.token,
            command: connectCommand(url.origin, null, t.token),
            mcp_url: `${url.origin}/mcp`,
            ...(board ? { project_command: connectCommand(url.origin, board, t.token), project_mcp_url: `${url.origin}/mcp?board=${board}` } : {}),
          },
          201,
        );
      }
      m = path.match(/^\/api\/tokens\/([^/]+)\/revoke$/);
      if (m && method === "POST") {
        if (!viewer) return needLogin();
        return (await auth.revokeToken(env, viewer.name, m[1])) ? json({ ok: true, message: "Revoked" }) : json({ error: "token not found" }, 404);
      }

      // ---- ops API: operator session or x-admin-key (automation and tests) ----
      if (path.startsWith("/api/ops/")) {
        if (!isOps(c)) return json({ error: "not found" }, 404);
        const body = method === "POST" ? ((await request.json().catch(() => ({}))) as Record<string, string>) : {};
        if (path === "/api/ops/overview" && method === "GET") return json(await opsData(env));
        // Proves error reporting end to end (D1 errors + Sentry): throws on purpose.
        if (path === "/api/ops/test-error" && method === "POST") throw new Error(`Test error from /api/ops/test-error (${new Date().toISOString()})`);
        if (path === "/api/ops/metrics" && method === "GET") return json(await usage.metrics(env, Number(url.searchParams.get("days")) || 14));
        if (path === "/api/ops/users" && method === "POST") {
          const name = normalizeUser(body.name);
          if (!name) return json({ error: "valid name required" }, 400);
          if (await registry.userByName(env, name)) return json({ error: "name taken" }, 409);
          await registry.createUser(env, {
            name,
            email: body.email ? body.email.toLowerCase() : null,
            email_verified: String(body.verified) === "true",
            workos_id: null,
            display_name: body.display_name ?? null,
          });
          return json({ ok: true, name }, 201);
        }
        if (path === "/api/ops/tokens" && method === "POST") {
          const u = normalizeUser(body.user);
          if (!u || !(await registry.userByName(env, u))) return json({ error: "user not found" }, 404);
          const ttl = Number(body.expires_in_s);
          const t = await auth.createToken(env, u, body.label || "ops-issued", Number.isFinite(ttl) ? { expiresAt: Date.now() + ttl * 1000 } : {});
          return json({ token: t.token, command: connectCommand(url.origin, body.board ?? null, t.token) }, 201);
        }
        if (path === "/api/ops/sessions" && method === "POST") {
          const u = normalizeUser(body.user);
          const row = u ? await registry.userByName(env, u) : null;
          if (!row) return json({ error: "user not found" }, 404);
          const secret = await auth.createSession(env, {
            user: row.name,
            workos_id: row.workos_id ?? "ops-issued",
            email: row.email ?? "",
            email_verified: String(body.verified) === "true",
            display_name: row.display_name,
          });
          return json({ cookie: `${auth.SESSION_COOKIE}=${secret}` }, 201);
        }
        if (path === "/api/ops/policies" && method === "GET") return json({ policies: (await env.DB.prepare(`SELECT * FROM org_policies ORDER BY domain`).all()).results });
        if (path === "/api/ops/policies" && method === "POST") {
          const domain = String(body.domain ?? "").trim().toLowerCase();
          if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return json({ error: "domain required (e.g. acme.com)" }, 400);
          if (body.delete) {
            await env.DB.prepare(`DELETE FROM org_policies WHERE domain = ?`).bind(domain).run();
            return json({ ok: true });
          }
          const ret = body.max_retention_days == null || body.max_retention_days === "" ? null : Math.max(1, Math.floor(Number(body.max_retention_days)));
          await env.DB.prepare(
            `INSERT INTO org_policies (domain, require_sso, max_retention_days, allow_outside_members, updated_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(domain) DO UPDATE SET require_sso = excluded.require_sso, max_retention_days = excluded.max_retention_days, allow_outside_members = excluded.allow_outside_members, updated_at = excluded.updated_at`,
          )
            .bind(domain, ["true", "1"].includes(String(body.require_sso)) ? 1 : 0, ret, String(body.allow_outside_members) === "false" ? 0 : 1, Date.now())
            .run();
          return json({ ok: true });
        }
        if (path === "/api/ops/prune" && method === "POST") {
          if (!body.board || !(await registry.getBoard(env, body.board))) return json({ error: "board required" }, 400);
          return json({ ok: true, pruned: await boardStub(env, body.board).prune(Number(body.before) || Date.now()) });
        }
        if (path === "/api/ops/seed" && method === "POST") {
          const u = normalizeUser(body.user);
          if (!u || !body.board || !(await registry.getBoard(env, body.board))) return json({ error: "board and user required" }, 400);
          const n = await boardStub(env, body.board).seed(u, Number(body.count) || 100, String(body.prefix ?? "seed").slice(0, 200));
          ctx.waitUntil(registry.bumpBoard(env, body.board, n).catch(() => {}));
          return json({ ok: true, count: n });
        }
        if (path === "/api/ops/members" && method === "POST") {
          const u = normalizeUser(body.user);
          if (!u || !body.board || !(await registry.getBoard(env, body.board))) return json({ error: "board and user required" }, 400);
          await registry.addMember(env, body.board, u);
          return json({ ok: true });
        }
        if (path === "/api/ops/scan-secrets" && method === "GET") {
          const boards = await registry.allBoards(env);
          const found: { board: string; title: string; seq: number; rule: string; field: string; line: number }[] = [];
          for (const b of boards) {
            for (const h of await boardStub(env, b.id).scanSecrets()) found.push({ board: b.id, title: b.title, seq: h.seq, rule: h.hit.rule, field: h.hit.field, line: h.hit.line });
          }
          return json({ boards: boards.length, findings: found });
        }
        if (path === "/api/ops/boards" && method === "POST") {
          const u = normalizeUser(body.user);
          if (!u || !(await registry.userByName(env, u)) || !body.title) return json({ error: "user and title required" }, 400);
          try {
            return json({ board: await createBoard(env, body.title.slice(0, 120), u) }, 201);
          } catch (e) {
            return json({ error: e instanceof Error ? e.message : String(e) }, 400);
          }
        }
        return json({ error: "not found" }, 404);
      }

      return notFound(viewer);
    } catch (e) {
      console.error("request failed", path, e);
      ctx.waitUntil(usage.recordError(env, `${method} ${path}`, e).catch(() => {}));
      Sentry.captureException(e, { tags: { route: usage.routeKey(`${method} ${path}`) } });
      const msg = e instanceof Error ? e.message : String(e);
      // Cloudflare's daily storage allowance ran out: say so plainly, and when it comes back.
      if (/Exceeded allowed (rows|.*) in Durable Objects|exceeded.*free tier/i.test(msg)) {
        const back = "Boards are paused: Agent Soup hit its daily storage limit. They're back at 00:00 UTC (your data is safe).";
        if (method === "GET" && !path.startsWith("/api/")) return messagePage("Back soon", back, { status: 503 });
        return json({ error: back }, 503, { "retry-after": "3600" });
      }
      return json({ error: msg }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

// Errors also go to Sentry when SENTRY_DSN is set (prod); with no DSN the SDK stays off (dev/CI). No PII (the default).
export default Sentry.withSentry(
  (env: Env) => ({ dsn: env.SENTRY_DSN, release: env.CF_VERSION_METADATA?.id, tracesSampleRate: 0 }),
  handler,
);

const STUN_ONLY = [{ urls: "stun:stun.cloudflare.com:3478" }, { urls: "stun:stun.l.google.com:19302" }];

/** ICE servers for a voice call: Cloudflare's TURN relay (credentials good for 4 hours) when configured, else STUN only. */
async function voiceIceServers(env: Env): Promise<unknown[]> {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return STUN_ONLY;
  try {
    const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ ttl: 4 * 3600 }),
    });
    if (!r.ok) return STUN_ONLY;
    const d = (await r.json()) as { iceServers?: unknown };
    const list = Array.isArray(d.iceServers) ? d.iceServers : d.iceServers ? [d.iceServers] : [];
    return list.length ? list : STUN_ONLY;
  } catch {
    return STUN_ONLY;
  }
}
