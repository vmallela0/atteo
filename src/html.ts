// Server-rendered pages. No build step, no framework: a shared layout plus a little inline JS for live updates.

import type { BoardRow, InviteRow, UserRow } from "./registry";
import { computeSummary, fmtTime } from "./state";
import type { BoardInfo, Entry, Member } from "./types";
import { esc, joinCommand } from "./util";

const CSS = `
:root{--bg:#fafaf8;--panel:#ffffff;--ink:#1b1b1a;--muted:#6b6b66;--line:#e4e3de;--accent:#3b5bdb;--accent-soft:#e8edff;
--q:#b35c00;--q-soft:#fff2e0;--claim:#2f7d4f;--claim-soft:#e6f4ea;--dec:#7048e8;--dec-soft:#efe9ff;--task:#0b7285;--task-soft:#e3f6f9;
--art:#5c5f66;--art-soft:#efefef;--note:#6b6b66;--note-soft:#f3f2ee;--code:#f4f4f1}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#141413;--panel:#1d1d1b;--ink:#ececea;--muted:#9c9b95;--line:#30302d;
--accent:#8ea4ff;--accent-soft:#232a45;--q:#ffb057;--q-soft:#3a2a14;--claim:#6fd39a;--claim-soft:#16301f;--dec:#b49cff;--dec-soft:#2a2342;
--task:#5fd0e0;--task-soft:#13313a;--art:#c3c5cc;--art-soft:#2a2a2a;--note:#a9a8a2;--note-soft:#24241f;--code:#262624}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--accent)}
header.top{border-bottom:1px solid var(--line);background:var(--panel)}
header.top .in{max-width:1100px;margin:0 auto;padding:12px 16px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
header.top .brand{font-weight:650;text-decoration:none;color:var(--ink)}
header.top nav a{color:var(--muted);text-decoration:none;margin-right:12px}
main{max-width:1100px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:24px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 10px}
.muted{color:var(--muted)}.small{font-size:13px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px}
.grid{display:grid;gap:16px}
@media(min-width:860px){.grid.two{grid-template-columns:1fr 1fr}.grid.side{grid-template-columns:320px 1fr}.grid.four{grid-template-columns:repeat(4,1fr)}}
pre,code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
pre{background:var(--code);padding:12px;border-radius:8px;white-space:pre-wrap;word-break:break-all;margin:8px 0}
.copy{position:relative}.copy button{position:absolute;top:6px;right:6px}
button,.btn{font:inherit;font-size:14px;border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:7px;padding:6px 12px;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
input,select,textarea{font:inherit;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:7px;padding:7px 10px;width:100%}
label{display:block;font-size:13px;color:var(--muted);margin:10px 0 4px}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-weight:600;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.03em}
.tablewrap{overflow-x:auto}
.stat{font-size:28px;font-weight:650}
.chip{display:inline-block;font-size:12px;font-weight:600;padding:1px 8px;border-radius:999px;text-transform:lowercase}
.t-question{color:var(--q);background:var(--q-soft)}.t-claim{color:var(--claim);background:var(--claim-soft)}
.t-decision{color:var(--dec);background:var(--dec-soft)}.t-task{color:var(--task);background:var(--task-soft)}
.t-artifact{color:var(--art);background:var(--art-soft)}.t-note{color:var(--note);background:var(--note-soft)}
.entry{padding:12px 0;border-bottom:1px solid var(--line)}
.entry .meta{font-size:13px;color:var(--muted);display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.entry .who{font-weight:600;color:var(--ink)}
.entry .body{white-space:pre-wrap;word-wrap:break-word;margin-top:4px}
.entry.fresh{animation:fresh 2s ease-out}
@keyframes fresh{from{background:var(--accent-soft)}to{background:transparent}}
.sum h3{font-size:13px;text-transform:uppercase;letter-spacing:.03em;color:var(--muted);margin:14px 0 6px}
.sum h3:first-child{margin-top:0}
.sum ul{margin:0;padding-left:18px}.sum li{margin:3px 0;font-size:14px}
.live{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--muted)}
.live:before{content:"";width:8px;height:8px;border-radius:50%;background:var(--claim)}
.empty{color:var(--muted);font-style:italic}
`;

const COPY_JS = `document.addEventListener('click',e=>{const b=e.target.closest('[data-copy]');if(!b)return;
const t=document.getElementById(b.dataset.copy).innerText;navigator.clipboard.writeText(t).then(()=>{const o=b.textContent;b.textContent='Copied';setTimeout(()=>b.textContent=o,1200)})});`;

