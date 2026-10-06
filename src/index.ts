import { PALETTE_JS, PALETTE_CSS } from "./palette";
// Worker entry: MCP endpoint, sign-in, web pages, JSON API, and the operator console (/_ops).

import { localize, pickLang } from "./i18n";
import { displayMap, displayNames, forgetDisplayName } from "./names";
import * as a2a from "./a2a";
import { runGrep } from "./grep";
import * as usage from "./usage";
import * as csp from "./csp";
import * as limits from "./limits";
import * as costGuard from "./costGuard";
import * as northStar from "./northStar";
import * as oauth from "./oauth";
import { consentPage } from "./oauthPage";
import * as approvals from "./approvals";
import { boardStates } from "./boardStates";
import { approvalsPage } from "./approvalsPage";
import { askPage } from "./ask";
import * as access from "./access";
import { accessAll } from "./accessAll";
import { AUDIT_EXPORT_LIMIT, auditExportDocument, auditExportHeaders, forAgents, parseAuditAfter } from "./auditExport";
import * as social from "./social";
import * as standing from "./standingRules";
import { isPublicMailDomain, orgPolicy } from "./policy";
import * as webhooks from "./webhooks";
import * as avatars from "./avatars";
import * as boardPictures from "./boardPictures";
import * as agents from "./agents";
import * as dm from "./dm";
import { settle, waitForBoard } from "./waits";
import { badMessageId, isRetriable, messageId, retryingReads, withRetry } from "./retry";
import CLI_BUNDLE from "../cli/dist/atteo.mjs";
import { installScript } from "./install";
import SKILL_MD from "../skills/atteo/SKILL.md";
import { agentsMd, guidePage } from "./guide";
import { docsPage } from "./docs";
import { openapi } from "./openapi";
import * as billing from "./billing";
import * as githubApp from "./githubApp";
import { egressRefusal, isHeldRequest, noteBoardCreated, noteRequestWallMs, noteWakeDelivery, type Later } from "./observe";
import * as inbox from "./inbox";
import * as notify from "./notify";
import * as forYou from "./forYou";
import * as auth from "./auth";
import * as appSignin from "./appSignin";
import * as moderation from "./moderation";
import * as bugs from "./bugs";
import { ensureBugBoard, isReservedUser } from "./bugBoard";
import { checkDeleteCode, deleteAccount, isDeletedHandle, noteDeleteCodeSent, type BoardForget } from "./accountDelete";
import * as feedback from "./feedback";
import { handleMcp } from "./mcp";
import * as device from "./device";
import { EMAIL_RE, sendInvite } from "./invite";
import { mayMention, parseMentions, SESSION_NAME_RE, type Mention } from "./mentions";
import * as registry from "./registry";
import { recordForward, scrubForwards } from "./forwards";
import * as backup from "./backup";
import * as cardsign from "./cardsign";
import * as accountlog from "./accountlog";
import * as pins from "./pins";
import * as boardkeys from "./boardkeys";
import * as mailbox from "./mailbox";
import * as recap from "./recap";
import * as hosts from "./hosts";
import { HOST_PAGE_JS } from "./hostUi";
import { MACHINE_RE } from "./hostCore";
import { listMount, LsError } from "./ls";
import * as testAccounts from "./testAccounts";
import { musePage } from "./muse";
import * as triggers from "./triggers";
import * as tts from "./tts";
import * as voice from "./voice";
import * as calls from "./calls";
import * as slack from "./slack";
import { slackOn } from "./slackCore";
import { CALL_CSS, CALL_CSS_PATH, CALL_CSS_SRC, CALL_JS, CALL_JS_PATH, callPageBody } from "./callWeb";
import { MAX_SCHEDULES } from "./schedules";
import {
  adminPage,
  BOARD_JS,
  BOARD_JS_PATH,
  BOARD_TAIL_PATH,
  boardTail,
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
  PREVIEW_FRAME_CSP,
  PREVIEW_FRAME_HTML,
} from "./html";
import { ENTRY_TYPES, type Entry, type Env, type NewEntry, type Viewer as Seer } from "./types";
import { APP_CSS, APP_JS, PAGE_CSS, directPeer, BOARD_PREFETCH_PATH, BOARD_PREFETCH_RULES, BUG_DIALOG, BUG_PAGE_JS, FAVICON_SVG, FEEDBACK_DIALOG, FEEDBACK_PAGE_JS, page, renderText, SHELL_PAGE_JS } from "./ui";
import { APPLE_TOUCH_PNG_B64 } from "./appleIcon";
import { assistantWelcomePage } from "./welcome";
import { agentCharter, applyCharter, charterAuditDetail, charterScanFields, charterView, parseCharterPatch, storedFromRow } from "./charter";
import { atteoHeader, BOARD_RE, connectCommand, esc, newBoardId, legacyHostRedirect, normalizeUser, parseBoardMeta, publicOrigin, requestNow } from "./util";
import { deepChecks, handlePublicStatus } from "./uptime";
import { isLocalHost } from "./util";
import { richTextOf } from "./richtext";

import * as Sentry from "@sentry/cloudflare";
import { scrubForSentry } from "./sentry";
import { analyticsConfig, trackCookieHeader, withAnalytics } from "./analytics";
export { Board } from "./board";
export { SlackTeam } from "./slackQueue";
import { forwardDestOk, forwardExcerptInEntry, keptOwnNotice } from "./audience";
import { audienceNotice, MAX_FILES_PER_MESSAGE, MAX_IMAGE, MAX_MESSAGE_BYTES, MAX_SEALED_FILE, MAX_WAIT_MS, WAIT_CAP } from "./board";
import * as sessions from "./sessions";
import * as listen from "./listen";
import { compactLine, formatEntry, formatMemory, handleMessage, parseReadBudget, parseSummaryBudget, presentReadEntries, readHeader, readParts, withNames } from "./state";
import { fence, flagged } from "./screen";
import { CODE_COLOR_PATH, CODE_COLOR_SCRIPT } from "./codecolor";
import { quickReplies } from "./quickReplies";
import { fontResponse } from "./fonts";
import { MERMAID_PATH, mermaidResponse } from "./mermaid";

const OPS_PATH = "/_ops";

let cliHashMemo: Promise<string> | null = null;
/** sha256 of the CLI file this server hands out: an installed CLI compares its own file against it. */
function cliHash(): Promise<string> {
  return (cliHashMemo ??= crypto.subtle.digest("SHA-256", new TextEncoder().encode(CLI_BUNDLE)).then((b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("")));
}

function boardStub(env: Env, id: string) {
  return env.BOARD.get(env.BOARD.idFromName(id));
}

/** Stops every machine on a board that's being archived or deleted, with the board's log saying so (#4951). */
async function stopBoardHosts(env: Env, board: string, by: string): Promise<void> {
  const got = await hosts.stop(env, board, "all", by, by);
  const log = (user: string, text: string) => boardStub(env, board).notice(user, "Host", text, { via: "agent", client: "atteo host", session: null }).catch((e: unknown) => console.error("host audit failed", e));
  for (const h of got.hosts) await log(h.owner, hosts.stopText(h, by));
  for (const r of got.dropped) {
    const h = got.hosts.find((x) => x.id === r.host_id);
    if (h) await log(h.owner, hosts.auditText(h, r));
  }
  for (const a of got.closed) await boardStub(env, board).approvalDecided(approvals.refOf(a)).catch((e: unknown) => console.error("approval event failed", e));
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
  // The interface language (i18n.ts): ?lang=, else the saved display pref, else the browser's.
  let pref: string | null = null;
  try {
    pref = session.u_display ? ((JSON.parse(session.u_display) as { lang?: unknown }).lang as string | null) ?? null : null;
  } catch {}
  return {
    name: u.name,
    email: u.email ?? session.email,
    display_name: u.display_name,
    admin: auth.isAdminViewer(env, session, request ? new URL(request.url).hostname : null),
    lang: pickLang(typeof pref === "string" ? pref : null, request ? new URL(request.url).searchParams.get("lang") : null, request?.headers.get("accept-language") ?? null),
  };
}

function hasOpsKey(c: Ctx): boolean {
  const k = c.request.headers.get("x-admin-key");
  return !!c.env.ADMIN_KEY && !!k && safeEqual(k, c.env.ADMIN_KEY);
}

const isOps = (c: Ctx) => !!c.viewer?.admin || hasOpsKey(c);

/** Two loops keep taking one session's wait from each other (limits.beginWait): the newest is turned away for a bit. */
const waitRefused = (retryAfter: number) =>
  json({ error: "Another wait from this agent session is already open (are two loops sharing one session?). Use one session per loop.", retry_after: retryAfter }, 429, { "retry-after": String(retryAfter) });

async function sideBoards(env: Env, user: string): Promise<SideBoard[]> {
  const [boards, live, pinned] = await Promise.all([registry.boardsForUser(env, user), sessions.liveByBoard(env).catch(() => new Map<string, number>()), pins.getPins(env, user)]);
  return pins.sortPinned(boards, pinned)
    .filter((b) => !b.archived_at)
    .map((b) => ({ id: b.id, title: b.title, kind: (b as { kind?: string | null }).kind ?? null, live: live.get(b.id) ?? 0, picture: boardPictures.pictureUrl(b.id, b.picture_v), pinned: pinned.includes(b.id), last: b.last_activity, opened: b.opened_at ?? null }));
}

/** The sidebar's boards, with each direct chat's other person by the name they chose (jxn #4369; cached, names.ts). */
async function sideBoardsNamed(env: Env, user: string): Promise<SideBoard[]> {
  const side = await sideBoards(env, user);
  const peers = side.filter((b) => b.kind === "direct").map((b) => directPeer(b, user));
  if (!peers.length) return side;
  const dn = await displayNames(env, peers).catch(() => ({}) as Record<string, string>);
  return side.map((b) => (b.kind === "direct" ? { ...b, peer_name: dn[directPeer(b, user)] ?? null } : b));
}

/** Members (and operators) can see a board; everyone else gets a 404 so board ids don't leak. */
async function canSee(c: Ctx, boardId: string): Promise<boolean> {
  if (!BOARD_RE.test(boardId)) return false;
  const a = await registry.boardAccess(c.env, boardId, c.viewer?.name ?? null);
  if (!a.exists) return false;
  return isOps(c) || a.member;
}

/** GET …/grep?q=&regex=0|1&case=0|1&author=&type=&since=<seq or ISO>&context=0..2&max=&files=0|1 → GrepOutput (text + hits). */
async function grepResponse(env: Env, user: string, url: URL, boardId: string | null, who: Seer | null): Promise<Response> {
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
      more: p.get("more") ?? undefined,
    }, boardId, who);
    const { compact, ...response } = out;
    return json({ ...response, ...(flag("compact") ? { text: compact } : {}) }, 200, { "cache-control": "no-store" });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
}

/** Plan limits apply to people (origin given); the ops API creates boards without them. */
async function createBoard(env: Env, title: string, user: string, origin?: string, opts: { encrypted?: boolean } = {}, later: Later | null = null) {
  if (origin) await billing.checkCanCreateBoard(env, user, origin);
  const id = newBoardId();
  const info = await boardStub(env, id).init(id, title, user, opts);
  await registry.recordBoard(env, info);
  await registry.addMember(env, id, user, { role: "owner" });
  void noteBoardCreated(env, later, user);
  if (opts.encrypted) await env.DB.prepare(`UPDATE boards SET encrypted = 1 WHERE id = ?`).bind(id).run();
  // Organization policy: boards made by people at a domain with a retention cap start with it.
  const u = await registry.userByName(env, user);
  const pol = u?.email ? await orgPolicy(env, u.email) : null;
  if (pol?.max_retention_days) {
    await env.DB.prepare(`UPDATE boards SET retention_days = ? WHERE id = ?`).bind(pol.max_retention_days, id).run();
    await boardStub(env, id).setCharter({ goal: null, data_classes: [], retention_days: pol.max_retention_days }); // what agents read (#3685)
  }
  return info;
}

function suggestName(email: string, display: string | null): string {
  const base = (email.split("@")[0] || display || "me").toLowerCase().replace(/[^a-z0-9_.-]/g, "").replace(/^[^a-z0-9]+/, "");
  return normalizeUser(base.slice(0, 32)) ?? "me";
}

/** A handle no one may take: reserved, a deleted account's (forever, accountDelete.ts), or simply someone's. */
async function handleTaken(env: Env, name: string): Promise<boolean> {
  return isReservedUser(name) || !!(await registry.userByName(env, name)) || (await isDeletedHandle(env, name));
}

