// Worker entry: MCP endpoint, sign-in, web pages, JSON API, and the operator console (/_ops).

import * as auth from "./auth";
import { handleMcp } from "./mcp";
import { EMAIL_RE, sendInvite } from "./invite";
import * as registry from "./registry";
import {
  adminPage,
  boardPage,
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
} from "./html";
import type { Env } from "./types";
import { BOARD_RE, connectCommand, newBoardId, normalizeUser } from "./util";

export { Board } from "./board";

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

async function loadViewer(env: Env, session: auth.Session | null): Promise<Viewer | null> {
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
  return (await registry.boardsForUser(env, user)).map((b) => ({ id: b.id, title: b.title }));
}

/** Members (and operators) can see a board; everyone else gets a 404 so board ids don't leak. */
async function canSee(c: Ctx, boardId: string): Promise<boolean> {
  if (!BOARD_RE.test(boardId)) return false;
  if (!(await registry.getBoard(c.env, boardId))) return false;
  if (isOps(c)) return true;
  return !!c.viewer && (await registry.isMember(c.env, boardId, c.viewer.name));
}

async function createBoard(env: Env, title: string, user: string) {
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
      if (path === "/health") return json({ ok: true });

      const session = await auth.getSession(request, env);
      const viewer = await loadViewer(env, session);
      const c: Ctx = { request, env, ctx, url, session, viewer };
      const needLogin = () =>
        method === "GET" ? redirect(`/auth/login?return=${encodeURIComponent(url.pathname + url.search)}`) : json({ error: "sign in required" }, 401);

      // ---- auth ----
      if (path === "/auth/login" && method === "GET") return authLogin(c);
      if (path === "/auth/callback" && method === "GET") return authCallback(c);
      if (path === "/welcome") return welcome(c);
      if (path === "/auth/logout" && method === "POST") {
        await auth.deleteSession(request, env);
        return redirect("/", { "Set-Cookie": auth.cookieHeader(url, auth.SESSION_COOKIE, "", 0) });
      }

      // ---- pages ----
      if (path === "/" && method === "GET") {
        if (session && !session.user) return redirect("/welcome");
        if (!viewer) return landingPage();
        const me = await registry.userByName(env, viewer.name);
        const [side, boards, invitations] = await Promise.all([sideBoards(env, viewer.name), registry.allBoards(env), me ? registry.invitationsFor(env, me) : []]);
        const mine = new Set(side.map((b) => b.id));
        return homePage(viewer, side, boards.filter((b) => mine.has(b.id)), invitations);
      }

      if (path === "/boards" && method === "POST") {
        if (!viewer) return needLogin();
        const title = String((await request.formData()).get("title") ?? "").trim().slice(0, 120);
        if (!title) return redirect("/?new=1");
        const info = await createBoard(env, title, viewer.name);
        return redirect(`/b/${info.id}`);
      }

      let m = path.match(/^\/(b|join)\/([^/]+)$/);
      if (m && method === "GET") {
        if (m[1] === "join") return redirect(`/b/${m[2]}`);
        if (!viewer) return needLogin();
        if (!(await canSee(c, m[2]))) return notFound(viewer);
        const [snap, members, invites, side] = await Promise.all([
          boardStub(env, m[2]).snapshot(0),
          registry.boardMembers(env, m[2]),
          registry.pendingInvites(env, m[2]),
          sideBoards(env, viewer.name),
        ]);
        return boardPage(viewer, side, snap.info, members, snap.entries, invites);
      }

      if (path === "/me" && method === "GET") {
        if (!viewer) return needLogin();
        const [side, tokens] = await Promise.all([sideBoards(env, viewer.name), auth.listTokens(env, viewer.name)]);
        return mePage(viewer, side, tokens);
      }

      if (path === OPS_PATH && method === "GET") {
        if (!viewer?.admin) return notFound(viewer); // indistinguishable from a missing page unless you're an operator
        const [side, data] = await Promise.all([sideBoards(env, viewer.name), opsData(env)]);
        return adminPage(viewer, side, data);
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
      m = path.match(/^\/api\/boards\/([^/]+)\/(updates|entries|invites)(?:\/(\d+))?$/);
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
          const [snap, members] = await Promise.all([stub.snapshot(after), registry.boardMembers(env, id)]);
          const fresh = snap.entries;
          const roots = await stub.rootsFor(fresh.map((e) => e.seq));
          return json({
            entries: fresh.map((e) => ({ seq: e.seq, root: roots[e.seq] ?? e.seq, html: entryHtml(e, id), row: logRow(e) })),
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
          const body = (await request.json().catch(() => ({}))) as { text?: string; type?: string; to?: string };
          const type = (["note", "question", "task", "decision", "claim"] as const).find((t) => t === body.type) ?? "note";
          const to = body.to ? normalizeUser(body.to) : null;
          try {
            const entry = await stub.post(viewer.name, { type, text: String(body.text ?? ""), to });
            ctx.waitUntil(Promise.all([registry.touch(env, viewer.name, id), registry.bumpBoard(env, id, entry.seq)]).catch(() => {}));
            return json({ ok: true, entry }, 201);
          } catch (e) {
            return json({ error: e instanceof Error ? e.message : String(e) }, 400);
          }
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
        const ok = m[2] === "accept" ? await registry.acceptInvitation(env, me, m[1]) : await registry.declineInvitation(env, me, m[1]);
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
          const t = await auth.createToken(env, u, body.label || "ops-issued");
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
        if (path === "/api/ops/boards" && method === "POST") {
          const u = normalizeUser(body.user);
          if (!u || !(await registry.userByName(env, u)) || !body.title) return json({ error: "user and title required" }, 400);
          return json({ board: await createBoard(env, body.title.slice(0, 120), u) }, 201);
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