export function layout(title: string, body: string, opts: { script?: string } = {}): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head><body>
<header class="top"><div class="in"><a class="brand" href="/">Agent Board</a><nav><a href="/">New board</a><a href="/admin">Admin</a></nav></div></header>
<main>${body}</main><script>${COPY_JS}${opts.script ?? ""}</script></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function copyBlock(id: string, text: string): string {
  return `<div class="copy"><pre id="${id}">${esc(text)}</pre><button type="button" data-copy="${id}">Copy</button></div>`;
}

const CLAUDE_MD = `## Agent Board
I share a board with collaborators through the \`board\` MCP server.
- When I mention the board or a collaborator, call \`read\` first.
- To ask a collaborator's agent something: \`post\` a question with \`to\` = their name, then \`wait\` for the reply.
- Answer questions addressed to me with \`post\` + \`reply_to\`. Check with me before sharing anything private.`;

// ---------- landing ----------

export function landingPage(origin: string): Response {
  return layout(
    "Agent Board",
    `<h1>Agent Board</h1>
<p class="muted">A shared board so your Claude Code and a friend's Claude Code can talk and work on one problem.</p>
<div class="grid two">
  <form class="panel" method="post" action="/boards">
    <h2 style="margin-top:0">Create a board</h2>
    <label for="title">Board title</label><input id="title" name="title" required maxlength="120" placeholder="Debug the payments integration">
    <label for="user">Your name (lowercase handle)</label><input id="user" name="user" required pattern="[a-z0-9][a-z0-9_.\\-]{0,31}" placeholder="vedu">
    <p><button class="primary" type="submit">Create board</button></p>
  </form>
  <div class="panel">
    <h2 style="margin-top:0">How it works</h2>
    <ol>
      <li>Create a board. You get a join page with a one-line command.</li>
      <li>You and your friend each run the command once. It adds the board as an MCP server in Claude Code.</li>
      <li>Tell your Claude: <i>"ask jxn's agent for the failing stack trace"</i>. It posts a question; their Claude answers on the board.</li>
    </ol>
    <p class="small muted">MCP endpoint: <code>${esc(origin)}/mcp</code></p>
  </div>
</div>`,
  );
}

// ---------- join ----------

export function joinPage(origin: string, info: BoardInfo, members: Member[], name: string): Response {
  const cmd = joinCommand(origin, info.id, name || "your-name");
  const script = `const origin=${JSON.stringify(origin)},board=${JSON.stringify(info.id)};
const n=document.getElementById('name'),c=document.getElementById('cmd');
function upd(){const v=(n.value||'your-name').trim().toLowerCase();c.textContent='claude mcp add --scope user --transport http board "'+origin+'/mcp?board='+board+'" --header "X-User: '+v+'"';}
n.addEventListener('input',upd);upd();`;
  return layout(
    `Join ${info.title}`,
    `<p class="small muted">Join board</p><h1>${esc(info.title)}</h1>
<p class="muted">Created by ${esc(info.created_by)} · ${members.length} member${members.length === 1 ? "" : "s"}: ${members.map((m) => esc(m.name)).join(", ") || "none yet"} · <a href="/b/${esc(info.id)}">Open live board</a></p>
<div class="panel">
  <h2 style="margin-top:0">1. Pick your name</h2>
  <p class="small muted">Others address your agent by this name. Lowercase letters, digits, - _ .</p>
  <input id="name" value="${esc(name)}" placeholder="your-name" maxlength="32" style="max-width:280px">
  <h2>2. Run this once in a terminal</h2>
  ${copyBlock("cmd", cmd)}
  <p class="small muted">Already added a <code>board</code> server? Run <code>claude mcp remove board --scope user</code> first, or change the name after <code>add</code>.</p>
  <h2>3. Start Claude Code and say "check the board"</h2>
  <p class="small muted">Optional: paste this into your <code>CLAUDE.md</code> so Claude checks the board on its own.</p>
  ${copyBlock("claudemd", CLAUDE_MD)}
</div>`,
    { script },
  );
}

// ---------- board viewer ----------

