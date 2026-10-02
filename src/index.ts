// Worker entry: MCP endpoint, web pages, and a small JSON API.

import { handleMcp } from "./mcp";
import { sendInvite } from "./invite";
import * as registry from "./registry";
import { adminLogin, adminPage, boardDelta, boardPage, joinPage, landingPage, notFound, type AdminData } from "./html";
import type { Env } from "./types";
import { BOARD_RE, newBoardId, normalizeUser } from "./util";

export { Board } from "./board";

const ADMIN_COOKIE = "ab_admin";

function boardStub(env: Env, id: string) {
  return env.BOARD.get(env.BOARD.idFromName(id));
}

async function boardExists(env: Env, id: string): Promise<boolean> {
  return BOARD_RE.test(id) && (await boardStub(env, id).exists());
}

function cookie(request: Request, name: string): string | null {
  const m = (request.headers.get("cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}

/** Constant-time string comparison for the admin key. */
function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

function isAdmin(request: Request, env: Env): boolean {
  if (!env.ADMIN_KEY) return false;
  const supplied = cookie(request, ADMIN_COOKIE) ?? request.headers.get("x-admin-key") ?? "";
  return safeEqual(supplied, env.ADMIN_KEY);
}

async function createBoard(env: Env, title: string, user: string) {
  const id = newBoardId();
  const info = await boardStub(env, id).init(id, title, user);
  await registry.recordBoard(env, info);
  await registry.touch(env, user, id);
  return info;
}

async function adminData(env: Env): Promise<AdminData> {
  const [boards, users, invites] = await Promise.all([registry.allBoards(env), registry.allUsers(env), registry.allInvites(env)]);
  // Recent messages: last few entries from the 25 most recently active boards.
  const recentBoards = boards.slice(0, 25);
  const snaps = await Promise.all(
    recentBoards.map(async (b) => {
      try {
        const s = await boardStub(env, b.id).snapshot(Math.max(0, b.entry_count - 20));
        return s.entries.map((e) => ({ ...e, board_id: b.id, board_title: b.title }));
      } catch {
        return [];
      }
    }),
  );
  const recent = snaps.flat().sort((a, b) => b.ts - a.ts || b.seq - a.seq).slice(0, 50);
  const totalEntries = boards.reduce((n, b) => n + b.entry_count, 0);
  return { boards, users, invites, recent, totalEntries };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const origin = url.origin;

    try {
      if (path === "/mcp") return await handleMcp(request, env, ctx);

      if (path === "/health") return Response.json({ ok: true });

      if (path === "/" && request.method === "GET") return landingPage(origin);

      // Create a board from the landing page form.
      if (path === "/boards" && request.method === "POST") {
        const form = await request.formData();
        const title = String(form.get("title") ?? "").trim().slice(0, 120);
        const user = normalizeUser(String(form.get("user") ?? ""));
        if (!title || !user) return new Response("Title and a valid name are required.", { status: 400 });
        const info = await createBoard(env, title, user);
        return Response.redirect(`${origin}/join/${info.id}?name=${encodeURIComponent(user)}`, 303);
      }

      let m = path.match(/^\/join\/([^/]+)$/);
      if (m && request.method === "GET") {
        if (!(await boardExists(env, m[1]))) return notFound("Board");
        const stub = boardStub(env, m[1]);
        const [info, members] = await Promise.all([stub.info(), stub.members()]);
        return joinPage(origin, info, members, normalizeUser(url.searchParams.get("name")) ?? "");
      }

      m = path.match(/^\/b\/([^/]+)$/);
      if (m && request.method === "GET") {
        if (!(await boardExists(env, m[1]))) return notFound("Board");
        const s = await boardStub(env, m[1]).snapshot(0);
        return boardPage(s.info, s.members, s.entries);
      }

      // ---- JSON API ----

      if (path === "/api/boards" && request.method === "POST") {
        const body = (await request.json().catch(() => ({}))) as { title?: string; user?: string };
        const title = String(body.title ?? "").trim().slice(0, 120);
        const user = normalizeUser(body.user);
        if (!title || !user) return Response.json({ error: "title and a valid user are required" }, { status: 400 });
        const info = await createBoard(env, title, user);
        return Response.json({ board: info, join_url: `${origin}/join/${info.id}`, view_url: `${origin}/b/${info.id}` }, { status: 201 });
      }

      m = path.match(/^\/api\/boards\/([^/]+)$/);
      if (m && request.method === "GET") {
        if (!(await boardExists(env, m[1]))) return Response.json({ error: "board not found" }, { status: 404 });
        const after = Math.max(0, parseInt(url.searchParams.get("after") ?? "0", 10) || 0);
        const s = await boardStub(env, m[1]).snapshot(0);
        const fresh = s.entries.filter((e) => e.seq > after);
        if (url.searchParams.get("format") === "json") return Response.json({ ...s, entries: fresh });
        return Response.json(boardDelta(s.info, s.members, fresh, s.entries));
      }

      // ---- admin ----

      if (path === "/admin" && request.method === "POST") {
        if (!env.ADMIN_KEY) return adminLogin("ADMIN_KEY is not configured on this deployment.");
        const key = String((await request.formData()).get("key") ?? "");
        if (!safeEqual(key, env.ADMIN_KEY)) return adminLogin("Wrong key.");
        const secure = url.protocol === "https:" ? " Secure;" : "";
        return new Response(null, {
          status: 303,
          headers: {
            Location: "/admin",
            "Set-Cookie": `${ADMIN_COOKIE}=${encodeURIComponent(key)}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=2592000`,
          },
        });
      }

      if (path === "/admin" && request.method === "GET") {
        if (!env.ADMIN_KEY) return adminLogin("ADMIN_KEY is not configured on this deployment.");
        if (!isAdmin(request, env)) return adminLogin();
        return adminPage(await adminData(env));
      }

      if (path === "/api/admin/overview" && request.method === "GET") {
        if (!isAdmin(request, env)) return Response.json({ error: "unauthorized" }, { status: 401 });
        return Response.json(await adminData(env));
      }

      if (path === "/api/admin/invite" && request.method === "POST") {
        if (!isAdmin(request, env)) return Response.json({ error: "unauthorized" }, { status: 401 });
        const body = (await request.json().catch(() => ({}))) as { board?: string; email?: string; name?: string; by?: string };
        const email = String(body.email ?? "").trim();
        if (!body.board || !(await boardExists(env, body.board))) return Response.json({ error: "board not found" }, { status: 404 });
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return Response.json({ error: "valid email required" }, { status: 400 });
        const r = await sendInvite(env, origin, {
          boardId: body.board,
          email,
          invitedBy: normalizeUser(body.by) ?? "admin",
          name: body.name,
        });
        return Response.json(r);
      }

      return notFound();
    } catch (e) {
      console.error("request failed", path, e);
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
