// Worker entry: MCP endpoint, sign-in, web pages, JSON API, and the operator console (/_ops).

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
} from "./html";
import type { Entry, Env } from "./types";
import { FAVICON_SVG, renderText } from "./ui";
import { BOARD_RE, connectCommand, newBoardId, normalizeUser, parseBoardMeta } from "./util";

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
  const accountOnly = /^\/api\/(ops|tokens|billing)(\/|$)/.test(path);
  if (!session?.user && bearer && path.startsWith("/api/") && !accountOnly) {
    const name = await auth.userForToken(env, bearer);
    const u = name ? await registry.userByName(env, name) : null;
    return u ? { name: u.name, email: u.email ?? "", display_name: u.display_name, admin: false, via: "agent" } : null;
  }
  if (!session?.user) return null;
  const u = await registry.userByName(env, session.user);
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
  return (await registry.boardsForUser(env, user)).filter((b) => !b.archived_at).map((b) => ({ id: b.id, title: b.title }));
}

/** Members (and operators) can see a board; everyone else gets a 404 so board ids don't leak. */
async function canSee(c: Ctx, boardId: string): Promise<boolean> {
  if (!BOARD_RE.test(boardId)) return false;
  if (!(await registry.getBoard(c.env, boardId))) return false;
  if (isOps(c)) return true;
  return !!c.viewer && (await registry.isMember(c.env, boardId, c.viewer.name));
}

/** Plan limits apply to people (origin given); the ops API creates boards without them. */
async function createBoard(env: Env, title: string, user: string, origin?: string) {
  if (origin) await billing.checkCanCreateBoard(env, user, origin);
  const id = newBoardId();
  const info = await boardStub(env, id).init(id, title, user);
  await registry.recordBoard(env, info);
  await registry.addMember(env, id, user);
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
  return { boards, users, invites, recent, totalEntries: boards.reduce((n, b) => n + b.entry_count, 0), access: [...access.values()] };
}

// ---------- router ----------

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method;

    try {
      if (path === "/mcp") return await handleMcp(request, env, ctx);
      if (path === "/health") return json({ ok: true, version: env.CF_VERSION_METADATA?.id ?? null });
      if (path === "/terms" || path === "/privacy") return legalPage(path.slice(1) as "terms" | "privacy");
      if (path === "/openapi.json") return json(openapi(url.origin), 200, { "access-control-allow-origin": "*", "cache-control": "public, max-age=300" });
      if (path === "/skill.md") return new Response(SKILL_MD, { headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "public, max-age=300" } });
      if (path === "/favicon.svg" || path === "/favicon.ico") {
        return new Response(FAVICON_SVG, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } });
      }

      const session = await auth.getSession(request, env);
      const viewer = await loadViewer(env, session, request, path);
      const pv = (): "agent" | "person" => viewer?.via ?? "person"; // who wrote it: a person on the web, or an agent via token
      const c: Ctx = { request, env, ctx, url, session, viewer };
      const needLogin = () =>
        method === "GET" && !path.startsWith("/api/") ? redirect(`/auth/login?return=${encodeURIComponent(url.pathname + url.search)}`) : json({ error: "sign in required" }, 401);

      // ---- auth ----
      if (path === "/auth/login" && method === "GET") return authLogin(c);
      if (path === "/auth/callback" && method === "GET") return authCallback(c);
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
        const title = String((await request.formData()).get("title") ?? "").trim().slice(0, 120);
        if (!title) return redirect("/?new=1");
        try {
          const info = await createBoard(env, title, viewer.name, url.origin);
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
          boardStub(env, m[2]).snapshot(0),
          registry.boardMembers(env, m[2]),
          registry.pendingInvites(env, m[2]),
          sideBoards(env, viewer.name),
          registry.agentsOnBoard(env, m[2]),
          registry.agentStatus(env, viewer.name),
        ]);
        const withAgents = members.map((x) => ({ ...x, agent_seen: live[x.user] ?? null }));
        return boardPage(viewer, side, snap.info, withAgents, snap.entries, invites, { connected: status.connected, onThisBoard: !!live[viewer.name] });
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

      // ---- profile pictures (people and their agents) ----
      m = path.match(/^\/avatar\/([a-z0-9][a-z0-9_.-]{0,31})$/);
      if (m && method === "GET") return avatars.avatarResponse(env, m[1], url.searchParams.get("k") === "agent" ? "agent" : "person");
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
        const [side, tokens, plan] = await Promise.all([sideBoards(env, viewer.name), auth.listTokens(env, viewer.name), billing.planOf(env, viewer.name)]);
        return mePage(viewer, side, tokens, plan, !!env.STRIPE_SECRET_KEY);
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
        if (!isOps(c) && board.created_by !== viewer?.name) return json({ error: "Only the board's creator can do that." }, 403);
        const body = (await request.json().catch(() => ({}))) as { title?: string; archived?: boolean | string };
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

      // ---- membership: the board's creator removes people; anyone else can leave ----
      m = path.match(/^\/api\/boards\/([^/]+)\/members\/([^/]+)\/remove$/);
      if (m && method === "POST") {
        if (!viewer) return needLogin();
        const [, id, who] = m;
        const board = BOARD_RE.test(id) ? await registry.getBoard(env, id) : null;
        if (!board || !(await registry.isMember(env, id, viewer.name))) return json({ error: "board not found" }, 404);
        const self = who === viewer.name;
        if (self && board.created_by === viewer.name) return json({ error: "You created this board, so you can't leave it." }, 400);
        if (!self && board.created_by !== viewer.name) return json({ error: "Only the board's creator can remove people." }, 403);
        if (!(await registry.isMember(env, id, who))) return json({ error: `${who} isn't a member.` }, 404);
        await registry.removeMember(env, id, who);
        await boardStub(env, id).removeMember(who);
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
        if (!(await registry.isMember(env, m[1], who))) return json({ error: "board not found" }, 404);
        return boardStub(env, m[1]).fetch(new Request(`https://board/ws?user=${encodeURIComponent(who)}`, request));
      }

      // ---- the signed-in person's boards (CLI uses its bearer token) ----
      if (path === "/api/me/boards" && method === "GET") {
        const tok = auth.bearer(request);
        const who = viewer?.name ?? (tok ? (await auth.resolveToken(env, tok, ctx)).user : null);
        if (!who) return json({ error: "sign in required" }, 401);
        const boards = await registry.boardsForUser(env, who);
        return json({ user: who, boards: boards.map((b) => ({ id: b.id, title: b.title, entry_count: b.entry_count, last_activity: b.last_activity })) });
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
            return json({ ...d, html: renderText(d.content) });
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
            })),
            ...(after === 0 ? { reactions: snap.reactions } : {}),
            reviews: snap.reviews, // every card's current verdicts (small), so open tabs can update cards above the fold
            reads: snap.reads, // how far each member has seen, as a person and through their agent (read receipts)
            summary: summaryHtml([], viewer?.name ?? "", members, snap.summary, { boardId: id, creator: snap.info.created_by }),
            count: snap.info.entry_count,
            last: fresh.length ? fresh[fresh.length - 1].seq : after,
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
          if (!viewer || !(await registry.isMember(env, id, viewer.name))) return json({ error: "Only members can post." }, 403);
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
            return json({ ok: true, entry }, 201);
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
          const body = (await request.json().catch(() => ({}))) as { email?: string };
          const email = String(body.email ?? "").trim();
          if (!EMAIL_RE.test(email)) return json({ error: "Enter a valid email address." }, 400);
          return json(await sendInvite(env, url.origin, { boardId: id, email, invitedBy: viewer?.name ?? "ops" }));
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
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
