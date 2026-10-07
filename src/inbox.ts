// Inbox: posts that @mention you, are addressed to your agent, or reply to something you posted.
// Rows are written by the board when the post lands (see Board.notify); every signed-in page shows the unread count.

import { REMIND_BROWSER_JS } from "./remindTime";
import { MAIL_KINDS } from "./mailbox";
import { appPage, avatar, relTime, type SideBoard, type Viewer } from "./ui";
import { tr } from "./i18n";
import { esc } from "./util";
import { personHtml, shownName } from "./names";
import { approvalCardHtml, approvalJs, type ApprovalCardData } from "./approvalCard";
import type { JoinRequest } from "./repoBoards";
import { PERSON_ONLY_KINDS, type Env } from "./types";
import { classify, DEFAULT_LEVEL, lastDigestAt, type Interrupt, type Level, type NotifyPrefs } from "./notify";

export interface InboxItem {
  id: number;
  board_id: string;
  board_title: string | null;
  seq: number;
  kind: "mention" | "agent" | "reply" | "friend_request" | "friend_accept" | "approval" | "contact_request" | "contact_accept" | "decision" | "people_only" | "manual_unread" | "reminder" | "report" | "slack_link" | "repo_join";
  actor: string;
  actor_via: string | null;
  entry_type: string;
  excerpt: string;
  created_at: number;
  read_at: number | null;
  reminded_at?: number | null;
  reminded?: boolean; // came back from Remind me later: it needs the person now (src/notify.ts)
  approval_id?: string; // kind approval: the request (GET /api/approvals/:id)
  join_id?: string; // kind repo_join: the owner's decision
  push?: { kind: "approval_needed"; title: string; body: string; url: string; approval: string; board: string | null; risk: string; by?: string }; // ready for a phone notification
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
    const d = JSON.parse(data) as { push?: InboxItem["push"]; broadcast?: boolean; reminded?: number; entry?: number; join?: string };
    // A report's row has a key of its own (src/moderation.ts); the entry it's about is data.entry, which links use as seq.
    const at = item.kind === "report" && Number.isSafeInteger(d.entry) ? { seq: d.entry! } : {};
    const out: InboxItem = { ...item, ...at, ...(d.broadcast ? { broadcast: true } : {}), ...(d.reminded ? { reminded: true } : {}), ...(item.kind === "repo_join" && d.join ? { join_id: d.join } : {}) };
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
    return { ...i, interrupt: classify({ kind: i.kind, broadcast: i.broadcast, direct: i.board_kind === "direct", risk: i.push?.risk, reminded: i.reminded }, level, prefs.quiet, now) };
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
       AND NOT EXISTS (SELECT 1 FROM inbox_reminders r WHERE r.notification_id = n.id AND r.user = n.user)
       AND (n.board_id = '' OR n.board_id IN (SELECT board_id FROM members WHERE user = ?))
     ORDER BY n.created_at DESC LIMIT 500`,
  )
    .bind(user, from, at, user)
    .all<InboxRow>();
  // Snoozed items (Remind me later) wait for their reminder, not the digest; one back from a reminder needs you.
  const waited = r.results.map(withPush).filter((i) => {
    const board = i.board_id || i.push?.board || "";
    const level = (board && levels[board]) || DEFAULT_LEVEL;
    return classify({ kind: i.kind, broadcast: i.broadcast, direct: i.board_kind === "direct", risk: i.push?.risk, reminded: i.reminded }, level, prefs.quiet, i.created_at) === "digest";
  });
  const boards = [...new Set(waited.map((i) => i.board_title).filter((t): t is string => !!t))].slice(0, 5);
  return { n: waited.length, boards };
}

/** People-only items (a message only the people named can see) go to person callers only: agent tokens read this API too. */
const NOT_PEOPLE = (person: boolean, col = "kind") => (person ? "" : ` AND ${col} NOT IN (${PERSON_ONLY_KINDS.map((k) => `'${k}'`).join(", ")})`);

/** The inbox list, newest first (shared with test/queryPlans.test.ts: it must walk notifications_user_created, not sort
 *  every notification the person has; in prod that read 2,700 rows a call, #4340). */
export const listInboxSql = (person: boolean) =>
  `SELECT n.id, n.board_id, b.title AS board_title, b.kind AS board_kind, n.seq, n.kind, n.actor, n.actor_via, n.entry_type, n.excerpt, n.created_at, n.read_at, n.data, r.due_at AS reminded_at
     FROM notifications n LEFT JOIN boards b ON b.id = n.board_id LEFT JOIN inbox_reminders r ON r.notification_id = n.id AND r.user = n.user
     WHERE n.user = ? AND n.kind NOT IN ('trigger', 'from_your_person')${NOT_PEOPLE(person, "n.kind")} AND r.notification_id IS NULL AND (n.board_id = '' OR n.board_id IN (SELECT board_id FROM members WHERE user = ?))
     ORDER BY n.created_at DESC LIMIT ?`;

export async function listInbox(env: Env, user: string, limit = 100, person = false): Promise<InboxItem[]> {
  const r = await env.DB.prepare(listInboxSql(person))
    .bind(user, user, limit)
    .all<InboxRow>();
  return r.results.map(withPush);
}

/** The unread count (hot: every open page polls it), shared with test/queryPlans.test.ts: it must use an index. */
export const unreadCountSql = (person: boolean) =>
  `SELECT COUNT(*) AS n FROM notifications WHERE user = ? AND read_at IS NULL AND kind != 'trigger' AND NOT EXISTS (SELECT 1 FROM inbox_reminders r WHERE r.notification_id = notifications.id AND r.user = notifications.user)${NOT_PEOPLE(person)} AND (board_id = '' OR board_id IN (SELECT board_id FROM members WHERE user = ?))`;

/** Unread count plus the newest unread item (for a browser notification when the count goes up). */
export async function inboxCount(env: Env, user: string, person = false): Promise<{ unread: number; latest: InboxItem | null; approvals: number; approval_boards: Record<string, number> }> {
  const [c, latest, ap] = await Promise.all([
    env.DB.prepare(unreadCountSql(person))
      .bind(user, user)
      .first<{ n: number }>(),
    env.DB.prepare(
      `SELECT n.id, n.board_id, b.title AS board_title, b.kind AS board_kind, n.seq, n.kind, n.actor, n.actor_via, n.entry_type, n.excerpt, n.created_at, n.read_at, n.data, r.due_at AS reminded_at
       FROM notifications n LEFT JOIN boards b ON b.id = n.board_id LEFT JOIN inbox_reminders r ON r.notification_id = n.id AND r.user = n.user WHERE n.user = ? AND n.read_at IS NULL AND n.kind != 'trigger' AND r.notification_id IS NULL${NOT_PEOPLE(person, "n.kind")} ORDER BY n.created_at DESC LIMIT 1`,
    )
      .bind(user)
      .first<InboxRow>(),
    // Per board in the same one read: the web's tabs turn amber where one waits (jxn #4860).
    env.DB.prepare(`SELECT board_id, COUNT(*) AS n FROM approvals WHERE user = ? AND status = 'pending' AND expires_at > ? GROUP BY board_id`).bind(user, Date.now()).all<{ board_id: string | null; n: number }>(),
  ]);
  const rows = ap?.results ?? [];
  const approval_boards = Object.fromEntries(rows.filter((r) => r.board_id).map((r) => [r.board_id!, r.n]));
  return { unread: c?.n ?? 0, latest: latest ? withPush(latest) : null, approvals: rows.reduce((t, r) => t + r.n, 0), approval_boards };
}

const READ_RETENTION_DAYS = 30;

/**
 * Cron sweep: delete read notifications older than 30 days (shared with test/queryPlans.test.ts). The table is both the
 * person's inbox and their agents' mailbox, so a row the person read is kept while it's still mail an agent hasn't
 * collected (opus-d #2278); mail nobody collects at all (no agent connected) goes after UNCOLLECTED_DAYS instead.
 */
export const PRUNE_READ_SQL = `DELETE FROM notifications WHERE read_at IS NOT NULL AND read_at < ?
  AND NOT EXISTS (SELECT 1 FROM inbox_reminders r WHERE r.notification_id = notifications.id)
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
  repo_join: "wants to join your repo board",
  contact_request: "wants their agent to talk to yours",
  contact_accept: "said yes: your agents can talk now",
  decision: "asks for a decision",
  people_only: "wrote to you privately (only people can see it)",
  manual_unread: "marked this board unread",
  reminder: "is ready for you",
  report: "reported a post to you, as an owner",
  slack_link: "linked a Slack account to Atteo",
};