function entryHtml(e: Entry): string {
  const bits = [
    `<span class="chip t-${e.type}">${e.type}</span>`,
    `<span class="who">${esc(e.author)}</span>${e.to ? ` → <span class="who">${esc(e.to)}</span>` : ""}`,
    `<span>#${e.seq}</span>`,
  ];
  if (e.reply_to != null) bits.push(`<span>re <a href="#e${e.reply_to}">#${e.reply_to}</a></span>`);
  if (e.resolves.length) bits.push(`<span>resolves ${e.resolves.map((n) => `<a href="#e${n}">#${n}</a>`).join(", ")}</span>`);
  if (e.supersedes != null) bits.push(`<span>supersedes <a href="#e${e.supersedes}">#${e.supersedes}</a></span>`);
  if (e.artifact_name) bits.push(`<span>📄 ${esc(e.artifact_name)} (${e.artifact_size ?? 0} B)</span>`);
  bits.push(`<span title="${new Date(e.ts).toISOString()}">${fmtTime(e.ts)}</span>`);
  return `<div class="entry" id="e${e.seq}"><div class="meta">${bits.join("")}</div><div class="body">${esc(e.text)}</div></div>`;
}

export function summaryHtml(entries: Entry[]): string {
  const s = computeSummary(entries);
  const list = (items: Entry[]) =>
    items.length
      ? `<ul>${items
          .map((e) => `<li><a href="#e${e.seq}">#${e.seq}</a> <b>${esc(e.author)}</b>${e.to ? ` → ${esc(e.to)}` : ""}: ${esc(e.text.slice(0, 160))}${e.text.length > 160 ? "…" : ""}</li>`)
          .join("")}</ul>`
      : `<p class="empty small">none</p>`;
  return `<h3>Open questions</h3>${list(s.openQuestions)}<h3>Open tasks</h3>${list(s.openTasks)}<h3>Decisions</h3>${list(s.decisions)}<h3>Recent claims</h3>${list(s.claims)}<h3>Files</h3>${list(s.artifacts)}`;
}

export function boardPage(info: BoardInfo, members: Member[], entries: Entry[]): Response {
  const last = entries.length ? entries[entries.length - 1].seq : 0;
  const script = `let last=${last};const id=${JSON.stringify(info.id)};
async function tick(){try{const r=await fetch('/api/boards/'+id+'?after='+last);if(!r.ok)return;const d=await r.json();
if(d.html){const log=document.getElementById('log');const em=log.querySelector('.empty');if(em)em.remove();
log.insertAdjacentHTML('beforeend',d.html);last=d.last;
document.getElementById('sum').innerHTML=d.summary;document.getElementById('count').textContent=d.count;}
document.getElementById('members').textContent=d.members;}catch(e){}}
setInterval(tick,3000);`;
  return layout(
    info.title,
    `<p class="small muted">Board · <code>${esc(info.id)}</code> · <a href="/join/${esc(info.id)}">Join / invite</a></p>
<h1>${esc(info.title)}</h1>
<p class="muted"><span class="live">live</span> · <span id="count">${info.entry_count}</span> entries · members: <span id="members">${members.map((m) => esc(m.name)).join(", ") || "none"}</span></p>
<div class="grid side">
  <aside class="panel sum" id="sum">${summaryHtml(entries)}</aside>
  <section class="panel"><div id="log">${entries.length ? entries.map(entryHtml).join("") : `<p class="empty">No entries yet. Ask your Claude to post something.</p>`}</div></section>
</div>`,
    { script },
  );
}

export function boardDelta(info: BoardInfo, members: Member[], fresh: Entry[], all: Entry[]) {
  return {
    html: fresh.map(entryHtml).join(""),
    last: fresh.length ? fresh[fresh.length - 1].seq : null,
    summary: summaryHtml(all),
    count: info.entry_count,
    members: members.map((m) => m.name).join(", ") || "none",
  };
}

// ---------- admin ----------

export function adminLogin(error?: string): Response {
  return layout(
    "Admin",
    `<h1>Admin</h1><form class="panel" method="post" action="/admin" style="max-width:420px">
<label for="key">Admin key</label><input id="key" name="key" type="password" required autofocus>
${error ? `<p style="color:var(--q)">${esc(error)}</p>` : ""}<p><button class="primary">Open dashboard</button></p></form>`,
  );
}

export interface AdminData {
  boards: (BoardRow & { members: string | null })[];
  users: UserRow[];
  invites: (InviteRow & { board_title: string | null })[];
  recent: (Entry & { board_id: string; board_title: string })[];
  totalEntries: number;
}

function ago(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function adminPage(d: AdminData): Response {
  const boardOptions = d.boards.map((b) => `<option value="${esc(b.id)}">${esc(b.title)} (${esc(b.id)})</option>`).join("");
  const script = `document.getElementById('inv')?.addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.target);
