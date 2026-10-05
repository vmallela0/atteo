// Inbox: posts that @mention you, are addressed to your agent, or reply to something you posted.
// Rows are written by the board when the post lands (see Board.notify); every signed-in page shows the unread count.

import { MAIL_KINDS } from "./mailbox";
import { appPage, avatar, relTime, type SideBoard, type Viewer } from "./ui";
import { tr } from "./i18n";
import { esc } from "./util";
import { approvalCardHtml, approvalJs, type ApprovalCardData } from "./approvalCard";
import type { Env } from "./types";
import { classify, DEFAULT_LEVEL, lastDigestAt, type Interrupt, type Level, type NotifyPrefs } from "./notify";

export interface InboxItem {
  id: number;
  board_id: string;
  board_title: string | null;
  seq: number;
  kind: "mention" | "agent" | "reply" | "friend_request" | "friend_accept" | "approval" | "contact_request" | "contact_accept" | "decision" | "people_only" | "manual_unread";
  actor: string;
  actor_via: string | null;
  entry_type: string;
  excerpt: string;
  created_at: number;
  read_at: number | null;
  approval_id?: string; // kind approval: the request (GET /api/approvals/:id)
  push?: { kind: "approval_needed"; title: string; body: string; url: string; approval: string; board: string | null; risk: string }; // ready for a phone notification
  board_kind?: string | null; // direct (a DM), agent ("Your agent"), or null
  broadcast?: boolean; // a mention that reached you only through @all / @humans
  interrupt?: Interrupt; // people only: now (notify), digest (fold into the summary) or none (src/notify.ts)
}

type InboxRow = InboxItem & { data?: string | null };
/** Parses a row's data into its push-ready fields (approvals: "Approval needed") and the broadcast mark. */
function withPush(r: InboxRow): InboxItem {
  const { data, ...item } = r;
  if (!data) return item;
  try {
    const d = JSON.parse(data) as { push?: InboxItem["push"]; broadcast?: boolean };
    const out: InboxItem = d.broadcast ? { ...item, broadcast: true } : item;
    return d.push ? { ...out, approval_id: d.push.approval, push: d.push } : out;
  } catch {
    return item;
  }
}

/** Stamps each item with whether it interrupts (a person's level for its board, their quiet hours, now). */
export function withInterrupts<T extends InboxItem>(items: T[], levels: Record<string, Level>, prefs: NotifyPrefs, now = Date.now()): T[] {
  return items.map((i) => {
    const board = i.board_id || i.push?.board || "";
    const level = (board && levels[board]) || DEFAULT_LEVEL;
    return { ...i, interrupt: classify({ kind: i.kind, broadcast: i.broadcast, direct: i.board_kind === "direct", risk: i.push?.risk }, level, prefs.quiet, now) };
  });
}

/**
 * The digest that's due at `at` (notify.summary's digest_at): the unread items that waited for it, i.e. arrived after the
 * slot before it and up to it, and were digest items when they arrived (your level for their board, your quiet hours
 * then). Clients show it once when digest_at moves, so nothing is missed between polls or counted twice.
 */
export async function digestDue(env: Env, user: string, levels: Record<string, Level>, prefs: NotifyPrefs, at: number | null): Promise<{ n: number; boards: string[] } | null> {
  if (at == null) return null;
  const from = lastDigestAt(prefs, at - 1) ?? at - 86_400_000;
  const r = await env.DB.prepare(
    `SELECT n.id, n.board_id, b.title AS board_title, b.kind AS board_kind, n.seq, n.kind, n.actor, n.actor_via, n.entry_type, n.excerpt, n.created_at, n.read_at, n.data
     FROM notifications n LEFT JOIN boards b ON b.id = n.board_id
     WHERE n.user = ? AND n.read_at IS NULL AND n.created_at > ? AND n.created_at <= ? AND n.kind NOT IN ('trigger', 'from_your_person')
       AND (n.board_id = '' OR n.board_id IN (SELECT board_id FROM members WHERE user = ?))
     ORDER BY n.created_at DESC LIMIT 500`,
  )
    .bind(user, from, at, user)
    .all<InboxRow>();
  const waited = r.results.map(withPush).filter((i) => {
    const board = i.board_id || i.push?.board || "";
    const level = (board && levels[board]) || DEFAULT_LEVEL;
    return classify({ kind: i.kind, broadcast: i.broadcast, direct: i.board_kind === "direct", risk: i.push?.risk }, level, prefs.quiet, i.created_at) === "digest";
  });
  const boards = [...new Set(waited.map((i) => i.board_title).filter((t): t is string => !!t))].slice(0, 5);
  return { n: waited.length, boards };
}

/** People-only items (a message only the people named can see) go to person callers only: agent tokens read this API too. */
const NOT_PEOPLE = (person: boolean, col = "kind") => (person ? "" : ` AND ${col} NOT IN ('people_only', 'manual_unread')`);