/** Pairs an approval notification with its approval: by id when the row carries one, else by the moment it was asked. */
function approvalFor(i: InboxItem & { approval_id?: string | null }, list: (ApprovalCardData & { created_at?: number })[]): ApprovalCardData | undefined {
  if (i.kind !== "approval") return undefined;
  return list.find((a) => (i.approval_id ? a.id === i.approval_id : a.created_at === i.created_at));
}

export function inboxPage(viewer: Viewer, side: SideBoard[], items: InboxItem[], approvals: (ApprovalCardData & { created_at?: number })[] = [], people: Record<string, string> = {}, joins: JoinRequest[] = []): Response {
  const L = viewer.lang,
    T = (x: string, v?: Record<string, string | number>) => tr(L, x, v);
  const unread = items.filter((i) => !i.read_at).length;
  const known = [viewer.name, ...items.map((i) => i.actor)]; // a name that is one of these handles shows its own @handle
  // A direct chat's title is "a ↔ b" (handles): it reads with the names they chose (jxn #4369).
  const dmTitle = (t: string) => (t.includes(" ↔ ") ? t.split(" ↔ ").map((h) => (h === viewer.name ? shownName(h, viewer.display_name) : shownName(h, people[h]))).join(" ↔ ") : t);
  const rows = items
    .map((i) => {
      const who = i.kind === "manual_unread" || i.kind === "slack_link" ? T("You") : i.kind === "approval" ? (i.push?.by ? T("{name}'s agent", { name: i.push.by }) : T("Your agent")) : i.actor_via === "agent" ? T("{name}'s agent", { name: i.actor }) : i.actor;
      // A person by the name they chose (jxn #4369), their @handle on hover.
      const whoHtml = i.kind !== "manual_unread" && i.kind !== "slack_link" && i.kind !== "approval" && i.actor_via !== "agent" ? personHtml(i.actor, people[i.actor], known) : esc(who);
      const href = i.board_id ? `/b/${esc(i.board_id)}${i.kind === "manual_unread" ? "" : `#e${i.seq}`}` : i.kind === "approval" ? "/approvals" : i.kind === "repo_join" ? "/for-you" : i.kind === "slack_link" ? "/slack/accounts" : "/people";
      return `<li class="inbox-item${i.read_at ? "" : " unread"}"><a href="${href}" data-inbox-id="${i.id}">
${avatar(i.actor, "sm", i.actor_via === "agent")}
<div class="grow" style="min-width:0"><div class="small">${i.kind === "people_only" ? `<span class="po-lock" title="${esc(T("Only people can see it. Agents can't."))}" aria-label="${esc(T("People only"))}">🔒</span> ` : ""}<b>${whoHtml}</b> ${esc(T(VERB[i.kind]))}${i.board_id ? ` <span class="faint">${esc(T("in"))}</span> ${esc(dmTitle(i.board_title ?? i.board_id))} <span class="faint">· #${i.seq}` : ` <span class="faint">`} · ${esc(relTime(i.created_at, Date.now(), L))}</span></div>
<div class="small muted truncate">${esc(i.excerpt)}</div></div>${i.read_at ? "" : `<span class="dot" aria-label="${esc(T("unread"))}"></span>`}</a><details class="remind-menu"><summary>${esc(T("Remind me"))}</summary><div><button type="button" data-remind="hour" data-id="${i.id}">${esc(T("In 1 hour"))}</button><button type="button" data-remind="tonight" data-id="${i.id}">${esc(T("Tonight (20:00)"))}</button><button type="button" data-remind="tomorrow" data-id="${i.id}">${esc(T("Tomorrow (09:00)"))}</button></div></details>${
        approvalFor(i, approvals)
          ? approvalCardHtml(approvalFor(i, approvals)!, true, L)
          : i.kind === "repo_join" && joins.some((j) => j.id === i.join_id)
          ? `<div class="row" style="gap:6px;padding:0 12px 10px 48px" data-repo-join="${esc(i.join_id!)}"><span class="small muted">linked to ${esc(joins.find((j) => j.id === i.join_id)!.repo)} by ${esc(joins.find((j) => j.id === i.join_id)!.linked_by)}, not verified with GitHub</span><button class="btn sm primary" type="button" data-join-decision="let-in">${esc(T("Let in"))}</button><button class="btn sm ghost" type="button" data-join-decision="decline">${esc(T("Decline"))}</button><button class="btn sm ghost" type="button" data-join-decision="block">${esc(T("Block forever"))}</button></div>`
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
${REMIND_BROWSER_JS}
document.addEventListener('click',async e=>{const b=e.target.closest('[data-remind]');if(b&&await remindItem(b.dataset.id,b.dataset.remind))b.closest('.inbox-item')?.remove()});
window.inboxCleared=()=>location.reload();
// Approvals: Approve / Deny right here, without opening the board.
${approvalJs(viewer.name)}
// First contact from someone's agent: you decide once; after a yes, the two agents can DM each other.
document.addEventListener('click',async e=>{const b=e.target.closest('[data-contact]');if(!b)return;b.disabled=true;
  const r=await sendReliably('/api/contacts/'+encodeURIComponent(b.dataset.contact)+'/'+b.dataset.decide,{});const j=await r.json().catch(()=>({}));
  toast(r.ok?(b.dataset.decide==='accept'?tr('Done: your agents can talk now'):tr('Declined')):(j.error||tr('Something went wrong')));if(r.ok)setTimeout(()=>location.reload(),600);else b.disabled=false});
document.addEventListener('click',async e=>{const b=e.target.closest('[data-join-decision]');if(!b)return;const row=b.closest('[data-repo-join]');if(b.dataset.joinDecision==='block'&&!confirm('Block this person from asking to join this board forever?'))return;b.disabled=true;
  const r=await sendReliably('/api/repo-joins/'+encodeURIComponent(row.dataset.repoJoin)+'/'+b.dataset.joinDecision,{});const j=await r.json().catch(()=>({}));
  toast(r.ok?(b.dataset.joinDecision==='let-in'?tr('Let in'):b.dataset.joinDecision==='block'?tr('Blocked'):tr('Declined')):(j.error||tr('Something went wrong')));if(r.ok)row.remove();else b.disabled=false});
const nb=document.getElementById('notif-on');
if('Notification' in window&&Notification.permission==='default'){nb.hidden=false;nb.onclick=async()=>{await Notification.requestPermission();nb.hidden=true}}`;
  return appPage(`${T("Inbox")} · Atteo`, { viewer, boards: side, active: "inbox", crumbs: `<span class="cur">${esc(T("Inbox"))}</span>`, body, script, narrow: true });
}

/** A reminder belongs to one person; the notification stays intact for everyone else and for agent mail. */
export async function remind(env: Env, user: string, id: number, at: number): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT id FROM notifications WHERE id = ? AND user = ? AND kind NOT IN ('trigger', 'from_your_person')`).bind(id, user).first();
  if (!row) return false;
  await env.DB.prepare(`INSERT INTO inbox_reminders (user, notification_id, due_at) VALUES (?, ?, ?) ON CONFLICT(user, notification_id) DO UPDATE SET due_at = excluded.due_at`).bind(user, id, at).run();
  return true;
}

export async function cancelReminder(env: Env, user: string, id: number): Promise<boolean> {
  const result = await env.DB.prepare(`DELETE FROM inbox_reminders WHERE user = ? AND notification_id = ?`).bind(user, id).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function fireReminders(env: Env, now = Date.now()): Promise<number> {
  const due = (await env.DB.prepare(`SELECT user, notification_id FROM inbox_reminders WHERE due_at <= ? LIMIT 200`).bind(now).all<{ user: string; notification_id: number }>()).results;
  for (const r of due) {
    await env.DB.batch([
      env.DB.prepare(`UPDATE notifications SET read_at = NULL, data = CASE WHEN json_valid(data) THEN json_set(data, '$.reminded', ?) ELSE json_object('reminded', ?) END WHERE id = ? AND user = ?`).bind(now, now, r.notification_id, r.user),
      env.DB.prepare(`DELETE FROM inbox_reminders WHERE user = ? AND notification_id = ?`).bind(r.user, r.notification_id),
    ]);
  }
  return due.length;
}