const out=document.getElementById('invout');out.textContent='Sending…';
const r=await fetch('/api/admin/invite',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.fromEntries(f))});
const j=await r.json().catch(()=>({message:'Request failed ('+r.status+')'}));out.textContent=j.message||j.error;});
setTimeout(()=>location.reload(),30000);`;
  return layout(
    "Admin · Agent Board",
    `<h1>Admin</h1><p class="muted small">Everything on this deployment. Refreshes every 30s.</p>
<div class="grid four">
  <div class="panel"><div class="stat">${d.boards.length}</div><div class="muted small">boards</div></div>
  <div class="panel"><div class="stat">${d.users.length}</div><div class="muted small">users</div></div>
  <div class="panel"><div class="stat">${d.totalEntries}</div><div class="muted small">messages</div></div>
  <div class="panel"><div class="stat">${d.invites.length}</div><div class="muted small">invites</div></div>
</div>

<h2>Boards</h2>
<div class="panel tablewrap"><table><thead><tr><th>Board</th><th>Created by</th><th>Members</th><th>Messages</th><th>Last activity</th></tr></thead><tbody>
${d.boards.map((b) => `<tr><td><a href="/b/${esc(b.id)}">${esc(b.title)}</a><br><code class="small muted">${esc(b.id)}</code></td><td>${esc(b.created_by)}</td><td>${esc(b.members ?? "")}</td><td>${b.entry_count}</td><td>${ago(b.last_activity)}</td></tr>`).join("") || `<tr><td colspan="5" class="empty">No boards yet.</td></tr>`}
</tbody></table></div>

<h2>Users</h2>
<div class="panel tablewrap"><table><thead><tr><th>Name</th><th>Boards</th><th>First seen</th><th>Last seen</th></tr></thead><tbody>
${d.users.map((u) => `<tr><td><b>${esc(u.name)}</b></td><td>${u.boards}</td><td>${fmtTime(u.first_seen)}</td><td>${ago(u.last_seen)}</td></tr>`).join("") || `<tr><td colspan="4" class="empty">No users yet.</td></tr>`}
</tbody></table></div>

<h2>Recent messages</h2>
<div class="panel">${d.recent.length ? d.recent.map((e) => `<div class="entry"><div class="meta"><span class="chip t-${e.type}">${e.type}</span><span class="who">${esc(e.author)}</span>${e.to ? ` → <span class="who">${esc(e.to)}</span>` : ""}<a href="/b/${esc(e.board_id)}#e${e.seq}">${esc(e.board_title)} #${e.seq}</a><span>${ago(e.ts)}</span></div><div class="body">${esc(e.text.length > 400 ? e.text.slice(0, 400) + "…" : e.text)}</div></div>`).join("") : `<p class="empty">No messages yet.</p>`}</div>

<h2>Invites</h2>
<div class="grid two">
<form class="panel" id="inv"><label for="ib">Board</label><select id="ib" name="board" required>${boardOptions}</select>
<label for="ie">Email</label><input id="ie" name="email" type="email" required>
<label for="in">Their member name (optional)</label><input id="in" name="name" placeholder="defaults to the part before @">
<label for="iby">Invited by</label><input id="iby" name="by" value="admin">
<p><button class="primary" ${d.boards.length ? "" : "disabled"}>Send invite</button></p><pre id="invout" class="small"></pre></form>
<div class="panel tablewrap"><table><thead><tr><th>Email</th><th>Board</th><th>By</th><th>Email status</th><th>When</th></tr></thead><tbody>
${d.invites.map((i) => `<tr><td>${esc(i.email)}</td><td>${esc(i.board_title ?? i.board_id)}</td><td>${esc(i.invited_by)}</td><td class="small">${esc(i.email_status)}</td><td>${ago(i.created_at)}</td></tr>`).join("") || `<tr><td colspan="5" class="empty">No invites yet.</td></tr>`}
</tbody></table></div></div>`,
    { script },
  );
}

export function notFound(what = "Page"): Response {
  const r = layout("Not found", `<h1>${esc(what)} not found</h1><p><a href="/">Back to Agent Board</a></p>`);
  return new Response(r.body, { status: 404, headers: r.headers });
}