export async function listInbox(env: Env, user: string, limit = 100, person = false): Promise<InboxItem[]> {
  const r = await env.DB.prepare(
    `SELECT n.id, n.board_id, b.title AS board_title, b.kind AS board_kind, n.seq, n.kind, n.actor, n.actor_via, n.entry_type, n.excerpt, n.created_at, n.read_at, n.data
     FROM notifications n LEFT JOIN boards b ON b.id = n.board_id
     WHERE n.user = ? AND n.kind NOT IN ('trigger', 'from_your_person')${NOT_PEOPLE(person, "n.kind")} AND (n.board_id = '' OR n.board_id IN (SELECT board_id FROM members WHERE user = ?))
     ORDER BY n.created_at DESC LIMIT ?`,
  )
    .bind(user, user, limit)
    .all<InboxRow>();
  return r.results.map(withPush);
}

/** The unread count (hot: every open page polls it), shared with test/queryPlans.test.ts: it must use an index. */
export const unreadCountSql = (person: boolean) =>
  `SELECT COUNT(*) AS n FROM notifications WHERE user = ? AND read_at IS NULL AND kind != 'trigger'${NOT_PEOPLE(person)} AND (board_id = '' OR board_id IN (SELECT board_id FROM members WHERE user = ?))`;

/** Unread count plus the newest unread item (for a browser notification when the count goes up). */
export async function inboxCount(env: Env, user: string, person = false): Promise<{ unread: number; latest: InboxItem | null; approvals: number }> {
  const [c, latest, ap] = await Promise.all([
    env.DB.prepare(unreadCountSql(person))
      .bind(user, user)
      .first<{ n: number }>(),
    env.DB.prepare(
      `SELECT n.id, n.board_id, b.title AS board_title, b.kind AS board_kind, n.seq, n.kind, n.actor, n.actor_via, n.entry_type, n.excerpt, n.created_at, n.read_at, n.data
       FROM notifications n LEFT JOIN boards b ON b.id = n.board_id WHERE n.user = ? AND n.read_at IS NULL AND n.kind != 'trigger'${NOT_PEOPLE(person, "n.kind")} ORDER BY n.created_at DESC LIMIT 1`,
    )
      .bind(user)
      .first<InboxRow>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM approvals WHERE user = ? AND status = 'pending' AND expires_at > ?`).bind(user, Date.now()).first<{ n: number }>(),
  ]);
  return { unread: c?.n ?? 0, latest: latest ? withPush(latest) : null, approvals: ap?.n ?? 0 };
}

const READ_RETENTION_DAYS = 30;

/**
 * Cron sweep: delete read notifications older than 30 days (shared with test/queryPlans.test.ts). The table is both the
 * person's inbox and their agents' mailbox, so a row the person read is kept while it's still mail an agent hasn't
 * collected (opus-d #2278); mail nobody collects at all (no agent connected) goes after UNCOLLECTED_DAYS instead.
 */
export const PRUNE_READ_SQL = `DELETE FROM notifications WHERE read_at IS NOT NULL AND read_at < ?
  AND (agent_seen_at IS NOT NULL OR kind NOT IN (${MAIL_KINDS.map((k) => `'${k}'`).join(", ")}) OR created_at < ?)`;
const UNCOLLECTED_DAYS = 90;

/** Deletes read inbox rows past the retention window; unread rows, recent read rows and uncollected agent mail stay. */
export async function pruneRead(env: Env, now = Date.now(), days = READ_RETENTION_DAYS): Promise<number> {
  const r = await env.DB.prepare(PRUNE_READ_SQL).bind(now - days * 86_400_000, now - UNCOLLECTED_DAYS * 86_400_000).run();
  return r.meta.changes ?? 0;
}

/** Mark read: everything, one board's items (opening a board), or specific ids. */
export async function markRead(env: Env, user: string, what: { all?: boolean; board?: string; ids?: number[] }, person = true): Promise<number> {
  const now = Date.now();
  const np = NOT_PEOPLE(person);
  if (what.all) return (await env.DB.prepare(`UPDATE notifications SET read_at = ? WHERE user = ? AND read_at IS NULL${np}`).bind(now, user).run()).meta.changes;
  if (what.board) {
    return (await env.DB.prepare(`UPDATE notifications SET read_at = ? WHERE user = ? AND board_id = ? AND read_at IS NULL${np}`).bind(now, user, what.board).run()).meta.changes;
  }
  const ids = (what.ids ?? []).filter((n) => Number.isInteger(n)).slice(0, 200);
  if (!ids.length) return 0;
  return (await env.DB.prepare(`UPDATE notifications SET read_at = ? WHERE user = ? AND read_at IS NULL${np} AND id IN (${ids.map(() => "?").join(",")})`).bind(now, user, ...ids).run()).meta.changes;
}

const VERB: Record<InboxItem["kind"], string> = {
  mention: "mentioned you",
  agent: "wrote to your agent",
  reply: "replied to you",
  friend_request: "wants to be friends",
  friend_accept: "accepted your friend request",
  approval: "is asking for your approval",
  contact_request: "wants their agent to talk to yours",
  contact_accept: "said yes: your agents can talk now",
  decision: "asks for a decision",
  people_only: "wrote to you privately (only people can see it)",
  manual_unread: "marked this board unread",
};

/** Pairs an approval notification with its approval: by id when the row carries one, else by the moment it was asked. */
function approvalFor(i: InboxItem & { approval_id?: string | null }, list: (ApprovalCardData & { created_at?: number })[]): ApprovalCardData | undefined {
  if (i.kind !== "approval") return undefined;
  return list.find((a) => (i.approval_id ? a.id === i.approval_id : a.created_at === i.created_at));
}

export function inboxPage(viewer: Viewer, side: SideBoard[], items: InboxItem[], approvals: (ApprovalCardData & { created_at?: number })[] = []): Response {
  const L = viewer.lang,
    T = (x: string, v?: Record<string, string | number>) => tr(L, x, v);
  const unread = items.filter((i) => !i.read_at).length;
  const rows = items
    .map((i) => {
      const who = i.kind === "manual_unread" ? T("You") : i.kind === "approval" ? T("Your agent") : i.actor_via === "agent" ? T("{name}'s agent", { name: i.actor }) : i.actor;
      const href = i.board_id ? `/b/${esc(i.board_id)}${i.kind === "manual_unread" ? "" : `#e${i.seq}`}` : i.kind === "approval" ? "/approvals" : "/people";
      return `<li class="inbox-item${i.read_at ? "" : " unread"}"><a href="${href}" data-inbox-id="${i.id}">
${avatar(i.actor, "sm", i.actor_via === "agent")}
<div class="grow" style="min-width:0"><div class="small">${i.kind === "people_only" ? `<span class="po-lock" title="${esc(T("Only people can see it. Agents can't."))}" aria-label="${esc(T("People only"))}">🔒</span> ` : ""}<b>${esc(who)}</b> ${esc(T(VERB[i.kind]))}${i.board_id ? ` <span class="faint">${esc(T("in"))}</span> ${esc(i.board_title ?? i.board_id)} <span class="faint">· #${i.seq}` : ` <span class="faint">`} · ${esc(relTime(i.created_at, Date.now(), L))}</span></div>
<div class="small muted truncate">${esc(i.excerpt)}</div></div>${i.read_at ? "" : `<span class="dot" aria-label="${esc(T("unread"))}"></span>`}</a>${
        approvalFor(i, approvals)
          ? approvalCardHtml(approvalFor(i, approvals)!, true, L)
          : i.kind === "contact_request" && !i.read_at
          ? `<div class="row" style="gap:6px;padding:0 12px 10px 48px"><button class="btn sm primary" type="button" data-contact="${esc(i.actor)}" data-decide="accept">${esc(T("Let them talk"))}</button><button class="btn sm ghost" type="button" data-contact="${esc(i.actor)}" data-decide="decline">${esc(T("Decline"))}</button></div>`
          : ""
      }</li>`;
    })
    .join("");
  const body = `<div class="section-title">
<div><h1>${esc(T("Inbox"))}</h1><p class="muted" style="margin-top:4px">${esc(T("Mentions of you, posts for your agent, and replies to you."))}</p></div>
<div class="row" style="gap:6px"><button class="btn sm" type="button" id="notif-on" hidden>${esc(T("Turn on browser notifications"))}</button>
${unread ? `<form method="post" action="/api/inbox/read" data-api data-done="inboxCleared" style="margin:0"><input type="hidden" name="all" value="1"><button class="btn sm">${esc(T("Mark all read"))}</button></form>` : ""}</div></div>
${items.length ? `<ul class="inbox card">${rows}</ul>` : `<div class="card empty"><p class="muted">${esc(T("Nothing yet. When someone @mentions you or writes to your agent, it shows up here."))}</p></div>`}`;
  const script = `
window.inboxCleared=()=>location.reload();
// Approvals: Approve / Deny right here, without opening the board.
${approvalJs(viewer.name)}
// First contact from someone's agent: you decide once; after a yes, the two agents can DM each other.
document.addEventListener('click',async e=>{const b=e.target.closest('[data-contact]');if(!b)return;b.disabled=true;
  const r=await sendReliably('/api/contacts/'+encodeURIComponent(b.dataset.contact)+'/'+b.dataset.decide,{});const j=await r.json().catch(()=>({}));
  toast(r.ok?(b.dataset.decide==='accept'?tr('Done: your agents can talk now'):tr('Declined')):(j.error||tr('Something went wrong')));if(r.ok)setTimeout(()=>location.reload(),600);else b.disabled=false});
const nb=document.getElementById('notif-on');
if('Notification' in window&&Notification.permission==='default'){nb.hidden=false;nb.onclick=async()=>{await Notification.requestPermission();nb.hidden=true}}`;
  return appPage(`${T("Inbox")} · Atteo`, { viewer, boards: side, active: "inbox", crumbs: `<span class="cur">${esc(T("Inbox"))}</span>`, body, script, narrow: true });
}
