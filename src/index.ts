// Worker entry: MCP endpoint, sign-in, web pages, JSON API, and the operator console (/_ops).

import * as a2a from "./a2a";
import { runGrep } from "./grep";
import * as usage from "./usage";
import * as oauth from "./oauth";
import { consentPage } from "./oauthPage";
import * as approvals from "./approvals";
import { approvalsPage } from "./approvalsPage";
import * as access from "./access";
import * as social from "./social";
import * as webhooks from "./webhooks";
import * as avatars from "./avatars";
import * as boardPictures from "./boardPictures";
import * as agents from "./agents";
import * as dm from "./dm";
import { waitForBoard } from "./waits";
import { isRetriable, messageId, retryingReads, withRetry } from "./retry";
import CLI_BUNDLE from "../cli/dist/atteo.mjs";
import { installScript } from "./install";
import SKILL_MD from "../skills/atteo/SKILL.md";
import { openapi } from "./openapi";
import * as billing from "./billing";
import { blockedMessage, scanFields } from "./secrets";
import * as inbox from "./inbox";
import * as auth from "./auth";
import * as appSignin from "./appSignin";
import { handleMcp } from "./mcp";
import * as device from "./device";
import { EMAIL_RE, sendInvite } from "./invite";
import { mayMention, parseMentions, SESSION_NAME_RE, type Mention } from "./mentions";
import * as registry from "./registry";
import * as boardkeys from "./boardkeys";
import * as mailbox from "./mailbox";
import * as recap from "./recap";
import * as triggers from "./triggers";
import * as tts from "./tts";
import { MAX_SCHEDULES } from "./schedules";
import {
  adminPage,
  boardPage,
  devicePage,
  entryHtml,
  agentNames,
  withAgentNames,
  homePage,
  landingPage,
  logRow,
  mePage,
  makeRoomPage, messagePage,
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
import type { Entry, Env, Viewer as Seer } from "./types";
import { FAVICON_SVG, page, renderText } from "./ui";
import { APPLE_TOUCH_PNG_B64 } from "./appleIcon";
import { atteoHeader, BOARD_RE, connectCommand, esc, newBoardId, legacyHostRedirect, normalizeUser, parseBoardMeta, publicOrigin } from "./util";

import * as Sentry from "@sentry/cloudflare";
import { scrubForSentry } from "./sentry";
export { Board } from "./board";
import { MAX_FILES_PER_MESSAGE, MAX_IMAGE, MAX_MESSAGE_BYTES, MAX_WAIT_MS, peopleNotice } from "./board";
import * as sessions from "./sessions";
import { formatEntry, formatMemory, handleMessage, readHeader, readParts, withNames } from "./state";
import { fence } from "./screen";

const OPS_PATH = "/_ops";

let cliHashMemo: Promise<string> | null = null;
/** sha256 of the CLI file this server hands out: an installed CLI compares its own file against it. */
function cliHash(): Promise<string> {
  return (cliHashMemo ??= crypto.subtle.digest("SHA-256", new TextEncoder().encode(CLI_BUNDLE)).then((b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("")));
}

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
  /** Where links back to the product point (publicOrigin): https://atteo.dev in production, the request's origin locally. */
  origin: string;
  session: auth.Session | null;
  viewer: Viewer | null;
}

async function loadViewer(env: Env, session: auth.Session | null, request?: Request, path = ""): Promise<Viewer | null> {
  // The JSON API also takes a personal token (Authorization: Bearer ab_…), as agents use for MCP. Never for pages.
  const bearer = request?.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  // Account-level actions (tokens, billing, ops) stay browser-only, so a leaked token can't mint more or change plans.
  const accountOnly = /^\/api\/(ops|tokens|billing|webhooks)(\/|$)/.test(path);
  // The Atteo app (a token of kind "app") acts as the person, and may also see and revoke agent connections.
  // (list connections, revoke one, or pull the kill switch; never mint new tokens).
  const appAllowed = request?.method === "POST" ? /^\/api\/tokens(\/revoke-all|\/[^/]+\/revoke)$/.test(path) : path === "/api/tokens";
  // Board pictures too: they're members-only images, and the app loads them with its token.
  if (!session?.user && bearer && (path.startsWith("/api/") || path.startsWith("/board-picture/")) && (!accountOnly || appAllowed)) {
    // Writes look the token up fresh, so a revoked token can't change anything anywhere (the kill switch).
    const id = await auth.tokenIdentity(env, bearer, !!request && request.method !== "GET" && request.method !== "HEAD");
    if (!id || (accountOnly && id.kind !== "app")) return null;
    const u = await registry.userByName(env, id.user);
    return u ? { name: u.name, email: u.email ?? "", display_name: u.display_name, admin: false, via: id.kind === "app" ? "person" : "agent" } : null;
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
  const [boards, live] = await Promise.all([registry.boardsForUser(env, user), sessions.liveByBoard(env).catch(() => new Map<string, number>())]);
  return boards
    .filter((b) => !b.archived_at)
    .map((b) => ({ id: b.id, title: b.title, kind: (b as { kind?: string | null }).kind ?? null, live: live.get(b.id) ?? 0, picture: boardPictures.pictureUrl(b.id, b.picture_v) }));
}

/** Members (and operators) can see a board; everyone else gets a 404 so board ids don't leak. */
async function canSee(c: Ctx, boardId: string): Promise<boolean> {
  if (!BOARD_RE.test(boardId)) return false;
  const a = await registry.boardAccess(c.env, boardId, c.viewer?.name ?? null);
  if (!a.exists) return false;
  return isOps(c) || a.member;
}

/** GET …/grep?q=&regex=0|1&case=0|1&author=&type=&since=<seq or ISO>&context=0..2&max=&files=0|1 → GrepOutput (text + hits). */
async function grepResponse(env: Env, user: string, url: URL, boardId: string | null): Promise<Response> {
  const p = url.searchParams;
  const flag = (k: string) => p.get(k) === "1" || p.get(k) === "true";
  try {
    const out = await runGrep(env, user, p.get("q") ?? "", {
      regex: flag("regex"),
      caseSensitive: flag("case"),
      author: p.get("author")?.trim().toLowerCase() || undefined,
      type: p.get("type") || undefined,
      since: p.get("since") ?? undefined,
      context: Number(p.get("context") ?? 0),
      max: Number(p.get("max") ?? 0),
      files: flag("files"),
    }, boardId);
    return json(out, 200, { "cache-control": "no-store" });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
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
  const ret = safeReturn(c.url.searchParams.get("return"));
  const state = auth.loginState(ret, c.url.searchParams.get("restart") === "1");
  const hint = c.url.searchParams.get("login_hint") ?? undefined;
  const to = auth.authorizeUrl(c.env, `${c.origin}/auth/callback`, state, {
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
      "Sign in with SSO · Atteo",
      `<div class="card pad" style="max-width:420px;margin:48px auto 0"><h1 style="font-size:18px">Sign in with SSO</h1><p class="small muted">Use your work email; we'll send you to your company's sign-in.</p>
<form method="get" action="/auth/sso" class="stack" style="--gap:10px;margin-top:12px"><input class="input" type="email" name="email" required placeholder="you@company.com" autofocus><button class="btn primary">Continue</button></form>
<p class="xs faint" style="margin-top:12px"><a href="/auth/login">Other ways to sign in</a></p></div>`,
      { narrow: true },
    );
  }
  const org = await auth.ssoOrganizationFor(c.env, email);
  if (!org) return messagePage("No SSO for that domain", `${email.split("@")[1]} hasn't set up single sign-on with Atteo. Sign in the usual way.`, { status: 404, action: { href: `/auth/login?login_hint=${encodeURIComponent(email)}`, label: "Sign in" } });
  const ret = safeReturn(c.url.searchParams.get("return"));
  const state = auth.loginState(ret);
  const to = auth.authorizeUrl(c.env, `${c.origin}/auth/callback`, state, { organizationId: org.id, loginHint: email });
  return redirect(to, { "Set-Cookie": auth.cookieHeader(c.url, auth.OAUTH_COOKIE, `${state}|${ret}`, 600) });
}

/**
 * Someone WorkOS just signed in (the web's AuthKit callback, or the app's email code): their Atteo member, or null if
 * they have none yet (they pick a name next). Known account → by WorkOS id. Otherwise a pre-made user row with this
 * *verified* email (e.g. a migrated beta user) is linked. A domain that requires SSO refuses every other way in.
 */
async function memberForWorkosUser(env: Env, wu: auth.WorkosUser): Promise<{ user: registry.FullUser | null; verified: boolean; display: string | null } | { ssoRequired: string }> {
  const verified = !!wu.email_verified;
  const display = [wu.first_name, wu.last_name].filter(Boolean).join(" ") || null;
  // Organization policy: people from a domain that requires SSO must come in through their identity provider.
  const policy = await orgPolicy(env, wu.email);
  if (policy?.require_sso && wu.authentication_method !== "SSO") return { ssoRequired: wu.email.split("@")[1] };
  let user = await registry.userByWorkosId(env, wu.id);
  if (user) await registry.setEmailVerified(env, user.name, wu.email, verified);
  if (!user && verified) {
    const unlinked = await registry.unlinkedUserByEmail(env, wu.email);
    if (unlinked) {
      await registry.linkWorkos(env, unlinked.name, wu.id, wu.email, display, verified);
      user = await registry.userByName(env, unlinked.name);
    }
  }
  return { user, verified, display };
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
  const cookie = auth.readCookie(c.request, auth.OAUTH_COOKIE);
  if (!cookie) {
    // Sign-in started on another host (the old workers.dev address) set its cookie there, but the callback is always on
    // the public address. Restart here, once, keeping the return path; AuthKit already has a session, so it bounces straight back.
    const s = auth.readLoginState(sentState);
    if (s.restarted) return fail("Your browser didn't keep the sign-in cookie. Allow cookies for this site and start again.");
    return redirect(`/auth/login?restart=1&return=${encodeURIComponent(safeReturn(s.ret))}`);
  }
  const [state, ret] = cookie.split("|");
  if (!code || !state || state !== sentState) return fail("The sign-in link expired or was opened in a different browser. Start again.");

  let wu: auth.WorkosUser;
  try {
    wu = await auth.authenticateCode(c.env, code);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  const who = await memberForWorkosUser(c.env, wu);
  if ("ssoRequired" in who) {
    return messagePage("Use your company's sign-in", `${who.ssoRequired} requires single sign-on. Sign in with SSO instead.`, { status: 403, action: { href: `/auth/sso?email=${encodeURIComponent(wu.email)}`, label: "Sign in with SSO" } });
  }
  const { user, verified, display } = who;
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

// ---------- the app's own sign-in: email → 6-digit code → (new people) a name; returns an app token ----------

const NAME_RULES = "Use 1–32 lowercase letters, numbers, dot, dash or underscore, starting with a letter or number.";
const tooMany = () => json({ error: "Too many tries. Wait a few minutes, then try again." }, 429, { "retry-after": "600" });

/** The same token the OAuth sign-in gives the app (scope "person"): kind "app", 30 days, listed in Settings → Connected. */
async function appToken(env: Env, user: registry.FullUser, device: string | null) {
  const t = await auth.createToken(env, user.name, device ? `Atteo app · ${device}` : "Atteo app", { expiresAt: Date.now() + oauth.OAUTH_TOKEN_TTL_MS, kind: "app" });
  return { token: t.token, token_type: "Bearer", expires_in: Math.floor(oauth.OAUTH_TOKEN_TTL_MS / 1000), user: { name: user.name, email: user.email, display_name: user.display_name } };
}

/** POST /api/app/signin/start {email}: emails a code. Always {ok: true}, whether or not the email has an account. */
async function appSigninStart(c: Ctx): Promise<Response> {
  const b = (await c.request.json().catch(() => ({}))) as { email?: unknown };
  const email = appSignin.normalizeEmail(b.email);
  if (!email) return json({ error: "Enter a valid email address." }, 400);
  const ip = appSignin.clientIp(c.request);
  const lim = appSignin.limits(c.env);
  if (!(await appSignin.hit(c.env, `start:ip:${ip}`, lim.startPerIp)) || !(await appSignin.hit(c.env, await appSignin.emailKey("start", email), lim.startPerEmail))) return tooMany();
  if (appSignin.fakeAllowed(c.env, c.url, email)) return json({ ok: true });
  if (!appSignin.workosConfigured(c.env)) return json({ error: "Sign-in isn't configured on this server." }, 503);
  const sent = await appSignin.sendCode(c.env, email, ip, c.request.headers.get("user-agent"));
  // Never tell the person (that would say whether the address is known); the logs hear it.
  if (!sent.ok) console.error(`app sign-in: WorkOS didn't send a code: ${sent.error}`);
  return json({ ok: true });
}

/** POST /api/app/signin/verify {email, code, device_name?}: an app token, or (new people) a ticket to pick a name. */
async function appSigninVerify(c: Ctx): Promise<Response> {
  const b = (await c.request.json().catch(() => ({}))) as { email?: unknown; code?: unknown; device_name?: unknown };
  const email = appSignin.normalizeEmail(b.email);
  const code = String(b.code ?? "").replace(/\s+/g, "");
  if (!email) return json({ error: "Enter a valid email address." }, 400);
  const ip = appSignin.clientIp(c.request);
  const lim = appSignin.limits(c.env);
  if (!(await appSignin.hit(c.env, `verify:ip:${ip}`, lim.verifyPerIp)) || !(await appSignin.hit(c.env, await appSignin.emailKey("verify", email), lim.verifyPerEmail))) return tooMany();
  if (!/^\d{6}$/.test(code)) return json({ error: appSignin.BAD_CODE }, 400);
  let wu: auth.WorkosUser;
  if (appSignin.fakeAllowed(c.env, c.url, email)) {
    if (code !== appSignin.FAKE_CODE) return json({ error: appSignin.BAD_CODE }, 400);
    wu = await appSignin.fakeWorkosUser(email);
  } else {
    if (!appSignin.workosConfigured(c.env)) return json({ error: "Sign-in isn't configured on this server." }, 503);
    try {
      wu = await appSignin.authenticateMagic(c.env, email, code, ip, c.request.headers.get("user-agent"));
    } catch (e) {
      if (e instanceof appSignin.CodeError) {
        if (e.detail) console.error(`app sign-in: WorkOS refused a code: ${e.detail}`);
        return json({ error: e.message }, e.status);
      }
      throw e;
    }
  }
  const who = await memberForWorkosUser(c.env, wu);
  if ("ssoRequired" in who) return json({ error: `${who.ssoRequired} requires single sign-on. Use “Continue with Google, GitHub or SSO” below.` }, 403);
  const device = appSignin.deviceLabel(b.device_name);
  if (who.user) return json(await appToken(c.env, who.user, device), 200, { "cache-control": "no-store" });
  // New here: pick a name (the app's version of /welcome).
  const ticket = await appSignin.createSignup(c.env, { workos_id: wu.id, email: wu.email, email_verified: who.verified ? 1 : 0, display_name: who.display, device_name: device });
  const suggestion = await freeName(c.env, suggestName(wu.email, who.display));
  return json({ needs_name: true, ticket, suggestion, email: wu.email, expires_in: Math.floor(appSignin.SIGNUP_TTL_MS / 1000) }, 200, { "cache-control": "no-store" });
}

/** POST /api/app/signin/name {ticket, name}: a new person picks their name (the same rules as /welcome); an app token. */
async function appSigninName(c: Ctx): Promise<Response> {
  const b = (await c.request.json().catch(() => ({}))) as { ticket?: unknown; name?: unknown };
  const ticket = String(b.ticket ?? "");
  const s = await appSignin.readSignup(c.env, ticket);
  if (!s) return json({ error: "This sign-in expired. Start again with your email." }, 400);
  // Already made (a double tap, or the web finished first): sign in as that member.
  const existing = await registry.userByWorkosId(c.env, s.workos_id);
  if (existing) {
    await appSignin.useSignup(c.env, ticket);
    return json(await appToken(c.env, existing, s.device_name), 200, { "cache-control": "no-store" });
  }
  const name = normalizeUser(String(b.name ?? "").trim().replace(/^@/, ""));
  if (!name) return json({ error: NAME_RULES }, 400);
  if (await registry.userByName(c.env, name)) return json({ error: `"${name}" is taken. Try another.`, suggestion: await freeName(c.env, name) }, 409);
  try {
    await registry.createUser(c.env, { name, email: s.email, email_verified: !!s.email_verified, workos_id: s.workos_id, display_name: s.display_name });
  } catch {
    return json({ error: `"${name}" is taken. Try another.` }, 409); // someone took it a moment ago
  }
  await appSignin.useSignup(c.env, ticket);
  const user = await registry.userByName(c.env, name);
  if (!user) return json({ error: "Couldn't finish signing up. Try again." }, 500);
  return json(await appToken(c.env, user, s.device_name), 201, { "cache-control": "no-store" });
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

/** Every 5 minutes (the cron; tests call it through POST /api/ops/cron): retention, sweeps, expired memberships, and
 *  workflow triggers on a daily schedule (`now` lets a test pick the time those see). */
async function runScheduled(env: Env, ctx: ExecutionContext, now = Date.now()): Promise<{ schedules: number; scheduled_tasks: number }> {
  // Boards with a retention period: blank what's older.
  const keep = (await env.DB.prepare(`SELECT id, retention_days FROM boards WHERE retention_days IS NOT NULL`).all<{ id: string; retention_days: number }>()).results;
  for (const b of keep) ctx.waitUntil(boardStub(env, b.id).prune(Date.now() - b.retention_days * 86_400_000).catch(() => 0));
  ctx.waitUntil(env.DB.prepare(`DELETE FROM tape WHERE ts < ?`).bind(Date.now() - 7 * 86_400_000).run().catch(() => {}));
  ctx.waitUntil(appSignin.sweep(env).catch(() => {}));
  for (const m of await registry.expiredMembers(env)) {
    ctx.waitUntil(
      (async () => {
        await registry.removeMember(env, m.board_id, m.user);
        await boardStub(env, m.board_id).removeMember(m.user).catch(() => {});
        await registry.audit(env, m.board_id, "system", "expired", m.user);
      })().catch(() => {}),
    );
  }
  // Workflow triggers on a schedule: only boards with one due in the last 20 minutes are woken (each fires once a day).
  const minute = Math.floor((now % 86_400_000) / 60_000);
  const lo = minute - 20;
  const due = (
    await env.DB.prepare(`SELECT DISTINCT board_id FROM trigger_schedules WHERE (minute BETWEEN ? AND ?) OR minute >= ?`)
      .bind(Math.max(0, lo), minute, lo < 0 ? 1440 + lo : 1440)
      .all<{ board_id: string }>()
      .catch(() => ({ results: [] as { board_id: string }[] }))
  ).results;
  const fired = await Promise.all(due.map((b) => boardStub(env, b.board_id).runSchedules(now).catch(() => 0)));
  // Shared crons (board schedules): boards with one due by now post its task (each due time once; the board knows).
  const dueBoards = (
    await env.DB.prepare(`SELECT DISTINCT board_id FROM board_schedules WHERE next_at <= ?`)
      .bind(now)
      .all<{ board_id: string }>()
      .catch(() => ({ results: [] as { board_id: string }[] }))
  ).results;
  const posted = await Promise.all(dueBoards.map((b) => boardStub(env, b.board_id).runBoardSchedules(now).catch((e) => (console.error("board schedules failed", b.board_id, e), 0))));
  return { schedules: fired.reduce((a, b) => a + b, 0), scheduled_tasks: posted.reduce((a, b) => a + b, 0) };
}

const handler = {
  /** Every 5 minutes (wrangler.jsonc triggers.crons). */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    await runScheduled(env, ctx);
  },

  async fetch(request: Request, rawEnv: Env, ctx: ExecutionContext): Promise<Response> {
    // Database reads retry through dropped connections (a transient D1 error must never fail someone's post).
    const env: Env = { ...rawEnv, DB: retryingReads(rawEnv.DB) };
    const url = new URL(request.url);
    // Links back to the product (sign-in callback, emails, OAuth/A2A/OpenAPI metadata, install.sh) use the public
    // address: atteo.dev proxies to this workers.dev host, so url.origin is workers.dev even for atteo.dev visitors.
    const origin = publicOrigin(env, url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method;

    // Old workers.dev page links move to the public site (legacyHostRedirect: what stays put, and the cf-worker loop guard).
    const moved = legacyHostRedirect(env, request, url);
    if (moved) return new Response(null, { status: 301, headers: { location: moved, "cache-control": "public, max-age=300" } });

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
      if (path === "/.well-known/agent-card.json" || path === "/.well-known/agent.json") return json(a2a.agentCard(origin), 200, { "access-control-allow-origin": "*" });
      if (path === "/a2a" && method === "POST") {
        const tok = auth.bearer(request);
        const who = tok ? (await auth.resolveToken(env, tok, ctx)).user : null;
        const rpcErr = (id: unknown, code: number, message: string, status = 200) => json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, status);
        if (!who) return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Send a personal token: Authorization: Bearer <token>" } }), { status: 401, headers: { "content-type": "application/json", "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` } });
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
            return ok(a2a.task(a2a.taskId(board.id, e.seq), "working", undefined, { metadata: { board: board.id, seq: e.seq, url: `${origin}/b/${board.id}#e${e.seq}` } }));
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
      if (path === "/openapi.json") return json(openapi(origin), 200, { "access-control-allow-origin": "*", "cache-control": "public, max-age=300" });
      if (path === "/skill.md") return new Response(SKILL_MD, { headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "public, max-age=300" } });
      if (path === "/apple-touch-icon.png" || path === "/apple-touch-icon-precomposed.png") {
        return new Response(Uint8Array.from(atob(APPLE_TOUCH_PNG_B64), (c) => c.charCodeAt(0)), { headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" } });
      }
      if (path === "/favicon.svg" || path === "/favicon.ico") {
        return new Response(FAVICON_SVG, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } });
      }

      const session = await auth.getSession(request, env);
      const viewer = await loadViewer(env, session, request, path);
      const pv = (): "agent" | "person" => viewer?.via ?? "person"; // who wrote it: a person on the web, or an agent via token
      // Who's looking, for what a board shows: people-only messages (vedu #1264) reach only their own people, signed
      // in as themselves (web, the app). An agent's token, or no viewer (ops), sees none of them.
      const seer = (): Seer | null => (viewer ? { user: viewer.name, person: viewer.via !== "agent" } : null);
      // The agent session making the call (the CLI sends X-Atteo-Session): what it causes counts as its own posts.
      let sessionMemo: Promise<string | null> | null = null;
      const asid = () =>
        (sessionMemo ??= (async () => {
          const h = atteoHeader(request, "session");
          return h && viewer?.via === "agent" ? ((await sessions.get(env, viewer.name, h))?.id ?? null) : null;
        })());
      // A read-only agent session (scope "read") can read and wait, mark things seen, and manage its own session,
      // but nothing it sends may change a board or anyone's account.
      if (viewer?.via === "agent" && method !== "GET" && method !== "HEAD" && atteoHeader(request, "session")) {
        const sid = await asid();
        const s = sid ? await sessions.get(env, viewer.name, sid) : null;
        if (s?.scope === "read" && !/^\/api\/(sessions(\/|$)|boards\/[^/]+\/seen$)/.test(path))
          return json({ error: `This agent session (${s.name}) is read-only: it can read and wait, not post or change anything. Your person can give it full access on the web.` }, 403);
      }
      if (viewer && viewer.via !== "agent") ctx.waitUntil(Promise.resolve(social.markSeen(env, viewer.name, "web")).catch(() => {}));
      if (viewer && viewer.via !== "agent" && !viewer.name.startsWith("e2e-")) ctx.waitUntil(Promise.resolve(usage.track(env, "active_person", viewer.name, true)).catch(() => {}));
      const c: Ctx = { request, env, ctx, url, origin, session, viewer };
      const needLogin = () =>
        method === "GET" && !path.startsWith("/api/") ? redirect(`/auth/login?return=${encodeURIComponent(url.pathname + url.search)}`) : json({ error: "sign in required" }, 401);

      // ---- MCP OAuth: discovery, client registration, sign-in + approve, code → token ----
      const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization, mcp-protocol-version", "access-control-allow-methods": "GET, POST, OPTIONS" };
      if ((path.startsWith("/.well-known/oauth-") || path.startsWith("/oauth/")) && method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
      if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") return json(oauth.protectedResource(origin), 200, cors);
      if (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/openid-configuration") return json(oauth.authorizationServer(origin), 200, cors);
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
          return consentPage(viewer, r.id, r.client.name, new URL(r.redirect).host, r.person);
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
      if (path === "/api/app/signin/start" && method === "POST") return appSigninStart(c);
      if (path === "/api/app/signin/verify" && method === "POST") return appSigninVerify(c);
      if (path === "/api/app/signin/name" && method === "POST") return appSigninName(c);
      if (path === "/auth/logout" && method === "POST") {
        await auth.deleteSession(request, env);
        return redirect("/", { "Set-Cookie": auth.cookieHeader(url, auth.SESSION_COOKIE, "", 0) });
      }

      // ---- CLI login (device flow) ----
      if (path === "/api/device/start" && method === "POST") {
        const body = (await request.json().catch(() => ({}))) as { client?: string };
        return json(await device.startDeviceLogin(env, origin, String(body.client ?? "Atteo CLI")));
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
        if (r === "expired") return json({ error: "That code expired. Run atteo login again." }, 410);
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
          registry.boardsOverview(env, viewer.name, viewer.via !== "agent"),
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
        const encrypted = form.get("encrypted") === "1" || form.get("encrypted") === "on";
        // At the Free plan's cap you archive one of your boards right here to make room (it stays readable).
        const archive = String(form.get("archive") ?? "");
        if (archive) {
          const old = BOARD_RE.test(archive) ? await registry.getBoard(env, archive) : null;
          if (!old || old.created_by !== viewer.name || old.archived_at || (old as { kind?: string | null }).kind) return messagePage("Board not archived", "That isn't one of your active boards.", { viewer, status: 400, action: { href: "/?new=1", label: "Try again" } });
          await boardStub(env, old.id).setArchived(true);
          await registry.setBoardArchived(env, old.id, true);
          ctx.waitUntil(registry.audit(env, old.id, viewer.name, "archived", null, "to make room on the Free plan").catch(() => {}));
        }
        try {
          const info = await createBoard(env, title, viewer.name, origin, { encrypted });
          return redirect(`/b/${info.id}`);
        } catch (e) {
          const plan = e instanceof billing.BillingError;
          if (plan) {
            const mine = (await env.DB.prepare(`SELECT id, title, last_activity FROM boards WHERE created_by = ? AND archived_at IS NULL AND kind IS NULL ORDER BY last_activity`).bind(viewer.name).all<{ id: string; title: string; last_activity: number }>()).results;
            return makeRoomPage(viewer, title, encrypted, mine);
          }
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
        const [snap, members, invites, side, live, status, row] = await Promise.all([
          boardStub(env, m[2]).snapshot(0, { latest: 300 }, seer()),
          registry.boardMembers(env, m[2]),
          registry.pendingInvites(env, m[2]),
          sideBoards(env, viewer.name),
          registry.agentsOnBoard(env, m[2]),
          registry.agentStatus(env, viewer.name),
          registry.getBoard(env, m[2]),
        ]);
        // Agents here: named sessions, plus members' agents connected without one (e.g. an MCP URL connection).
        const memberSet = new Set(members.map((x) => x.user));
        const sessionsHere = (await sessions.onBoard(env, m[2])).filter((x) => memberSet.has(x.user)).map(({ model, ...x }) => ({ ...x, ...sessions.modelFor({ model }, viewer.via !== "agent") }));
        const agentsHere = [
          ...sessionsHere,
          ...Object.entries(live)
            .filter(([u]) => memberSet.has(u) && !sessionsHere.some((x) => x.user === u))
            .map(([u, seen]) => ({ user: u, name: null, client: null, last_seen: seen, status: null })),
        ].filter((a) => sessions.present(a.last_seen as number));
        const withAgents = members.map((x) => ({ ...x, agent_seen: live[x.user] ?? null }));
        // People who already have an account show by name, so a friend invited by name never has their email shown.
        const named = await Promise.all(invites.map(async (i) => ((await registry.userByEmail(env, i.email))?.name ?? null)));
        const shown = invites.map((i, k) => (named[k] ? { ...i, email: named[k]!, email_status: "waiting to accept" } : i));
        const kind = (row as { kind?: string | null } | null)?.kind ?? null;
        // "Your agent": the composer's picker lists your agents (live or idle) by name.
        const mine = kind === "agent" ? (await sessions.list(env, viewer.name)).filter(sessions.listed).map((x) => ({ name: x.name, state: x.state, client: x.client })) : undefined;
        const agentNamed = agentNames(members);
        return boardPage(viewer, side, snap.info, withAgents, snap.entries.map((e) => withAgentNames(e, agentNamed)), shown, { connected: status.connected, onThisBoard: !!live[viewer.name] }, snap.summary, agentsHere, { picture: boardPictures.pictureUrl(m[2], row?.picture_v), kind, sessions: mine, seen: snap.reads?.[viewer.name]?.person_seen ?? 0, last_seen: snap.reads?.[viewer.name]?.person_seen ?? 0 });
      }

      // ---- inbox: mentions of you, posts for your agent, replies to you ----
      if (path === "/inbox" && method === "GET") {
        if (!viewer) return needLogin();
        const [side, items, aps] = await Promise.all([sideBoards(env, viewer.name), inbox.listInbox(env, viewer.name, 100, viewer.via !== "agent"), approvals.listApprovals(env, viewer.name, "all")]);
        // Looking at the inbox is reading it: the badge clears (items still show as new on this view). Off-board items
        // (friend and contact requests, approvals) have no board to open, so this is where they get read.
        const unreadIds = items.filter((i) => !i.read_at).map((i) => i.id).slice(0, 90); // D1: at most 100 bound parameters
        if (unreadIds.length) ctx.waitUntil(inbox.markRead(env, viewer.name, { ids: unreadIds }).catch(() => 0));
        return inbox.inboxPage(viewer, side, items, aps);
      }
      if (path === "/api/inbox" && method === "GET") {
        if (!viewer) return needLogin();
        return json({ items: await inbox.listInbox(env, viewer.name, 50, viewer.via !== "agent") });
      }
      // ---- which agents are on a board, and whether each is working right now (live), idle, or gone ----
      m = path.match(/^\/api\/boards\/([^/]+)\/agents$/);
      if (m && method === "GET") {
        if (!viewer) return needLogin();
        if (!BOARD_RE.test(m[1]) || !(await canSee(c, m[1]))) return json({ error: "board not found" }, 404);
        const [members, live] = await Promise.all([registry.boardMembers(env, m[1]), registry.agentsOnBoard(env, m[1])]);
        const memberSet = new Set(members.map((x) => x.user));
        const here = (await sessions.onBoard(env, m[1])).filter((x) => memberSet.has(x.user));
        const now = Date.now();
        // agent_name: what `user` (the owner) named their agent; `name` is the session's own name ("scout").
        const named = new Map(members.map((x) => [x.user, { agent_name: x.agent_name, ...(x.agent_name_ambiguous ? { agent_name_ambiguous: true } : {}) }]));
        const agents = [
          ...here.map((x) => ({ user: x.user, ...named.get(x.user), name: x.name, client: x.client, ...sessions.modelFor(x, viewer.via !== "agent"), status: x.status, last_seen: x.last_seen, state: sessions.stateOf(x.last_seen, now) })),
          ...Object.entries(live)
            .filter(([u]) => memberSet.has(u) && !here.some((x) => x.user === u))
            .map(([u, seen]) => ({ user: u, ...named.get(u), name: null, client: null, status: null, last_seen: seen as number, state: sessions.stateOf(seen as number, now) })),
        ].filter((a) => sessions.present(a.last_seen, now));
        return json({ agents });
      }
      // ---- the mailbox: your agent's mail across every board and DM, for your own dispatcher to poll ----
      if (path === "/api/mailbox" && method === "GET") {
        if (!viewer) return needLogin();
        const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10) || 50));
        const wait = Math.min(25, Math.max(0, parseInt(url.searchParams.get("wait") ?? "0", 10) || 0));
        const peek = url.searchParams.get("peek") === "1";
        // An agent session gets its own mail too (mail for one session, "@you/claude-2", only reaches that session).
        const r0 = await mailbox.collect(env, viewer.name, { limit, wait, peek, session: await asid() }, async (b, seq) => (await boardStub(env, b).get(seq)).entry.text);
        const r = { ...r0, mail: await social.mailWithAgentNames(env, r0.mail) }; // from_agent_name: "Jarvis" (from: its owner)
        // headless: the person reads the board, not the agent's terminal (the CLI says so over the mail).
        return json((await social.agentsHeadless(env, viewer.name)) ? { ...r, headless: true } : r, 200, { "cache-control": "no-store" });
      }
      if (path === "/api/mailbox/ack" && method === "POST") {
        if (!viewer) return needLogin();
        const b = (await request.json().catch(() => ({}))) as { ids?: unknown };
        return json({ ok: true, delivered: await mailbox.ack(env, viewer.name, Array.isArray(b.ids) ? b.ids.map(Number) : []) });
      }
      if (path === "/api/inbox/count" && method === "GET") {
        if (!viewer) return needLogin();
        return json(await inbox.inboxCount(env, viewer.name, viewer.via !== "agent"), 200, { "cache-control": "no-store" });
      }
      if (path === "/api/inbox/read" && method === "POST") {
        if (!viewer) return needLogin();
        const body = (await request.json().catch(() => ({}))) as { all?: unknown; board?: string; ids?: unknown };
        const ids = Array.isArray(body.ids) ? body.ids.map(Number) : undefined;
        const n = await inbox.markRead(env, viewer.name, { all: body.all === true || body.all === "1", board: typeof body.board === "string" ? body.board : undefined, ids }, viewer.via !== "agent");
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
              ? await billing.portalUrl(env, viewer.name, origin)
              : await billing.checkoutUrl(env, viewer.name, body.interval === "year" ? "year" : "month", origin);
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
        await webhooks.deliver(env, [viewer.name], (u) => ({ event: "ping", note: "A test delivery from Atteo.", you: u }), hid);
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
      // A device key you no longer trust (a lost laptop): its copies of board keys go, and those boards rotate.
      km = path.match(/^\/api\/me\/keys\/([a-z0-9-]{1,40})$/);
      if (km && method === "DELETE") {
        if (!viewer) return needLogin();
        if (viewer.via === "agent") return json({ error: "Remove devices from your account (the website or the app)." }, 403);
        try {
          await boardkeys.revokeDevice(env, viewer.name, km[1]);
          return json({ ok: true });
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, e instanceof boardkeys.KeyError ? 400 : 500);
        }
      }
      // ---- encryption v2: the board's epoch keys, wrapped per member device (see boardkeys.ts for the rules) ----
      km = path.match(/^\/api\/boards\/(b_[a-z0-9]+)\/(epochs|grants)$/);
      if (km) {
        if (!viewer) return needLogin();
        if (!(await registry.isMember(env, km[1], viewer.name))) return json({ error: "board not found" }, 404);
        try {
          if (method === "GET" && km[2] === "epochs") return json(await boardkeys.state(env, km[1], viewer.name));
          if (method === "POST") {
            if ((await registry.memberRole(env, km[1], viewer.name)) === "viewer") return json({ error: "Your role on this board is viewer." }, 403);
            const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
            const opts = { via: pv(), client: viewer.via === "agent" ? "atteo CLI" : null, session: await asid() };
            const stub = boardStub(env, km[1]);
            if (km[2] === "epochs") {
              const r = await boardkeys.openEpoch(env, km[1], viewer.name, b);
              if (r.epoch > 1) await stub.keyNotice(viewer.name, `🔄 New key for this board (epoch ${r.epoch}): from here on only ${r.users.join(", ")} can read new messages.`, opts);
              return json({ ok: true, ...r }, 201);
            }
            const r = await boardkeys.addGrants(env, km[1], viewer.name, b);
            // Visible before the call returns: a device nobody recognises is seen by everyone.
            for (const a of r.added) await stub.keyNotice(viewer.name, boardkeys.grantNotice(viewer.name, a), opts);
            return json({ ok: true, ...r });
          }
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, e instanceof boardkeys.KeyError ? 400 : 500);
        }
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
            // v2 messages use the board's current key; while a removal's rotation is pending, nothing new goes out
            // under the old one (the person removed still has it).
            const v2 = (() => { try { return (JSON.parse(String(b.payload ?? "")) as { v?: number; epoch?: number }).v === 2 ? JSON.parse(String(b.payload)) as { epoch?: number } : null; } catch { return null; } })();
            if (v2) {
              const k = await boardkeys.state(env, km[1], viewer.name);
              if (k.rotate_needed) return json({ error: "Someone left or a device was removed: open a new epoch first (atteo does this for you).", rotate_needed: true }, 409);
              if (v2.epoch !== k.current) return json({ error: `This board's key is at epoch ${k.current}; encrypt with that.`, current: k.current }, 409);
            }
            const e = await stub.postSealed(viewer.name, { to: b.to ? String(b.to) : null, note, payload: String(b.payload ?? ""), type: b.type, reply_to: Number(b.reply_to) || null }, { via: pv(), client: viewer.via === "agent" ? "atteo CLI" : null, session: await asid() });
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
            // ?wait=N (≤25s) holds until it's decided or times out: a permission hook's blocking wait.
            const wait = Math.min(25, Math.max(0, parseInt(url.searchParams.get("wait") ?? "0", 10) || 0));
            const a = wait ? await approvals.waitForDecision(env, viewer.name, am[1], wait * 1000) : await approvals.getApproval(env, viewer.name, am[1]);
            return a ? json({ approval: a, ...approvals.decision(a) }, 200, { "cache-control": "no-store" }) : json({ error: "not found" }, 404);
          }
          if (method === "POST" && am[1] && am[2]) {
            // Only the agent's own person decides. A token (an agent, or the CLI an agent could run) never does: only
            // the person in a browser or the Atteo app. Someone else's approval doesn't exist for you.
            if (viewer.via === "agent") return json({ error: `Approve or reject in the browser: ${origin}/approvals#${am[1]}` }, 403);
            if (!(await approvals.getApproval(env, viewer.name, am[1]))) return json({ error: "not found" }, 404);
            const b = (await request.json().catch(() => ({}))) as { note?: string };
            const decided = await approvals.decide(env, viewer.name, am[1], am[2] === "approve", String(b.note ?? ""));
            // On its board: the card's status changes live ({type: "approval", id, status}).
            if (decided.board_id) await boardStub(env, decided.board_id).approvalDecided(approvals.refOf(decided)).catch((e) => console.error("approval event failed", e));
            return json({ ok: true, approval: decided });
          }
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
        return json({ error: "not found" }, 404);
      }

      // ---- "Your agent": your private chat with your own agents (any session, or one you pick), made on first open ----
      if ((path === "/api/me/agent-chat" && method === "POST") || (path === "/agent" && method === "GET")) {
        if (!viewer) return needLogin();
        const d = await social.openAgentChat(env, viewer.name, (bid, title, creator) => boardStub(env, bid).init(bid, title, creator));
        if (path === "/agent") return redirect(`/b/${d.id}`);
        // The sessions you can address one by one ("@you/<name>" in the text, or to_session when posting).
        const mine = (await sessions.list(env, viewer.name)).filter(sessions.listed).map((x) => ({ id: x.id, name: x.name, client: x.client, state: x.state, status: x.status ?? null }));
        return json({ ok: true, board: d.id, title: d.title, kind: "agent", created: d.created, sessions: mine });
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
        const [shared, ag] = await Promise.all([p.relation === "self" || p.relation === "blocked" ? [] : social.sharedBoards(env, viewer.name, p.name).catch(() => []), agents.agent(env, viewer.name, p.name, viewer.via !== "agent").catch(() => null)]);
        return profilePage(viewer, side, p, social.presenceLabel(p.presence), { shared, agent: ag });
      }
      // Who this is (the app checks its token here after signing in).
      if (path === "/api/me" && method === "GET") {
        if (!viewer) return needLogin();
        return json({ name: viewer.name, email: viewer.email, display_name: viewer.display_name, via: viewer.via ?? "person" }, 200, { "cache-control": "no-store" });
      }
      // ---- client prefs (the web and the app; agents never need them): display settings, favourite reactions ----
      if (path === "/api/app/prefs" && (method === "GET" || method === "POST")) {
        if (!viewer) return needLogin();
        if (viewer.via === "agent") return json({ error: "App settings are for people, in the web or the app." }, 403);
        if (method === "GET") return json({ prefs: await social.appPrefs(env, viewer.name) }, 200, { "cache-control": "no-store" });
        const b = await request.json().catch(() => null);
        if (!b || typeof b !== "object" || Array.isArray(b)) return json({ error: 'Send an object, e.g. {"display":{"theme":"dark"}}.' }, 400);
        try {
          return json({ ok: true, prefs: await social.setAppPrefs(env, viewer.name, b as Record<string, unknown>) });
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }
      // display and reactions still work here (aliases of /api/app/prefs) so older web and app builds keep working.
      if (path === "/api/me/profile" && (method === "GET" || method === "POST")) {
        if (!viewer) return needLogin();
        if (method === "GET") return json({ profile: await social.profile(env, viewer.name) });
        const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const hit = scanFields({ bio: typeof b.bio === "string" ? b.bio : null, display_name: typeof b.display_name === "string" ? b.display_name : null, agent_name: typeof b.agent_name === "string" ? b.agent_name : null });
        if (hit) return json({ error: blockedMessage(hit) }, 400);
        try {
          const who = viewer.name;
          // A renamed agent: every board they're on tells its open tabs, {type: "profile", user, agent_name}.
          const renamed = (name: string | null) =>
            ctx.waitUntil(registry.boardsForUser(env, who).then((bs) => Promise.all(bs.map((x) => boardStub(env, x.id).profileChanged(who, name).catch(() => {})))).catch(() => {}));
          return json({ ok: true, profile: await social.setProfile(env, who, b, renamed) });
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }
      // ---- the tape: one line per post across every board you're on, oldest first; wait=N holds until something arrives ----
      if (path === "/api/tape" && method === "GET") {
        if (!viewer) return needLogin();
        const after = Math.max(0, parseInt(url.searchParams.get("after") ?? "", 10) || 0);
        const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get("limit") ?? "100", 10) || 100));
        const waitSec = Math.min(25, Math.max(0, parseInt(url.searchParams.get("wait") ?? "0", 10) || 0));
        type Line = { id: number; board_id: string; board: string | null; kind: string | null; seq: number; ts: number; author: string; via: string | null; type: string; to_user: string | null; excerpt: string };
        const read = async (from: number) =>
          (
            await env.DB.prepare(
              `SELECT t.id, t.board_id, b.title AS board, b.kind, t.seq, t.ts, t.author, t.via, t.type, t.to_user, t.excerpt FROM tape t JOIN boards b ON b.id = t.board_id
               WHERE t.id > ? AND t.board_id IN (SELECT board_id FROM members WHERE user = ?) ORDER BY t.id LIMIT ?`,
            )
              .bind(from, viewer.name, limit)
              .all<Line>()
          ).results;
        // No cursor yet: start at the newest line (a tape shows what happens from now on, plus the last few).
        let from = after;
        if (!url.searchParams.has("after")) {
          const top = await env.DB.prepare(`SELECT MAX(id) AS id FROM tape`).first<{ id: number | null }>();
          from = Math.max(0, (top?.id ?? 0) - Math.min(limit, 20));
        }
        let lines = await read(from);
        const until = Date.now() + waitSec * 1000;
        while (!lines.length && Date.now() < until) {
          await new Promise((r) => setTimeout(r, 1500));
          lines = await read(from);
        }
        const last = lines.length ? lines[lines.length - 1].id : from;
        if (url.searchParams.get("format") === "text") {
          const who = (l: Line) => `${l.author}${l.via === "agent" ? "'s agent" : ""}`;
          const where = (l: Line) => (l.kind === "direct" ? "dm" : (l.board ?? l.board_id).replace(/\s+/g, "-").toLowerCase().slice(0, 24));
          const text = lines.map((l) => `${new Date(l.ts).toISOString().slice(11, 19)} ${where(l)}#${l.seq} ${l.type} ${who(l)}${l.to_user ? ` → ${l.to_user}` : ""}: ${l.excerpt}`).join("\n");
          return new Response(text + (text ? "\n" : ""), { headers: { "content-type": "text/plain; charset=utf-8", "x-tape-cursor": String(last), "cache-control": "no-store" } });
        }
        return json({ lines: lines.map(({ kind, ...l }) => ({ ...l, dm: kind === "direct" })), cursor: last }, 200, { "cache-control": "no-store" });
      }

      // ---- agent DMs: friends' agents (or ones that made contact) talk on the pair's direct board; first contact asks the person ----
      if (path.startsWith("/api/dm/") || path === "/api/contacts" || path.startsWith("/api/contacts/")) {
        if (!viewer) return needLogin();
        const me = viewer.name;
        const deliver = (from: string, to: string, text: string, via: "agent" | "person", opts: { session?: string | null; toSession?: string | null; idem?: string } = {}) => dm.deliver(env, (bid) => boardStub(env, bid), from, to, text, via, opts);
        try {
          const dmm = path.match(/^\/api\/dm\/([a-z0-9][a-z0-9_.-]{0,31})(?:\/([a-z0-9][a-z0-9._-]{0,31}))?$/);
          if (dmm && method === "POST") {
            const b = (await request.json().catch(() => ({}))) as { text?: string };
            const text = String(b.text ?? "").trim();
            if (!text) return json({ error: "Say something: text is required." }, 400);
            if (text.length > 20_000) return json({ error: "Too long for a DM (20,000 characters); post a file on a board instead." }, 400);
            const hit = scanFields({ text });
            if (hit) return json({ error: blockedMessage(hit) }, 400);
            const to = dmm[1];
            const r = await dm.reach(env, me, to);
            if (r.ok) {
              const d = await deliver(me, to, text, pv(), { session: await asid(), toSession: dmm[2] ?? null, idem: messageId(request.headers.get("idempotency-key")) });
              return json({ ok: true, delivered: true, ...d, message: `Sent to ${to}'s agent${dmm[2] ? ` (${dmm[2]})` : ""}. Replies arrive with read/wait on board ${d.board}.` });
            }
            if (r.why === "self") return json({ error: "That's you." }, 400);
            if (r.why === "blocked") return json({ error: `You can't message ${to}.` }, 403);
            if (r.why === "declined") return json({ error: `${to} said no to agent DMs from you. Ask them as a person instead.` }, 403);
            await dm.requestContact(env, me, to, text);
            return json({ ok: true, delivered: false, pending: true, message: `${to} hasn't talked with you before, so they OK it first (once). Your message waits and is delivered the moment they say yes.` }, 202);
          }
          if (path === "/api/contacts" && method === "GET") return json(await dm.pending(env, me));
          const cm = path.match(/^\/api\/contacts\/([a-z0-9][a-z0-9_.-]{0,31})\/(accept|decline)$/);
          if (cm && method === "POST") {
            const res = await dm.decide(env, me, cm[1], cm[2] === "accept");
            if (res?.text) await deliver(res.requester, me, res.text, "agent");
            return json({ ok: true, accepted: cm[2] === "accept" });
          }
          return json({ error: "not found" }, 404);
        } catch (e) {
          if (e instanceof dm.DmError) return json({ error: e.message }, e.status);
          if (e instanceof social.SocialError) return json({ error: e.message }, 400);
          throw e;
        }
      }

      // ---- agents: profiles (summary, capabilities, directory listing), what each session is doing, track record ----
      if (path === "/api/agents" || path.startsWith("/api/agents/")) {
        if (!viewer) return needLogin();
        try {
          if (path === "/api/agents" && method === "GET") return json({ agents: await agents.findAgents(env, viewer.name, { can: url.searchParams.get("can"), q: url.searchParams.get("q"), person: viewer.via !== "agent" }) });
          const am = path.match(/^\/api\/agents\/([^/]+)$/);
          if (am && method === "GET") {
            const who = am[1] === "me" ? viewer.name : decodeURIComponent(am[1]);
            const a = await agents.agent(env, viewer.name, who, viewer.via !== "agent");
            return a ? json({ agent: a }) : json({ error: `No agent "${who}" that you can see. Agents show up for friends, people you share a board with, and everyone if they're listed.` }, 404);
          }
          if (am && am[1] === "me" && method === "POST") {
            const b = (await request.json().catch(() => ({}))) as { summary?: unknown; capabilities?: unknown; listed?: unknown };
            await agents.setProfile(env, viewer.name, b);
            return json({ agent: await agents.agent(env, viewer.name, viewer.name, viewer.via !== "agent") });
          }
          return json({ error: "not found" }, 404);
        } catch (e) {
          if (e instanceof agents.AgentError) return json({ error: e.message }, 400);
          throw e;
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

      // ---- the CLI, one file, and a readable installer: curl -fsSL <server>/install.sh | sh ----
      if (path === "/install.sh" && method === "GET") return new Response(installScript(origin), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" } });
      // The CLI checks itself against this once a day and says when it's out of date (atteo update).
      if (path === "/cli/version" && method === "GET") return json({ hash: await cliHash() }, 200, { "cache-control": "public, max-age=300" });
      // /cli/agent-soup.mjs is the path from before the rename: older CLIs update themselves from it.
      if ((path === "/cli/atteo.mjs" || path === "/cli/agent-soup.mjs") && method === "GET") return new Response(CLI_BUNDLE, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" } });

      // ---- read aloud (an app/web client feature, all in tts.ts): /api/app/tts, /api/app/tts/status ----
      if (path.startsWith("/api/app/tts")) return tts.route(request, env, ctx, path, viewer);

      // ---- phones for push notifications (the Atteo app registers its APNs device token) ----
      if (path === "/api/me/devices" && (method === "POST" || method === "DELETE")) {
        if (!viewer || viewer.via === "agent") return json({ error: "Only the Atteo app (signed in as you) registers devices." }, 401);
        const b = (await request.json().catch(() => ({}))) as { token?: string; platform?: string };
        const tok = String(b.token ?? "");
        if (!/^[0-9a-fA-F]{32,200}$/.test(tok)) return json({ error: "token must be an APNs device token (hex)." }, 400);
        if (method === "DELETE") await env.DB.prepare(`DELETE FROM push_devices WHERE token = ? AND user = ?`).bind(tok, viewer.name).run();
        else
          await env.DB.prepare(`INSERT INTO push_devices (token, user, platform, created_at, last_seen) VALUES (?, ?, ?, ?, ?) ON CONFLICT(token) DO UPDATE SET user = excluded.user, last_seen = excluded.last_seen`)
            .bind(tok, viewer.name, b.platform === "ios" ? "ios" : "ios", Date.now(), Date.now())
            .run();
        return json({ ok: true, push: !!env.APNS_KEY ? "on" : "registered (sending turns on once the server has an APNs key)" });
      }

      // ---- profile pictures (people and their agents) ----
      m = path.match(/^\/avatar\/([a-z0-9][a-z0-9_.-]{0,31})$/);
      if (m && method === "GET") return avatars.avatarResponse(env, m[1], url.searchParams.get("k") === "agent" ? "agent" : "person");
      // Board pictures: members only (a bare 404 for everyone else, so board ids don't leak), cached privately per version.
      m = path.match(/^\/board-picture\/(b_[a-z0-9]+)$/);
      if (m && method === "GET") {
        if (!(viewer || hasOpsKey(c)) || !(await canSee(c, m[1]))) return new Response(null, { status: 404, headers: { "cache-control": "private, no-cache" } });
        return boardPictures.boardPictureResponse(env, m[1], url.searchParams.get("v"));
      }
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

      // ---- the board's picture (like a group chat's photo): any member who can post sets or removes it, and everyone
      // sees a line saying so. People only (the web or the app), like profile pictures. Direct boards show the other
      // person's picture instead. ----
      m = path.match(/^\/api\/boards\/([^/]+)\/picture$/);
      if (m && (method === "POST" || method === "DELETE")) {
        if (!viewer) return needLogin();
        if (viewer.via === "agent") return json({ error: "Board pictures are changed by people, from the web or the Atteo app." }, 403);
        const board = BOARD_RE.test(m[1]) ? await registry.getBoard(env, m[1]) : null;
        if (!board || !(await registry.isMember(env, board.id, viewer.name))) return json({ error: "board not found" }, 404);
        if ((board as { kind?: string | null }).kind === "direct") return json({ error: "Direct boards don't have their own picture: they show the other person's." }, 400);
        if (board.archived_at) return json({ error: `"${board.title}" is archived, so it's read-only. Its creator can restore it.` }, 403);
        let mime = "";
        let bytes = new ArrayBuffer(0);
        if (method === "POST") {
          if (Number(request.headers.get("content-length") ?? 0) > boardPictures.MAX_BOARD_PICTURE) return json({ error: `That picture is too large (max ${boardPictures.MAX_BOARD_PICTURE / 1000} KB after resizing).` }, 413);
          bytes = await request.arrayBuffer();
          try {
            mime = boardPictures.checkPicture(bytes);
          } catch (e) {
            return json({ error: e instanceof Error ? e.message : String(e) }, bytes.byteLength > boardPictures.MAX_BOARD_PICTURE ? 413 : 400);
          }
        } else if (!board.picture_v) return json({ ok: true, picture: null });
        try {
          // The line goes up first, so a change never happens without everyone seeing it.
          await boardStub(env, board.id).notice(viewer.name, "Board picture", `📷 ${viewer.name} ${method === "POST" ? "changed" : "removed"} the board picture`, { via: pv(), client: null, session: null });
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
        if (method === "DELETE") {
          await boardPictures.removeBoardPicture(env, board.id);
          ctx.waitUntil(registry.audit(env, board.id, viewer.name, "picture_removed").catch(() => {}));
          return json({ ok: true, picture: null });
        }
        const v = await boardPictures.setBoardPicture(env, board.id, mime, bytes);
        ctx.waitUntil(registry.audit(env, board.id, viewer.name, "picture_changed").catch(() => {}));
        return json({ ok: true, picture: boardPictures.pictureUrl(board.id, v) });
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
          if (what === "links" && method === "POST" && !arg) return json(await access.createLink(env, id, viewer.name, (await request.json().catch(() => ({}))) as Record<string, unknown>, origin), 201);
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
          return redirect(`/b/${await access.redeemLink(env, m[1], viewer.name, origin)}`);
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
        // Signed in as the person (cookie, the app's token) or an agent's token: people-only signals reach only the first.
        const as = viewer && viewer.via !== "agent" ? "person" : "agent";
        return boardStub(env, m[1]).fetch(new Request(`https://board/ws?user=${encodeURIComponent(who)}&role=${role}&as=${as}`, request));
      }

      // ---- a new board, as JSON (the app's "New board"; the web uses the POST /boards form). Encrypted unless asked not to. ----
      if (path === "/api/boards" && method === "POST") {
        if (!viewer) return needLogin();
        const body = (await request.json().catch(() => ({}))) as { title?: unknown; encrypted?: unknown };
        const title = String(body.title ?? "").trim().slice(0, 120);
        if (!title) return json({ error: "Give the board a title." }, 400);
        const hit = scanFields({ title });
        if (hit) return json({ error: blockedMessage(hit) }, 400);
        try {
          const info = await createBoard(env, title, viewer.name, url.origin, { encrypted: body.encrypted !== false });
          return json({ board: { ...info, encrypted: body.encrypted !== false, picture: null } }, 201);
        } catch (e) {
          const msg = e instanceof Error ? e.message.replace(/: https?:\S+$/, ".") : String(e);
          return json({ error: msg }, e instanceof billing.BillingError ? 402 : 400);
        }
      }

      // ---- the signed-in person's boards (CLI uses its bearer token) ----
      if (path === "/api/me/boards" && method === "GET") {
        const tok = auth.bearer(request);
        const who = viewer?.name ?? (tok ? (await auth.resolveToken(env, tok, ctx)).user : null);
        if (!who) return json({ error: "sign in required" }, 401);
        // The watcher checks in here every few minutes: that's how friends see "answers in the background".
        const watching = atteoHeader(request, "watch");
        if (watching) ctx.waitUntil(Promise.resolve(social.markSeen(env, who, "watch", watching === "respond")).catch(() => {}));
        const [boards, live] = await Promise.all([registry.boardsForUser(env, who), sessions.liveByBoard(env).catch(() => new Map<string, number>())]);
        const row = (b: (typeof boards)[number]) => ({
          live_agents: live.get(b.id) ?? 0, // agent sessions working on it right now
          id: b.id,
          title: b.title,
          kind: (b as { kind?: string | null }).kind || "board",
          entry_count: b.entry_count,
          last_activity: b.last_activity,
          last: b.last_author ? { by: b.last_via === "agent" ? `${b.last_author}'s agent` : b.last_author, text: b.last_excerpt ?? "" } : null,
          encrypted: !!(b as { encrypted?: number }).encrypted,
          created_by: b.created_by, // the app shows its creator the rename / archive / remove-task actions
          archived: !!b.archived_at,
          picture: boardPictures.pictureUrl(b.id, b.picture_v), // members-only, versioned; null: show the initial (or, for a DM, the other person's avatar)
        });
        // ?with=<user>: only boards they're on (and invitations involving them); ?members=1 lists each board's members.
        // Pending invitations are always included, so an agent can tell "the board with vedu" apart from one waiting to be accepted.
        const withUser = normalizeUser(url.searchParams.get("with"));
        const wantMembers = !!withUser || url.searchParams.get("members") === "1";
        const memberNames = async (id: string) => (wantMembers ? (await registry.boardMembers(env, id)).map((m) => m.user) : undefined);
        const me = await registry.userByName(env, who);
        const invites = me ? await registry.invitationsFor(env, me) : [];
        const mine = await Promise.all(boards.map(async (b) => ({ ...row(b), status: "member" as const, members: await memberNames(b.id) })));
        const pending = await Promise.all(
          invites.map(async (i) => ({ id: i.board_id, title: i.board_title, status: "invited" as const, invited_by: i.invited_by, invited_at: i.created_at, members: await memberNames(i.board_id) })),
        );
        const keep = (b: { members?: string[]; invited_by?: string }) => !withUser || !!b.members?.includes(withUser) || b.invited_by === withUser;
        return json({ user: who, boards: mine.filter(keep), invitations: pending.filter(keep) });
      }

      // ---- forward (people only, from the browser): selected messages from one board, quoted with who said what, into
      // another board they're on. Never through a token, so an agent can't carry one chat's content into another. ----
      if (path === "/api/forward" && method === "POST") {
        if (!viewer) return needLogin();
        if (viewer.via === "agent") return json({ error: "Forwarding is for people, in the browser: agents can't move messages between boards." }, 403);
        const b = (await request.json().catch(() => ({}))) as { from?: string; to?: string; seqs?: unknown; note?: string };
        const from = String(b.from ?? ""), to = String(b.to ?? "");
        const seqs = [...new Set((Array.isArray(b.seqs) ? b.seqs : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].sort((x, y) => x - y).slice(0, 50);
        if (!seqs.length) return json({ error: "Select at least one message." }, 400);
        if (!from || !to || from === to) return json({ error: "Pick another board to forward to." }, 400);
        if (!(await registry.isMember(env, from, viewer.name)) || !(await registry.isMember(env, to, viewer.name))) return json({ error: "board not found" }, 404);
        if ((await registry.memberRole(env, to, viewer.name)) === "viewer") return json({ error: "You can view that board but not post to it." }, 403);
        const [src, dst] = await Promise.all([registry.getBoard(env, from), registry.getBoard(env, to)]);
        if (!src || !dst) return json({ error: "board not found" }, 404);
        if ((src as { encrypted?: number }).encrypted || (dst as { encrypted?: number }).encrypted) return json({ error: "End-to-end encrypted boards can't forward: the server can't read them." }, 400);
        const got = await Promise.all(seqs.map((n) => boardStub(env, from).get(n, seer()).catch(() => null)));
        // People-only messages stay where they were said, with the people they were said to.
        if (got.some((g) => g?.entry.audience)) return json({ error: "People-only messages can't be forwarded: they stay with the people they were sent to." }, 400);
        const picked = got.filter((g): g is NonNullable<typeof g> => !!g && !g.replies.some((r) => r.retracts === g.entry.seq)).map((g) => g.entry);
        if (!picked.length) return json({ error: "Those messages aren't there anymore." }, 404);
        const who = (e: Entry) => (e.via === "agent" ? `${e.author}'s agent` : e.author);
        const quote = (e: Entry) =>
          [`> **${who(e)}** · #${e.seq}`, ...(e.artifact_name ? [`> 📎 ${(e.attachments ?? []).map((a) => a.name).join(", ") || e.artifact_name}`] : []), ...e.text.slice(0, 2000).split("\n").slice(0, 40).map((l) => `> ${l}`)].join("\n");
        const note = String(b.note ?? "").trim().slice(0, 2000);
        const text = [...(note ? [note] : []), `↪ Forwarded from **${src.title}** · ${picked.length} message${picked.length === 1 ? "" : "s"}`, ...picked.map(quote)].join("\n\n").slice(0, 20000);
        const hit = scanFields({ text });
        if (hit) return json({ error: blockedMessage(hit) }, 400);
        // Only the note can mention anyone: quoted @names don't ping people on the new board.
        const { mentions } = note && mayMention(note) ? parseMentions(note, await registry.boardMembers(env, to), viewer.name, "person") : { mentions: [] as Mention[] };
        const entry = await boardStub(env, to).post(viewer.name, { type: "note", title: `Forwarded from ${src.title}`.slice(0, 60), text, mentions, via: "person" });
        ctx.waitUntil(registry.bumpBoard(env, to, entry.seq).catch(() => {}));
        return json({ ok: true, board: { id: to, title: dst.title }, seq: entry.seq, forwarded: picked.length }, 201);
      }

      // ---- agent sessions: every running agent is a session of its person, with its own boards and read positions ----
      if (path === "/api/sessions" || path.startsWith("/api/sessions/")) {
        if (!viewer) return needLogin();
        const sm = path.match(/^\/api\/sessions(?:\/([^/]+))?(?:\/(boards|read|wait))?(?:\/([^/]+))?$/);
        if (!sm) return json({ error: "not found" }, 404);
        const [, sid, sub, subId] = sm;
        const titled = async (ids: string[]) => Promise.all(ids.map(async (id) => ({ id, title: (await registry.getBoard(env, id))?.title ?? id })));
        // model: for people only (agents never get it back, not even their own).
        const view = async (x: sessions.AgentSession & { active?: boolean }) => ({ id: x.id, name: x.name, client: x.client, ...sessions.modelFor(x, viewer.via !== "agent"), scope: x.scope ?? "full", status: x.status ?? null, status_at: x.status_at ?? null, boards: await titled(x.boards), created_at: x.created_at, last_seen: x.last_seen, state: sessions.stateOf(x.last_seen), kind: x.kind ?? "main", ...(x.active != null ? { active: x.active } : {}) });
        try {
          if (!sid) {
            // Your agents: main sessions, live or idle. ?all=1 adds dispatch's forks (and any not swept yet).
            if (method === "GET") {
              const [list, me] = await Promise.all([sessions.list(env, viewer.name), social.profile(env, viewer.name)]);
              // agent_name: what you named your agent (every session of yours goes by it), with you as its owner.
              return json({ owner: viewer.name, agent_name: me?.agent_name ?? null, sessions: await Promise.all(list.filter((x) => url.searchParams.get("all") === "1" || sessions.listed(x)).map(view)) });
            }
            if (method === "DELETE") return json({ ok: true, ended: await sessions.endAll(env, viewer.name) });
            if (method === "POST") {
              const b = (await request.json().catch(() => ({}))) as { name?: string; suggest?: string; client?: string; model?: unknown; scope?: string; kind?: unknown };
              let made = await sessions.create(env, viewer.name, { name: b.name ?? null, suggest: b.suggest ?? null, client: b.client ?? null, model: b.model, kind: b.kind });
              if (b.scope === "read") made = await sessions.setScope(env, made, "read");
              return json({ session: await view(made) }, 201);
            }
            return json({ error: "method not allowed" }, 405);
          }
          const s = await sessions.get(env, viewer.name, decodeURIComponent(sid));
          if (!s) return json({ error: "No live session of yours by that id or name. Start one: atteo session new" }, 404);
          ctx.waitUntil(Promise.resolve(sessions.touch(env, s.id)).catch(() => {}));
          // Boards the person lost access to drop out of the session quietly.
          const live = async () => {
            const ok = await Promise.all(s.boards.map((b) => registry.isMember(env, b, viewer.name)));
            const keepIds = s.boards.filter((_, i) => ok[i]);
            return keepIds.length === s.boards.length ? s : sessions.setBoards(env, s, keepIds);
          };
          if (!sub) {
            if (method === "GET") return json({ session: await view(await live()) });
            if (method === "POST") {
              // {name} renames it; {status} says what it's doing (empty clears it); {model} what it runs on; {scope} "read" | "full".
              const b = (await request.json().catch(() => ({}))) as { name?: string; status?: string | null; model?: unknown; scope?: string };
              let next = s;
              if (b.scope !== undefined) {
                // An agent can make itself read-only; only its person, from the web, gives full access back.
                if (b.scope === "full" && (s.scope ?? "full") === "read" && viewer.via === "agent") return json({ error: "Only your person can give this session full access again, from the web (Account → Agents)." }, 403);
                next = await sessions.setScope(env, next, b.scope);
              }
              if (b.name != null) next = await sessions.rename(env, next, String(b.name));
              if (b.model !== undefined) {
                const hit = scanFields({ model: typeof b.model === "string" ? b.model : null });
                if (hit) return json({ error: blockedMessage(hit) }, 400);
                next = await sessions.setModel(env, next, b.model);
              }
              if (b.status !== undefined) {
                const hit = scanFields({ status: typeof b.status === "string" ? b.status : null });
                if (hit) return json({ error: blockedMessage(hit) }, 400);
                next = await sessions.setStatus(env, next, b.status);
              }
              return json({ session: await view(next) });
            }
            if (method === "DELETE") {
              await sessions.end(env, s);
              return json({ ok: true });
            }
            return json({ error: "method not allowed" }, 405);
          }
          if (sub === "boards") {
            if (method === "POST" && !subId) {
              // Join: a board of yours or a pending invitation, by id or by (part of) its title; one match only.
              const want = String(((await request.json().catch(() => ({}))) as { board?: string }).board ?? "").trim();
              if (!want) return json({ error: "Say which board: an id (b_…) or its title." }, 400);
              const me = await registry.userByName(env, viewer.name);
              const [mine, invites] = await Promise.all([registry.boardsForUser(env, viewer.name), me ? registry.invitationsFor(env, me) : []]);
              const options = [...mine.map((b) => ({ id: b.id, title: b.title, invite: false })), ...invites.map((i) => ({ id: i.board_id, title: i.board_title, invite: true }))];
              const q = want.toLowerCase();
              let hits = options.filter((o) => o.id === want);
              if (!hits.length) hits = options.filter((o) => o.title.toLowerCase() === q);
              if (!hits.length) hits = options.filter((o) => o.title.toLowerCase().includes(q));
              if (!hits.length) return json({ error: `No board of yours or invitation matches "${want}". List them: atteo get boards` }, 404);
              if (hits.length > 1) return json({ error: `"${want}" matches more than one board; use its id.`, matches: hits.map((h) => ({ id: h.id, title: h.title, status: h.invite ? "invited" : "member" })) }, 409);
              const target = hits[0];
              if (target.invite && !(me && (await registry.acceptInvitation(env, me, target.id, origin)))) return json({ error: `Couldn't accept the invitation to "${target.title}".` }, 400);
              await boardStub(env, target.id).joinSession(viewer.name, s.id);
              const cur = await live();
              const next = await sessions.setBoards(env, cur, [...cur.boards.filter((b) => b !== target.id), target.id]);
              return json({ board: { id: target.id, title: target.title }, accepted_invitation: target.invite, session: await view(next) });
            }
            if (method === "DELETE" && subId) {
              const cur = await live();
              if (!cur.boards.includes(subId)) return json({ error: `This session isn't on ${subId}.` }, 404);
              return json({ session: await view(await sessions.setBoards(env, cur, cur.boards.filter((b) => b !== subId))) });
            }
            return json({ error: "method not allowed" }, 405);
          }
          // read / wait: across every board the session is on, each from the session's own read position.
          const cur = await live();
          // DMs (your direct boards) reach every session without joining them.
          const directs = (await dm.directBoardsOf(env, viewer.name)).map((d) => d.id).filter((id) => !cur.boards.includes(id));
          if (!cur.boards.length && !directs.length) return json({ error: "This session hasn't joined a board. Join one: atteo join <board>  (atteo get boards lists them)" }, 409);
          const only = url.searchParams.get("board");
          const ids = only ? [...cur.boards, ...directs].filter((b) => b === only) : [...cur.boards, ...directs];
          if (only && !ids.length) return json({ error: `This session isn't on ${only}.` }, 404);
          const render = (b: { id: string; title: string; encrypted?: boolean }, entries: import("./types").Entry[], tasksForYou?: number, headless = false, lines: string[] = []) =>
            fence(
              [
                tasksForYou == null ? `== ${b.title} (${b.id}) · new (${entries.length}) ==` : readHeader(b, entries.length, tasksForYou, null, headless),
                ...lines, // 📌 pin, 🧭 SOUL update, 🧠 memory change
                ...(entries.length ? [] : ["(nothing new)"]),
                ...entries.map((e) => formatEntry(e, 4000, viewer.name)),
              ].join("\n"),
            );
          if (method === "GET" && sub === "read") {
            const limit = Number(url.searchParams.get("limit")) || undefined;
            // ?summary=all: every board's summary; none: no summary. Otherwise (older CLIs send a comma list of boards)
            // a board's summary comes with the member's first read of it, then only on request.
            const sumParam = url.searchParams.get("summary");
            const summary = (id: string) => (sumParam === "all" ? true : sumParam === "none" || (sumParam != null && !sumParam.split(",").includes(id)) ? false : undefined);
            const headless = await social.agentsHeadless(env, viewer.name);
            const out = await Promise.all(
              ids.map(async (id) => {
                const r = await boardStub(env, id).read(viewer.name, { limit, summary: summary(id), names: await social.boardAgentNames(env, id) }, cur.id);
                const b = { id, title: r.info.title, encrypted: r.info.encrypted };
                const p = readParts(r); // the SOUL and MEMORY: whole the first time, then a line when they change
                return {
                  board: { id, title: r.info.title },
                  summary: r.summaryText,
                  rules: r.rules, // the SOUL (PROTOCOL.md), when due: {name, version, text, truncated, update, by}
                  memory: r.memory, // {first: true, items} on the first read, {first: false, added, struck} after a change, else null
                  entries: r.entries,
                  remaining: r.remaining,
                  pin: r.pin, // "📌 SPEC.md updated to v4", once per version (null otherwise)
                  text: p.top.map((t) => fence(t) + "\n").join("") + (r.summaryText ? fence(r.summaryText) + "\n" : "") + render(b, r.entries, r.tasksForYou, headless, p.lines),
                };
              }),
            );
            return json({ session: { id: cur.id, name: cur.name }, boards: out });
          }
          if (method === "GET" && sub === "wait") {
            const ms = Math.max(1000, Math.min((Number(url.searchParams.get("timeout")) || 45) * 1000, MAX_WAIT_MS));
            const take = async (join: boolean) =>
              (await Promise.all(ids.map(async (id) => ({ id, r: await boardStub(env, id).wait(viewer.name, join, cur.id).catch(() => null) })))).filter((x) => x.r && x.r.entries.length);
            const named = async (got: Awaited<ReturnType<typeof take>>) => Promise.all(got.map(async (x) => ({ ...x, r: { ...x.r!, entries: withNames(x.r!.entries, await social.boardAgentNames(env, x.id)) } })));
            let got = await take(true);
            if (!got.length) {
              // The Worker waits on every board at once (they sleep meanwhile); the first that has something wakes it.
              const woke = await new Promise<boolean>((resolve) => {
                let left = ids.length;
                for (const id of ids)
                  waitForBoard(boardStub(env, id), { kind: "agent", user: viewer.name, session: cur.id }, ms).then((v) => (v ? resolve(true) : --left === 0 && resolve(false)), () => --left === 0 && resolve(false));
              });
              if (woke) got = await take(false);
            }
            if (got.length) got = await named(got); // "Jarvis (vedu's agent)"
            const entries = got.flatMap((x) => x.r!.entries.map((e) => ({ board: { id: x.id, title: x.r!.info.title }, entry: e })));
            return json({ timed_out: !entries.length, entries, text: entries.length ? got.map((x) => render({ id: x.id, title: x.r!.info.title }, x.r!.entries)).join("\n") : `Nothing new on ${ids.length} board${ids.length === 1 ? "" : "s"} in ${Math.round(ms / 1000)}s.` });
          }
          return json({ error: "method not allowed" }, 405);
        } catch (e) {
          if (e instanceof sessions.SessionError) return json({ error: e.message }, 400);
          throw e;
        }
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
          const q = (k: string) => url.searchParams.get(k);
          // Several files in one message: multipart/form-data with a `file` part per file (up to 10), plus optional
          // `text`, `reply_to`, and per-file `w`/`h`/`name` repeated in the files' order (fields may also be query params).
          // Anything else is one file as the raw body, its details in the query (the app and older pages).
          const multi = /^multipart\/form-data/i.test(request.headers.get("content-type") ?? "");
          let files: { name: string; bytes: ArrayBuffer; width: number | null; height: number | null }[];
          let text: string;
          let replyRaw: string | null;
          if (multi) {
            const tooBig = `Those files are too large together (max ${MAX_MESSAGE_BYTES / 1e6} MB in one message).`;
            if (Number(request.headers.get("content-length") ?? 0) > MAX_MESSAGE_BYTES + 512_000) return json({ error: tooBig }, 413);
            const form = await request.formData().catch(() => null);
            if (!form) return json({ error: "Couldn't read the upload: send multipart/form-data with one `file` part per file." }, 400);
            const parts = form.getAll("file").filter((x): x is File => typeof x !== "string");
            if (!parts.length) return json({ error: "Attach at least one file (a `file` part)." }, 400);
            if (parts.length > MAX_FILES_PER_MESSAGE) return json({ error: `At most ${MAX_FILES_PER_MESSAGE} files in one message (got ${parts.length}).` }, 400);
            const big = parts.find((p) => p.size > MAX_IMAGE);
            if (big) return json({ error: `${big.name || "A file"} is too large (max ${MAX_IMAGE / 1e6} MB per file).` }, 413);
            if (parts.reduce((n, p) => n + p.size, 0) > MAX_MESSAGE_BYTES) return json({ error: tooBig }, 413);
            const field = (k: string) => (typeof form.get(k) === "string" ? (form.get(k) as string) : q(k));
            const each = (k: string) => form.getAll(k).map((v) => (typeof v === "string" ? v : ""));
            const [ws, hs, names] = [each("w"), each("h"), each("name")];
            files = await Promise.all(parts.map(async (p, i) => ({ name: names[i] || p.name || "", bytes: await p.arrayBuffer(), width: Number(ws[i]) || null, height: Number(hs[i]) || null })));
            text = (field("text") ?? "").slice(0, 4000);
            replyRaw = field("reply_to");
          } else {
            if (Number(request.headers.get("content-length") ?? 0) > MAX_IMAGE) return json({ error: `That file is too large (max ${MAX_IMAGE / 1e6} MB).` }, 413);
            files = [{ name: q("name") ?? "", bytes: await request.arrayBuffer(), width: Number(q("w")) || null, height: Number(q("h")) || null }];
            text = (q("text") ?? "").slice(0, 4000);
            replyRaw = q("reply_to");
          }
          const { mentions } = mayMention(text) ? parseMentions(text, await registry.boardMembers(env, id), viewer.name, pv()) : { mentions: [] };
          try {
            const replyTo = Number(replyRaw) > 0 ? Math.floor(Number(replyRaw)) : null; // files sent as a reply
            const entry = multi
              ? await stub.postFiles(viewer.name, { files, text, mentions, reply_to: replyTo, via: pv() })
              : await stub.postFile(viewer.name, { ...files[0], text, mentions, reply_to: replyTo, via: pv() });
            ctx.waitUntil(Promise.all([registry.touch(env, viewer.name, id), registry.bumpBoard(env, id, entry.seq)]).catch(() => {}));
            // Like a text post, the rendered entry comes back so the page can swap its "sending" copy for it.
            const root = replyTo ? ((await stub.rootsFor([entry.seq]))[entry.seq] ?? entry.seq) : entry.seq;
            return json({ ok: true, entry, update: { seq: entry.seq, root, retracts: entry.retracts, html: entryHtml(entry, id, true, { canRetract: true }), row: logRow(entry), reactions: [] } }, 201);
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
            const opts = { via: pv(), summary: body.summary ?? null, session: await asid() };
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

      // ---- approval cards: your own approvals on this board (only you decide them), pending by default ----
      m = path.match(/^\/api\/boards\/(b_[a-z0-9]+)\/approvals$/);
      if (m && method === "GET") {
        if (!viewer) return needLogin();
        if (!(await registry.isMember(env, m[1], viewer.name))) return json({ error: "board not found" }, 404);
        const state = (url.searchParams.get("state") ?? "pending") as (typeof approvals.APPROVAL_STATES)[number];
        if (!approvals.APPROVAL_STATES.includes(state)) return json({ error: `state is one of: ${approvals.APPROVAL_STATES.join(", ")}` }, 400);
        return json({ approvals: await approvals.listBoardApprovals(env, viewer.name, m[1], state) }, 200, { "cache-control": "no-store" });
      }

      // ---- workflow triggers: "when X happens on this board, wake my agent with P" (any member; only their own agent) ----
      m = path.match(/^\/api\/boards\/(b_[a-z0-9]+)\/triggers(?:\/(tr_[a-z0-9]+))?$/);
      if (m) {
        if (!viewer) return needLogin();
        if (!(await registry.isMember(env, m[1], viewer.name))) return json({ error: "board not found" }, 404);
        const stub = boardStub(env, m[1]);
        const fail = (e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e);
          return json({ error: msg }, /^Only /.test(msg) ? 403 : /^No trigger /.test(msg) ? 404 : 400);
        };
        try {
          if (method === "GET" && !m[2]) return json({ triggers: await stub.triggers(), limit: triggers.MAX_TRIGGERS }, 200, { "cache-control": "no-store" });
          const b = (await request.json().catch(() => ({}))) as { on?: unknown; match?: unknown; prompt?: unknown; enabled?: unknown; wake?: { user?: unknown; session?: unknown } };
          const wake = await triggers.wakeFor(env, viewer.name, b.wake);
          if ("error" in wake) return json({ error: wake.error }, wake.status);
          if (method === "POST" && !m[2]) return json({ trigger: await stub.triggerAdd(viewer.name, { on: b.on, match: b.match, prompt: b.prompt, session: wake.session, enabled: b.enabled !== false }) }, 201);
          if (method === "PATCH" && m[2]) return json({ trigger: await stub.triggerUpdate(viewer.name, m[2], { enabled: b.enabled, prompt: b.prompt, match: b.match }) });
          if (method === "DELETE" && m[2]) {
            await stub.triggerRemove(viewer.name, m[2]);
            return json({ ok: true });
          }
        } catch (e) {
          return fail(e);
        }
        return json({ error: "method not allowed" }, 405);
      }

      // ---- shared crons: board schedules that post a task at each due time (people set them; agents may list) ----
      m = path.match(/^\/api\/boards\/(b_[a-z0-9]+)\/schedules(?:\/(sc_[a-z0-9]+))?$/);
      if (m) {
        if (!viewer) return needLogin();
        const role = await registry.memberRole(env, m[1], viewer.name);
        if (!role) return json({ error: "board not found" }, 404);
        const stub = boardStub(env, m[1]);
        try {
          if (method === "GET" && !m[2]) return json({ schedules: await stub.schedules(), limit: MAX_SCHEDULES }, 200, { "cache-control": "no-store" });
          if (!["POST", "PATCH", "DELETE"].includes(method) || (method === "POST") === !!m[2]) return json({ error: "method not allowed" }, 405);
          if (viewer.via === "agent") return json({ error: "Only people can add, change or remove schedules (on the web, in board settings). Agents can list them: atteo schedules." }, 403);
          if (role === "viewer") return json({ error: "You can view this board but not change it (your role is viewer). Ask an owner for contributor access." }, 403);
          const manager = role === "owner";
          if (method === "DELETE") {
            await stub.scheduleRemove(viewer.name, m[2]!, manager);
            return json({ ok: true });
          }
          const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
          const fields = { title: b.title, body: b.body, at: b.at, tz: b.tz, days: b.days, enabled: b.enabled };
          if (method === "POST") return json({ schedule: await stub.scheduleAdd(viewer.name, fields) }, 201);
          return json({ schedule: await stub.scheduleUpdate(viewer.name, m[2]!, fields, manager) });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return json({ error: msg }, /^Only /.test(msg) ? 403 : /^No schedule /.test(msg) ? 404 : 400);
        }
      }

      // ---- a recap: what happened since an entry (?since=N) or since you last read (?since=last-read, the default) ----
      m = path.match(/^\/api\/boards\/(b_[a-z0-9]+)\/recap$/);
      if (m && method === "GET") {
        if (!viewer) return needLogin();
        if (!(await registry.isMember(env, m[1], viewer.name))) return json({ error: "board not found" }, 404);
        try {
          const since = recap.parseSince(url.searchParams.get("since"));
          return json(await recap.buildRecap(env, boardStub(env, m[1]), viewer.name, { since, session: await asid(), as: viewer.via === "agent" ? "agent" : "person" }), 200, { "cache-control": "no-store" });
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }

      // ---- the pinned doc: one document a board pins as its source of truth (any member who can post) ----
      m = path.match(/^\/api\/boards\/(b_[a-z0-9]+)\/pin$/);
      if (m) {
        if (!viewer) return needLogin();
        if (!(await registry.isMember(env, m[1], viewer.name))) return json({ error: "board not found" }, 404);
        const stub = boardStub(env, m[1]);
        try {
          if (method === "GET") return json({ pinned: await stub.pinned() });
          const opts = { via: pv(), client: viewer.via === "agent" ? "atteo CLI" : null, session: await asid() };
          if (method === "POST") {
            const b = (await request.json().catch(() => ({}))) as { doc?: unknown; name?: unknown };
            const name = String(b.doc ?? b.name ?? "").trim();
            if (!name) return json({ error: "Say which document to pin: {doc: \"SPEC.md\"}." }, 400);
            return json({ ok: true, pinned: await stub.pin(viewer.name, name, opts) });
          }
          if (method === "DELETE") {
            const r = await stub.unpin(viewer.name, url.searchParams.get("doc") || null, opts);
            return json({ ok: true, pinned: null, unpinned: r.unpinned });
          }
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
        return json({ error: "method not allowed" }, 405);
      }

      // ---- the board's SOUL: its PROTOCOL.md (every agent is handed it). Members read it; only people change it ----
      m = path.match(/^\/api\/boards\/(b_[a-z0-9]+)\/soul$/);
      if (m) {
        if (!viewer) return needLogin();
        if (!(await registry.isMember(env, m[1], viewer.name))) return json({ error: "board not found" }, 404);
        const stub = boardStub(env, m[1]);
        try {
          if (method === "GET") return json({ soul: await stub.soul() }, 200, { "cache-control": "no-store" });
          if (method === "PUT") {
            if (viewer.via === "agent") return json({ error: "Only people edit a board's SOUL. Post your proposed change for your person to make." }, 403);
            const b = (await request.json().catch(() => ({}))) as { text?: unknown; base_version?: unknown };
            if (typeof b.text !== "string") return json({ error: "Send {text, base_version?}: the whole SOUL (Markdown)." }, 400);
            const base = b.base_version == null ? null : Number(b.base_version);
            if (base != null && !Number.isInteger(base)) return json({ error: "base_version is the version you read (0 to create)." }, 400);
            const r = await stub.setSoul(viewer.name, b.text, base, { via: "person", summary: "SOUL", session: null });
            if (r.conflict) return json({ error: `Someone saved v${r.current} while you were editing. Reload, then apply your change again.`, current: r.current }, 409);
            ctx.waitUntil(registry.bumpBoard(env, m[1], r.note).catch(() => {}));
            return json({ ok: true, soul: await stub.soul() });
          }
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
        return json({ error: "method not allowed" }, 405);
      }

      // ---- the board's MEMORY: short durable facts for every agent's context (people and agents add; people strike
      // any, an agent only its own person's) ----
      m = path.match(/^\/api\/boards\/(b_[a-z0-9]+)\/memory(?:\/m?(\d+))?$/);
      if (m) {
        if (!viewer) return needLogin();
        if (!(await registry.isMember(env, m[1], viewer.name))) return json({ error: "board not found" }, 404);
        const stub = boardStub(env, m[1]);
        const via = pv();
        try {
          if (method === "GET" && !m[2]) {
            const r = await stub.memory();
            const dec = r.decisions.map((d) => `#${d.seq} ${d.via === "agent" ? `${d.author}'s agent` : d.author}: ${d.title ? `${d.title}: ` : ""}${d.text.slice(0, 120)}`);
            // text: what an agent (the CLI) shows as is, fenced like every other piece of board content.
            return json({ ...r, text: fence([formatMemory(r.items, r.max), ...(dec.length ? ["Latest decisions:", ...dec] : [])].join("\n")) }, 200, { "cache-control": "no-store" });
          }
          if (method === "POST" && !m[2]) {
            const b = (await request.json().catch(() => ({}))) as { text?: unknown; from?: unknown };
            const from = b.from == null || b.from === "" ? null : Number(b.from);
            if (from != null && !Number.isInteger(from)) return json({ error: "from is an entry number." }, 400);
            const sid = via === "agent" ? await asid() : null;
            const sname = sid ? ((await sessions.get(env, viewer.name, sid))?.name ?? null) : null;
            const r = await stub.remember(viewer.name, { text: typeof b.text === "string" ? b.text : null, from }, { via, session_name: sname });
            return json({ ok: true, item: r.item, duplicate: r.duplicate, count: r.count }, r.duplicate ? 200 : 201);
          }
          if (method === "DELETE" && m[2]) return json({ ok: true, item: await stub.forget(viewer.name, Number(m[2]), { via }) });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return json({ error: msg }, /memory is full/.test(msg) ? 409 : /an agent can only strike/.test(msg) ? 403 : /^No memory item/.test(msg) ? 404 : 400);
        }
        return json({ error: "method not allowed" }, 405);
      }

      // ---- one board as JSON: its info, your role and its pinned doc ----
      m = path.match(/^\/api\/boards\/(b_[a-z0-9]+)$/);
      if (m && method === "GET") {
        if (!viewer && !hasOpsKey(c)) return needLogin();
        if (!(await canSee(c, m[1]))) return json({ error: "board not found" }, 404);
        const stub = boardStub(env, m[1]);
        const [info, pinned, role] = await Promise.all([stub.info(), stub.pinned(), viewer ? registry.memberRole(env, m[1], viewer.name) : null]);
        return json({ board: { ...info, role, pinned } });
      }

      // ---- react to an entry (toggle); GET lists every reaction on the board ----
      m = path.match(/^\/api\/boards\/([^/]+)\/(?:entries\/(\d+)\/react|reactions)$/);
      if (m && (method === "POST" || method === "GET")) {
        if (!viewer) return needLogin();
        if (!(await registry.isMember(env, m[1], viewer.name))) return json({ error: "board not found" }, 404);
        const stub = boardStub(env, m[1]);
        if (method === "GET" && !m[2]) return json({ reactions: await stub.reactions(seer()) });
        if (method === "POST" && m[2]) {
          const body = (await request.json().catch(() => ({}))) as { emoji?: string };
          try {
            const r = await stub.react(viewer.name, parseInt(m[2], 10), String(body.emoji ?? ""), { as: pv() });
            // The person's own reactions (web/app, not their agents' tokens) feed their recent_reactions.
            if (viewer.via !== "agent") ctx.waitUntil(social.countReaction(env.DB, viewer.name, String(body.emoji ?? "").trim(), r.on).catch(() => {}));
            return json(r);
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
      // grep across all your boards (encrypted ones are skipped and counted).
      if (path === "/api/grep" && method === "GET") {
        if (!viewer) return needLogin();
        return grepResponse(env, viewer.name, url, null);
      }
      if (path === "/api/boards/search" && method === "GET") {
        if (!viewer) return needLogin();
        const q = (url.searchParams.get("q") ?? "").trim().slice(0, 200);
        if (!q) return json({ boards: [], hits: [] });
        const all = await registry.boardsOverview(env, viewer.name, viewer.via !== "agent");
        const needle = q.toLowerCase();
        const boards = all
          .filter((b) => [b.title, b.description ?? "", b.tags ?? ""].join(" ").toLowerCase().includes(needle))
          .map((b) => b.id);
        // Content: ranked search inside the 25 most recently active boards, in parallel.
        const hits = (
          await Promise.all(
            all.slice(0, 25).map(async (b) => {
              try {
                const r = await boardStub(env, b.id).rankedSearch(q, { limit: 3 }, seer());
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
            // html: the task as it is now, rendered like its entry (title, then body), for the live card in the chat
            return json({ task: { ...task, html: renderText(task.body ? `${task.title}\n\n${task.body}` : task.title) }, history });
          } catch (e) {
            return json({ error: e instanceof Error ? e.message : String(e) }, 404);
          }
        }
        if (method === "POST" && !m[2]) {
          const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
          try {
            const t = await stub.taskCreate(
              viewer.name,
              { title: String(b.title ?? ""), body: typeof b.body === "string" ? b.body : "", priority: (["high", "medium", "low"] as const).find((p) => p === b.priority) ?? null, parent: typeof b.parent === "number" && b.parent > 0 ? b.parent : null },
              { via: pv(), session: await asid() },
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
          const opts = { via: pv(), session: await asid() };
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
                  old_str: typeof b.old_str === "string" ? b.old_str : undefined,
                  new_str: typeof b.new_str === "string" ? b.new_str : undefined,
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
                  parent: b.parent === undefined ? undefined : typeof b.parent === "number" && b.parent > 0 ? b.parent : null,
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
          const r = await boardStub(env, m[1]).review(viewer.name, parseInt(m[2], 10), String(body.verdict ?? "") as "approve", String(body.note ?? ""), { via: pv(), session: await asid() });
          ctx.waitUntil(registry.bumpBoard(env, m[1], r.entry.seq).catch(() => {}));
          return json({ ok: true, entry: r.entry, state: r.state }, 201);
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }

      // ---- human decisions (a person's decision): people agree / object; its author closes it. Agents can't. ----
      m = path.match(/^\/api\/boards\/([^/]+)\/entries\/(\d+)\/(vote|close)$/);
      if (m && method === "POST") {
        if (!viewer) return needLogin();
        if (!(await registry.isMember(env, m[1], viewer.name))) return json({ error: "board not found" }, 404);
        if (viewer.via === "agent") return json({ error: "Human decisions are for people: agents can't vote on them or close them. Reply with your input instead." }, 403);
        const body = (await request.json().catch(() => ({}))) as { vote?: string; outcome?: string; note?: string };
        const stub = boardStub(env, m[1]);
        const seq = parseInt(m[2], 10);
        try {
          const hd = m[3] === "vote" ? await stub.humanVote(viewer.name, seq, String(body.vote ?? ""), body.note, { via: pv() }) : await stub.humanClose(viewer.name, seq, String(body.outcome ?? ""), body.note, { via: pv() });
          if (hd.line != null) ctx.waitUntil(registry.bumpBoard(env, m[1], hd.line).catch(() => {}));
          return json({ ok: true, seq, human_decision: hd });
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
            session: await asid(),
          });
          ctx.waitUntil(registry.bumpBoard(env, m[1], entry.seq).catch(() => {}));
          return json({ ok: true, entry }, 201);
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }

      m = path.match(/^\/api\/boards\/([^/]+)\/(updates|entries|invites|seen|search|grep|handle|typing)(?:\/(\d+))?$/);
      if (m) {
        const [, id, what, seqStr] = m;
        if (!viewer && !hasOpsKey(c)) return needLogin();
        if (!(await canSee(c, id))) return json({ error: "board not found" }, 404);
        const stub = boardStub(env, id);

        if (what === "updates" && method === "GET") {
          const after = Math.max(0, parseInt(url.searchParams.get("after") ?? "0", 10) || 0);
          // Long-poll (wait=seconds) so an open board tab costs one request per change or per ~25s, not one every few seconds.
          const waitSec = Math.min(25, Math.max(0, parseInt(url.searchParams.get("wait") ?? "0", 10) || 0));
          if (waitSec) await waitForBoard(stub, { kind: "any", after }, waitSec * 1000);
          // Only entries after `after` (up to 1000 per call; the client advances and asks again), roots resolved in the DO.
          const [snap, members0, live] = await Promise.all([stub.snapshot(after, {}, seer()), registry.boardMembers(env, id), registry.agentsOnBoard(env, id)]);
          const members = members0.map((x) => ({ ...x, agent_seen: live[x.user] ?? null }));
          const fresh = snap.entries;
          const roots = await stub.rootsFor(fresh.map((e) => e.seq));
          const canRetract = (e: Entry) => !!viewer && (e.author === viewer.name || snap.info.created_by === viewer.name);
          const names = Object.fromEntries(members0.filter((x) => x.agent_name).map((x) => [x.user, x.agent_name!]));
          return json({
            entries: fresh.map((e) => ({
              seq: e.seq,
              author: e.author, // their "… is typing" ends when their message arrives
              ...(e.via === "agent" && names[e.author] ? { agent_name: names[e.author] } : {}), // "Jarvis · vedu's agent"
              root: roots[e.seq] ?? e.seq,
              retracts: e.retracts,
              html: entryHtml(withAgentNames(e, names), id, true, { canRetract: canRetract(e) }),
              row: logRow(e),
              reactions: snap.reactions[e.seq] ?? [],
              ...(e.type === "change" ? { reviews: snap.reviews[e.seq] ?? [] } : {}),
              ...(snap.claims[e.seq] ? { claim: snap.claims[e.seq] } : {}),
              ...(e.human_decision ? { human_decision: e.human_decision } : {}),
            })),
            ...(after === 0 ? { reactions: snap.reactions } : {}),
            reviews: snap.reviews, // every card's current verdicts (small), so open tabs can update cards above the fold
            claims: snap.claims, // every claim's status and every stale entry, same idea
            decisions: snap.decisions, // every human decision's state, votes and who it's waiting on
            handling: snap.handling, // which agent took which message ("vedu/scout")
            reads: snap.reads, // how far each member has seen, as a person and through their agent (read receipts)
            typing_agents: snap.typing_agents, // agents working on a person's message right now ("… is typing")
            summary: summaryHtml([], viewer?.name ?? "", members, snap.summary, { boardId: id, creator: snap.info.created_by }),
            pinned: snap.pinned, // the board's pinned doc {name, version, …} or null
            count: snap.info.entry_count,
            last: snap.last, // past any people-only entries this viewer doesn't get, so the tab doesn't ask again
          });
        }
        if (what === "entries" && !seqStr && method === "GET" && url.searchParams.has("after")) {
          // Plain JSON for SDKs and scripts: entries after N (oldest first), optionally waiting up to 25s for new ones.
          const after = Math.max(0, parseInt(url.searchParams.get("after") ?? "0", 10) || 0);
          const waitSec = Math.min(25, Math.max(0, parseInt(url.searchParams.get("wait") ?? "0", 10) || 0));
          if (waitSec) await waitForBoard(stub, { kind: "any", after }, waitSec * 1000);
          const [snap, names] = await Promise.all([stub.snapshot(after, {}, seer()), social.boardAgentNames(env, id)]);
          const list = withNames(snap.entries.slice(0, Math.min(500, parseInt(url.searchParams.get("limit") ?? "200", 10) || 200)), names);
          // Reactions on these entries (agents' 🤔 / ✅ read receipts among them), keyed by seq.
          const reactions = list.length ? await stub.reactionsFor(list.map((e) => e.seq), seer()) : {};
          // last: past any people-only entries this caller doesn't get (all of them, for an agent's token).
          const last = list.length < snap.entries.length ? list[list.length - 1].seq : snap.last;
          return json({ entries: list, last, reactions, reads: snap.reads, decisions: snap.decisions });
        }
        if (what === "entries" && !seqStr && method === "GET") {
          // Earlier entries for "Load earlier messages", rendered like live updates.
          const before = parseInt(url.searchParams.get("before") ?? "0", 10) || null;
          const page = await stub.page(before, parseInt(url.searchParams.get("limit") ?? "100", 10) || 100, seer());
          const seqs = page.map((e) => e.seq);
          const [isOwner, roots, reactions] = await Promise.all([
            viewer ? registry.memberRole(env, id, viewer.name).then((r) => r === "owner") : false,
            stub.rootsFor(seqs),
            stub.reactionsFor(seqs, seer()),
          ]);
          return json({
            first: page.length ? page[0].seq : 0,
            entries: page.map((e) => ({
              seq: e.seq,
              root: roots[e.seq] ?? e.seq,
              html: entryHtml(e, id, true, { canRetract: !!viewer && (e.author === viewer.name || isOwner) }),
              row: logRow(e),
              reactions: reactions[e.seq] ?? [],
              ...(e.human_decision ? { human_decision: e.human_decision } : {}),
            })),
          });
        }
        if (what === "entries" && seqStr && method === "GET") {
          try {
            const [r, names] = await Promise.all([stub.get(parseInt(seqStr, 10), seer()), social.boardAgentNames(env, id)]);
            return json({ ...r, entry: withNames([r.entry], names)[0], replies: withNames(r.replies, names) });
          } catch (e) {
            return json({ error: e instanceof Error ? e.message : String(e) }, 404);
          }
        }
        if (what === "entries" && !seqStr && method === "POST") {
          // canSee above already checked membership, unless it let an operator through.
          if (!viewer || (isOps(c) && !(await registry.isMember(env, id, viewer.name)))) return json({ error: "Only members can post." }, 403);
          const body = (await request.json().catch(() => ({}))) as { text?: string; type?: string; to?: string | string[]; reply_to?: string | number; to_session?: string; people_only?: unknown };
          const type = (["note", "question", "task", "decision", "claim"] as const).find((t) => t === body.type) ?? "note";
          // People-only (vedu #1264): for the people named in `to` (a list, or one name) and/or @named in the text.
          // Never from an agent's token: agents can't create them (or read them).
          const peopleOnly = body.people_only === true || body.people_only === "true" || body.people_only === 1;
          if (peopleOnly && viewer.via === "agent") return json({ error: "Only people can send people-only messages, signed in on the web or in the Atteo app. Agents can't create or read them." }, 403);
          let to = !peopleOnly && typeof body.to === "string" && body.to ? normalizeUser(body.to) : null;
          let text = String(body.text ?? "");
          // For one of your own agent sessions (the "Your agent" picker): "@you/<session>" leads the text, so it's
          // stored and shown as that session mention, and only that session's read, wait and mailbox get it.
          const toSession = typeof body.to_session === "string" ? body.to_session.trim().toLowerCase().replace(/^@/, "") : "";
          if (!peopleOnly && toSession && SESSION_NAME_RE.test(toSession) && text.trim() && !text.toLowerCase().includes(`@${viewer.name}/${toSession}`)) text = `@${viewer.name}/${toSession} ${text}`;
          const boardMembers = await registry.boardMembers(env, id);
          const { mentions, ambiguous }: { mentions: Mention[]; ambiguous: string[] } = mayMention(text) ? parseMentions(text, boardMembers, viewer.name, pv()) : { mentions: [], ambiguous: [] };
          // People-only: who it's for, each a member of this board (the author is added by the board).
          let toPeople: string[] | undefined;
          if (peopleOnly) {
            const named = (Array.isArray(body.to) ? body.to : typeof body.to === "string" ? body.to.split(/[\s,]+/) : []).map((n) => String(n).trim().replace(/^@/, "")).filter(Boolean);
            const memberSet = new Set(boardMembers.map((x) => x.user));
            toPeople = [];
            for (const n of named) {
              const u = normalizeUser(n);
              if (!u || !memberSet.has(u)) return json({ error: `${n} isn't on this board: a people-only message is for people on it.` }, 400);
              toPeople.push(u);
            }
            for (const x of mentions) if (!x.agent && memberSet.has(x.user)) toPeople.push(x.user); // "@jxn" in the text
          }
          // Replying: to an agent's post, the reply goes to that agent; to a person's post, it mentions them.
          const replyTo = Number(body.reply_to) > 0 ? Math.floor(Number(body.reply_to)) : null;
          if (replyTo) {
            const parent = await stub.get(replyTo, seer()).catch(() => null);
            if (!parent) return json({ error: `Entry #${replyTo} does not exist on this board.` }, 400);
            const p = parent.entry;
            if (p.author !== viewer.name) {
              if (p.via === "person") {
                if (!mentions.some((m) => m.user === p.author)) mentions.push({ user: p.author, agent: false });
              } else if (!peopleOnly) to ??= p.author;
            }
          }
          try {
            const idem = messageId(request.headers.get("idempotency-key"));
            const session = await asid();
            const entry = await withRetry(() => stub.post(viewer.name, { type, text, to, mentions, reply_to: replyTo, via: pv(), session, idem, ...(peopleOnly ? { people_only: true, to_people: toPeople } : {}) }));
            ctx.waitUntil(Promise.all([registry.touch(env, viewer.name, id), registry.bumpBoard(env, id, entry.seq)]).catch(() => {}));
            // The rendered entry comes back with the post, so the page shows it without another round trip.
            const root = replyTo ? ((await stub.rootsFor([entry.seq]))[entry.seq] ?? entry.seq) : entry.seq;
            // A people-only message (asked for, or a reply in one) says once, here, who can see it.
            const notice = entry.audience ? { notice: peopleNotice(viewer.name, entry.to_people ?? []) } : {};
            return json({ ok: true, entry, ...notice, update: { seq: entry.seq, root, retracts: entry.retracts, html: entryHtml(entry, id, true, { canRetract: true }), row: logRow(entry), reactions: [] }, ...(ambiguous.length ? { ambiguous } : {}) }, 201);
          } catch (e) {
            // Still restarting after our retries: say "try again" (the page retries with the same message id).
            if (isRetriable(e)) {
              ctx.waitUntil(usage.recordError(env, `${method} ${path}`, e).catch(() => {}));
              return json({ error: "Atteo is restarting; your message wasn't lost. Retrying…", retry: true }, 503, { "retry-after": "2" });
            }
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
          const r = q ? await stub.rankedSearch(q, { author: from ?? undefined, type, limit: 60 }, seer()) : { entries: (await stub.search("", { author: from ?? undefined, type, limit: 60 }, seer())).map((entry) => ({ entry, snippet: "" })), files: [] };
          const keep = (e: Entry) => agent == null || (agent === "1" ? e.via === "agent" : e.via !== "agent");
          return json({
            entries: r.entries
              .filter((x) => keep(x.entry))
              .map((x) => ({ seq: x.entry.seq, ts: x.entry.ts, author: x.entry.author, via: x.entry.via ?? null, type: x.entry.type, title: x.entry.title ?? null, snippet: x.snippet || x.entry.text.slice(0, 200) })),
            files: scope === "chat" || from || type ? [] : r.files,
          }, 200, { "cache-control": "no-store" });
        }
        // grep for agents: exact matching lines, one per hit (grep.ts). Members only (canSee above).
        if (what === "grep" && method === "GET") return grepResponse(env, viewer?.name ?? "", url, id);
        // Read receipts: the board page reports the newest entry its person has had on screen.
        // "jxn is typing…": a person's composer says so every few seconds while they type; nothing is stored.
        if (what === "typing" && method === "POST") {
          if (!viewer || viewer.via === "agent" || !(await registry.isMember(env, id, viewer.name))) return json({ error: "Only members can do that." }, 403);
          await stub.typing(viewer.name);
          return new Response(null, { status: 204 });
        }
        if (what === "handle" && method === "POST" && seqStr) {
          // "I'm on it" (atteo handle N): the calling agent session, or the person on the web.
          if (!viewer || !(await registry.isMember(env, id, viewer.name))) return json({ error: "Only members can do that." }, 403);
          const sid = await asid();
          const sess = sid ? await sessions.get(env, viewer.name, sid) : null;
          const label = sess ? `${viewer.name}/${sess.name}` : viewer.via === "agent" ? `${viewer.name}'s agent` : viewer.name;
          const body = (await request.json().catch(() => ({}))) as { action?: string };
          const action = body.action === "release" || body.action === "done" ? body.action : "take";
          try {
            const r = await stub.handle(viewer.name, parseInt(seqStr, 10), { session: sess?.id ?? null, label, person: viewer.via !== "agent" }, action);
            return json({ ok: r.ok, by: r.by, done: r.done, message: handleMessage(seqStr, action, r) }, r.ok ? 200 : 409);
          } catch (e) {
            return json({ error: e instanceof Error ? e.message : String(e) }, 404);
          }
        }
        if (what === "seen" && method === "POST") {
          if (!viewer || !(await registry.isMember(env, id, viewer.name))) return json({ error: "Only members can mark entries seen." }, 403);
          const body = (await request.json().catch(() => ({}))) as { seq?: number };
          await stub.seen(viewer.name, Number(body.seq) || 0);
          return json({ ok: true });
        }
        if (what === "invites" && method === "POST") {
          if (viewer && !viewer.admin && !(await registry.isMember(env, id, viewer.name))) return json({ error: "Only members can invite." }, 403);
          if (((await registry.getBoard(env, id)) as { kind?: string | null } | null)?.kind === "agent") return json({ error: "This is your private chat with your own agents; no one else can join it." }, 400);
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
            const r = await sendInvite(env, origin, { boardId: id, email: u.email, invitedBy: viewer.name, role, expiresDays });
            return json({ ok: r.ok, added: r.added, message: r.message.split(` (${u.email.toLowerCase()})`).join("").split(u.email.toLowerCase()).join(u.name) });
          }
          if (!EMAIL_RE.test(to)) return json({ error: "Enter a valid email address." }, 400);
          return json(await sendInvite(env, origin, { boardId: id, email: to, invitedBy: viewer?.name ?? "ops", role, expiresDays }));
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
          ok = m[2] === "accept" ? await registry.acceptInvitation(env, me, m[1], origin) : await registry.declineInvitation(env, me, m[1]);
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 402);
        }
        if (!ok) return json({ error: "No open invitation to that board for your verified email." }, 404);
        return json({ ok: true, board: m[1], message: m[2] === "accept" ? "Joined" : "Declined" });
      }

      // ---- personal tokens ----
      if (path === "/api/tokens" && method === "GET") {
        if (!viewer) return needLogin();
        const list = await auth.listTokens(env, viewer.name);
        return json({ tokens: list.map((t) => ({ id: t.id, label: t.label, kind: t.kind, created_at: t.created_at, last_used: t.last_used, revoked_at: t.revoked_at, expires_at: t.expires_at })) });
      }
      if (path === "/api/tokens" && method === "POST") {
        if (!viewer) return needLogin();
        const body = (await request.json().catch(() => ({}))) as { board?: string; label?: string };
        const board = body.board && (await canSee(c, body.board)) ? body.board : null;
        const t = await auth.createToken(env, viewer.name, String(body.label ?? "").slice(0, 80) || "Agent");
        return json(
          {
            id: t.id,
            token: t.token,
            command: connectCommand(origin, null, t.token),
            mcp_url: `${origin}/mcp`,
            ...(board ? { project_command: connectCommand(origin, board, t.token), project_mcp_url: `${origin}/mcp?board=${board}` } : {}),
          },
          201,
        );
      }
      // The kill switch (Account → Disconnect all agents): every token revoked, every agent session ended, and agents
      // drop off every board's presence. Browser only (an /api/tokens path), so an agent can't trigger it on its own.
      if (path === "/api/tokens/revoke-all" && method === "POST") {
        if (!viewer) return needLogin();
        const [tokens, ended] = await Promise.all([auth.revokeAllTokens(env, viewer.name), sessions.endAll(env, viewer.name)]);
        await env.DB.prepare(`DELETE FROM mcp_sessions WHERE user = ?`).bind(viewer.name).run();
        return json({ ok: true, tokens, sessions: ended, message: `Disconnected: ${tokens} sign-in${tokens === 1 ? "" : "s"} revoked and ${ended} agent session${ended === 1 ? "" : "s"} ended. Run atteo login to connect again.` });
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
        if (path === "/api/ops/test-error" && method === "POST") throw new Error("Test error from /api/ops/test-error");
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
          // kind "app": a token as the Atteo app would get (tests and simulator runs only; people get theirs by signing in).
          const t = await auth.createToken(env, u, body.label || "ops-issued", { ...(Number.isFinite(ttl) ? { expiresAt: Date.now() + ttl * 1000 } : {}), ...(body.kind === "app" ? { kind: "app" as const } : {}) });
          return json({ token: t.token, command: connectCommand(origin, body.board ?? null, t.token) }, 201);
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
        // Tests: run the cron now (as the 5-minute schedule would), at `now` (ms) for scheduled triggers.
        if (path === "/api/ops/cron" && method === "POST") {
          const at = Number((body as { now?: unknown }).now);
          return json({ ok: true, ...(await runScheduled(env, ctx, Number.isFinite(at) && at > 0 ? at : Date.now())) });
        }
        if (path === "/api/ops/seed" && method === "POST") {
          const u = normalizeUser(body.user);
          if (!u || !body.board || !(await registry.getBoard(env, body.board))) return json({ error: "board and user required" }, 400);
          const n = await boardStub(env, body.board).seed(u, Number(body.count) || 100, String(body.prefix ?? "seed").slice(0, 200));
          ctx.waitUntil(registry.bumpBoard(env, body.board, n).catch(() => {}));
          return json({ ok: true, count: n });
        }
        // Tests: when an agent session was last seen (sessions gone for a day aren't listed, and get ended).
        if (path === "/api/ops/session-seen" && method === "POST") {
          const ts = Number(body.last_seen);
          if (!sessions.SESSION_RE.test(String(body.session ?? "")) || !Number.isFinite(ts)) return json({ error: "session and last_seen required" }, 400);
          await env.DB.prepare(`UPDATE agent_sessions SET last_seen = ? WHERE id = ?`).bind(ts, body.session).run();
          return json({ ok: true });
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
            return json({ board: await createBoard(env, body.title.slice(0, 120), u, undefined, { encrypted: (body as { encrypted?: unknown }).encrypted === true }) }, 201);
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
        const back = "Boards are paused: Atteo hit its daily storage limit. They're back at 00:00 UTC (your data is safe).";
        if (method === "GET" && !path.startsWith("/api/")) return messagePage("Back soon", back, { status: 503 });
        return json({ error: back }, 503, { "retry-after": "3600" });
      }
      return json({ error: msg }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

// Errors also go to Sentry when SENTRY_DSN is set (prod); with no DSN the SDK stays off (dev/CI).
export default Sentry.withSentry(
  (env: Env) => ({ dsn: env.SENTRY_DSN, release: env.CF_VERSION_METADATA?.id, tracesSampleRate: 0, beforeSend: scrubForSentry }),
  handler,
);