async function freeName(env: Env, base: string): Promise<string> {
  if (!(await handleTaken(env, base))) return base;
  for (let i = 2; i < 100; i++) {
    const n = `${base.slice(0, 29)}${i}`;
    if (!(await handleTaken(env, n))) return n;
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

/**
 * Who can find you and what's accepted without asking are the person's own consent (#3502): the directory listing (yours
 * and your agent's) and the auto-accept rules. An agent token, even the person's own CLI login, can't change them, like
 * the SOUL; the web and the app (person sessions and app tokens) can.
 */
const PEOPLE_ONLY_SETTING = "Who can find you and what's accepted without asking (your directory listing and the auto-accept rules) are your person's call: they change them on the web (Account) or in the app (Settings).";
const PEOPLE_ONLY_AGENT_LISTING = "Listing your agent in the public directory is your person's call: they change it in the app (Settings). Your agent can still set its summary and capabilities.";

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

  if (user) {
    await accountlog.record(c.env, user.name, "signin.web", c.request);
    if (analyticsConfig(c.env)) headers.append("Set-Cookie", trackCookieHeader(c.url, "sign_in"));
  }
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
  if (!s) return redirect("/auth/login?return=%2Fwelcome");
  // Signed in: the Everyday first-run screen, "Bring your assistant" (board #1272). Before a name is picked, choose one.
  if (s.user) {
    if (c.request.method !== "GET" || !c.viewer) return redirect("/");
    const [side, mine] = await Promise.all([sideBoardsNamed(c.env, c.viewer.name), sessions.list(c.env, c.viewer.name)]);
    return assistantWelcomePage(c.viewer, side, c.origin, mine.filter(sessions.listed).map((x) => x.client || x.name));
  }
  const suggestion = await freeName(c.env, suggestName(s.email, s.display_name));
  if (c.request.method === "GET") return welcomePage(s.email, suggestion);
  if (c.request.method !== "POST") return notFound();

  const name = normalizeUser(String((await c.request.formData()).get("name") ?? ""));
  if (!name) return welcomePage(s.email, suggestion, "Use 1–32 lowercase letters, numbers, dot, dash or underscore, starting with a letter or number.");
  if ((await handleTaken(c.env, name))) return welcomePage(s.email, name, `"${name}" is taken. Try another.`);
  if (await registry.userByWorkosId(c.env, s.workos_id)) return redirect("/");
  await registry.createUser(c.env, { name, email: s.email, email_verified: !!s.email_verified, workos_id: s.workos_id, display_name: s.display_name });
  await auth.setSessionUser(c.env, s.id_hash, name);
  await accountlog.record(c.env, name, "signin.web", c.request); // their first, finished on /welcome
  return redirect(safeReturn(c.url.searchParams.get("return")), analyticsConfig(c.env) ? { "Set-Cookie": trackCookieHeader(c.url, "sign_up") } : {});
}

// ---------- the app's own sign-in: email → 6-digit code → (new people) a name; returns an app token ----------

const NAME_RULES = "Use 1–32 lowercase letters, numbers, dot, dash or underscore, starting with a letter or number.";
const tooMany = () => json({ error: "Too many tries. Wait a few minutes, then try again." }, 429, { "retry-after": "600" });

/** The same token the OAuth sign-in gives the app (scope "person"): kind "app", 30 days, listed in Settings → Connected. */
async function appToken(env: Env, user: registry.FullUser, device: string | null, request: Request) {
  const label = device ? `Atteo app · ${device}` : "Atteo app";
  const t = await auth.createToken(env, user.name, label, { expiresAt: Date.now() + oauth.OAUTH_TOKEN_TTL_MS, kind: "app" });
  await accountlog.record(env, user.name, "signin.app", request, { label, kind: "app" });
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
  if (who.user) return json(await appToken(c.env, who.user, device, c.request), 200, { "cache-control": "no-store" });
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
    return json(await appToken(c.env, existing, s.device_name, c.request), 200, { "cache-control": "no-store" });
  }
  const name = normalizeUser(String(b.name ?? "").trim().replace(/^@/, ""));
  if (!name) return json({ error: NAME_RULES }, 400);
  if ((await handleTaken(c.env, name))) return json({ error: `"${name}" is taken. Try another.`, suggestion: await freeName(c.env, name) }, 409);
  try {
    await registry.createUser(c.env, { name, email: s.email, email_verified: !!s.email_verified, workos_id: s.workos_id, display_name: s.display_name });
  } catch {
    return json({ error: `"${name}" is taken. Try another.` }, 409); // someone took it a moment ago
  }
  await appSignin.useSignup(c.env, ticket);
  const user = await registry.userByName(c.env, name);
  if (!user) return json({ error: "Couldn't finish signing up. Try again." }, 500);
  return json(await appToken(c.env, user, s.device_name, c.request), 201, { "cache-control": "no-store" });
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
  const since14 = new Date(Date.now() - 13 * 86_400_000).toISOString().slice(0, 10);
  const [oauthClients, oauthPruned] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM oauth_clients`).first<{ n: number }>().catch(() => ({ n: 0 })),
    env.DB
      .prepare(`SELECT COALESCE(SUM(count), 0) AS n FROM usage_daily WHERE metric = 'oauth_clients_pruned' AND day >= ?`)
      .bind(since14)
      .first<{ n: number }>()
      .catch(() => ({ n: 0 })),
  ]);
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
  return {
    boards, users, invites, recent, totalEntries: boards.reduce((n, b) => n + b.entry_count, 0), access: [...access.values()], metrics: await usage.metrics(env).catch(() => undefined),
    oauth_clients: oauthClients?.n ?? 0,
    oauth_clients_pruned: oauthPruned?.n ?? 0,
    cost: {
      capped: await costGuard.capped(env).catch(() => null),
      watching: !!(env.CF_ACCOUNT_ID && costGuard.analyticsToken(env)),
      thresholds: costGuard.thresholds(env),
      ...(await costGuard.status(env)),
    },
  };
}

// ---------- router ----------

/** Every 5 minutes (the cron; tests call it through POST /api/ops/cron): retention, sweeps, unused OAuth clients,
 *  expired memberships, and workflow triggers on a daily schedule (`now` lets a test pick the time those see). */
async function runScheduled(env: Env, ctx: ExecutionContext, now = Date.now()): Promise<{ schedules: number; scheduled_tasks: number; housekeeping: boolean; oauth_clients_pruned: number; shed: Awaited<ReturnType<typeof limits.updateShedLevel>>; backup?: backup.BackupTick }> {
  // Load shedding (src/limits.ts): today's usage sets the level every request then sees (0 normal, 1 stretch waits and
  // pause background work, 2 also refuse non-essential agent writes).
  const shed = await limits.updateShedLevel(env).catch(() => ({ level: limits.shedLevelNow(), requests: 0, rows_read: null }));
  // The cost guard (src/costGuard.ts, vedu #4340): today's D1 and Durable Object usage against the soft and hard caps.
  // Alerts go to the developers' board (BUGS_BOARD) as the bug bot; no board configured, the cap still trips.
  ctx.waitUntil(
    costGuard
      .check(env, async (text) => {
        const board = (env.BUGS_BOARD ?? "").trim();
        if (!board) return console.log(text);
        const stub = boardStub(env, board);
        await ensureBugBoard(env, board, stub);
        await stub.post(bugs.BUG_BOT, { type: "note", text, via: "person", client: "cost-guard" });
      }, now)
      .catch((e) => console.error("cost guard failed", e)),
  );
  // Calls whose last page closed without leaving: end them and post the summary (src/calls.ts).
  ctx.waitUntil(calls.reapAll(calls.depsFor(env, null, null)).catch((e) => console.error("call reap failed", e)));
  // Slack: digests that waited their 15 minutes, the daily who-can-read check, and cleanup (src/slack.ts).
  ctx.waitUntil(slack.cron(env, now).catch((e) => console.error("slack sweep failed", e)));
  // Boards with a retention period: blank what's older.
  const keep = (await env.DB.prepare(`SELECT id, retention_days FROM boards WHERE retention_days IS NOT NULL`).all<{ id: string; retention_days: number }>()).results;
  for (const b of keep) ctx.waitUntil(boardStub(env, b.id).prune(now - b.retention_days * 86_400_000).catch(() => 0));
  // Housekeeping sweeps wait while shedding load (they catch up on a quieter run).
  const housekeeping = shed.level < 1;
  let oauth_clients_pruned = 0;
  if (housekeeping) {
    ctx.waitUntil(env.DB.prepare(registry.TAPE_PRUNE_SQL).bind(Date.now() - 7 * 86_400_000).run().catch(() => {}));
    ctx.waitUntil(appSignin.sweep(env).catch(() => {}));
    ctx.waitUntil(inbox.pruneRead(env, now).catch(() => {}));
    ctx.waitUntil(mailbox.pruneMail(env, now).catch(() => {}));
    ctx.waitUntil(usage.pruneUsageDaily(env, now).catch(() => {}));
    ctx.waitUntil(backup.pruneBackupParts(env, now).catch(() => {}));
    ctx.waitUntil(accountlog.prune(env, now).catch(() => {}));
    // Small table (DCR leftovers); await so POST /api/ops/cron can log the count. Fail-safe: an error leaves rows.
    oauth_clients_pruned = await oauth.pruneUnusedClients(env, now).catch((e) => (console.error("oauth client prune failed", e), 0));
    if (oauth_clients_pruned) console.log(`oauth clients pruned: ${oauth_clients_pruned}`);
  }
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
  await inbox.fireReminders(env, now);
  // Shared crons (board schedules): boards with one due by now post its task (each due time once; the board knows).
  const dueBoards = (
    await env.DB.prepare(`SELECT DISTINCT board_id FROM board_schedules WHERE next_at <= ?`)
      .bind(now)
      .all<{ board_id: string }>()
      .catch(() => ({ results: [] as { board_id: string }[] }))
  ).results;
  const posted = await Promise.all(dueBoards.map((b) => boardStub(env, b.board_id).runBoardSchedules(now).catch((e) => (console.error("board schedules failed", b.board_id, e), 0))));
  // The north star (src/northStar.ts): snapshot the running week; Monday from 16:00 UTC, last week's line to the team's
  // board, posted by the bug bot (the same one-bot-member setup as the cost guard's alerts).
  ctx.waitUntil(
    northStar
      .tick(env, now, async (board, text) => {
        const stub = boardStub(env, board);
        await ensureBugBoard(env, board, stub);
        await stub.post(bugs.BUG_BOT, { type: "note", text, via: "person", client: "north-star" });
      })
      .catch((e) => console.error("north star failed", e)),
  );
  // Tonight's encrypted backup (src/backup.ts, R2 or an S3 bucket): a batch of parts per run; it waits only at the worst shed level.
  const nightly =
    shed.level < 2
      ? await backup.backupTick(env, now, (id, day) => boardStub(env, id).backup(day)).catch((e) => (console.error("backup run failed", e), undefined))
      : undefined;
  return { schedules: fired.reduce((a, b) => a + b, 0), scheduled_tasks: posted.reduce((a, b) => a + b, 0), housekeeping, oauth_clients_pruned, shed, ...(nightly ? { backup: nightly } : {}) };
}

/** 429 for the signed-out endpoints limits.publicAllowed caps (one minute windows). */
function tooManyPublic(headers: Record<string, string> = {}): Response {
  return json({ error: "Too many requests from this address. Try again in a minute." }, 429, { ...headers, "retry-after": "60" });
}

const handler = {
  /** Every 5 minutes (wrangler.jsonc triggers.crons). */
  async scheduled(_event: ScheduledController, rawEnv: Env, ctx: ExecutionContext): Promise<void> {
    // Cron reads retry through dropped D1 connections too (SOUP-5/6 came after fetch got retryingReads, vedu #4844).
    await runScheduled({ ...rawEnv, DB: retryingReads(rawEnv.DB) }, ctx);
  },

  async fetch(request: Request, rawEnv: Env, ctx: ExecutionContext): Promise<Response> {
    // Local runs (wrangler dev, every test suite) never load analytics: the key in wrangler.jsonc is production's.
    return withAnalytics(isLocalHost(new URL(request.url).hostname) ? {} : rawEnv, async () => {
    // Database reads retry through dropped connections (a transient D1 error must never fail someone's post).
    const env: Env = { ...rawEnv, DB: retryingReads(rawEnv.DB) };
    const url = new URL(request.url);
    // Links back to the product (sign-in callback, emails, OAuth/A2A/OpenAPI metadata, install.sh) use the public
    // address: atteo.dev proxies to this workers.dev host, so url.origin is workers.dev even for atteo.dev visitors.
    const origin = publicOrigin(env, url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method;
    limits.countServed(env, ctx); // every request, for the cron's shed level (in memory, flushed in batches)
    const started = Date.now(); // wall time; Cloudflare does not expose CPU-ms cheaply on ctx

    // Old workers.dev page links move to the public site (legacyHostRedirect: what stays put, and the cf-worker loop guard).
    const moved = legacyHostRedirect(env, request, url);
    if (moved) {
      noteRequestWallMs(env, ctx, Date.now() - started);
      return new Response(null, { status: 301, headers: { location: moved, "cache-control": "public, max-age=300" } });
    }

    try {
      if (path === "/mcp") return await handleMcp(request, env, ctx);
      if (path === "/health") return json({ ok: true, version: env.CF_VERSION_METADATA?.id ?? null });
      // Public uptime page (docs/SELF_HOST.md). Coarse ok/degraded/down; not the board composer's /status card.
      if (path === "/status" || path === "/status.json") {
        if (!(await limits.publicAllowed(env, "status", request))) return tooManyPublic();
        return await handlePublicStatus(request, env, path);
      }
      // Browsers post what the CSP blocked (jxn's agent #2636; enforced since vedu #5192): no sign-in, always 204.
      if (path === "/api/csp-report" && method === "POST") return await csp.handleReport(request, env);
      if (path === "/health/deep") {
        if (!(await limits.publicAllowed(env, "health", request))) return tooManyPublic();
        // Same probes as /status (a board Durable Object and D1). Detail strings stay here; /status does not return them.
        const checks = await deepChecks(env);
        const ok = checks.boards === "ok" && checks.database === "ok";
        return json({ ok, version: env.CF_VERSION_METADATA?.id ?? null, checks }, ok ? 200 : 503, { "cache-control": "no-store" });
      }
      // ---- A2A: an Agent Card and a JSON-RPC endpoint for agents that don't speak MCP ----
      // Signed (A2A §8.4): clients check the card against /.well-known/jwks.json.
      if (path === "/.well-known/agent-card.json" || path === "/.well-known/agent.json") {
        const card = await a2a.signedCard(env, origin);
        return json(card, 200, { "access-control-allow-origin": "*", "atteo-card-signature": card.signatures ? "es256" : "none" });
      }
      if (path === "/.well-known/jwks.json") return json(await cardsign.jwks(env), 200, { "access-control-allow-origin": "*", "cache-control": "public, max-age=300" });
      if (path === "/a2a" && method === "POST") {
        const tok = auth.bearer(request);
        const who = tok ? (await auth.resolveToken(env, tok, ctx)).user : null;
        const rpcErr = (id: unknown, code: number, message: string, status = 200) => json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, status);
        if (!who) return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Send a personal token: Authorization: Bearer <token>" } }), { status: 401, headers: { "content-type": "application/json", "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` } });
        const denied = await limits.admit(env, ctx, { user: who, kind: "agent", tokenKey: await auth.sha256hex(tok!), wait: false, write: true, essential: true });
        if (denied) return denied;
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
            const blocked = egressRefusal(env, ctx, { text });
            if (blocked) return rpcErr(rpc.id, -32602, blocked);
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

      // The public pages' top bar offers Open Atteo instead of Sign in to someone with a session cookie (no lookup needed).
      const signedIn = !!auth.readCookie(request, auth.SESSION_COOKIE);
      if (path === "/terms" || path === "/privacy") return legalPage(path.slice(1) as "terms" | "privacy", signedIn);
      if (path === "/openapi.json") return json(openapi(origin), 200, { "access-control-allow-origin": "*", "cache-control": "public, max-age=300" });
      if (path === "/skill.md") return new Response(SKILL_MD, { headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "public, max-age=300" } });
      if (path === "/docs") return docsPage(origin, SKILL_MD, signedIn);
      if (path === "/agents.md") return new Response(agentsMd(origin), { headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "public, max-age=300", "access-control-allow-origin": "*" } });
      if (path === "/apple-touch-icon.png" || path === "/apple-touch-icon-precomposed.png") {
        return new Response(Uint8Array.from(atob(APPLE_TOUCH_PNG_B64), (c) => c.charCodeAt(0)), { headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" } });
      }
      // The HTML preview's shell (opus-b #2678): no data, its own enforced CSP, never the page's nonce. See PREVIEW_JS.
      if (path === "/preview-frame") {
        return new Response(PREVIEW_FRAME_HTML, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": PREVIEW_FRAME_CSP,
            "x-content-type-options": "nosniff",
            "referrer-policy": "no-referrer",
            "cache-control": "public, max-age=3600",
          },
        });
      }
      if (path === "/favicon.svg" || path === "/favicon.ico") {
        return new Response(FAVICON_SVG, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } });
      }

      const session = await auth.getSession(request, env);
      const viewer = await loadViewer(env, session, request, path);
      // Free-plan guardrails (src/limits.ts): per-token rate limit, the person's daily budget, load shedding. No D1 here.
      if (viewer) {
        const tok = session?.user ? null : auth.bearer(request);
        const denied = await limits.admit(env, ctx, {
          user: viewer.name,
          kind: viewer.via === "agent" ? "agent" : "person",
          tokenKey: tok ? await auth.sha256hex(tok) : null,
          wait: limits.isWaitRequest(method, path, url),
          write: method !== "GET" && method !== "HEAD" && method !== "OPTIONS",
          essential: limits.isEssentialRest(path),
          heavy: costGuard.isHeavyRest(method, path),
        });
        if (denied) return denied;
      }
      // ---- the Slack bridge (src/slack.ts): Slack's own requests (signed, no session) and the people's pages ----
      if (path.startsWith("/slack/")) return await slack.route(request, env, ctx, path, viewer, origin);
      const pv = (): "agent" | "person" => viewer?.via ?? "person"; // who wrote it: a person on the web, or an agent via token
      // Who's looking, for what a board shows: people-only messages (vedu #1264) reach only their own people, signed
      // in as themselves (web, the app). An agent's token, or no viewer (ops), sees none of them.
      const seer = (): Seer | null => (viewer ? { user: viewer.name, person: viewer.via !== "agent" } : null);
      // The agent session making the call (the CLI sends X-Atteo-Session): what it causes counts as its own posts.
      let sessionMemo: Promise<sessions.AgentSession | null> | null = null;
      const asess = () =>
        (sessionMemo ??= (async () => {
          const h = atteoHeader(request, "session");
          return h && viewer?.via === "agent" ? await sessions.get(env, viewer.name, h) : null;
        })());
      const asid = async () => (await asess())?.id ?? null;
      // Who's draining the mailbox (mailbox.leaseFor): the agent session, else the token (a dispatcher runs without a
      // session), else the signed-in page.
      const mailboxHolder = async () => {
        const s = await asid();
        if (s) return `s:${s}`;
        const tok = session?.user ? null : auth.bearer(request);
        return tok ? `t:${(await auth.sha256hex(tok)).slice(0, 32)}` : "web";
      };
      // Its id and name for the board: posts and tasks it causes are its own, and "is on it" names it.
      const asOpts = async () => {
        const s = await asess();
        return { session: s?.id ?? null, session_name: s?.name ?? null };
      };
      // A read-only agent session (scope "read") can read and wait, mark things seen, and manage its own session,
      // but nothing it sends may change a board or anyone's account.
      if (viewer?.via === "agent" && method !== "GET" && method !== "HEAD" && atteoHeader(request, "session")) {
        const sid = await asid();
        const s = sid ? await sessions.get(env, viewer.name, sid) : null;
        if (s?.scope === "read" && !/^\/api\/(sessions(\/|$)|boards\/[^/]+\/seen$)/.test(path))
          return json({ error: `This agent session (${s.name}) is read-only: it can read and wait, not post or change anything. Your person can give it full access on the web.` }, 403);
      }
      // A page fetched ahead (a hovered board link, #3717: Sec-Purpose: prefetch) isn't the person doing anything yet.
      const ahead = /prefetch/i.test(request.headers.get("sec-purpose") ?? "");
      if (viewer && viewer.via !== "agent" && !ahead) ctx.waitUntil(Promise.resolve(social.markSeen(env, viewer.name, "web")).catch(() => {}));
      if (viewer && viewer.via !== "agent" && !ahead && !viewer.name.startsWith("e2e-")) ctx.waitUntil(Promise.resolve(usage.track(env, "active_person", viewer.name, true)).catch(() => {}));
      const c: Ctx = { request, env, ctx, url, origin, session, viewer };
      const needLogin = () =>
        method === "GET" && !path.startsWith("/api/") ? redirect(`/auth/login?return=${encodeURIComponent(url.pathname + url.search)}`) : json({ error: "sign in required" }, 401);

      // ---- soft-deleted boards: gone for everyone (data stays in storage) until the creator restores one within 30 days ----
      {
        const dm = path.match(/^\/(?:api\/boards|b)\/(b_[a-z0-9]{8,32})(?:\/|$)/);
        if (dm && !(method === "POST" && path === `/api/boards/${dm[1]}/restore`) && (await registry.deletedAt(env, dm[1]))) {
          return path.startsWith("/api/") ? json({ error: "This chat was deleted" }, 404) : notFound(viewer);
        }
      }

      // ---- MCP OAuth: discovery, client registration, sign-in + approve, code → token ----
      const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization, mcp-protocol-version", "access-control-allow-methods": "GET, POST, OPTIONS" };
      if ((path.startsWith("/.well-known/oauth-") || path.startsWith("/oauth/")) && method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
      if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") return json(oauth.protectedResource(origin), 200, cors);
      if (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/openid-configuration") return json(oauth.authorizationServer(origin), 200, cors);
      if (path === "/oauth/register" && method === "POST") {
        if (!(await limits.publicAllowed(env, "oauth-register", request))) return tooManyPublic(cors);
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
          return json(await oauth.exchange(env, f, request), 200, { ...cors, "cache-control": "no-store" });
        } catch (e) {
          return json({ error: e instanceof oauth.OAuthError ? e.code : "invalid_request", error_description: e instanceof Error ? e.message : String(e) }, 400, cors);
        }
      }
      if (path === "/oauth/authorize" && method === "GET") {
        if (!viewer || viewer.via === "agent") return redirect(`/auth/login?return=${encodeURIComponent(url.pathname + url.search)}`);
        try {
          const r = await oauth.startAuthorize(env, viewer.name, url.searchParams);
          return consentPage(viewer, r.id, r.client.name, r.redirect, r.person);
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

      // ---- bug reports (web + app; jxn #3336, split with vedu's agent #3337/#3342) ----
      if (path === "/api/bugs" && method === "POST") {
        const bugsBoard = (env.BUGS_BOARD ?? "").trim();
        if (!bugsBoard) return json({ error: "Bug reports aren't set up." }, 501);
        if (viewer?.via === "agent") return json({ error: "Bug reports come from people (the button or the app). Ask your person to file it." }, 403);
        if (Number(request.headers.get("content-length") ?? 0) > bugs.BUG_SCREENSHOT_MAX + 64_000) return json({ error: "That report is too large (the screenshot is capped at 2 MB)." }, 413);
        const ip = appSignin.clientIp(request);
        for (const l of bugs.bugLimitKeys(viewer?.name ?? null, ip)) {
          if (!(await appSignin.hit(env, l.key, l.limit))) return json({ error: "That's a few bug reports in a row — try again in ten minutes." }, 429);
        }
        let report: bugs.BugReport;
        try {
          report = await bugs.parseBugForm(request);
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
        // One bug-bot member authors every report (an entry's author must be a real member, opus-d #3416);
        // the reporter is named in the text.
        const stub = boardStub(env, bugsBoard);
        try {
          await ensureBugBoard(env, bugsBoard, stub); // the bot member, set up on first use (jxn #4139)
          const pics = report.screenshots ?? (report.screenshot ? [report.screenshot] : []);
          const entry = pics.length > 1
            ? await stub.postFiles(bugs.BUG_BOT, { files: pics.map((p) => ({ name: p.name, bytes: p.bytes })), text: bugs.bugReportText(report, viewer?.name ?? "someone (signed out)"), via: "person", client: "bug-report" })
            : report.screenshot
            ? await stub.postFile(bugs.BUG_BOT, { name: report.screenshot.name, bytes: report.screenshot.bytes, text: bugs.bugReportText(report, viewer?.name ?? "someone (signed out)"), via: "person", client: "bug-report" })
            : await stub.post(bugs.BUG_BOT, { type: "note", text: bugs.bugReportText(report, viewer?.name ?? "someone (signed out)"), via: "person", client: "bug-report" });
          if (viewer) ctx.waitUntil(registry.touch(env, viewer.name, bugsBoard).catch(() => {}));
          return json({ ok: true, board: bugsBoard, seq: entry.seq }, 201);
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }

      if (path === "/bug-form" && method === "GET") {
        if (!viewer) return json({ error: "Sign in to report a bug." }, 401);
        return new Response(localize(viewer.lang, BUG_DIALOG), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" } });
      }

      // ---- feedback about Atteo itself (vedu #4125): people from the web and the app, agents on behalf of their person ----
      if (path === "/feedback-form" && method === "GET") {
        if (!viewer) return json({ error: "Sign in to send feedback." }, 401);
        return new Response(localize(viewer.lang, FEEDBACK_DIALOG), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" } });
      }
      if (path === "/api/feedback" && method === "POST") {
        if (!viewer) return json({ error: "Sign in to send feedback." }, 401);
        try {
          const body = await request.json().catch(() => null);
          const r = await feedback.sendFeedback(env, { hit: appSignin.hit, stub: boardStub, ensure: (e, b) => ensureBugBoard(e, b, boardStub(e, b)) }, { person: viewer.name, via: viewer.via === "agent" ? "agent" : "person", body });
          return json({ ok: true, ...r }, 201);
        } catch (e) {
          if (e instanceof feedback.FeedbackError) return json({ error: e.message }, e.status);
          return json({ error: e instanceof Error ? e.message : String(e) }, 400);
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
        if (!(await limits.publicAllowed(env, "device-start", request))) return tooManyPublic();
        const body = (await request.json().catch(() => ({}))) as { client?: string };
        return json(await device.startDeviceLogin(env, origin, String(body.client ?? "Atteo CLI")));
      }
      if (path === "/api/device/token" && method === "POST") {
        const body = (await request.json().catch(() => ({}))) as { device_code?: string };
        if (!body.device_code) return json({ error: "device_code required" }, 400);
        const r = await device.pollDeviceLogin(env, body.device_code, request);
        return json(r, r.status === "ok" ? 200 : r.status === "pending" ? 428 : 400);
      }
      if (path === "/device" && method === "GET") {
        if (!viewer) return needLogin();
        const code = device.normalizeUserCode(url.searchParams.get("code"));
        const d = code ? await device.deviceByUserCode(env, code) : null;
        const side = await sideBoardsNamed(env, viewer.name);
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
      if ((path === "/" || path === "/chats") && method === "GET") {
        if (session && !session.user) return redirect("/welcome");
        if (!viewer) return landingPage();
        const me = await registry.userByName(env, viewer.name);
        const [side, boards, invitations, status, had] = await Promise.all([
          sideBoardsNamed(env, viewer.name),
          registry.boardsOverview(env, viewer.name, viewer.via !== "agent"),
          me ? registry.invitationsFor(env, me) : [],
          registry.agentStatus(env, viewer.name),
          registry.everHadAgent(env, viewer.name),
        ]);
        // Everyday (#1272): home is "For you" once you have an assistant; the chat list lives at /chats. Developer mode keeps today's home.
        if (path === "/" && had && !invitations.length && viewer.via !== "agent" && !url.search && !(await developerFor(env, viewer.name, (await social.appPrefs(env, viewer.name))?.display.mode))) return redirect("/for-you");
        return homePage(viewer, side, boards, invitations, { connected: status.connected, onThisBoard: false }, undefined, !had);
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
          await stopBoardHosts(env, old.id, `${viewer.name} (archived the board)`); // like any archive (#4951, #5008)
          await boardStub(env, old.id).setArchived(true);
          await registry.setBoardArchived(env, old.id, true);
          ctx.waitUntil(registry.audit(env, old.id, viewer.name, "archived", null, "to make room on the Free plan").catch(() => {}));
        }
        try {
          const info = await createBoard(env, title, viewer.name, origin, { encrypted }, ctx);
          return redirect(`/b/${info.id}`, analyticsConfig(env) ? { "Set-Cookie": trackCookieHeader(url, "board_created") } : {});
        } catch (e) {
          const plan = e instanceof billing.BillingError;
          if (plan) {
            const mine = (await env.DB.prepare(`SELECT id, title, last_activity FROM boards WHERE created_by = ? AND archived_at IS NULL AND deleted_at IS NULL AND kind IS NULL ORDER BY last_activity`).bind(viewer.name).all<{ id: string; title: string; last_activity: number }>()).results;
            return makeRoomPage(viewer, title, encrypted, mine);
          }
          return messagePage(plan ? "Free plan limit" : "Board not created", e instanceof Error ? e.message.replace(/: https?:\S+$/, ".") : String(e), {
            viewer,
            status: plan ? 402 : 400,
            action: plan ? { href: "/me#billing", label: "See plans" } : { href: "/?new=1", label: "Try again" },
          });
        }
      }

      // A board's call on a page of its own (src/callWeb.ts; the app opens it in a web view). People who are members only.
      const cm = path.match(/^\/b\/([^/]+)\/call$/);
      if (cm && method === "GET") {
        if (!calls.callsOn(env, request)) return notFound(viewer); // not until a Realtime app is set up
        if (!viewer) return needLogin();
        if (viewer.via === "agent" || !(await registry.isMember(env, cm[1], viewer.name))) return notFound(viewer);
        const b = await registry.getBoard(env, cm[1]);
        if (!b || b.deleted_at) return notFound(viewer);
        return page(`Call · ${b.title}`, callPageBody(cm[1], b.title), { viewer, narrow: true, script: CALL_JS, css: [CALL_CSS_SRC] });
      }

      let m = path.match(/^\/(b|join)\/([^/]+)$/);
      if (m && method === "GET") {
        if (m[1] === "join") return redirect(`/b/${m[2]}`);
        if (!viewer) return needLogin();
        if (!(await canSee(c, m[2]))) return notFound(viewer);
        const [snap, members, invites, side, live, status, row, muted] = await Promise.all([
          boardStub(env, m[2]).snapshot(0, { latest: 80 }, seer()), // fewer messages on the page keeps scrolling smooth (jxn #1365); older ones load as you go back
          registry.boardMembers(env, m[2]),
          registry.pendingInvites(env, m[2]),
          sideBoardsNamed(env, viewer.name),
          registry.agentsOnBoard(env, m[2]),
          registry.agentStatus(env, viewer.name),
          registry.getBoard(env, m[2]),
          viewer.via === "agent" ? [] : moderation.mutedOn(env, viewer.name, m[2]).catch(() => []), // whom you muted here (#3602)
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
        const charter = charterView(storedFromRow(row), members.map((x) => ({ user: x.user, role: x.role })));
        // "Your agent": the composer's picker lists your agents (live or idle) by name.
        const mine = kind === "agent" ? (await sessions.list(env, viewer.name)).filter(sessions.listed).map((x) => ({ name: x.name, state: x.state, client: x.client })) : undefined;
        const agentNamed = agentNames(members);
        // This board leads the tabs in "Last opened" order (vedu #5192). The page itself records the open when it shows
        // (STRIP_JS): a hovered link fetches the page ahead (#3717), and that isn't opening it.
        const here = side.find((b) => b.id === m![2]);
        if (here) here.opened = Date.now();
        return boardPage(viewer, side, snap.info, withAgents, snap.entries.map((e) => withAgentNames(e, agentNamed)), shown, { connected: status.connected, onThisBoard: !!live[viewer.name] }, snap.summary, agentsHere, { picture: boardPictures.pictureUrl(m[2], row?.picture_v), kind, charter, sessions: mine, seen: snap.reads?.[viewer.name]?.person_seen ?? 0, last_seen: snap.reads?.[viewer.name]?.person_seen ?? 0, muted, calls: calls.callsOn(env, request), slack: slackOn(env, request) });
      }

      // ---- inbox: mentions of you, posts for your agent, replies to you ----
      if (path === "/inbox" && method === "GET") {
        if (!viewer) return needLogin();
        const [side, items, aps] = await Promise.all([sideBoardsNamed(env, viewer.name), inbox.listInbox(env, viewer.name, 100, viewer.via !== "agent"), approvals.listApprovals(env, viewer.name, "all")]);
        // Looking at the inbox is reading it: the badge clears (items still show as new on this view). Off-board items
        // (friend and contact requests, approvals) have no board to open, so this is where they get read.
        const unreadIds = items.filter((i) => !i.read_at).map((i) => i.id).slice(0, 90); // D1: at most 100 bound parameters
        if (unreadIds.length) ctx.waitUntil(inbox.markRead(env, viewer.name, { ids: unreadIds }).catch(() => 0));
        const dmPeers = items.flatMap((i) => (i.board_title?.includes(" ↔ ") ? i.board_title.split(" ↔ ") : []));
        const people = await displayNames(env, [...items.filter((i) => i.actor_via !== "agent").map((i) => i.actor), ...dmPeers]).catch(() => ({}));
        return inbox.inboxPage(viewer, side, items, aps, people);
      }
      // ---- The guide (vedu #2402): what people can do, by task. Public; signed in, its top bar goes back to the app ----
      if (path === "/guide" && method === "GET") {
        const lang = viewer?.lang ?? pickLang(null, url.searchParams.get("lang"), request.headers.get("accept-language"));
        return guidePage(lang, !!viewer, origin);
      }
      // ---- For you (Everyday's home): what needs your OK, decisions and questions for you, what your assistant did today ----
      if (path === "/for-you" && method === "GET") {
        if (!viewer) return needLogin();
        const now = Date.now();
        const [side, aps, items] = await Promise.all([sideBoardsNamed(env, viewer.name), approvals.listApprovals(env, viewer.name, "pending"), inbox.listInbox(env, viewer.name, 60)]);
        // Unread mail for you (the person) from the last week: mentions and replies open in their chat; their boards are
        // looked at too, so a decision or question waiting there shows even on a quiet board.
        const mail = items.filter((i) => !i.read_at && i.board_id && (i.kind === "mention" || i.kind === "reply" || i.kind === "decision") && now - i.created_at < 7 * 86_400_000);
        const mentions = mail.filter((i) => i.kind !== "decision" && i.entry_type !== "question" && i.entry_type !== "decision");
        const ids = [...new Set([...side.slice(0, forYou.FOR_YOU_BOARDS).map((b) => b.id), ...mail.map((i) => i.board_id)])].slice(0, forYou.FOR_YOU_BOARDS + 4);
        const boards = (await Promise.all(ids.map((id) => boardStub(env, id).forYou(viewer.name, now - forYou.DONE_WINDOW_MS).catch(() => null)))).filter((b): b is forYou.ForYouCore => !!b);
        const snoozedRows = (await env.DB.prepare(`SELECT n.board_id, n.seq, n.data FROM inbox_reminders r JOIN notifications n ON n.id = r.notification_id WHERE r.user = ?`).bind(viewer.name).all<{ board_id: string; seq: number; data: string | null }>()).results;
        const snoozed = new Set(snoozedRows.map((r) => `${r.board_id}:${r.seq}`));
        const snoozedApprovals = new Set(snoozedRows.flatMap((r) => { try { const id = JSON.parse(r.data ?? "null")?.push?.approval; return id ? [id as string] : []; } catch { return []; } }));
        const visible = boards.map((b) => ({ ...b, decisions: b.decisions.filter((x) => !snoozed.has(`${b.board.id}:${x.seq}`)), questions: b.questions.filter((x) => !snoozed.has(`${b.board.id}:${x.seq}`)) }));
        return forYou.forYouPage(viewer, side, { approvals: aps.filter((a) => !snoozedApprovals.has(a.id)), boards: visible, mentions, now });
      }
      if (path === "/api/inbox" && method === "GET") {
        if (!viewer) return needLogin();
        const items = await inbox.listInbox(env, viewer.name, 50, viewer.via !== "agent");
        if (viewer.via === "agent") return json({ items }); // agents never see a person's notification settings
        // People: each item says whether it interrupts (src/notify.ts), and when the digest is due.
        const [levels, prefs] = await Promise.all([notify.getLevels(env, viewer.name), notify.getPrefs(env, viewer.name, notify.fallbackTz(url.searchParams.get("tz")))]);
        const now = requestNow(env, request);
        return json({ items: inbox.withInterrupts(items, levels, prefs, now), notify: notify.summary(prefs, now) });
      }
      // ---- notification volume (a person's own): level per board, quiet hours, digest times ----
      if (path === "/api/me/notify" && (method === "GET" || method === "PUT")) {
        if (!viewer) return needLogin();
        if (viewer.via === "agent") return json({ error: "Only you set your notifications, in Atteo; agents can't read or change them." }, 403);
        const tz = notify.fallbackTz(url.searchParams.get("tz"));
        let prefs = await notify.getPrefs(env, viewer.name, tz);
        if (method !== "GET") {
          try {
            prefs = notify.mergePrefs(prefs, await request.json().catch(() => null));
          } catch (e) {
            if (e instanceof notify.NotifyError) return json({ error: e.message }, 400);
            throw e;
          }
          await notify.setPrefs(env, viewer.name, prefs);
        }
        return json({ ok: true, ...prefs, levels: await notify.getLevels(env, viewer.name), default_level: notify.DEFAULT_LEVEL, ...notify.summary(prefs, requestNow(env, request)) });
      }
      m = path.match(/^\/api\/boards\/([^/]+)\/notify$/);
      if (m && (method === "GET" || method === "PUT")) {
        if (!viewer) return needLogin();
        if (viewer.via === "agent") return json({ error: "Only you set your notifications, in Atteo; agents can't read or change them." }, 403);
        if (!BOARD_RE.test(m[1]) || !(await canSee(c, m[1]))) return json({ error: "board not found" }, 404);
        if (method !== "GET") {
          const b = (await request.json().catch(() => ({}))) as { level?: unknown };
          try {
            await notify.setLevel(env, viewer.name, m[1], notify.cleanLevel(b.level));
          } catch (e) {
            if (e instanceof notify.NotifyError) return json({ error: e.message }, 400);
            throw e;
          }
        }
        return json({ ok: true, board: m[1], level: await notify.getLevel(env, viewer.name, m[1]) });
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
      // ---- atteo ping (jxn #5433): is a member's agent open and listening here, and the infra round trip to it ----
      // {to: "vedu" | "vedu/bender" | "all", probe}: probe pings each CLI socket (never a model, never the log);
      // without it, only who holds a socket or a wait. Members only; pings are capped per person (src/board.ts).
      m = path.match(/^\/api\/boards\/([^/]+)\/ping$/);
      if (m && method === "POST") {
        if (!viewer) return needLogin();
        if (!BOARD_RE.test(m[1]) || !(await registry.memberRole(env, m[1], viewer.name))) return json({ error: "board not found" }, 404);
        const body = (await request.json().catch(() => ({}))) as { to?: unknown; probe?: unknown };
        const target = listen.parseTarget(typeof body.to === "string" ? body.to : null);
        if (target && !(await registry.memberRole(env, m[1], target.user))) return json({ error: `${target.user} isn't on this board.` }, 404);
        const probe = body.probe !== false;
        const got = await boardStub(env, m[1]).listeners(viewer.name, target?.user ?? null, probe);
        if (!Array.isArray(got)) return json({ error: got.error }, 429);
        const ids = [...new Set(got.map((l) => l.session).filter((x): x is string => !!x))].slice(0, 100);
        const named = ids.length
          ? (await env.DB.prepare(`SELECT id, name, client FROM agent_sessions WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<{ id: string; name: string; client: string | null }>()).results
          : [];
        const [members, mcp, here] = await Promise.all([registry.boardMembers(env, m[1]), registry.agentsOnBoard(env, m[1]), sessions.onBoard(env, m[1])]);
        const memberSet = new Set(members.map((x) => x.user));
        const rows = listen.liveRows(
          got.filter((l) => memberSet.has(l.user)),
          new Map(named.map((x) => [x.id, { name: x.name, client: x.client }])),
          here.filter((x) => memberSet.has(x.user)),
          Object.fromEntries(Object.entries(mcp).filter(([u]) => memberSet.has(u))),
          probe,
          target,
        );
        return json({ probe, agents: rows.map((r) => ({ ...r, line: listen.describeRow(r) })) }, 200, { "cache-control": "no-store" });
      }
      // ---- the mailbox: your agent's mail across every board and DM, for your own dispatcher to poll ----
      if (path === "/api/mailbox" && method === "GET") {
        if (!viewer) return needLogin();
        const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10) || 50));
        // Shedding load: waits hold up to twice as long and check half as often (fewer requests, same D1 reads a minute).
        const level = await limits.shedLevel(env);
        const wait = Math.round(limits.stretchWait(Math.min(25, Math.max(0, parseInt(url.searchParams.get("wait") ?? "0", 10) || 0)) * 1000, 50_000, level) / 1000);
        const peek = url.searchParams.get("peek") === "1";
        // An agent session gets its own mail too (mail for one session, "@you/claude-2", only reaches that session).
        const sid = await asid();
        // One drainer per person (#2184): drain=1 takes (or renews) the lease; while someone else holds it, a delivering
        // read only peeks (mail for this very session still comes). A plain peek never looks.
        const drain = url.searchParams.get("drain") === "1";
        const lease = drain || !peek ? await mailbox.leaseFor(env, viewer.name, await mailboxHolder(), (await asess())?.name ?? null, requestNow(env, request), drain) : null;
        // One open wait per agent session: a newer one ends this one (limits.beginWait).
        const w = wait && sid ? limits.beginWait(`s:${sid}`) : null;
        if (w?.refused) return waitRefused(w.refused);
        const editMail = sid && mailbox.editSweepDue(sid, wait > 0) ? (await Promise.all((await registry.boardsForUser(env, viewer.name)).map(async b =>
          (await withRetry(() => boardStub(env, b.id).editNotices(viewer.name, sid, peek)).catch((): string[] => [])).map((line, i) => ({ id: -Date.now() - i, kind: "edited" as const, board: b.id, board_title: b.title, seq: Number(line.match(/#(\d+)/)?.[1] ?? 0), from: "", from_via: "person", type: "edit", text: line, preview: line, for: "for your agent", ts: Date.now() }))))) .flat() : [];
        let r0: Awaited<ReturnType<typeof mailbox.collect>>;
        try {
          r0 = await mailbox.collect(env, viewer.name, { limit, wait: editMail.length ? 0 : wait, peek, held: !!lease, session: sid, pollMs: level >= 1 ? 6000 : 3000, signal: w?.signal }, async (b, seq) => { const e = (await boardStub(env, b).get(seq, { user: viewer.name, person: false })).entry; return { text: e.text, title: e.title }; }); // as the agent: its own lane too
        } finally {
          w?.done();
        }
        const r = { ...r0, mail: [...await social.mailWithAgentNames(env, r0.mail), ...editMail], ...(lease ? { held: mailbox.heldHint(lease), held_until: lease.expires_at } : {}), ...(limits.superseded(w?.signal) ? { superseded: true } : {}), ...(limits.pollAfterMs(level) ? { poll_after_ms: limits.pollAfterMs(level) } : {}) }; // from_agent_name: "Jarvis" (from: its owner)
        // headless: the person reads the board, not the agent's terminal (the CLI says so over the mail).
        return json((await social.agentsHeadless(env, viewer.name)) ? { ...r, headless: true } : r, 200, { "cache-control": "no-store" });
      }
      if (path === "/api/mailbox/ack" && method === "POST") {
        if (!viewer) return needLogin();
        const b = (await request.json().catch(() => ({}))) as { ids?: unknown };
        // Acknowledging is delivering: while another session drains this mailbox, only this session's own mail.
        const lease = await mailbox.leaseFor(env, viewer.name, await mailboxHolder(), null, requestNow(env, request), false);
        const delivered = await mailbox.ack(env, viewer.name, Array.isArray(b.ids) ? b.ids.map(Number) : [], lease ? await asid() : undefined);
        return json({ ok: true, delivered, ...(lease ? { held: mailbox.heldHint(lease), held_until: lease.expires_at } : {}) });
      }
      if (path === "/api/inbox/count" && method === "GET") {
        if (!viewer) return needLogin();
        const cnt = await inbox.inboxCount(env, viewer.name, viewer.via !== "agent");
        if (viewer.via === "agent") return json(cnt, 200, { "cache-control": "no-store" });
        // People: the newest item says whether it interrupts, and notify carries the digest that's due (digest_count:
        // what waited for the slot at digest_at, and on which boards), so a client shows it once without counting.
        const [levels, prefs] = await Promise.all([notify.getLevels(env, viewer.name), notify.getPrefs(env, viewer.name, notify.fallbackTz(url.searchParams.get("tz")))]);
        const now = requestNow(env, request);
        const sum = notify.summary(prefs, now);
        const due = await inbox.digestDue(env, viewer.name, levels, prefs, sum.digest_at);
        const latest0 = cnt.latest ? inbox.withInterrupts([cnt.latest], levels, prefs, now)[0] : null;
        // The notification names a person as they chose (jxn #4369; cached in names.ts, so polling costs no extra reads).
        const actorName = latest0 && latest0.actor_via !== "agent" && latest0.actor ? (await displayNames(env, [latest0.actor]).catch(() => ({}) as Record<string, string>))[latest0.actor] : undefined;
        const latest = latest0 && actorName ? { ...latest0, actor_name: actorName } : latest0;
        return json({ ...cnt, latest, notify: { ...sum, digest_count: due?.n ?? 0, digest_boards: due?.boards ?? [] } }, 200, { "cache-control": "no-store" });
      }
      m = path.match(/^\/api\/inbox\/([^/]+)\/remind$/);
      if (m && (method === "POST" || method === "DELETE")) {
        if (!viewer) return needLogin();
        if (viewer.via === "agent") return json({ error: "people only" }, 403);
        const body = method === "POST" ? (await request.json().catch(() => ({}))) as { at?: unknown } : {};
        const at = typeof body.at === "string" ? Date.parse(body.at) : body.at;
        if (method === "POST" && (typeof at !== "number" || !Number.isSafeInteger(at) || at <= Date.now() || at > Date.now() + 365 * 86_400_000)) return json({ error: "at must be a future ISO time within one year" }, 400);
        let id = Number(m[1]);
        if (!/^\d+$/.test(m[1])) {
          const target = m[1].match(/^([a-zA-Z0-9_-]+):(\d+)$/);
          if (!target || !BOARD_RE.test(target[1]) || !(await canSee(c, target[1]))) return json({ error: "message not found" }, 404);
          const existing = await env.DB.prepare(`SELECT id FROM notifications WHERE user = ? AND board_id = ? AND seq = ?`).bind(viewer.name, target[1], Number(target[2])).first<{ id: number }>();
          if (existing) id = existing.id;
          else if (method === "POST") {
            const entry = (await boardStub(env, target[1]).get(Number(target[2]), { user: viewer.name, person: true }).catch(() => null))?.entry;
            if (!entry) return json({ error: "message not found" }, 404);
            const created = await env.DB.prepare(`INSERT INTO notifications (user, board_id, seq, kind, actor, actor_via, entry_type, excerpt, created_at, read_at) VALUES (?, ?, ?, 'reminder', ?, ?, ?, ?, ?, ?) RETURNING id`).bind(viewer.name, target[1], entry.seq, entry.author, entry.via, entry.type, entry.text.slice(0, 180), Date.now(), Date.now()).first<{ id: number }>();
            id = created!.id;
          } else return json({ error: "reminder not found" }, 404);
        }
        if (method === "DELETE") return (await inbox.cancelReminder(env, viewer.name, id)) ? json({ ok: true }) : json({ error: "reminder not found" }, 404);
        return (await inbox.remind(env, viewer.name, id, at as number)) ? json({ ok: true, at }) : json({ error: "inbox item not found" }, 404);
      }
      if (path === "/api/inbox/read" && method === "POST") {
        if (!viewer) return needLogin();
        const body = (await request.json().catch(() => ({}))) as { all?: unknown; board?: string; ids?: unknown };
        const ids = Array.isArray(body.ids) ? body.ids.map(Number) : undefined;
        const n = await inbox.markRead(env, viewer.name, { all: body.all === true || body.all === "1", board: typeof body.board === "string" ? body.board : undefined, ids }, viewer.via !== "agent");
        return json({ ok: true, read: n });
      }

      // ---- GitHub App (signed inbound webhooks; outbound Checks only when App secrets are set) ----
      if (path === "/github/webhook" && method === "POST") {
        const raw = await request.text();
        const result = await githubApp.handleWebhook(env, raw, {
          event: request.headers.get("x-github-event"),
          signature: request.headers.get("x-hub-signature-256"),
          delivery: request.headers.get("x-github-delivery"),
        });
        if (result.status !== 200) return json({ error: result.error }, result.status);
        return json({ ok: true, applied: result.applied, ...(result.note ? { note: result.note } : {}) });
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
        // v2 messages use the board's current key; while a removal's rotation is pending, nothing new goes out under the
        // old one (the person removed still has it). Null when the payload may go ahead.
        const epochRefusal = async (payload: string): Promise<Response | null> => {
          const v2 = (() => { try { const p = JSON.parse(payload) as { v?: number; epoch?: number }; return p.v === 2 ? p : null; } catch { return null; } })();
          if (!v2) return null;
          const k = await boardkeys.state(env, km![1], viewer.name);
          if (k.rotate_needed) return json({ error: "Someone left or a device was removed: open a new epoch first (atteo does this for you).", rotate_needed: true }, 409);
          if (v2.epoch !== k.current) return json({ error: `This board's key is at epoch ${k.current}; encrypt with that.`, current: k.current }, 409);
          return null;
        };
        try {
          if (method === "POST" && !km[2]) {
            const b = (await request.json().catch(() => ({}))) as { to?: string; note?: string; payload?: string; type?: string; reply_to?: number; files?: unknown };
            const note = String(b.note ?? "");
            const blocked = egressRefusal(env, ctx, { note });
            if (blocked) return json({ error: blocked }, 400);
            if ((await registry.memberRole(env, km[1], viewer.name)) === "viewer") return json({ error: "Your role on this board is viewer." }, 403);
            const refused = await epochRefusal(String(b.payload ?? ""));
            if (refused) return refused;
            const files = Array.isArray(b.files) ? b.files.map(String) : [];
            const e = await stub.postSealed(viewer.name, { to: b.to ? String(b.to) : null, note, payload: String(b.payload ?? ""), type: b.type, reply_to: Number(b.reply_to) || null, files }, { via: pv(), client: viewer.via === "agent" ? "atteo CLI" : null, ...(await asOpts()) });
            ctx.waitUntil(registry.bumpBoard(env, km[1], e.seq).catch(() => {}));
            return json({ ok: true, entry: e }, 201);
          }
          // An edit: the author's new envelope for their message (people only, within 15 minutes; Board.editSealed).
          if (method === "PUT" && km[2]) {
            if (viewer.via === "agent") return json({ error: "Only people can edit their messages." }, 403);
            const b = (await request.json().catch(() => ({}))) as { payload?: string };
            const refused = await epochRefusal(String(b.payload ?? ""));
            if (refused) return refused;
            return json({ ok: true, entry: await stub.editSealed(viewer.name, pv(), parseInt(km[2], 10), String(b.payload ?? "")) });
          }
          if (method === "GET" && km[2]) return json(await stub.sealedFor(viewer.name, parseInt(km[2], 10)));
          if (method === "GET" && !km[2]) return json({ entries: await stub.sealedAfter(parseInt(url.searchParams.get("after") ?? "0", 10) || 0) });
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
        return json({ error: "not found" }, 404);
      }

      // ---- end-to-end encrypted boards' files: ciphertext in, ciphertext out (the key is inside the message) ----
      km = path.match(/^\/api\/boards\/(b_[a-z0-9]+)\/sealed-files(?:\/(sf_[a-z0-9]{1,40}))?$/);
      if (km) {
        if (!viewer) return needLogin();
        if (!(await registry.isMember(env, km[1], viewer.name))) return json({ error: "board not found" }, 404);
        const stub = boardStub(env, km[1]);
        try {
          if (method === "POST" && !km[2]) {
            if ((await registry.memberRole(env, km[1], viewer.name)) === "viewer") return json({ error: "Your role on this board is viewer." }, 403);
            const len = Number(request.headers.get("content-length") ?? "0");
            if (len > MAX_SEALED_FILE) return json({ error: `That file is too large (max ${MAX_IMAGE / 1e6} MB per file).` }, 413);
            const bytes = await request.arrayBuffer();
            return json({ ok: true, ...(await stub.putSealedFile(viewer.name, bytes)) }, 201);
          }
          if (method === "GET" && km[2]) {
            const bytes = await stub.sealedFile(km[2]);
            // Ciphertext never changes under an id, and only members get it.
            return new Response(bytes, { headers: { "content-type": "application/octet-stream", "cache-control": "private, max-age=31536000, immutable", "x-content-type-options": "nosniff" } });
          }
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
        return json({ error: "not found" }, 404);
      }

      // ---- approvals: agents ask their person before side effects; decisions only from a browser ----
      // Ask (Everyday): a voice-first page that asks your assistant in its chat and reads the answer aloud.
      if (path === "/ask" && method === "GET") {
        if (!viewer) return needLogin();
        const [side, me] = await Promise.all([sideBoardsNamed(env, viewer.name), social.profile(env, viewer.name).catch(() => null)]);
        return askPage(viewer, side, { assistant: me?.agent_name ?? null, agentChat: side.find((b) => b.kind === "agent")?.id ?? null });
      }
      if (path === "/approvals" && method === "GET") {
        if (!viewer) return needLogin();
        const [side, list] = await Promise.all([sideBoardsNamed(env, viewer.name), approvals.listApprovals(env, viewer.name, "all")]);
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
            const decided = await approvals.decide(env, viewer.name, am[1], am[2] === "approve", String(b.note ?? ""), ctx);
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
        const [side, friends, org] = await Promise.all([sideBoardsNamed(env, viewer.name), social.friendsOf(env, viewer.name), social.orgPeople(env, viewer.name)]);
        return peoplePage(viewer, side, friends, org);
      }
      let um = path.match(/^\/u\/([a-z0-9][a-z0-9_.-]{0,31})$/);
      if (um && method === "GET") {
        if (!viewer) return needLogin();
        const [side, p] = await Promise.all([sideBoardsNamed(env, viewer.name), social.person(env, viewer.name, um[1])]);
        if (!p) return notFound(viewer);
        const [shared, ag] = await Promise.all([p.relation === "self" || p.relation === "blocked" ? [] : social.sharedBoards(env, viewer.name, p.name).catch(() => []), agents.agent(env, viewer.name, p.name, viewer.via !== "agent").catch(() => null)]);
        return profilePage(viewer, side, p, social.presenceLabel(p.presence), { shared, agent: ag });
      }
      // Delete my account (Apple 5.1.1(v); jxn #4329): people only, never an agent's token, and only with the handle
      // typed back. Messages on shared boards stay as "Deleted user"; the rest goes (accountDelete.ts).
      // Delete my account (Apple 5.1.1(v); jxn #4329): people only, never an agent's token, from Atteo's own pages or the
      // app, with the handle typed back and the code emailed to the account's own address (jxn's agent #4414: a stolen
      // session or token alone isn't enough). Messages on shared boards stay as "Deleted user"; the rest goes.
      if ((path === "/api/me/delete-code" && method === "POST") || (path === "/api/me" && method === "DELETE")) {
        if (!viewer) return needLogin();
        if (viewer.via === "agent") return json({ error: "Only you can delete your account, from the app or the web. An agent can't." }, 403);
        const site = request.headers.get("sec-fetch-site");
        if (site && site !== "same-origin" && site !== "none") return json({ error: "Delete your account from Atteo's own pages." }, 403);
        const email = appSignin.normalizeEmail(viewer.email);
        if (!email) return json({ error: "Your account has no email to send a code to. Write to support to delete it." }, 400);
        const ip = appSignin.clientIp(request);
        const lim = appSignin.limits(env);
        const fake = appSignin.fakeAllowed(env, url, email);
        if (method === "POST") {
          if (!(await appSignin.hit(env, `delcode:ip:${ip}`, lim.startPerIp)) || !(await appSignin.hit(env, await appSignin.emailKey("delcode", email), lim.startPerEmail))) return tooMany();
          if (!fake) {
            if (!appSignin.workosConfigured(env)) return json({ error: "Codes aren't set up on this server." }, 503);
            const sent = await appSignin.sendCode(env, email, ip, request.headers.get("user-agent"));
            if (!sent.ok) {
              console.error(`delete account: WorkOS didn't send a code: ${sent.error}`);
              return json({ error: "Couldn't send the code. Try again in a minute." }, 502);
            }
          }
          await noteDeleteCodeSent(env, viewer.name);
          return json({ ok: true, sent_to: email }, 200, { "cache-control": "no-store" });
        }
        const body = (await request.json().catch(() => ({}))) as { confirm?: string; code?: string };
        if (String(body.confirm ?? "").trim().replace(/^@/, "").toLowerCase() !== viewer.name.toLowerCase()) return json({ error: `Type your handle, ${viewer.name}, to confirm.` }, 400);
        if (!(await appSignin.hit(env, `delverify:ip:${ip}`, lim.verifyPerIp)) || !(await appSignin.hit(env, await appSignin.emailKey("delverify", email), lim.verifyPerEmail))) return tooMany();
        const code = String(body.code ?? "").replace(/\s+/g, "");
        const verdict = await checkDeleteCode(env, viewer.name, email, code, async (e, c) => {
          if (fake) {
            if (c !== appSignin.FAKE_CODE) throw new Error("bad code");
            return { email: e };
          }
          return await appSignin.authenticateMagic(env, e, c, ip, request.headers.get("user-agent"));
        });
        if (verdict !== "ok")
          return json(verdict === "bad" ? { error: appSignin.BAD_CODE, need_code: true } : { error: "Send yourself a new code first: codes work once, for 10 minutes.", need_code: true, need_new_code: true }, 400);
        let r: Awaited<ReturnType<typeof deleteAccount>>;
        try {
          r = await deleteAccount(env, viewer.name, (id) => boardStub(env, id) as unknown as BoardForget);
        } catch (e) {
          console.error("account delete stopped part way (a retry finishes it)", e instanceof Error ? e.message : String(e));
          return json({ error: "Your account wasn't fully deleted. Send a new code and try again." }, 503);
        }
        if (r.stripe_followup) console.warn("account deleted with an active Pro plan: cancel its Stripe subscription by hand (ids in deleted_handles)", r.tombstone);
        return json({ ok: true, boards_kept: r.boards_kept, boards_removed: r.boards_removed }, 200, { "Set-Cookie": auth.cookieHeader(url, auth.SESSION_COOKIE, "", 0), "cache-control": "no-store" });
      }
      // Who this is (the app checks its token here after signing in).
      if (path === "/api/me" && method === "GET") {
        if (!viewer) return needLogin();
        return json({ name: viewer.name, email: viewer.email, display_name: viewer.display_name, via: viewer.via ?? "person" }, 200, { "cache-control": "no-store" });
      }
      // The account log (#3490): this person's sign-ins and token changes, newest first. People only: an agent's token
      // shouldn't read where its person signs in. ?format=jsonl downloads the year.
      if (path === "/api/me/audit" && method === "GET") {
        if (!viewer) return needLogin();
        if (viewer.via === "agent") return json({ error: "Your account log is for you, not your agents." }, 403);
        if (url.searchParams.get("format") === "jsonl") {
          return new Response(await accountlog.jsonl(env, viewer.name), {
            headers: { "content-type": "application/x-ndjson; charset=utf-8", "content-disposition": `attachment; filename="atteo-account-${viewer.name}-${new Date().toISOString().slice(0, 10)}.jsonl"`, "cache-control": "no-store" },
          });
        }
        return json(await accountlog.list(env, viewer.name, { before: Number(url.searchParams.get("before")) || undefined, limit: Number(url.searchParams.get("limit")) || 50 }), 200, { "cache-control": "no-store" });
      }
      // Access across your boards (#3568): your role on each, and on the boards you own everyone's access, open links and
      // invitations, with review nudges. People only, like the account log.
      if (path === "/api/me/access" && method === "GET") {
        if (!viewer) return needLogin();
        if (viewer.via === "agent") return json({ error: "Your access page is for you, not your agents." }, 403);
        return json(await accessAll(env, viewer.name), 200, { "cache-control": "no-store" });
      }
      if (path === "/api/me/pins" && (method === "GET" || method === "PUT")) {
        if (!viewer) return needLogin();
        if (viewer.via === "agent") return json({ error: "Pins are for people." }, 403);
        if (method === "GET") return json({ pins: await pins.getPins(env, viewer.name) }, 200, { "cache-control": "no-store" });
        const body = await request.json().catch(() => null) as { pins?: unknown } | null;
        try { return json({ pins: await pins.putPins(env, viewer.name, body?.pins) }, 200, { "cache-control": "no-store" }); }
        catch (e) { return json({ error: e instanceof Error ? e.message : String(e) }, 400); }
      }
      // ---- client prefs (the web and the app; agents never need them): display settings, favourite reactions ----
      if (path === "/api/app/prefs" && (method === "GET" || method === "POST")) {
        if (!viewer) return needLogin();
        if (viewer.via === "agent") return json({ error: "App settings are for people, in the web or the app." }, 403);
        if (method === "GET") {
          const prefs = await social.appPrefs(env, viewer.name);
          return json({ prefs: prefs && { ...prefs, developer: await developerFor(env, viewer.name, prefs.display.mode) } }, 200, { "cache-control": "no-store" });
        }
        const b = await request.json().catch(() => null);
        if (!b || typeof b !== "object" || Array.isArray(b)) return json({ error: 'Send an object, e.g. {"display":{"theme":"dark"}}.' }, 400);
        try {
          const saved = await social.setAppPrefs(env, viewer.name, b as Record<string, unknown>);
          return json({ ok: true, prefs: { ...saved, developer: await developerFor(env, viewer.name, saved.display.mode) } });
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }
      // display and reactions still work here (aliases of /api/app/prefs) so older web and app builds keep working.
      if (path === "/api/me/profile" && (method === "GET" || method === "POST")) {
        if (!viewer) return needLogin();
        if (method === "GET") {
          const p = await social.profile(env, viewer.name);
          return json({ profile: p && { ...p, developer: await developerFor(env, viewer.name, p.display?.mode) } });
        }
        const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        // Consent to send voice to xAI is the person's alone (jxn's agent #4444): an agent token can't give it.
        if (viewer.via === "agent" && (b.listed !== undefined || b.rules !== undefined || (b.display as { xai_ok?: unknown } | undefined)?.xai_ok !== undefined)) return json({ error: PEOPLE_ONLY_SETTING }, 403);
        const blocked = egressRefusal(env, ctx, { bio: typeof b.bio === "string" ? b.bio : null, display_name: typeof b.display_name === "string" ? b.display_name : null, agent_name: typeof b.agent_name === "string" ? b.agent_name : null });
        if (blocked) return json({ error: blocked }, 400);
        try {
          const who = viewer.name;
          // A renamed agent: every board they're on tells its open tabs, {type: "profile", user, agent_name}.
          const renamed = (name: string | null) =>
            ctx.waitUntil(registry.boardsForUser(env, who).then((bs) => Promise.all(bs.map((x) => boardStub(env, x.id).profileChanged(who, name).catch(() => {})))).catch(() => {}));
          const saved = await social.setProfile(env, who, b, renamed);
          if (b.display_name !== undefined) forgetDisplayName(who); // this isolate shows the new name at once (jxn #4369)
          return json({ ok: true, profile: saved });
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
            await env.DB.prepare(registry.TAPE_READ_SQL)
              .bind(from, viewer.name, limit)
              .all<Line>()
          ).results;
        // No cursor yet: start at the newest line (a tape shows what happens from now on, plus the last few).
        let from = after;
        if (!url.searchParams.has("after")) {
          const top = await env.DB.prepare(registry.TAPE_TOP_SQL).first<{ id: number | null }>();
          from = Math.max(0, (top?.id ?? 0) - Math.min(limit, 20));
        }
        let lines = await read(from);
        const until = Date.now() + waitSec * 1000;
        // How often a waiting call re-reads D1: 1.5s, or 5s while shedding load. ?every=<s> (up to 10) asks for slower
        // checks, never faster: the web's board tabs wait with every=5 (jxn's agent #5248), a third of the reads per open tab.
        const slower = Math.min(10, Math.max(0, parseInt(url.searchParams.get("every") ?? "", 10) || 0)) * 1000;
        const every = Math.max(limits.shedLevelNow() >= 1 ? 5000 : 1500, slower);
        while (!lines.length && Date.now() < until) {
          await new Promise((r) => setTimeout(r, every));
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
            const blocked = egressRefusal(env, ctx, { text });
            if (blocked) return json({ error: blocked }, 400);
            const to = dmm[1];
            const r = await dm.reach(env, me, to);
            if (r.ok) {
              const idemError = badMessageId(request.headers.get("idempotency-key"));
              if (idemError) return json({ error: idemError }, 400);
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
            const denied = social.contactDecisionError(viewer.via);
            if (denied) return json({ error: denied }, 403);
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
          if (path === "/api/agents" && method === "GET") return json({ agents: (await agents.findAgents(env, viewer.name, { can: url.searchParams.get("can"), q: url.searchParams.get("q"), person: viewer.via !== "agent" })).map((x) => flagged(x, x.summary)) });
          const am = path.match(/^\/api\/agents\/([^/]+)$/);
          if (am && method === "GET") {
            const who = am[1] === "me" ? viewer.name : decodeURIComponent(am[1]);
            const a = await agents.agent(env, viewer.name, who, viewer.via !== "agent");
            return a ? json({ agent: flagged(a, a.summary) }) : json({ error: `No agent "${who}" that you can see. Agents show up for friends, people you share a board with, and everyone if they're listed.` }, 404);
          }
          if (am && am[1] === "me" && method === "POST") {
            const b = (await request.json().catch(() => ({}))) as { summary?: unknown; capabilities?: unknown; listed?: unknown };
            if (viewer.via === "agent" && b.listed !== undefined) return json({ error: PEOPLE_ONLY_AGENT_LISTING }, 403);
            await agents.setProfile(env, viewer.name, b);
            const mine = await agents.agent(env, viewer.name, viewer.name, viewer.via !== "agent");
            return json({ agent: mine && flagged(mine, mine.summary) });
          }
          return json({ error: "not found" }, 404);
        } catch (e) {
          if (e instanceof agents.AgentError) return json({ error: e.message }, 400);
          throw e;
        }
      }

      // Standing rules: one automatic yes, for one board or one person, until it expires. People only.
      if (path === "/api/rules" && (method === "GET" || method === "POST")) {
        if (!viewer) return needLogin();
        if (viewer.via === "agent") return json({ error: "Standing rules are yours to set. Agents can't create or list them." }, 403);
        try {
          if (method === "GET") return json({ rules: await standing.listRules(env, viewer.name, url.searchParams.get("all") === "1") });
          const b = (await request.json().catch(() => ({}))) as { scope?: unknown; scope_id?: unknown; action?: unknown; expires_in?: unknown };
          const rule = await standing.createRule(env, viewer.name, b);
          await accountlog.record(env, viewer.name, "rule.added", request, { label: await standing.ruleLabel(env, rule), kind: rule.action });
          return json({ ok: true, rule }, 201);
        } catch (e) {
          if (e instanceof standing.StandingRuleError) return json({ error: e.message }, 400);
          throw e;
        }
      }
      const srm = path.match(/^\/api\/rules\/(sr_[A-Za-z0-9_-]+)\/revoke$/);
      if (srm && method === "POST") {
        if (!viewer) return needLogin();
        if (viewer.via === "agent") return json({ error: "Standing rules are yours to revoke. Agents can't." }, 403);
        try {
          const rule = await standing.revokeRule(env, viewer.name, srm[1]);
          await accountlog.record(env, viewer.name, "rule.revoked", request, { label: await standing.ruleLabel(env, rule), kind: rule.action });
          return json({ ok: true, rule });
        } catch (e) {
          if (e instanceof standing.StandingRuleError) return json({ error: e.message }, 400);
          throw e;
        }
      }

      if (path.startsWith("/api/people") || path.startsWith("/api/friends") || path.startsWith("/api/direct/") || path === "/api/org") {
        if (!viewer) return needLogin();
        const me = viewer.name;
        const err = (e: unknown) => json({ error: e instanceof Error ? e.message : String(e) }, e instanceof social.SocialError ? 400 : 500);
        try {
          if (path === "/api/org" && method === "GET") return json(await social.orgPeople(env, me, url.searchParams.get("q") ?? ""));
          if (path === "/api/people" && method === "GET") return json({ people: await social.findPeople(env, me, url.searchParams.get("q") ?? "") });
          let pm = path.match(/^\/api\/people\/([a-z0-9][a-z0-9_.-]{0,31})$/);
          if (pm && method === "GET") {
            const p = await social.person(env, me, pm[1]);
            return p ? json({ person: p, presence: social.presenceLabel(p.presence) }) : json({ error: "not found" }, 404);
          }
          if (path === "/api/friends" && method === "GET") return json(await social.friendsOf(env, me));
          if (path === "/api/friends/request" && method === "POST") {
            // Starting a friend request is the person's call, same as accept, decline, and block.
            // Agent tokens (MCP, the CLI, and the API) are refused before a row or an inbox item is written.
            const denied = social.contactDecisionError(viewer.via);
            if (denied) return json({ error: denied }, 403);
            const b = (await request.json().catch(() => ({}))) as { user?: string; note?: string };
            const note = String(b.note ?? "").trim();
            const blocked = egressRefusal(env, ctx, { note });
            if (blocked) return json({ error: blocked }, 400);
            try {
              return json({ ok: true, relation: await social.requestFriend(env, me, String(b.user ?? ""), note, ctx, viewer.via === "agent") });
            } catch (e) {
              if (e instanceof social.SocialError && e.message.includes(social.PERSON_ONLY_CONTACT_DECISION)) return json({ error: e.message }, 403);
              throw e;
            }
          }
          pm = path.match(/^\/api\/friends\/([a-z0-9][a-z0-9_.-]{0,31})\/(accept|decline|remove|block|unblock)$/);
          if (pm && method === "POST") {
            const denied = social.contactDecisionError(viewer.via);
            if (denied) return json({ error: denied }, 403);
            if (pm[2] === "accept") return json({ ok: true, relation: await social.acceptFriend(env, me, pm[1], ctx) });
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

      // The web's fonts (fonts.ts): served here, so no page asks Google for anything (#2515).
      if (path.startsWith("/fonts/") && method === "GET") return fontResponse(path, url) ?? new Response("not found", { status: 404 });

      // Every page's stylesheet and shell script (ui.ts): the pages ask for them with a version hash, so they're cached for good.
      if (path === BOARD_PREFETCH_PATH && method === "GET") return new Response(BOARD_PREFETCH_RULES, { headers: { "content-type": "application/speculationrules+json", "cache-control": "public, max-age=3600", "x-content-type-options": "nosniff" } });
      if (path === "/shell.js" && method === "GET") return new Response(SHELL_PAGE_JS, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": url.searchParams.get("v") ? "public, max-age=31536000, immutable" : "public, max-age=300", "x-content-type-options": "nosniff" } });
      if (path === "/bug.js" && method === "GET") return new Response(BUG_PAGE_JS, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": url.searchParams.get("v") ? "public, max-age=31536000, immutable" : "public, max-age=300", "x-content-type-options": "nosniff" } });
      if ((path === "/palette.js" || path === "/palette.css") && method === "GET") return new Response(path.endsWith(".js") ? PALETTE_JS : PALETTE_CSS, { headers: { "content-type": path.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8", "cache-control": url.searchParams.get("v") ? "public, max-age=31536000, immutable" : "public, max-age=300", "x-content-type-options": "nosniff" } });
      if (path === "/feedback.js" && method === "GET") return new Response(FEEDBACK_PAGE_JS, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": url.searchParams.get("v") ? "public, max-age=31536000, immutable" : "public, max-age=300", "x-content-type-options": "nosniff" } });
      if (path === "/host.js" && method === "GET") return new Response(HOST_PAGE_JS, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": url.searchParams.get("v") ? "public, max-age=31536000, immutable" : "public, max-age=300", "x-content-type-options": "nosniff" } });
      if (path === BOARD_TAIL_PATH && method === "GET") {
        const t = boardTail(url.searchParams.get("f") ?? "");
        if (!t) return new Response("not found", { status: 404 });
        return new Response(t.js, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": url.searchParams.get("v") ? "public, max-age=31536000, immutable" : "public, max-age=300", "x-content-type-options": "nosniff" } });
      }
      if ((path === CALL_JS_PATH || path === CALL_CSS_PATH) && method === "GET") {
        const css = path === CALL_CSS_PATH;
        return new Response(css ? CALL_CSS : CALL_JS, { headers: { "content-type": css ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8", "cache-control": url.searchParams.get("v") ? "public, max-age=31536000, immutable" : "public, max-age=300", "x-content-type-options": "nosniff" } });
      }
      if (path === BOARD_JS_PATH && method === "GET") return new Response(BOARD_JS, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": url.searchParams.get("v") ? "public, max-age=31536000, immutable" : "public, max-age=300", "x-content-type-options": "nosniff" } });
      if ((path === "/app.css" || path === "/app.js") && method === "GET") {
        const css = path === "/app.css";
        return new Response(css ? APP_CSS : APP_JS, { headers: { "content-type": css ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8", "cache-control": url.searchParams.get("v") ? "public, max-age=31536000, immutable" : "public, max-age=300", "x-content-type-options": "nosniff" } });
      }
      if (method === "GET" && path in PAGE_CSS) {
        return new Response(PAGE_CSS[path], { headers: { "content-type": "text/css; charset=utf-8", "cache-control": url.searchParams.get("v") ? "public, max-age=31536000, immutable" : "public, max-age=300", "x-content-type-options": "nosniff" } });
      }
      // Syntax colours for code blocks (codecolor.ts): pages load it only once a code block is on screen; the URL is versioned.
      if (path === CODE_COLOR_PATH && method === "GET") return new Response(CODE_COLOR_SCRIPT, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": url.searchParams.get("v") ? "public, max-age=31536000, immutable" : "public, max-age=300", "x-content-type-options": "nosniff" } });
      // Mermaid (mermaid.ts): pages load the pinned UMD build only once a diagram is on screen; SRI checks its bytes.
      if (path === MERMAID_PATH && method === "GET") return mermaidResponse(env, url);

      // ---- read aloud (an app/web client feature, all in tts.ts): /api/app/tts, /api/app/tts/status ----
      if (path.startsWith("/api/app/tts")) return tts.route(request, env, ctx, path, viewer);
      // ---- board calls (Cloudflare Realtime + the gated Atteo turn; all in calls.ts): /api/boards/:id/call… ----
      if (path.startsWith("/api/boards/") && calls.CALL_RE.test(path)) return (await calls.route(request, env, path, viewer))!;
      // ---- talk to Atteo (speech-to-speech; all in voice.ts): /api/app/voice/session, /session/end, /status ----
      if (path.startsWith("/api/app/voice/")) return voice.route(request, env, path, viewer);

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

      // Connect Muse with a key (#2291): a page for people; the key is made by its button, never on this GET.
      if (path === "/connect/muse" && method === "GET") {
        if (!viewer) return needLogin();
        if (viewer.via === "agent") return json({ error: "This page is for people, signed in on the web." }, 403);
        return musePage(viewer, await sideBoardsNamed(env, viewer.name), origin);
      }
      if (path === "/me" && method === "GET") {
        if (!viewer) return needLogin();
        const [side, tokens, plan, hooks, prof, mine, log, access, rules] = await Promise.all([
          sideBoardsNamed(env, viewer.name),
          auth.listTokens(env, viewer.name),
          billing.planOf(env, viewer.name),
          webhooks.listWebhooks(env, viewer.name),
          social.profile(env, viewer.name),
          sessions.list(env, viewer.name),
          accountlog.list(env, viewer.name, { limit: 6 }),
          viewer.via === "agent" ? null : accessAll(env, viewer.name).catch(() => null),
          viewer.via === "agent" ? null : standing.listRules(env, viewer.name).catch(() => null), // yours, active (#3775)
        ]);
        return mePage(viewer, side, tokens, plan, !!env.STRIPE_SECRET_KEY, hooks, prof, mine.filter(sessions.listed).map((x) => x.client || x.name), log.events, access, rules);
      }

      if (path === OPS_PATH && method === "GET") {
        if (!viewer?.admin) return notFound(viewer); // indistinguishable from a missing page unless you're an operator
        const [side, data] = await Promise.all([sideBoardsNamed(env, viewer.name), opsData(env)]);
        return adminPage(viewer, side, data);
      }

      // ---- rename / archive / restore a board (its creator, or an operator) ----
      m = path.match(/^\/api\/boards\/([^/]+)\/(rename|archive|unarchive)$/);
      if (m && method === "POST") {
        if (!viewer && !hasOpsKey(c)) return needLogin();
        const board = BOARD_RE.test(m[1]) ? await registry.getBoard(env, m[1]) : null;
        if (!board || !(await canSee(c, m[1]))) return json({ error: "board not found" }, 404);
        if (!isOps(c) && board.created_by !== viewer?.name && (await registry.memberRole(env, board.id, viewer?.name ?? "")) !== "owner") return json({ error: "Only the board's owners can do that." }, 403);
        const body = (await request.json().catch(() => ({}))) as { title?: string; archived?: boolean | string };
        ctx.waitUntil(registry.audit(env, board.id, viewer?.name ?? "ops", m[2] === "rename" ? "renamed" : m[2] === "unarchive" ? "unarchived" : body.archived === true || body.archived === "true" ? "archived" : "restored", null, m[2] === "rename" ? String(body.title ?? "").slice(0, 120) : null).catch(() => {}));
        try {
          if (m[2] === "rename") {
            const info = await boardStub(env, board.id).rename(String(body.title ?? ""));
            await registry.renameBoard(env, board.id, info.title);
            return json({ ok: true, title: info.title, message: `Renamed to "${info.title}".` });
          }
          const on = m[2] === "archive" && (body.archived === true || body.archived === "true");
          // Archiving stops every machine attached here (and drops their waiting runs, logged) before the board goes
          // read-only, so nothing runs on a board no one can see act (#4951).
          if (on) await stopBoardHosts(env, board.id, `${viewer?.name ?? "the board"} (archived the board)`);
          await boardStub(env, board.id).setArchived(on);
          await registry.setBoardArchived(env, board.id, on);
          return json({ ok: true, archived: on, message: on ? `Archived "${board.title}". It's read-only until restored.` : `Restored "${board.title}".` });
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }

      // ---- soft delete / restore (people who own the board; agents can't). Nothing is removed. ----
      m = path.match(/^\/api\/boards\/([^/]+)$/);
      if (m && method === "DELETE") {
        if (!viewer) return needLogin();
        const board = BOARD_RE.test(m[1]) ? await registry.getBoard(env, m[1]) : null;
        if (!board || board.deleted_at || !(await registry.isMember(env, board.id, viewer.name))) return json({ error: "board not found" }, 404);
        if (viewer.via === "agent") return json({ error: "Agents can't delete chats. Ask your person to." }, 403);
        if ((board as { kind?: string | null }).kind) return json({ error: "Direct messages and your agent chat can't be deleted." }, 400);
        if (board.created_by !== viewer.name) return json({ error: "Only the person who created this chat can delete it." }, 403);
        await registry.setBoardDeleted(env, board.id, viewer.name);
        ctx.waitUntil(registry.audit(env, board.id, viewer.name, "deleted", null, "soft delete; can be restored for 30 days").catch(() => {}));
        return json({ ok: true, deleted: true, restorable_until: Date.now() + registry.RESTORE_WINDOW_MS, message: `Deleted "${board.title}". You can restore it for 30 days.` });
      }
      m = path.match(/^\/api\/boards\/([^/]+)\/restore$/);
      if (m && method === "POST") {
        if (!viewer) return needLogin();
        const board = BOARD_RE.test(m[1]) ? await registry.getBoard(env, m[1]) : null;
        if (!board || !board.deleted_at || board.created_by !== viewer.name || viewer.via === "agent") return json({ error: "board not found" }, 404);
        if (requestNow(env, request) - board.deleted_at > registry.RESTORE_WINDOW_MS) return json({ error: "This chat was deleted more than 30 days ago, so it can't be restored." }, 410);
        await registry.setBoardDeleted(env, board.id, null);
        ctx.waitUntil(registry.audit(env, board.id, viewer.name, "restored_from_delete", null, null).catch(() => {}));
        return json({ ok: true, deleted: false, message: `Restored "${board.title}".` });
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
        await stopBoardHosts(env, board.id, `${viewer?.name ?? "ops"} (deleted the board)`).catch((e: unknown) => console.error("stopping hosts failed", e)); // #4951
        await registry.deleteBoard(env, board.id); // access ends here
        await boardStub(env, board.id).destroy(); // then the data
        return json({ ok: true, message: `Deleted "${board.title}".` });
      }

      // The app showed this board to its person: the tabs' "Last opened" order (vedu #5192). Personal; nothing is sent.
      m = path.match(/^\/api\/boards\/([^/]+)\/opened$/);
      if (m && method === "POST") {
        if (!viewer) return needLogin();
        if (viewer.via === "agent") return json({ error: "Only people open boards." }, 403);
        if (!(await registry.isMember(env, m[1], viewer.name))) return json({ error: "board not found" }, 404);
        const at = Date.now();
        await registry.markOpened(env, viewer.name, m[1], at);
        return json({ ok: true, opened_at: at });
      }

      // A personal bookmark: no post, mail, or push is sent to anyone.
      m = path.match(/^\/api\/boards\/([^/]+)\/unread$/);
      if (m && method === "POST") {
        if (!viewer) return needLogin();
        if (viewer.via === "agent") return json({ error: "Only people can mark a board unread." }, 403);
        if (!(await registry.isMember(env, m[1], viewer.name))) return json({ error: "board not found" }, 404);
        const seq = await boardStub(env, m[1]).markUnread(viewer.name);
        if (!seq) return json({ error: "This board has no entries." }, 409);
        await env.DB.prepare(`INSERT INTO notifications (user, board_id, seq, kind, actor, actor_via, entry_type, excerpt, created_at, read_at)
          VALUES (?, ?, 0, 'manual_unread', ?, 'person', 'note', '', ?, NULL)
          ON CONFLICT(user, board_id, seq) DO UPDATE SET read_at = NULL`)
          .bind(viewer.name, m[1], viewer.name, Date.now()).run();
        return json({ ok: true, seq, unread: 1 });
      }

      // ---- access: viewers can read but not change anything on a board ----
      m = path.match(/^\/api\/boards\/(b_[a-z0-9]+)\/(.+)$/);
      if (m && method !== "GET" && viewer && !hasOpsKey(c) && !/^members\/[^/]+\/remove$/.test(m[2]) && m[2] !== "ws" && m[2] !== "seen" && m[2] !== "unread" && m[2] !== "opened") { // read receipts aren't changes
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
        if (board.archived_at) return json({ error: `Board ${board.id} is archived, so it's read-only. Its creator can restore it.` }, 403);
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
        const agentView = viewer.via === "agent"; // the audit masks invitees' email addresses for agents (#3437)
        try {
          if (what === "members" && method === "GET" && !arg) return json({ members: await registry.boardMembers(env, id), you: myRole });
          if (what === "audit" && method === "GET" && arg === "export") {
            const afterId = parseAuditAfter(url.searchParams.get("after"));
            const exportedAt = Date.now();
            const rows = await registry.auditExportRows(env, id, afterId, owner);
            return json(auditExportDocument(id, agentView ? forAgents(rows) : rows, { exportedAt, afterId, pageSize: AUDIT_EXPORT_LIMIT }), 200, auditExportHeaders(id, exportedAt));
          }
          if (what === "audit" && method === "GET" && !arg) {
            const rows = await registry.auditLog(env, id, 100, owner);
            return json({ audit: agentView ? forAgents(rows) : rows });
          }
          if (what === "audit") return json({ error: "not found" }, 404);
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
          return redirect(`/b/${await access.redeemLink(env, m[1], viewer.name, origin, ctx)}`);
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
        // An agent's CLI says which session it is (X-Atteo-Session), so atteo ping can answer per session (#5433).
        const sh = as === "agent" ? atteoHeader(request, "session") : null;
        const sid = sh ? ((await sessions.get(env, who, sh).catch(() => null))?.id ?? null) : null;
        return boardStub(env, m[1]).fetch(new Request(`https://board/ws?user=${encodeURIComponent(who)}&role=${role}&as=${as}${sid ? `&session=${encodeURIComponent(sid)}` : ""}`, request));
      }

      // ---- a new board, as JSON (the app's "New board"; the web uses the POST /boards form). Encrypted unless asked not to. ----
      if (path === "/api/boards" && method === "POST") {
        if (!viewer) return needLogin();
        const body = (await request.json().catch(() => ({}))) as { title?: unknown; encrypted?: unknown };
        const title = String(body.title ?? "").trim().slice(0, 120);
        if (!title) return json({ error: "Give the board a title." }, 400);
        const blocked = egressRefusal(env, ctx, { title });
        if (blocked) return json({ error: blocked }, 400);
        try {
          const info = await createBoard(env, title, viewer.name, url.origin, { encrypted: body.encrypted !== false }, ctx);
          return json({ board: { ...info, encrypted: body.encrypted !== false, picture: null } }, 201);
        } catch (e) {
          const msg = e instanceof Error ? e.message.replace(/: https?:\S+$/, ".") : String(e);
          return json({ error: msg }, e instanceof billing.BillingError ? 402 : 400);
        }
      }

      if (path === "/api/me/board-states" && method === "GET") {
        if (!viewer) return json({ error: "sign in required" }, 401);
        return json({ boards: await boardStates(env, viewer.name) }, 200, { "cache-control": "private, no-store" });
      }

      // ---- the signed-in person's boards (CLI uses its bearer token) ----
      if (path === "/api/me/boards" && method === "GET") {
        const tok = auth.bearer(request);
        const who = viewer?.name ?? (tok ? (await auth.resolveToken(env, tok, ctx)).user : null);
        if (!who) return json({ error: "sign in required" }, 401);
        // The watcher checks in here every few minutes: that's how friends see "answers in the background".
        const watching = atteoHeader(request, "watch");
        if (watching) ctx.waitUntil(Promise.resolve(social.markSeen(env, who, "watch", watching === "respond")).catch(() => {}));
        const [boards, live, pinned] = await Promise.all([registry.boardsForUser(env, who), sessions.liveByBoard(env).catch(() => new Map<string, number>()), viewer?.via === "agent" ? Promise.resolve([] as string[]) : pins.getPins(env, who)]);
        const row = (b: (typeof boards)[number]) => ({
          live_agents: live.get(b.id) ?? 0, // agent sessions working on it right now
          id: b.id,
          title: b.title,
          kind: (b as { kind?: string | null }).kind || "board",
          entry_count: b.entry_count,
          last_activity: b.last_activity,
          opened_at: b.opened_at ?? null, // when you last opened it (web or app): the tabs' "Last opened" order (vedu #5192)
          last: b.last_author ? { by: b.last_via === "agent" ? `${b.last_author}'s agent` : b.last_author, text: b.last_excerpt ?? "" } : null,
          encrypted: !!(b as { encrypted?: number }).encrypted,
          created_by: b.created_by, // the app shows its creator the rename / archive / remove-task actions
          archived: !!b.archived_at,
          pinned: pinned.includes(b.id),
          picture: boardPictures.pictureUrl(b.id, b.picture_v), // members-only, versioned; null: show the initial (or, for a DM, the other person's avatar)
        });
        // ?with=<user>: only boards they're on (and invitations involving them); ?members=1 lists each board's members.
        // Pending invitations are always included, so an agent can tell "the board with vedu" apart from one waiting to be accepted.
        const withUser = normalizeUser(url.searchParams.get("with"));
        const wantMembers = !!withUser || url.searchParams.get("members") === "1";
        const memberNames = async (id: string) => (wantMembers ? (await registry.boardMembers(env, id)).map((m) => m.user) : undefined);
        const me = await registry.userByName(env, who);
        const invites = me ? await registry.invitationsFor(env, me) : [];
        const mine = await Promise.all(pins.sortPinned(boards, pinned).map(async (b) => ({ ...row(b), status: "member" as const, members: await memberNames(b.id) })));
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
        const b = (await request.json().catch(() => ({}))) as { from?: string; to?: string; seqs?: unknown; note?: string; selectedText?: string };
        const from = String(b.from ?? ""), to = String(b.to ?? "");
        const selectedText = typeof b.selectedText === "string" ? b.selectedText.replace(/\r/g, "").trim() : "";
        const seqs = [...new Set((Array.isArray(b.seqs) ? b.seqs : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].sort((x, y) => x - y).slice(0, 50);
        if (!seqs.length) return json({ error: "Select at least one message." }, 400);
        if (selectedText) {
          if (seqs.length !== 1) return json({ error: "Selected text forwards one message at a time." }, 400);
          if (!selectedText) return json({ error: "Selected text is empty." }, 400);
        }
        if (!from || !to || from === to) return json({ error: "Pick another board to forward to." }, 400);
        if (!(await registry.isMember(env, from, viewer.name)) || !(await registry.isMember(env, to, viewer.name))) return json({ error: "board not found" }, 404);
        if ((await registry.memberRole(env, to, viewer.name)) === "viewer") return json({ error: "You can view that board but not post to it." }, 403);
        const [src, dst] = await Promise.all([registry.getBoard(env, from), registry.getBoard(env, to)]);
        if (!src || !dst) return json({ error: "board not found" }, 404);
        if ((src as { encrypted?: number }).encrypted || (dst as { encrypted?: number }).encrypted) return json({ error: "End-to-end encrypted boards can't forward: the server can't read them." }, 400);
        const got = await Promise.all(seqs.map((n) => boardStub(env, from).get(n, seer()).catch(() => null)));
        const picked = got.filter((g): g is NonNullable<typeof g> => !!g && !g.replies.some((r) => r.retracts === g.entry.seq)).map((g) => g.entry);
        if (!picked.length) return json({ error: "Those messages aren't there anymore." }, 404);
        const destMembers = (await registry.boardMembers(env, to)).map((m) => m.user);
        let forwardPeople: string[] | undefined;
        for (const e of picked) {
          const fd = forwardDestOk(e, destMembers);
          if (!fd.ok) {
            return json(
              {
                error:
                  fd.reason === "just-mine"
                    ? "Just-mine messages can't be forwarded: they stay with you and your own agents."
                    : "People-only messages can only be forwarded to a board whose members are exactly the people who could see the original.",
              },
              400,
            );
          }
          if (fd.people) {
            const key = fd.people.slice().sort().join("\0");
            const cur = forwardPeople?.slice().sort().join("\0");
            if (forwardPeople && key !== cur) return json({ error: "Those people-only messages aren't for the same people." }, 400);
            forwardPeople = fd.people;
          }
        }
        if (selectedText && !forwardExcerptInEntry(selectedText, picked[0].text)) return json({ error: "That text isn't in the message" }, 400);
        const who = (e: Entry) => (e.via === "agent" ? `${e.author}'s agent` : e.author);
        const quote = (e: Entry) =>
          [`> **${who(e)}** · #${e.seq}`, ...(e.artifact_name ? [`> 📎 ${(e.attachments ?? []).map((a) => a.name).join(", ") || e.artifact_name}`] : []), ...e.text.slice(0, 2000).split("\n").slice(0, 40).map((l) => `> ${l}`)].join("\n");
        const note = String(b.note ?? "").trim().slice(0, 2000);
        const text = selectedText
          ? [...(note ? [note] : []), `↪ Forwarded from **${src.title}** · excerpt`, [...selectedText.slice(0, 2000).split("\n").slice(0, 40).map((l) => `> ${l}`), `> — ${who(picked[0])}, #${picked[0].seq}`].join("\n")].join("\n\n").slice(0, 20000)
          : [...(note ? [note] : []), `↪ Forwarded from **${src.title}** · ${picked.length} message${picked.length === 1 ? "" : "s"}`, ...picked.map(quote)].join("\n\n").slice(0, 20000);
        const blocked = egressRefusal(env, ctx, { text });
        if (blocked) return json({ error: blocked }, 400);
        // Only the note can mention anyone: quoted @names don't ping people on the new board.
        const { mentions } = note && mayMention(note) ? parseMentions(note, await registry.boardMembers(env, to), viewer.name, "person") : { mentions: [] as Mention[] };
        const entry = await boardStub(env, to).post(viewer.name, {
          type: "note",
          title: `Forwarded from ${src.title}`.slice(0, 60),
          text,
          mentions,
          via: "person",
          ...(forwardPeople ? { people_only: true, to_people: forwardPeople } : {}),
        });
        ctx.waitUntil(registry.bumpBoard(env, to, entry.seq).catch(() => {}));
        await recordForward(env, from, picked.map((e) => e.seq), to, entry.seq).catch(() => {}); // so a purge of these reaches the copy (#3969)
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
                const blocked = egressRefusal(env, ctx, { model: typeof b.model === "string" ? b.model : null });
                if (blocked) return json({ error: blocked }, 400);
                next = await sessions.setModel(env, next, b.model);
              }
              if (b.status !== undefined) {
                const blocked = egressRefusal(env, ctx, { status: typeof b.status === "string" ? b.status : null });
                if (blocked) return json({ error: blocked }, 400);
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
              if (target.invite && !(me && (await registry.acceptInvitation(env, me, target.id, origin, ctx)))) return json({ error: `Couldn't accept the invitation to ${target.id}.` }, 400);
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
          const render = (b: { id: string; title: string; encrypted?: boolean }, entries: import("./types").Entry[], tasksForYou?: number, headless = false, lines: string[] = [], entryLines: string[] = []) =>
            fence(
              [
                tasksForYou == null ? `== ${b.title} (${b.id}) · new (${entries.length}) ==` : readHeader(b, entries.length, tasksForYou, null, headless),
                ...lines, // 📌 pin, 🧭 SOUL update, 🧠 memory change
                ...(entries.length ? [] : ["(nothing new)"]),
                ...entryLines,
              ].join("\n"),
            );
          // ?ack=<board>:<seq>,…: what the client got from its last held wait (the `ack` that wait returned). Its read
          // position moves there first. Present at all (even empty), a wait holds: see below.
          const ackParam = url.searchParams.get("ack");
          const held = ackParam != null;
          if (ackParam) {
            const mine = new Set([...cur.boards, ...directs]);
            await Promise.all(
              ackParam.split(",").map(async (part) => {
                const [b, n] = part.split(":");
                const seq = Number(n);
                if (mine.has(b) && Number.isInteger(seq) && seq > 0) await boardStub(env, b).ack(viewer.name, seq, cur.id).catch(() => {});
              }),
            );
          }
          if (method === "GET" && sub === "read") {
            const limit = Number(url.searchParams.get("limit")) || undefined;
            const maxChars = parseReadBudget(url.searchParams.get("max_chars"));
            const summaryChars = parseSummaryBudget(url.searchParams.get("summary_budget"));
            // ?summary=all: every board's summary; none: no summary. Otherwise (older CLIs send a comma list of boards)
            // a board's summary comes with the member's first read of it, then only on request.
            const sumParam = url.searchParams.get("summary");
            const summary = (id: string) => (sumParam === "all" ? true : sumParam === "none" || (sumParam != null && !sumParam.split(",").includes(id)) ? false : undefined);
            const headless = await social.agentsHeadless(env, viewer.name);
            const out = await Promise.all(
              ids.map(async (id) => {
                const r = await boardStub(env, id).read(viewer.name, { limit, summary: summary(id), names: await social.boardAgentNames(env, id), maxChars, summaryChars }, cur.id);
                const b = { id, title: r.info.title, encrypted: r.info.encrypted };
                const p = readParts(r);
                p.lines.push(...await boardStub(env, id).editNotices(viewer.name, cur.id));
                const shown = presentReadEntries(r.entries, maxChars, viewer.name);
                return {
                  board: { id, title: r.info.title },
                  summary: r.summaryText,
                  rules: r.rules, // the SOUL (PROTOCOL.md), when due: {name, version, text, truncated, update, by}
                  memory: r.memory, // {first: true, items} on the first read, {first: false, added, struck} after a change, else null
                  entries: shown.entries,
                  remaining: r.remaining,
                  pin: r.pin, // "📌 SPEC.md updated to v4", once per version (null otherwise)
                  text: p.top.map((t) => fence(t) + "\n").join("") + (r.summaryText ? fence(r.summaryText) + "\n" : "") + render(b, shown.entries, r.tasksForYou, headless, p.lines, shown.lines),
                };
              }),
            );
            return json({ session: { id: cur.id, name: cur.name }, boards: out });
          }
          if (method === "GET" && sub === "wait") {
            // Shedding load stretches the wait (up to the usual maximum): fewer requests for the same listening.
            const ms = limits.stretchWait(Math.max(1000, Math.min((Number(url.searchParams.get("timeout")) || 45) * 1000, MAX_WAIT_MS)), MAX_WAIT_MS, await limits.shedLevel(env));
            // ?for=me: wake only for what's for this agent (a DM always is), then return everything new.
            const forMe = url.searchParams.get("for") === "me";
            const mineMode = (id: string, mine: boolean) => mine && forMe && !directs.includes(id);
            let gone = false; // removed from a board meanwhile: the wait ends
            // Held (?ack present): nothing moves the read position until the client acks with the `ack` this returns, so
            // a reply lost on the way (a deploy, a dropped connection, a retry) comes back on the next wait. Per board,
            // the burst's later takes start past what this request already took (`after`).
            const taken = new Map<string, number>(); // board → the last seq this request took
            const take = async (join: boolean, mine = true) => {
              const all = await Promise.all(ids.map(async (id) => ({ id, r: await boardStub(env, id).wait(viewer.name, join, cur.id, mineMode(id, mine), held ? { hold: true, after: taken.get(id) ?? 0 } : {}).catch(() => null) })));
              for (const x of all) if (x.r?.entries.length) taken.set(x.id, x.r.entries[x.r.entries.length - 1].seq);
              gone ||= all.some((x) => x.r?.gone);
              return all.filter((x) => x.r && x.r.entries.length);
            };
            const named = async (got: Awaited<ReturnType<typeof take>>) => Promise.all(got.map(async (x) => ({ ...x, r: { ...x.r!, entries: withNames(x.r!.entries, await social.boardAgentNames(env, x.id)) } })));
            let got = await take(true);
            let wasSuperseded = false;
            let waited = false;
            if (!got.length) {
              waited = true;
              // One open wait per session: a newer one ends this one (limits.beginWait).
              const w = limits.beginWait(`s:${cur.id}`);
              if (w.refused) return waitRefused(w.refused);
              const until = Date.now() + ms;
              try {
                // The Worker waits on every board at once (they sleep meanwhile); the first that has something wakes it.
                // For me, a wake can find nothing (another reader got there first): wait on for the time that's left.
                // Otherwise a wake ends the wait, as always (a removal, an archive).
                for (let again = true; again && !w.signal?.aborted; again = forMe && !got.length && !gone && until - Date.now() > 250) {
                  const woke = await new Promise<boolean>((resolve) => {
                    let left = ids.length;
                    for (const id of ids)
                      waitForBoard(boardStub(env, id), { kind: "agent", user: viewer.name, session: cur.id, forMe: mineMode(id, true) }, until - Date.now(), w.signal).then((v) => (v ? resolve(true) : --left === 0 && resolve(false)), () => --left === 0 && resolve(false));
                  });
                  if (!woke) break;
                  got = await take(false);
                }
              } finally {
                w.done();
              }
              wasSuperseded = limits.superseded(w.signal);
              // A burst (a few posts in a row) comes back as one answer, not just the post that woke this.
              if (got.length)
                await settle(async () => {
                  const more = await take(false, false);
                  for (const m of more) {
                    const x = got.find((g) => g.id === m.id);
                    if (x) x.r = { ...m.r!, entries: [...x.r!.entries, ...m.r!.entries], mine: [...x.r!.mine, ...m.r!.mine] };
                    else got.push(m);
                  }
                  return more.length;
                }, () => got.reduce((k, x) => k + x.r!.entries.length, 0) >= WAIT_CAP);
            }
            if (got.length) got = await named(got); // "Jarvis (vedu's agent)"
            if (waited) noteWakeDelivery(env, ctx, got.flatMap((x) => x.r!.entries), viewer.name);
            const entries = got.flatMap((x) => x.r!.entries.map((e) => ({ board: { id: x.id, title: x.r!.info.title }, entry: e })));
            // What's for you in full; the rest one line each with for=me or when there's a lot.
            const brief = forMe || entries.length > 10;
            const waitText = (x: (typeof got)[number]) => {
              const mine = new Set(x.r!.mine);
              return fence(
                [
                  `== ${x.r!.info.title} (${x.id}) · new (${x.r!.entries.length}${forMe ? `, ${mine.size} for you` : ""}) ==`,
                  ...x.r!.entries.map((e) => (brief && !mine.has(e.seq) ? compactLine(e, 80) : formatEntry(e, 4000, viewer.name))),
                  ...(x.r!.remaining ? [`… ${x.r!.remaining} more unread on this board; read again.`] : []),
                ].join("\n"),
              );
            };
            return json({
              timed_out: !entries.length,
              ...(wasSuperseded && !entries.length ? { superseded: true } : {}),
              // Held: send this as ?ack= on the next wait or read, once these entries are safely in hand.
              ...(held && taken.size ? { ack: [...taken].map(([id, seq]) => `${id}:${seq}`).join(",") } : {}),
              entries,
              text: entries.length
                ? got.map(waitText).join("\n")
                : wasSuperseded
                  ? "This wait ended early: a newer wait from the same session took over."
                  : `Nothing new on ${ids.length} board${ids.length === 1 ? "" : "s"} in ${Math.round(ms / 1000)}s.`,
            });
          }
          return json({ error: "method not allowed" }, 405);
        } catch (e) {
          if (e instanceof sessions.SessionLimitError) return json({ error: e.message, retry_after: 180 }, 429, { "retry-after": "180" });
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
          // ?format=text: a pasted rich-text file's words as JSON (vedu #5225), shown with textContent, never as HTML.
          // 422 when the bytes hold no RTF (an encrypted board's ciphertext): the page keeps the file card.
          if (url.searchParams.get("format") === "text") {
            const text = richTextOf(new Uint8Array(img.bytes));
            if (text === null) return json({ error: "not rich text" }, 422);
            return new Response(JSON.stringify({ text }), {
              headers: { "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff", "cache-control": v ? "private, max-age=31536000, immutable" : "private, no-cache" },
            });
          }
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
          const fileMembers = await registry.boardMembers(env, id);
          const { mentions } = mayMention(text) ? parseMentions(text, fileMembers, viewer.name, pv()) : { mentions: [] };
          try {
            const replyTo = Number(replyRaw) > 0 ? Math.floor(Number(replyRaw)) : null; // files sent as a reply
            const entry = multi
              ? await stub.postFiles(viewer.name, { files, text, mentions, reply_to: replyTo, via: pv() })
              : await stub.postFile(viewer.name, { ...files[0], text, mentions, reply_to: replyTo, via: pv() });
            ctx.waitUntil(Promise.all([registry.touch(env, viewer.name, id), registry.bumpBoard(env, id, entry.seq)]).catch(() => {}));
            // Like a text post, the rendered entry comes back so the page can swap its "sending" copy for it.
            const root = replyTo ? ((await stub.rootsFor([entry.seq]))[entry.seq] ?? entry.seq) : entry.seq;
            return json({ ok: true, entry, update: { seq: entry.seq, root, retracts: entry.retracts, html: entryHtml(withAgentNames(entry, agentNames(fileMembers)), id, true, { canRetract: true, canEdit: true, lang: viewer?.lang, people: displayMap(fileMembers), members: fileMembers.map((m) => m.user), person: !!viewer && viewer.via !== "agent" }), row: logRow(entry, undefined, undefined, viewer?.lang), reactions: [] } }, 201);
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

      // atteo host's link: the board, with the consent dialog for that machine open (the person types the phrase there).
      if (path === "/host/consent" && method === "GET") {
        if (!viewer) return needLogin();
        const bid = url.searchParams.get("board") ?? "", machine = url.searchParams.get("machine") ?? "";
        if (!/^b_[a-z0-9]+$/.test(bid) || !MACHINE_RE.test(machine) || !(await registry.isMember(env, bid, viewer.name))) return json({ error: "This link isn't for a board you're on, or it's incomplete. Copy it again from atteo host." }, 404);
        // The folders and allowlist ride along so the dialog shows exactly what the code will allow (#4917).
        const scope = (url.searchParams.get("scope") ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 6000);
        return redirect(`/b/${bid}?host_consent=${encodeURIComponent(machine)}${scope ? `&host_scope=${scope}` : ""}`);
      }
      // ---- atteo host (docs/HOST.md): a member's own machine on the board; every command needs its owner's OK ----
      m = path.match(/^\/api\/boards\/(b_[a-z0-9]+)\/hosts(?:\/(confirm|h_[A-Za-z0-9_-]+|all)(?:\/(stop|next|runs)(?:\/(hr_[A-Za-z0-9_-]+)(?:\/(result))?)?)?)?$/);
      if (m) {
        if (!viewer) return needLogin();
        const [, bid, target, act, runId, result] = m;
        if (!(await registry.isMember(env, bid, viewer.name))) return json({ error: "board not found" }, 404);
        const audit = (user: string, text: string) =>
          boardStub(env, bid)
            .notice(user, "Host", text, { via: "agent", client: "atteo host", session: null })
            .catch((e: unknown) => console.error("host audit failed", e));
        try {
          if (!target && method === "GET") return json({ hosts: (await hosts.listHosts(env, bid)).map((h) => hosts.hostView(h)) }, 200, { "cache-control": "no-store" });
          if (target === "confirm" && !act && method === "POST") {
            // The consent is the person's alone, like approvals: an agent (or the CLI an agent could run) can't mint it.
            if (viewer.via === "agent") return json({ error: `Only you can allow a machine, signed in on the web or the app: open ${origin}/host/consent?board=${bid}&machine=… from atteo host's link.` }, 403);
            const b = (await request.json().catch(() => ({}))) as { phrase?: unknown; machine?: unknown; shares?: unknown; allow?: unknown; network?: unknown };
            return json(await hosts.confirm(env, bid, viewer.name, b.phrase, b.machine, { shares: b.shares, allow: b.allow, network: b.network }));
          }
          if (!target && method === "POST") {
            const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
            const { host: h, secret } = await hosts.register(env, bid, viewer.name, b);
            await audit(viewer.name, hosts.attachText(h));
            // The secret is shown once, to the daemon that registered: only it can poll for work and report results (#4939).
            return json({ host: hosts.hostView(h), secret });
          }
          if (target && act === "stop" && method === "POST") {
            const board = await registry.getBoard(env, bid);
            const owner = (await registry.memberRole(env, bid, viewer.name)) === "owner" || board?.created_by === viewer.name ? viewer.name : null;
            const got = await hosts.stop(env, bid, target, viewer.name, owner);
            for (const h of got.hosts) await audit(viewer.name, hosts.stopText(h, viewer.name));
            for (const r of got.dropped) {
              const h = got.hosts.find((x) => x.id === r.host_id);
              if (h) await audit(h.owner, hosts.auditText(h, r)); // one line per run the Stop dropped (#4942)
            }
            for (const a of got.closed) await boardStub(env, bid).approvalDecided(approvals.refOf(a)).catch((e: unknown) => console.error("approval event failed", e));
            return json({ stopped: got.hosts.map((h) => hosts.hostView(h)) });
          }
          if (target && target !== "all" && target !== "confirm") {
            const host = await hosts.getHost(env, bid, target);
            if (!host) return json({ error: "No such host." }, 404);
            // The host's own endpoints: its owner's login AND the daemon's secret, so no other token of the owner (an
            // agent's) can take approved runs or report fake results (#4939).
            const ownerOnly = async () => {
              if (host.owner !== viewer.name) throw new hosts.HostError("Only the machine's owner (its atteo host) can do that.", 403);
              if (!(await hosts.secretOk(host, request.headers.get("x-atteo-host-secret")))) throw new hosts.HostError("Only this machine's own atteo host can do that.", 403);
            };
            if (act === "next" && method === "GET") {
              await ownerOnly();
              const wait = Math.min(25, Math.max(0, parseInt(url.searchParams.get("wait") ?? "0", 10) || 0));
              const got = await hosts.next(env, bid, host, wait * 1000, requestNow(env, request));
              for (const r of got.settled) await audit(host.owner, hosts.auditText(host, r));
              if (got.stop) return json({ stop: got.stop }, 200, { "cache-control": "no-store" });
              return json({ run: got.run ? hosts.runView(got.run) : null }, 200, { "cache-control": "no-store" });
            }
            if (act === "runs" && !runId && method === "POST") {
              if ((await registry.memberRole(env, bid, viewer.name)) === "viewer") return json({ error: "You can only view this board, so you can't ask its machines to run anything." }, 403);
              const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
              const made = await hosts.request(env, bid, host.id, viewer.name, b, requestNow(env, request));
              if (made.approval) {
                // The owner's card on the board: Approve or Deny, like any approval (only the person decides).
                await boardStub(env, bid).approvalRequested(approvals.refOf(made.approval), { via: "agent", client: "atteo host" }).catch((e: unknown) => console.error("host approval entry failed", e));
              }
              return json({ run: hosts.runView(made.run) });
            }
            if (act === "runs" && runId && !result && method === "GET") {
              const wait = Math.min(25, Math.max(0, parseInt(url.searchParams.get("wait") ?? "0", 10) || 0));
              const got = await hosts.runNow(env, bid, host, runId, wait * 1000, requestNow(env, request));
              if (!got) return json({ error: "No such run." }, 404);
              if (got.closed) await audit(host.owner, hosts.auditText(host, got.closed));
              return json({ run: hosts.runView(got.run) }, 200, { "cache-control": "no-store" });
            }
            if (act === "runs" && runId && result && method === "POST") {
              await ownerOnly();
              const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
              const r = await hosts.finish(env, bid, host, runId, b);
              await audit(host.owner, hosts.auditText(host, r));
              return json({ run: hosts.runView(r) });
            }
          }
        } catch (e) {
          if (e instanceof hosts.HostError) return json({ error: e.message }, e.status);
          throw e;
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

      // ---- ls: the board as a read-only tree (state.md, files/, log/); nothing is marked read ----
      m = path.match(/^\/api\/boards\/(b_[a-z0-9]+)\/ls$/);
      if (m && method === "GET") {
        if (!viewer) return needLogin();
        if (!(await registry.isMember(env, m[1], viewer.name))) return json({ error: "board not found" }, 404);
        try {
          const r = await listMount(
            boardStub(env, m[1]),
            { path: url.searchParams.get("path") ?? undefined, long: url.searchParams.get("long"), since: url.searchParams.get("since"), limit: url.searchParams.get("limit") },
            seer(),
          );
          const { untrusted: _untrusted, ...body } = r;
          return json(body, 200, { "cache-control": "no-store" });
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, e instanceof LsError ? 400 : 400);
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

      // ---- board charter: goal, data classes, retention, and a note for each member ----
      m = path.match(/^\/api\/boards\/(b_[a-z0-9]+)\/charter$/);
      if (m && (method === "GET" || method === "POST")) {
        if (!viewer) return needLogin();
        const role = await registry.memberRole(env, m[1], viewer.name);
        if (!role) return json({ error: "board not found" }, 404);
        const board = await registry.getBoard(env, m[1]);
        if (!board) return json({ error: "board not found" }, 404);
        const members = await registry.boardMembers(env, m[1]);
        const stored = storedFromRow(board);
        const canEdit = (role === "owner" || board.created_by === viewer.name) && viewer.via !== "agent" && !board.archived_at;
        if (method === "GET") {
          // The goal and members' notes are owner-written prose agents act on: screened, as in the agents' Charter line (#3778, #3879).
          const view = charterView(stored, members);
          return json({ charter: flagged({ ...view, members: view.members.map((x) => flagged(x, x.note)) }, stored.goal), can_edit: canEdit }, 200, { "cache-control": "no-store" });
        }
        if (viewer.via === "agent") return json({ error: "Only people edit a board's charter. Ask your person to change it." }, 403);
        if (role !== "owner" && board.created_by !== viewer.name) return json({ error: "Only the board's owners can edit its charter." }, 403);
        if (board.archived_at) return json({ error: "This board is archived. Restore it to edit the charter." }, 403);
        let patch;
        try {
          patch = parseCharterPatch(await request.json().catch(() => ({})));
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
        let next;
        try {
          next = applyCharter(stored, patch, members.map((x) => x.user));
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
        const blocked = egressRefusal(env, ctx, charterScanFields(next, patch));
        if (blocked) return json({ error: blocked }, 400);
        if (patch.retention_days !== undefined) {
          const creator = await registry.userByName(env, board.created_by);
          const pol = creator?.email ? await orgPolicy(env, creator.email) : null;
          if (pol?.max_retention_days && (next.retention_days == null || next.retention_days > pol.max_retention_days)) return json({ error: `${pol.domain} keeps messages at most ${pol.max_retention_days} days.` }, 400);
        }
        const changed = JSON.stringify(stored) !== JSON.stringify(next);
        if (changed) {
          await registry.saveBoardCharter(env, m[1], next);
          await boardStub(env, m[1]).setCharter(agentCharter(next)); // agents read it from the board (#3685)
          await registry.audit(env, m[1], viewer.name, "charter", null, charterAuditDetail(next));
        }
        const pruned = patch.retention_days !== undefined && next.retention_days ? await boardStub(env, m[1]).prune(Date.now() - next.retention_days * 86_400_000) : 0;
        return json({ ok: true, charter: charterView(next, members), pruned });
      }

      // ---- board details (any member edits) and search across your boards ----
      m = path.match(/^\/api\/boards\/(b_[a-z0-9]+)\/retention$/);
      if (m && method === "POST") {
        if (!viewer) return needLogin();
        const board = await registry.getBoard(env, m[1]);
        if (!board || ((await registry.memberRole(env, m[1], viewer.name)) !== "owner" && board.created_by !== viewer.name)) return json({ error: "Only the board's owners can set how long it keeps messages." }, 403);
        if (board.archived_at) return json({ error: "This board is archived. Restore it to change retention." }, 403);
        const b = (await request.json().catch(() => ({}))) as { days?: number | string | null };
        const days = b.days == null || b.days === "" || Number(b.days) === 0 ? null : Math.floor(Number(b.days));
        if (days != null && (!Number.isFinite(days) || days < 1 || days > 3650)) return json({ error: "days must be 1–3650, or empty to keep everything." }, 400);
        const creator = await registry.userByName(env, board.created_by);
        const pol = creator?.email ? await orgPolicy(env, creator.email) : null;
        if (pol?.max_retention_days && (days == null || days > pol.max_retention_days)) return json({ error: `${pol.domain} keeps messages at most ${pol.max_retention_days} days.` }, 400);
        await env.DB.prepare(`UPDATE boards SET retention_days = ? WHERE id = ?`).bind(days, m[1]).run();
        await boardStub(env, m[1]).setCharter(agentCharter({ ...storedFromRow(board), retention_days: days })); // the charter agents read says it (#3685)
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
          const blocked = egressRefusal(env, ctx, { description: meta.description, tags: meta.tags.join(" "), links: meta.links.map((l) => `${l.label} ${l.url}`).join("\n") });
          if (blocked) return json({ error: blocked }, 400);
          await registry.setBoardMeta(env, m[1], meta);
          return json({ ok: true, meta });
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }
      // grep across all your boards (encrypted ones are skipped and counted).
      if (path === "/api/grep" && method === "GET") {
        if (!viewer) return needLogin();
        return grepResponse(env, viewer.name, url, null, seer());
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
        if (method === "GET" && !m[2]) return json({ tasks: (await stub.tasks()).map((t) => flagged(t, `${t.title}\n${t.body}`)) });
        if (method === "GET" && m[2]) {
          try {
            const seq = parseInt(m[2], 10);
            const [task, history] = await Promise.all([stub.taskGet(seq), stub.taskHistory(seq)]);
            // html: the task as it is now, rendered like its entry (title, then body), for the live card in the chat
            return json({ task: flagged({ ...task, html: renderText(task.body ? `${task.title}\n\n${task.body}` : task.title) }, `${task.title}\n${task.body}`), history });
          } catch (e) {
            return json({ error: e instanceof Error ? e.message : String(e) }, 404);
          }
        }
        if (method === "POST" && !m[2]) {
          const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
          try {
            const created = await stub.taskCreate(
              viewer.name,
              { title: String(b.title ?? ""), body: typeof b.body === "string" ? b.body : "", priority: (["high", "medium", "low"] as const).find((p) => p === b.priority) ?? null, parent: typeof b.parent === "number" && b.parent > 0 ? b.parent : null },
              { via: pv(), ...(await asOpts()) },
            );
            if (!created.duplicate) ctx.waitUntil(registry.bumpBoard(env, m[1], created.task.seq).catch(() => {}));
            return json({ ok: true, task: created.task, duplicate: created.duplicate, ...(created.similar?.length ? { similar: created.similar } : {}) }, created.duplicate ? 200 : 201);
          } catch (e) {
            return json({ error: e instanceof Error ? e.message : String(e) }, 400);
          }
        }
        if (method === "POST" && m[2]) {
          const seq = parseInt(m[2], 10);
          const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
          const s = (k: string) => (typeof b[k] === "string" ? (b[k] as string).trim() : undefined);
          const opts = { via: pv(), ...(await asOpts()) };
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
                  status: s("status") as "todo" | "doing" | "blocked" | "done" | "frozen" | undefined,
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
      // Moderation (#3602, src/moderation.ts): mute a member on this board (your view and your notifications), and
      // report an entry to the board's owners. People only.
      m = path.match(/^\/api\/boards\/(b_[a-z0-9]+)\/mutes(?:\/([^/]+))?$/);
      if (m && (method === "GET" || method === "POST" || method === "DELETE")) {
        if (!viewer) return needLogin();
        if (viewer.via === "agent") return json({ error: "Muting is for people, not their agents." }, 403);
        if (!(await registry.isMember(env, m[1], viewer.name))) return json({ error: "board not found" }, 404);
        try {
          if (method === "GET" && !m[2]) return json({ muted: await moderation.mutedOn(env, viewer.name, m[1]) });
          if (method === "POST" && !m[2]) {
            const body = (await request.json().catch(() => ({}))) as { user?: unknown };
            const who = typeof body.user === "string" ? body.user.trim().toLowerCase().replace(/^@/, "") : "";
            if (!who) return json({ error: "Say whom to mute (user)." }, 400);
            return json({ ok: true, muted: await moderation.mute(env, viewer.name, m[1], who) });
          }
          if (method === "DELETE" && m[2]) return json({ ok: true, muted: await moderation.unmute(env, viewer.name, m[1], decodeURIComponent(m[2])) });
          return json({ error: "not found" }, 404);
        } catch (e) {
          if (e instanceof moderation.ModerationError) return json({ error: e.message }, e.status);
          throw e;
        }
      }
      m = path.match(/^\/api\/boards\/(b_[a-z0-9]+)\/entries\/(\d+)\/report$/);
      if (m && method === "POST") {
        if (!viewer) return needLogin();
        if (viewer.via === "agent") return json({ error: "Reporting is for people, not their agents." }, 403);
        if (!(await registry.isMember(env, m[1], viewer.name))) return json({ error: "board not found" }, 404);
        const body = (await request.json().catch(() => ({}))) as { reason?: unknown };
        const seq = parseInt(m[2], 10);
        try {
          const reason = moderation.reportReason(body.reason);
          const entry = await boardStub(env, m[1]).get(seq, { user: viewer.name, person: true }).then((g) => g.entry).catch(() => null);
          if (!entry) return json({ error: `Entry #${seq} does not exist on this board.` }, 404);
          if (!(await appSignin.hit(env, `reports:u:${viewer.name}`, moderation.REPORTS_PER_WINDOW))) return json({ error: "That's a lot of reports: try again in ten minutes." }, 429);
          const done = await moderation.report(env, m[1], seq, viewer.name, entry, reason);
          // A copy for us on the developers' board (the terms: we look within 24 hours), reason and link only.
          const bugsBoard = (env.BUGS_BOARD ?? "").trim();
          if (bugsBoard) {
            const text = bugs.messageReportText({ reason, reporter: viewer.name, board: m[1], seq, link: `${publicOrigin(env, url)}/b/${m[1]}#e${seq}` });
            ctx.waitUntil((async () => { const s = boardStub(env, bugsBoard); await ensureBugBoard(env, bugsBoard, s); await s.post(bugs.BUG_BOT, { type: "note", text, via: "person", client: "report" }); })().catch((e) => console.error("report copy", e)));
          }
          return json({ ok: true, ...done }, 201);
        } catch (e) {
          if (e instanceof moderation.ModerationError) return json({ error: e.message }, e.status);
          throw e;
        }
      }

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

      // ---- purge an entry: a leaked secret goes for good (its author, an agent only its agent's posts; any, for an owner) ----
      m = path.match(/^\/api\/boards\/([^/]+)\/entries\/(\d+)\/purge$/);
      if (m && method === "POST") {
        if (!viewer) return needLogin();
        const role = await registry.memberRole(env, m[1], viewer.name);
        if (!role) return json({ error: "board not found" }, 404);
        try {
          const seq = parseInt(m[2], 10);
          const r = await boardStub(env, m[1]).purge(viewer.name, seq, { via: pv(), owner: role === "owner" });
          const forwards = await scrubForwards(env, m[1], seq).catch(() => 0); // its words quoted into other boards go too (#3969)
          return json({ ok: true, ...r, forwards });
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }

      m = path.match(/^\/api\/boards\/([^/]+)\/(updates|entries|invites|seen|search|grep|handle|typing|answered|handoffs)(?:\/(\d+))?$/);
      if (m) {
        const [, id, what, seqStr] = m;
        if (!viewer && !hasOpsKey(c)) return needLogin();
        if (!(await canSee(c, id))) return json({ error: "board not found" }, 404);
        const stub = boardStub(env, id);
        // Long-polls (wait=seconds, up to 25): stretched up to 50s while shedding load; one open per agent session.
        const longPoll = async (after: number): Promise<Response | null> => {
          const waitSec = Math.min(25, Math.max(0, parseInt(url.searchParams.get("wait") ?? "0", 10) || 0));
          if (!waitSec) return null;
          const ms = limits.stretchWait(waitSec * 1000, 50_000, await limits.shedLevel(env));
          const sid = viewer?.via === "agent" ? await asid() : null;
          const w = limits.beginWait(sid && `s:${sid}`);
          if (w.refused) return waitRefused(w.refused);
          try {
            await waitForBoard(stub, { kind: "any", after }, ms, w.signal);
          } finally {
            w.done();
          }
          return null;
        };

        if (what === "updates" && method === "GET") {
          const after = Math.max(0, parseInt(url.searchParams.get("after") ?? "0", 10) || 0);
          // Long-poll (wait=seconds) so an open board tab costs one request per change or per ~25s, not one every few seconds.
          const refused = await longPoll(after);
          if (refused) return refused;
          // Only entries after `after` (up to 1000 per call; the client advances and asks again), roots resolved in the DO.
          const [snap, members0, live] = await Promise.all([stub.snapshot(after, {}, seer()), registry.boardMembers(env, id), registry.agentsOnBoard(env, id)]);
          const members = members0.map((x) => ({ ...x, agent_seen: live[x.user] ?? null }));
          const fresh = snap.entries;
          const roots = await stub.rootsFor(fresh.map((e) => e.seq));
          const canRetract = (e: Entry) => !!viewer && (e.author === viewer.name || snap.info.created_by === viewer.name);
          const names = Object.fromEntries(members0.filter((x) => x.agent_name).map((x) => [x.user, x.agent_name!]));
          const memberSet = new Set(members0.map((x) => x.user)), people = displayMap(members0);
          return json({
            entries: fresh.map((e) => ({
              seq: e.seq,
              author: e.author, // their "… is typing" ends when their message arrives
              ...(e.via === "agent" && names[e.author] ? { agent_name: names[e.author] } : {}), // "Jarvis · vedu's agent"
              root: roots[e.seq] ?? e.seq,
              retracts: e.retracts,
              html: entryHtml(withAgentNames(e, names), id, true, { canRetract: canRetract(e), canEdit: !!viewer && !snap.info.encrypted && e.author === viewer.name, lang: viewer?.lang, members: memberSet, people, person: !!viewer && viewer.via !== "agent" }),
              row: logRow(e, undefined, undefined, viewer?.lang),
              reactions: snap.reactions[e.seq] ?? [],
              ...(e.type === "change" ? { reviews: snap.reviews[e.seq] ?? [] } : {}),
              ...(snap.claims[e.seq] ? { claim: snap.claims[e.seq] } : {}),
              ...(e.human_decision ? { human_decision: e.human_decision } : {}),
            })),
            ...(after === 0 ? { reactions: snap.reactions } : {}),
            reviews: snap.reviews, // every card's current verdicts (small), so open tabs can update cards above the fold
            claims: snap.claims, // every claim's status and every stale entry, same idea
            decisions: snap.decisions, // every human decision's state, votes and who it's waiting on
            open_questions: snap.summary.openQuestions.map((e) => e.seq), // the quick-reply chips show only while their question is open
            handling: snap.handling, // which agent took which message ("vedu/scout")
            reads: snap.reads, // how far each member has seen, as a person and through their agent (read receipts)
            typing_agents: snap.typing_agents, // agents working on a person's message right now ("… is typing")
            summary: summaryHtml([], viewer?.name ?? "", members, snap.summary, { boardId: id, creator: snap.info.created_by }, viewer?.lang),
            pinned: snap.pinned, // the board's pinned doc {name, version, …} or null
            count: snap.info.entry_count,
            last: snap.last, // past any people-only entries this viewer doesn't get, so the tab doesn't ask again
            ...(limits.pollAfterMs() ? { poll_after_ms: limits.pollAfterMs() } : {}), // shedding load: the tab waits this long before asking again
          });
        }
        if (what === "entries" && !seqStr && method === "GET" && url.searchParams.has("after")) {
          // Plain JSON for SDKs and scripts: entries after N (oldest first), optionally waiting up to 25s for new ones.
          const after = Math.max(0, parseInt(url.searchParams.get("after") ?? "0", 10) || 0);
          const refused = await longPoll(after);
          if (refused) return refused;
          const [snap, names] = await Promise.all([stub.snapshot(after, {}, seer()), social.boardAgentNames(env, id)]);
          const list = withNames(snap.entries.slice(0, Math.min(500, parseInt(url.searchParams.get("limit") ?? "200", 10) || 200)), names);
          // Reactions on these entries (agents' 🤔 / ✅ read receipts among them), keyed by seq.
          const reactions = list.length ? await stub.reactionsFor(list.map((e) => e.seq), seer()) : {};
          // last: past any people-only entries this caller doesn't get (all of them, for an agent's token).
          const last = list.length < snap.entries.length ? list[list.length - 1].seq : snap.last;
          // ?ack=1: an agent that reads this way has read them: its read position moves to last, so its next post isn't
          // refused for what it already has (the stale-read rule, SPEC.md §9). Opt-in: a plain listing (export, cat log/N,
          // watch) moves no position (opus-d #3823). People's reading is the page's business.
          const ack = ["1", "true"].includes(url.searchParams.get("ack") ?? "");
          // The same reader post uses (asOpts), registered if new (#3881); a failure is the request's, not hidden.
          if (ack && viewer?.via === "agent" && last > after) await stub.ack(viewer.name, last, (await asOpts()).session, true);
          // One-tap reply chips (vedu #2490), people only (the app shows them; agents don't need them): seq → who and what.
          const qMembers = seer()?.person && list.some((e) => e.type === "question" && e.via === "agent") ? new Set((await registry.boardMembers(env, id)).map((m) => m.user)) : undefined;
          const quick = seer()?.person ? Object.fromEntries(list.flatMap((e) => { const q = quickReplies(e, { members: qMembers }); return q && q.for.includes(viewer!.name) ? [[e.seq, { options: q.options, own: q.own }]] : []; })) : undefined;
          return json({ entries: list, last, reactions, reads: snap.reads, decisions: snap.decisions, ...(quick && Object.keys(quick).length ? { quick } : {}) });
        }
        if (what === "entries" && !seqStr && method === "GET") {
          // Earlier entries for "Load earlier messages", rendered like live updates.
          const before = parseInt(url.searchParams.get("before") ?? "0", 10) || null;
          const page = await stub.page(before, parseInt(url.searchParams.get("limit") ?? "100", 10) || 100, seer());
          const seqs = page.map((e) => e.seq);
          const [isOwner, roots, reactions, names, pageInfo] = await Promise.all([
            viewer ? registry.memberRole(env, id, viewer.name).then((r) => r === "owner") : false,
            stub.rootsFor(seqs),
            stub.reactionsFor(seqs, seer()),
            registry.boardMembers(env, id), // "@Jarvis" chips, as on the page (jxn #1659); who's on it (quick replies)
            stub.info(),
          ]);
          const pageMembers = new Set(names.map((m) => m.user)), pageNames = agentNames(names), pagePeople = displayMap(names);
          return json({
            first: page.length ? page[0].seq : 0,
            entries: page.map((e) => ({
              seq: e.seq,
              root: roots[e.seq] ?? e.seq,
              html: entryHtml(withAgentNames(e, pageNames), id, true, { canRetract: !!viewer && (e.author === viewer.name || isOwner), canEdit: !!viewer && !pageInfo.encrypted && e.author === viewer.name, lang: viewer?.lang, members: pageMembers, people: pagePeople, person: !!viewer && viewer.via !== "agent" }),
              row: logRow(e, undefined, undefined, viewer?.lang),
              reactions: reactions[e.seq] ?? [],
              ...(e.human_decision ? { human_decision: e.human_decision } : {}),
            })),
          });
        }
        // The gate's queue (#2173 item 3): open handoffs, oldest first. Its text and fields are members' data.
        if (what === "handoffs" && !seqStr && method === "GET") {
          const [open, names] = await Promise.all([stub.handoffs(seer()), social.boardAgentNames(env, id)]);
          return json({ handoffs: withNames(open, names) });
        }
        if (what === "entries" && seqStr && method === "PATCH") {
          if (!viewer || viewer.via === "agent") return json({ error: "Only people can edit their messages." }, 403);
          try {
            const body = await request.json().catch(() => ({})) as { text?: unknown };
            const entry = await stub.edit(viewer.name, pv(), Number(seqStr), typeof body.text === "string" ? body.text : "");
            return json({ ok: true, entry, history: await stub.editHistory(entry.seq, seer()!) });
          } catch (e) { return json({ error: e instanceof Error ? e.message : String(e) }, 400); }
        }
        if (what === "entries" && seqStr && method === "GET" && url.searchParams.has("history")) {
          try { return json({ history: await stub.editHistory(Number(seqStr), seer()!) }); }
          catch (e) { return json({ error: e instanceof Error ? e.message : String(e) }, 404); }
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
          const body = (await request.json().catch(() => ({}))) as { text?: string; type?: string; title?: unknown; to?: string | string[]; reply_to?: string | number; to_session?: string; people_only?: unknown; own?: unknown; resolves?: unknown; supersedes?: unknown; depends_on?: unknown; strict?: unknown; artifact_name?: unknown; artifact_content?: unknown; card?: unknown; handoff?: unknown; data?: unknown };
          // The same entry as MCP's post (SPEC.md §17): an unknown type is refused, not turned into a note.
          const askedType = typeof body.type === "string" ? body.type.trim().toLowerCase() : "";
          if (body.type != null && !(ENTRY_TYPES as readonly string[]).includes(askedType)) return json({ error: `type must be one of: ${ENTRY_TYPES.join(", ")}` }, 400);
          const type = (askedType || "note") as NewEntry["type"];
          const idemError = badMessageId(request.headers.get("idempotency-key"));
          if (idemError) return json({ error: idemError }, 400);
          // People-only (vedu #1264): for the people named in `to` (a list, or one name) and/or @named in the text.
          // Never from an agent's token: agents can't create them (or read them).
          const yes = (v: unknown) => v === true || v === "true" || v === 1;
          const peopleOnly = yes(body.people_only);
          if (peopleOnly && viewer.via === "agent") return json({ error: "Only people can send people-only messages, signed in on the web or in the Atteo app. Agents can't create or read them." }, 403);
          // Just mine (#1748): only you and your own agents; from you or your agent's token. The board checks the rest.
          const own = yes(body.own);
          const notOwn = body.own === false || body.own === "false" || body.own === 0; // public on purpose: never kept in Just mine
          let to = !peopleOnly && typeof body.to === "string" && body.to ? normalizeUser(body.to) : null;
          if (own && (peopleOnly || (body.to != null && body.to !== "" && to !== viewer.name))) return json({ error: peopleOnly ? "Pick one: own (just you and your agents) or people-only (people you name, no agents)." : "A just-mine message is only for you and your own agents, so it can't go to anyone else. Drop to (or own)." }, 400);
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
          // What it answers or completes, as over MCP (REST used to drop it, so a REST "resolves" did nothing). The board
          // caps it (MAX_RESOLVES) for both.
          const ints = (v: unknown) => (Array.isArray(v) ? v : v == null ? [] : [v]).map(Number).filter((n) => Number.isInteger(n) && n > 0);
          const resolves = [...new Set(ints(body.resolves))];
          const supersedes = ints(body.supersedes)[0] ?? null;
          const dependsOn = ints(body.depends_on);
          const title = typeof body.title === "string" && body.title.trim() ? body.title : null;
          if (replyTo) {
            const parent = await stub.get(replyTo, seer()).catch(() => null);
            if (!parent) return json({ error: `Entry #${replyTo} does not exist on this board.` }, 400);
            const p = parent.entry;
            if (p.author !== viewer.name) {
              if (p.via === "person") {
                if (!mentions.some((m) => m.user === p.author)) mentions.push({ user: p.author, agent: false });
              } else if (!peopleOnly && !own) to ??= p.author;
            }
          }
          try {
            const idem = messageId(request.headers.get("idempotency-key"));
            const so = await asOpts();
            const input: NewEntry = {
              type, text, title, to, mentions, reply_to: replyTo, ...(resolves.length ? { resolves } : {}), ...(supersedes ? { supersedes } : {}), ...(dependsOn.length ? { depends_on: dependsOn } : {}),
              ...(typeof body.artifact_name === "string" ? { artifact_name: body.artifact_name } : {}), ...(typeof body.artifact_content === "string" ? { artifact_content: body.artifact_content } : {}), ...(body.card != null ? { card: body.card } : {}),
              via: pv(), ...so, idem, data: body.data, ...(peopleOnly ? { people_only: true, to_people: toPeople } : {}), ...(own ? { own: true } : notOwn ? { own: false } : {}), ...(body.handoff != null ? { handoff: body.handoff } : {}),
            };
            // An agent's post goes through the stale-read rule, as over MCP (SPEC.md §9): if something it hasn't read bears
            // on it, nothing is posted and it gets those entries (now marked read). People on the web post as before.
            let missed: number[] | undefined;
            let entry: Entry;
            if (viewer.via === "agent") {
              const res = await withRetry(async () => await stub.postFresh(viewer.name, input, so.session, yes(body.strict)));
              if ("refused" in res) {
                const n = res.relevant.length + res.others.length + res.remaining;
                return json({ error: `Not posted: ${n} new ${n === 1 ? "entry" : "entries"} arrived since you last read${res.relevant.length ? `, and ${res.relevant.length === 1 ? "this one bears" : `these ${res.relevant.length} bear`} on your post (in relevant)` : ""}. All now marked read${res.remaining ? ` (${res.remaining} more unread)` : ""}. Take ${n === 1 ? "it" : "them"} into account, then post again if your message still fits.`, refused: true, relevant: withNames(res.relevant, await social.boardAgentNames(env, id)), others: res.others, remaining: res.remaining }, 409);
              }
              entry = res.entry;
              missed = res.missed.map((e) => e.seq);
            } else entry = await withRetry(async () => await stub.post(viewer.name, input));
            ctx.waitUntil(Promise.all([registry.touch(env, viewer.name, id), registry.bumpBoard(env, id, entry.seq)]).catch(() => {}));
            // The rendered entry comes back with the post, so the page shows it without another round trip.
            const root = replyTo ? ((await stub.rootsFor([entry.seq]))[entry.seq] ?? entry.seq) : entry.seq;
            // The poster sees "@Jarvis" as that agent's chip straight away, as everyone else does (jxn #1659).
            // A people-only message (asked for, or a reply in one) says once, here, who can see it.
            // An agent's top-level post the board kept in Just mine (board.ts ownByDefault) says so instead.
            const said = entry.audience === "own" && entry.reply_to == null && !own && !notOwn && viewer.via === "agent" ? keptOwnNotice(viewer.name) : audienceNotice(entry, viewer.name);
            const notice = said ? { notice: said } : {};
            return json({ ok: true, entry, ...notice, ...(missed?.length ? { missed } : {}), update: { seq: entry.seq, root, retracts: entry.retracts, html: entryHtml(withAgentNames(entry, agentNames(boardMembers)), id, true, { canRetract: true, canEdit: true, lang: viewer?.lang, members: boardMembers.map((m) => m.user), person: !!viewer && viewer.via !== "agent", people: displayMap(boardMembers) }), row: logRow(entry, undefined, undefined, viewer?.lang), reactions: [] }, ...(ambiguous.length ? { ambiguous } : {}) }, 201);
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
          const r = q ? await stub.rankedSearch(q, { author: from ?? undefined, type, limit: 60, more: url.searchParams.get("more") ?? undefined }, seer()) : { entries: (await stub.search("", { author: from ?? undefined, type, limit: 60 }, seer())).map((entry) => ({ entry, snippet: "" })), files: [], more: null };
          const keep = (e: Entry) => agent == null || (agent === "1" ? e.via === "agent" : e.via !== "agent");
          return json({
            entries: r.entries
              .filter((x) => keep(x.entry))
              .map((x) => ({ seq: x.entry.seq, ts: x.entry.ts, author: x.entry.author, via: x.entry.via ?? null, type: x.entry.type, title: x.entry.title ?? null, snippet: x.snippet || x.entry.text.slice(0, 200) })),
            files: scope === "chat" || from || type ? [] : r.files,
            more: r.more,
          }, 200, { "cache-control": "no-store" });
        }
        // grep for agents: exact matching lines, one per hit (grep.ts). Members only (canSee above).
        if (what === "grep" && method === "GET") return grepResponse(env, viewer?.name ?? "", url, id, seer());
        // Read receipts: the board page reports the newest entry its person has had on screen.
        // "jxn is typing…": a person's composer says so every few seconds while they type; nothing is stored. ?root=N
        // says it's in thread N's reply box (vedu #4746: a thread's typing shows only in that thread); none means the chat.
        if (what === "typing" && method === "POST") {
          if (!viewer || viewer.via === "agent" || !(await registry.isMember(env, id, viewer.name))) return json({ error: "Only members can do that." }, 403);
          const r = Number(url.searchParams.get("root"));
          await stub.typing(viewer.name, Number.isSafeInteger(r) && r > 0 ? r : 0);
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
        if (what === "answered" && method === "POST" && seqStr) {
          // "Mark answered" on an open question in the side panel: people who can post, not agents (they reply instead).
          if (!viewer || viewer.via === "agent") return json({ error: "People mark questions answered, on the web or in the app. Agents answer in the thread." }, 403);
          const role = await registry.memberRole(env, id, viewer.name);
          if (!role) return json({ error: "Only members can do that." }, 403);
          if (role === "viewer") return json({ error: "You can view this board but not change it (your role is viewer)." }, 403);
          try {
            return json(await stub.markAnswered(viewer.name, parseInt(seqStr, 10)));
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
          // invite.ts names the board by id (agents read these words; a title is anyone's text, #1922). A person (the
          // web shows it with textContent, the app as plain text) gets the board's name back (opus-d #1953).
          const forPerson = async (m: string) => {
            if (viewer?.via === "agent") return m;
            const title = ((await registry.getBoard(env, id)) as { title?: string | null } | null)?.title;
            return title ? m.split(`board ${id}`).join(`"${title}"`) : m;
          };
          const role = access.inviteRole(body.role); // owners are promoted after they join
          const expiresDays = access.grantExpiresDays(body.expires_days);
          // A name instead of an email invites a friend; their email stays private (the reply names them, never the address).
          if (viewer && to && !to.includes("@")) {
            const name = normalizeUser(to.replace(/^@/, ""));
            const friend = name && (await social.friendsOf(env, viewer.name)).friends.find((f) => f.name === name);
            const u = friend ? await registry.userByName(env, friend.name) : null;
            if (!u?.email) return json({ error: `You can invite friends by name; for anyone else, use their email.` }, 400);
            const r = await sendInvite(env, origin, { boardId: id, email: u.email, invitedBy: viewer.name, role, expiresDays }, ctx);
            return json({ ok: r.ok, added: r.added, message: await forPerson(r.message.split(` (${u.email.toLowerCase()})`).join("").split(u.email.toLowerCase()).join(u.name)) });
          }
          if (!EMAIL_RE.test(to)) return json({ error: "Enter a valid email address." }, 400);
          const r = await sendInvite(env, origin, { boardId: id, email: to, invitedBy: viewer?.name ?? "ops", role, expiresDays }, ctx);
          return json({ ...r, message: await forPerson(r.message) });
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
          ok = m[2] === "accept" ? await registry.acceptInvitation(env, me, m[1], origin, ctx) : await registry.declineInvitation(env, me, m[1]);
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
        // Only this site's own pages mint a key (the browser says where a request came from; SameSite=Lax already keeps
        // other sites' POSTs from carrying the cookie). Muse's key (#2291, opus-d #2292) is made here, from /connect/muse.
        const site = request.headers.get("sec-fetch-site");
        if (site && site !== "same-origin" && site !== "none") return json({ error: "Make keys from Atteo's own pages." }, 403);
        const body = (await request.json().catch(() => ({}))) as { board?: string; label?: string; expires_in_days?: unknown };
        const board = body.board && (await canSee(c, body.board)) ? body.board : null;
        const days = Number(body.expires_in_days);
        const expiresAt = Number.isFinite(days) && days >= 1 ? Date.now() + Math.min(365, Math.floor(days)) * 86400e3 : null;
        const label = String(body.label ?? "").slice(0, 80) || "Agent";
        const t = await auth.createToken(env, viewer.name, label, { expiresAt });
        await accountlog.record(env, viewer.name, "token.created", request, { label, kind: "manual" });
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
        await accountlog.record(env, viewer.name, "tokens.revoked_all", request, { label: `${tokens} sign-in${tokens === 1 ? "" : "s"}` });
        return json({ ok: true, tokens, sessions: ended, message: `Disconnected: ${tokens} sign-in${tokens === 1 ? "" : "s"} revoked and ${ended} agent session${ended === 1 ? "" : "s"} ended. Run atteo login to connect again.` });
      }
      m = path.match(/^\/api\/tokens\/([^/]+)\/revoke$/);
      if (m && method === "POST") {
        if (!viewer) return needLogin();
        const gone = await auth.revokeToken(env, viewer.name, m[1]);
        if (!gone) return json({ error: "token not found" }, 404);
        await accountlog.record(env, viewer.name, "token.revoked", request, { label: gone.label, kind: gone.kind });
        return json({ ok: true, message: "Revoked" });
      }

      // ---- ops API: operator session or x-admin-key (automation and tests) ----
      if (path.startsWith("/api/ops/")) {
        if (!isOps(c)) return json({ error: "not found" }, 404);
        const body = method === "POST" ? ((await request.json().catch(() => ({}))) as Record<string, string>) : {};
        if (path === "/api/ops/overview" && method === "GET") return json(await opsData(env));
        // Leftover e2e/test accounts: GET lists; POST dry-runs unless confirm is exactly DELETE TEST ACCOUNTS.
        if (path === "/api/ops/test-accounts" && method === "GET") return json({ ...(await testAccounts.preview(env)), dry_run: true });
        if (path === "/api/ops/test-accounts" && method === "POST") {
          const b = body as testAccounts.ApplyOpts;
          const result = await testAccounts.apply(env, b);
          if (result.status === 200 && result.body && "dry_run" in result.body && result.body.dry_run === false) {
            for (const id of result.body.deleted_boards ?? []) ctx.waitUntil(boardStub(env, id).destroy().catch(() => {}));
          }
          return json(result.body, result.status);
        }
        // The cost guard (src/costGuard.ts): its state and its last check (vedu #4665); {clear: true} lifts the hard cap.
        if (path === "/api/ops/cost-guard") {
          if (method === "POST" && (body as Record<string, unknown>).clear === true) await costGuard.clearCap(env, viewer?.name ?? "admin-key");
          const st = await costGuard.status(env);
          return json({
            capped: await costGuard.capped(env),
            thresholds: costGuard.thresholds(env),
            watching: !!(env.CF_ACCOUNT_ID && costGuard.analyticsToken(env)),
            last_ok: st.last_ok ? { at: st.last_ok.at } : null,
            last_error: st.last_error,
            usage: st.last_ok?.totals ?? null,
          });
        }
        // Proves error reporting end to end (D1 errors + Sentry): throws on purpose.
        if (path === "/api/ops/test-error" && method === "POST") throw new Error("Test error from /api/ops/test-error");
        if (path === "/api/ops/metrics" && method === "GET") return json(await usage.metrics(env, Number(url.searchParams.get("days")) || 14));
        if (path === "/api/ops/usage-daily" && method === "GET") {
          const d = url.searchParams.get("day");
          const r = d
            ? await env.DB.prepare(`SELECT day, metric, key, count FROM usage_daily WHERE day = ?`).bind(d).all<{ day: string; metric: string; key: string; count: number }>()
            : await env.DB.prepare(`SELECT day, metric, key, count FROM usage_daily ORDER BY day DESC LIMIT 500`).all<{ day: string; metric: string; key: string; count: number }>();
          return json({ rows: r.results });
        }
        if (path === "/api/ops/usage-daily" && method === "POST") {
          const { day: d, metric, key, count } = body as { day?: string; metric?: string; key?: string; count?: number };
          if (!d || !metric || !key) return json({ error: "day, metric, key required" }, 400);
          await env.DB.prepare(`INSERT INTO usage_daily (day, metric, key, count) VALUES (?, ?, ?, ?) ON CONFLICT(day, metric, key) DO UPDATE SET count = excluded.count`)
            .bind(d, metric, key, Number(count) || 1)
            .run();
          return json({ ok: true });
        }
        if (path === "/api/ops/users" && method === "POST") {
          const name = normalizeUser(body.name);
          if (!name) return json({ error: "valid name required" }, 400);
          if ((await handleTaken(env, name))) return json({ error: "name taken" }, 409);
          await registry.createUser(env, {
            name,
            email: body.email ? body.email.toLowerCase() : null,
            email_verified: String(body.verified) === "true",
            workos_id: null,
            display_name: body.display_name ?? null,
          });
          // Tests can start a person in a given mode (Everyday is the default for people without a coding agent).
          if (body.display && typeof body.display === "object") await social.setAppPrefs(env, name, { display: body.display });
          return json({ ok: true, name }, 201);
        }
        if (path === "/api/ops/tokens" && method === "POST") {
          const u = normalizeUser(body.user);
          if (!u || !(await registry.userByName(env, u))) return json({ error: "user not found" }, 404);
          const ttl = Number(body.expires_in_s);
          // kind "app": a token as the Atteo app would get (tests and simulator runs only; people get theirs by signing in).
          const t = await auth.createToken(env, u, body.label || "ops-issued", { ...(Number.isFinite(ttl) ? { expiresAt: Date.now() + ttl * 1000 } : {}), ...(body.kind === "app" ? { kind: "app" as const } : {}) });
          await accountlog.record(env, u, "token.created", request, { label: body.label || "ops-issued", kind: body.kind === "app" ? "app" : "manual", client: "operator" });
          return json({ token: t.token, command: connectCommand(origin, body.board ?? null, t.token) }, 201);
        }
        if (path === "/api/ops/sessions" && method === "POST") {
          const u = normalizeUser(body.user);
          const row = u ? await registry.userByName(env, u) : null;
          if (!row) return json({ error: "user not found" }, 404);
          // Local tests only: a browser session that can open /_ops without ADMIN_EMAIL (csp-enforced.mjs). Needs
          // DEV_FAKE_ADMIN=1 in .dev.vars (never wrangler.jsonc) and localhost; production still requires ADMIN_EMAIL.
          const admin = ["true", "1"].includes(String(body.admin ?? "")); // JSON true stringifies to "true"
          if (admin && (env.DEV_FAKE_ADMIN !== "1" || !isLocalHost(url.hostname))) return json({ error: "admin test sessions require DEV_FAKE_ADMIN=1 on localhost" }, 400);
          const secret = await auth.createSession(env, {
            user: row.name,
            workos_id: admin ? auth.OPS_ADMIN_WORKOS_ID : (row.workos_id ?? "ops-issued"),
            email: row.email ?? "",
            email_verified: admin || String(body.verified) === "true",
            display_name: row.display_name,
          });
          await accountlog.record(env, row.name, "signin.web", request, { client: "operator" });
          return json({ cookie: `${auth.SESSION_COOKIE}=${secret}` }, 201);
        }
        if (path === "/api/ops/policies" && method === "GET") return json({ policies: (await env.DB.prepare(`SELECT * FROM org_policies ORDER BY domain`).all()).results });
        if (path === "/api/ops/policies" && method === "POST") {
          const domain = String(body.domain ?? "").trim().toLowerCase();
          if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return json({ error: "domain required (e.g. acme.com)" }, 400);
          // Free and public mail (gmail.com, outlook.com…) is not an organization: no policy, and so never a directory.
          if (!body.delete && isPublicMailDomain(domain)) return json({ error: `${domain} is a public mail provider, not an organization` }, 400);
          if (body.delete) {
            await env.DB.prepare(`DELETE FROM org_policies WHERE domain = ?`).bind(domain).run();
            return json({ ok: true });
          }
          const ret = body.max_retention_days == null || body.max_retention_days === "" ? null : Math.max(1, Math.floor(Number(body.max_retention_days)));
          await env.DB.prepare(
            `INSERT INTO org_policies (domain, require_sso, max_retention_days, allow_outside_members, directory, updated_at) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(domain) DO UPDATE SET require_sso = excluded.require_sso, max_retention_days = excluded.max_retention_days, allow_outside_members = excluded.allow_outside_members, directory = excluded.directory, updated_at = excluded.updated_at`,
          )
            .bind(domain, ["true", "1"].includes(String(body.require_sso)) ? 1 : 0, ret, String(body.allow_outside_members) === "false" ? 0 : 1, ["true", "1"].includes(String(body.directory)) ? 1 : 0, Date.now())
            .run();
          return json({ ok: true });
        }
        if (path === "/api/ops/prune" && method === "POST") {
          if (!body.board || !(await registry.getBoard(env, body.board))) return json({ error: "board required" }, 400);
          return json({ ok: true, pruned: await boardStub(env, body.board).prune(Number(body.before) || Date.now()) });
        }
        // Tests: move a board's lease clock forward (renewing claims, src/leases.ts). DEV_FAKE_CLOCK=1 on localhost only.
        if (path === "/api/ops/dev-clock" && method === "POST") {
          if (env.DEV_FAKE_CLOCK !== "1" || !isLocalHost(url.hostname)) return json({ error: "dev-clock requires DEV_FAKE_CLOCK=1 on localhost" }, 400);
          if (!body.board || !(await registry.getBoard(env, body.board))) return json({ error: "board required" }, 400);
          return json({ ok: true, offset_ms: await boardStub(env, body.board).devClock(Number(body.offset_ms) || 0) });
        }
        // Free-plan guardrails (src/limits.ts) in this isolate: GET shows them; POST overrides limits (tests lower one; a
        // single isolate under wrangler dev), {reset: true} clears overrides and counters, {shed: 0-2} sets today's level.
        if (path === "/api/ops/limits") {
          if (method === "POST") {
            const b = body as { reset?: unknown; nearQuota?: unknown; shed?: unknown };
            limits.setOverrides(body as Record<string, unknown>, b.reset === true);
            if (b.nearQuota === true) {
              if (!limits.setNearQuota(env, true)) return json({ error: "nearQuota requires DEV_FAKE_NEAR_QUOTA=1 on localhost" }, 400);
            } else if (b.nearQuota === false || b.reset === true) limits.setNearQuota(env, false);
            const lv = b.shed;
            if (lv != null) await limits.setShedLevel(env, Number(lv));
          }
          return json({ limits: limits.limits(env), shed: await limits.shedLevel(env), near_quota: limits.nearQuotaActive() });
        }
        // Tests: run the cron now (as the 5-minute schedule would), at `now` (ms) for scheduled triggers.
        if (path === "/api/ops/cron" && method === "POST") {
          const at = Number((body as { now?: unknown }).now);
          return json({ ok: true, ...(await runScheduled(env, ctx, Number.isFinite(at) && at > 0 ? at : Date.now())) });
        }
        // Backups outside Cloudflare (src/backup.ts): the last two weeks; run tonight's share now (tests: at `now`); and the
        // restore drill's board half (localhost, or BACKUP_RESTORE=1 for a real recovery): replaces that board's tables.
        if (path === "/api/ops/backups" && method === "GET") return json(await backup.backupStatus(env));
        if (path === "/api/ops/backup" && method === "POST") {
          const at = Number((body as { now?: unknown }).now);
          return json({ ok: true, ...(await backup.backupTick(env, Number.isFinite(at) && at > 0 ? at : Date.now(), (id, day) => boardStub(env, id).backup(day))) });
        }
        if (path === "/api/ops/restore-board" && method === "POST") {
          if (env.BACKUP_RESTORE !== "1" && !isLocalHost(url.hostname)) return json({ error: "restore-board runs on localhost, or with BACKUP_RESTORE=1" }, 400);
          const b = body as { board?: unknown; tables?: unknown; append?: unknown };
          if (typeof b.board !== "string" || !BOARD_RE.test(b.board) || !b.tables || typeof b.tables !== "object") return json({ error: "board and tables required" }, 400);
          return json({ ok: true, ...(await boardStub(env, b.board).restoreTables(b.tables as import("./backupcore").DumpTables, b.append === true)) });
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
            return json({ board: await createBoard(env, body.title.slice(0, 120), u, undefined, { encrypted: (body as { encrypted?: unknown }).encrypted === true }, ctx) }, 201);
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
    } finally {
      const wall = Date.now() - started;
      noteRequestWallMs(env, ctx, wall, { wait: isHeldRequest(url, path, wall) });
    }
    });
  },
} satisfies ExportedHandler<Env>;

// Errors also go to Sentry when SENTRY_DSN is set (prod); with no DSN the SDK stays off (dev/CI).
/** Everyday or Developer (#1272): Developer when the person chose it, or (auto) once they've connected a coding agent. */
const CODING_AGENT = /claude code|codex|cursor|windsurf|copilot|aider|cline|zed|opencode|gemini cli|amp\b/i;
async function developerFor(env: Env, user: string, mode: string | undefined): Promise<boolean> {
  if (mode === "developer") return true;
  if (mode === "everyday") return false;
  return (await sessions.list(env, user).catch(() => [])).some((s) => CODING_AGENT.test(s.client ?? ""));
}

export default Sentry.withSentry(
  (env: Env) => ({ dsn: env.SENTRY_DSN, release: env.CF_VERSION_METADATA?.id, tracesSampleRate: 0, beforeSend: scrubForSentry }),
  handler,
);


