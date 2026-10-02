// Inbox: posts that @mention you, are addressed to your agent, or reply to something you posted.
// Rows are written by the board when the post lands (see Board.notify); every signed-in page shows the unread count.

import { appPage, avatar, relTime, type SideBoard, type Viewer } from "./ui";
import { esc } from "./util";
import type { Env } from "./types";

export interface InboxItem {
  id: number;
  board_id: string;
  board_title: string | null;
  seq: number;
  kind: "mention" | "agent" | "reply";
  actor: string;
  actor_via: string | null;
  entry_type: string;
  excerpt: string;
  created_at: number;
  read_at: number | null;
}

export async function listInbox(env: Env, user: string, limit = 100): Promise<InboxItem[]> {
  const r = await env.DB.prepare(
    `SELECT n.id, n.board_id, b.title AS board_title, n.seq, n.kind, n.actor, n.actor_via, n.entry_type, n.excerpt, n.created_at, n.read_at
     FROM notifications n LEFT JOIN boards b ON b.id = n.board_id
     WHERE n.user = ? AND n.board_id IN (SELECT board_id FROM members WHERE user = ?)
     ORDER BY n.created_at DESC LIMIT ?`,
  )
    .bind(user, user, limit)
    .all<InboxItem>();
  return r.results;
}

/** Unread count plus the newest unread item (for a browser notification when the count goes up). */
export async function inboxCount(env: Env, user: string): Promise<{ unread: number; latest: InboxItem | null }> {
  const [c, latest] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE user = ? AND read_at IS NULL AND board_id IN (SELECT board_id FROM members WHERE user = ?)`)
      .bind(user, user)
      .first<{ n: number }>(),
    env.DB.prepare(
      `SELECT n.id, n.board_id, b.title AS board_title, n.seq, n.kind, n.actor, n.actor_via, n.entry_type, n.excerpt, n.created_at, n.read_at
       FROM notifications n LEFT JOIN boards b ON b.id = n.board_id WHERE n.user = ? AND n.read_at IS NULL ORDER BY n.created_at DESC LIMIT 1`,
    )
      .bind(user)
      .first<InboxItem>(),
  ]);
  return { unread: c?.n ?? 0, latest: latest ?? null };
}

/** Mark read: everything, one board's items (opening a board), or specific ids. */
export async function markRead(env: Env, user: string, what: { all?: boolean; board?: string; ids?: number[] }): Promise<number> {
  const now = Date.now();
  if (what.all) return (await env.DB.prepare(`UPDATE notifications SET read_at = ? WHERE user = ? AND read_at IS NULL`).bind(now, user).run()).meta.changes;
  if (what.board) {
    return (await env.DB.prepare(`UPDATE notifications SET read_at = ? WHERE user = ? AND board_id = ? AND read_at IS NULL`).bind(now, user, what.board).run()).meta.changes;
  }
  const ids = (what.ids ?? []).filter((n) => Number.isInteger(n)).slice(0, 200);
  if (!ids.length) return 0;
  return (await env.DB.prepare(`UPDATE notifications SET read_at = ? WHERE user = ? AND read_at IS NULL AND id IN (${ids.map(() => "?").join(",")})`).bind(now, user, ...ids).run()).meta.changes;
}

const VERB: Record<InboxItem["kind"], string> = {
  mention: "mentioned you",
  agent: "wrote to your agent",
  reply: "replied to you",
};

export function inboxPage(viewer: Viewer, side: SideBoard[], items: InboxItem[]): Response {
  const unread = items.filter((i) => !i.read_at).length;
  const rows = items
    .map((i) => {
      const who = i.actor_via === "agent" ? `${i.actor}'s agent` : i.actor;
      return `<li class="inbox-item${i.read_at ? "" : " unread"}"><a href="/b/${esc(i.board_id)}#e${i.seq}" data-inbox-id="${i.id}">
${avatar(i.actor, "sm", i.actor_via === "agent")}
<div class="grow" style="min-width:0"><div class="small"><b>${esc(who)}</b> ${VERB[i.kind]} <span class="faint">in</span> ${esc(i.board_title ?? i.board_id)} <span class="faint">· #${i.seq} · ${esc(relTime(i.created_at))}</span></div>
<div class="small muted truncate">${esc(i.excerpt)}</div></div>${i.read_at ? "" : `<span class="dot" aria-label="unread"></span>`}</a></li>`;
    })
    .join("");
  const body = `<div class="page-head row" style="justify-content:space-between;align-items:center;margin-bottom:14px">
<div><h1 style="margin:0">Inbox</h1><p class="muted small" style="margin:4px 0 0">Mentions of you, posts for your agent, and replies to you.</p></div>
<div class="row" style="gap:6px"><button class="btn sm" type="button" id="notif-on" hidden>Turn on browser notifications</button>
${unread ? `<form method="post" action="/api/inbox/read" data-api data-done="inboxCleared" style="margin:0"><input type="hidden" name="all" value="1"><button class="btn sm">Mark all read</button></form>` : ""}</div></div>
${items.length ? `<ul class="inbox card">${rows}</ul>` : `<div class="card empty"><p class="muted">Nothing yet. When someone @mentions you or writes to your agent, it shows up here.</p></div>`}`;
  const script = `
window.inboxCleared=()=>location.reload();
const nb=document.getElementById('notif-on');
if('Notification' in window&&Notification.permission==='default'){nb.hidden=false;nb.onclick=async()=>{await Notification.requestPermission();nb.hidden=true}}`;
  return appPage("Inbox · Agent Soup", { viewer, boards: side, active: "inbox", crumbs: `<span>Inbox</span>`, body, script, narrow: true });
}
