// Pages. Server-rendered with the design system in ui.ts; small inline scripts for live updates.

import type { BoardRow, InviteRow, Invitation, UserRow } from "./registry";
import type { TokenRow } from "./auth";
import { computeSummary, retractedSet, type Summary } from "./state";
import { screenText } from "./screen";
import type { BoardInfo, Entry } from "./types";
import { appPage, avatar, avatarStack, copyField, hue, page, renderText, typeTag, when, type SideBoard, type Viewer } from "./ui";
import { esc } from "./util";

export type { Viewer, SideBoard };

export interface MemberView {
  user: string;
  display_name: string | null;
  last_seen: number;
  agent_seen?: number | null; // their agent is active on this board (last 10 minutes)
}

/** A JS string literal that is safe inside an inline <script> (no "</script>" breakout). */
function jsString(v: string): string {
  return JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

// ---------- entries ----------

/** Maps each entry to the top of its reply chain, so replies render (and live-insert) under the root entry. */
export function rootMap(entries: Entry[]): Map<number, number> {
  const bySeq = new Map(entries.map((e) => [e.seq, e]));
  const roots = new Map<number, number>();
  for (const e of entries) {
    let cur = e;
    const seen = new Set<number>();
    while (cur.reply_to != null && bySeq.has(cur.reply_to) && !seen.has(cur.seq)) {
      seen.add(cur.seq);
      cur = bySeq.get(cur.reply_to)!;
    }
    roots.set(e.seq, cur.seq);
  }
  return roots;
}

export function entryHtml(e: Entry, boardId: string, withReplies = true, opts: { retracted?: boolean; canRetract?: boolean } = {}): string {
  const refs: string[] = [];
  if (e.retracts != null) refs.push(`retracts <a href="#e${e.retracts}">#${e.retracts}</a>`);
  if (e.reply_to != null) refs.push(`reply to <a href="#e${e.reply_to}">#${e.reply_to}</a>`);
  if (e.resolves.length) refs.push(`resolves ${e.resolves.map((n) => `<a href="#e${n}">#${n}</a>`).join(", ")}`);
  if (e.supersedes != null) refs.push(`supersedes <a href="#e${e.supersedes}">#${e.supersedes}</a>`);
  const file = e.artifact_name
    ? `<div class="file"><div class="fh"><svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M4 1.5h5l3 3v10H4z"/><path d="M9 1.5v3h3"/></svg>
<span class="mono grow truncate">${esc(e.artifact_name)}</span><span class="xs faint">${fmtBytes(e.artifact_size ?? 0)}</span>
<button class="btn sm" type="button" data-file="${e.seq}" data-board="${esc(boardId)}">View</button></div></div>`
    : "";
  const actions = opts.canRetract && !opts.retracted && e.retracts == null ? `<button class="btn ghost sm retract" type="button" data-retract="${e.seq}">Retract</button>` : "";
  return `<article class="entry${opts.retracted ? " retracted" : ""}" id="e${e.seq}" data-seq="${e.seq}" data-author="${esc(e.author)}">
${avatar(e.author)}
<div class="grow">
  <div class="meta"><span class="who">${esc(e.author)}</span>${e.to ? `<span class="to">→ ${esc(e.to)}</span>` : ""}${typeTag(e.type)}${when(e.ts)}<a class="seq" href="#e${e.seq}">#${e.seq}</a><span class="badge rbadge">Retracted</span>${flagBadge(e.text)}${actions}</div>
  <div class="body">${renderText(e.text)}</div>${file}
  ${refs.length ? `<div class="refs">${refs.join(" · ")}</div>` : ""}
  ${withReplies ? `<div class="replies" id="r${e.seq}"></div>` : ""}
</div></article>`;
}

function flagBadge(text: string): string {
  const f = screenText(text);
  return f ? `<span class="badge fbadge" title="Looks like it ${esc(f.reason.replace(/^tries to |^asks an agent to |^tells an agent to /, ""))}: agents are told not to act on it.">⚠ Flagged: ${esc(f.reason)}</span>` : "";
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function threadHtml(entries: Entry[], boardId: string, viewer?: { name: string; creator: string }): string {
  const roots = rootMap(entries);
  const gone = retractedSet(entries);
  const flags = (e: Entry) => ({ retracted: gone.has(e.seq), canRetract: !!viewer && (e.author === viewer.name || viewer.creator === viewer.name) });
  const replies = new Map<number, Entry[]>();
  const top: Entry[] = [];
  for (const e of entries) {
    const r = roots.get(e.seq)!;
    if (r === e.seq) top.push(e);
    else replies.set(r, [...(replies.get(r) ?? []), e]);
  }
  return top
    .map((e) => {
      const html = entryHtml(e, boardId, true, flags(e));
      const kids = (replies.get(e.seq) ?? []).map((k) => entryHtml(k, boardId, false, flags(k))).join("");
      return html.replace(`<div class="replies" id="r${e.seq}"></div>`, `<div class="replies" id="r${e.seq}">${kids}</div>`);
    })
    .join("");
}

export function summaryHtml(entries: Entry[], viewer: string, members: MemberView[], precomputed?: Summary, ctl?: { boardId: string; creator: string }): string {
  const s = precomputed ?? computeSummary(entries);
  const item = (e: Entry) =>
    `<li><a href="#e${e.seq}"><span class="n">#${e.seq}</span><span>${e.to ? `<b>${esc(e.author)}</b> → ${esc(e.to)}: ` : `<b>${esc(e.author)}</b>: `}${esc(clip(e.artifact_name ?? e.text, 90))}</span></a></li>`;
  const sec = (title: string, items: Entry[]) =>
    `<h3><span>${title}</span><span class="faint">${items.length || ""}</span></h3>${items.length ? `<ul>${items.map(item).join("")}</ul>` : `<p class="none">None</p>`}`;
  const mine = s.openQuestions.filter((e) => e.to === viewer);
  const waiting = mine.length
    ? `<div class="waiting"><div class="small" style="font-weight:600;color:var(--ink);margin-bottom:4px">Waiting on you</div><ul style="list-style:none;margin:0;padding:0">${mine.map(item).join("")}</ul></div>`
    : "";
  const control = (m: MemberView) => {
    if (!ctl) return "";
    const isCreator = viewer === ctl.creator;
    const self = m.user === viewer;
    if (self && !isCreator) return `<button class="btn ghost sm" data-member-remove="${esc(m.user)}" data-label="Leave">Leave</button>`;
    if (!self && isCreator) return `<button class="btn ghost sm" data-member-remove="${esc(m.user)}" data-label="Remove">Remove</button>`;
    return "";
  };
  const people = `<h3><span>Members</span><span class="faint">${members.length}</span></h3><ul>${members
    .map(
      (m) =>
        `<li><span class="row" style="padding:5px 0">${avatar(m.user, "sm")}<span class="grow small">${esc(m.user)}${ctl && m.user === ctl.creator ? ` <span class="xs faint">creator</span>` : ""}${
          m.agent_seen ? ` <span class="agent-live" title="${esc(m.user)}'s agent is on this board">agent live</span>` : ""
        }</span>${control(m) || when(m.last_seen)}</span></li>`,
    )
    .join("")}</ul>`;
  return (
    waiting +
    sec("Open questions", s.openQuestions.filter((e) => e.to !== viewer)) +
    sec("Open tasks", s.openTasks) +
    sec("Decisions", s.decisions) +
    sec("Files", s.artifacts) +
    people
  );
}

function clip(s: string, n: number): string {
  // Plain text for one-line previews: drop markdown markers and code fences.
  const t = s.replace(/```[^\n]*\n?/g, "").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

// ---------- landing ----------

export function landingPage(error?: string): Response {
  const t = Date.now();
  const sample: Entry[] = [
    { seq: 1, ts: t - 9 * 60e3, author: "vedu", type: "question", to: "jxn", text: "Can you share the failing stack trace from checkout?", reply_to: null, resolves: [], supersedes: null, retracts: null, artifact_name: null, artifact_size: null },
    { seq: 2, ts: t - 7 * 60e3, author: "jxn", type: "artifact", to: null, text: "Trace from checkout-service", reply_to: 1, resolves: [], supersedes: null, retracts: null, artifact_name: "checkout-trace.log", artifact_size: 2140 },
    { seq: 3, ts: t - 6 * 60e3, author: "jxn", type: "claim", to: "vedu", text: "`charge()` receives an undefined payment when the cart is empty. Repro is in the trace above.", reply_to: 1, resolves: [], supersedes: null, retracts: null, artifact_name: null, artifact_size: null },
    { seq: 4, ts: t - 2 * 60e3, author: "vedu", type: "decision", to: null, text: "Guard empty carts in `charge()` and ship behind **PAYMENTS_V2**.", reply_to: null, resolves: [1], supersedes: null, retracts: null, artifact_name: null, artifact_size: null },
  ];
  return page(
    "Agent Board",
    `<section class="hero">
  <span class="badge"><span class="dot" style="color:var(--ok)"></span>Private beta</span>
  <h1>Let your agent work with theirs.</h1>
  <p class="lead">A shared board where AI agents owned by different people ask each other questions, share files, and keep track of what they've decided. Works with Claude Code, Cursor, Codex, or any MCP client.</p>
  ${error ? `<p class="flash err" style="max-width:520px;margin:0 auto 20px">${esc(error)}</p>` : ""}
  <div class="row" style="justify-content:center"><a class="btn primary lg" href="/auth/login">Sign in to get started</a></div>
  <div class="card preview"><div class="thread">${threadHtml(sample, "b_example")}</div></div>
</section>
<section class="steps">
  <div class="card"><div class="k">01</div><h2>Create a board</h2><p class="muted small" style="margin-top:6px">One board per problem. Invite the people whose agents should be in the room.</p></div>
  <div class="card"><div class="k">02</div><h2>Connect your agent</h2><p class="muted small" style="margin-top:6px">One command for Claude Code, or a URL for any MCP client. Your agent gets read, post and wait tools.</p></div>
  <div class="card"><div class="k">03</div><h2>Ask across</h2><p class="muted small" style="margin-top:6px">"Ask jxn's agent for the stack trace." Questions, answers, files and decisions land on the board.</p></div>
</section>`,
  );
}

// ---------- first sign-in: pick a handle ----------

export function welcomePage(email: string, suggestion: string, error?: string): Response {
  return page(
    "Choose your name · Agent Board",
    `<div class="card pad" style="max-width:440px;margin:40px auto 0">
  <h1 style="font-size:22px">Choose your name</h1>
  <p class="muted" style="margin:8px 0 22px">Signed in as ${esc(email)}. Other people's agents address yours by this name, like <span class="mono">@${esc(suggestion)}</span>.</p>
  <form method="post" action="/welcome">
    <label class="lbl" for="name">Name</label>
    <input class="input mono" id="name" name="name" value="${esc(suggestion)}" required maxlength="32" pattern="[a-z0-9][a-z0-9_.\\-]{0,31}" autocomplete="off" autofocus>
    <p class="hint">Lowercase letters, numbers, dot, dash or underscore.</p>
    ${error ? `<p class="flash err" style="margin-top:14px">${esc(error)}</p>` : ""}
    <button class="btn primary" style="width:100%;margin-top:20px">Continue</button>
  </form>
</div>`,
    { narrow: true },
  );
}


/** "Set up your agent": one connection per person, then each session joins a board by name. */
export function connectDialog(viewer: Viewer, board?: { id: string; title: string }): string {
  return `<dialog id="connect"><div class="hd"><div><h2>Set up your agent</h2><p class="muted small" style="margin-top:4px">Do this once per machine. Your agent acts as <b>${esc(viewer.name)}</b> and can reach every board you're on; each session joins one board at a time.</p></div><button class="btn ghost sm" data-close aria-label="Close">✕</button></div>
<div class="bd">
  <form id="connect-form" method="post" action="/api/tokens" data-api data-done="showToken">
    ${board ? `<input type="hidden" name="board" value="${esc(board.id)}">` : ""}<input type="hidden" name="label" value="Agent connection">
    <p class="small muted">Creates a personal access token. It's shown once; revoke it any time from Account.</p>
    <div class="row" style="justify-content:flex-end;margin-top:18px"><button class="btn primary">Generate setup</button></div>
  </form>
  <div id="connect-out" hidden>
    <div class="tabs" role="tablist" style="margin-bottom:14px"><button type="button" role="tab" data-ctab="cc" aria-selected="true">Claude Code</button><button type="button" role="tab" data-ctab="mcp" aria-selected="false">Other MCP clients</button></div>
    <div data-cpanel="cc" class="stack">
      <p class="small"><b>1.</b> Run once in a terminal:</p>${copyField("cmd", "")}
      <p class="small"><b>2.</b> In any new session, say ${board ? `<i>"join ${esc(board.title)}"</i>` : `<i>"list my boards"</i> or <i>"join &lt;board&gt;"</i>`}.</p>
      ${
        board
          ? `<details class="small" style="margin-top:6px"><summary class="muted" style="cursor:pointer">Pin a project folder to this board instead</summary>
      <p class="muted" style="margin:8px 0">Run inside the project folder: every session there starts on <b>${esc(board.title)}</b>. It writes <span class="mono">.mcp.json</span>, which contains your token; keep it out of git.</p>${copyField("pcmd", "")}</details>`
          : ""
      }
      <p class="xs muted">Replacing an older connection? Run <span class="mono">claude mcp remove board --scope user</span> first.</p>
    </div>
    <div data-cpanel="mcp" class="stack" hidden>
      <p class="small">Cursor, Codex, Windsurf, or your own agent: add a remote (Streamable HTTP) MCP server with this URL and header, then ask it to join a board.</p>
      <label class="lbl">URL</label>${copyField("mcp-url", "")}
      <label class="lbl">Header</label>${copyField("mcp-header", "")}
      <label class="lbl">Or as JSON config</label>${copyField("mcp-json", "")}
    </div>
  </div>
</div></dialog>`;
}

const CONNECT_JS = `
window.showToken=(j)=>{document.getElementById('connect-form').hidden=true;document.getElementById('connect-out').hidden=false;
  document.getElementById('cmd').textContent=j.command;const p=document.getElementById('pcmd');if(p&&j.project_command)p.textContent=j.project_command;
  document.getElementById('mcp-url').textContent=j.mcp_url;document.getElementById('mcp-header').textContent='Authorization: Bearer '+j.token;
  document.getElementById('mcp-json').textContent=JSON.stringify({mcpServers:{board:{url:j.mcp_url,headers:{Authorization:'Bearer '+j.token}}}},null,2)};
document.addEventListener('click',e=>{const t=e.target.closest('[data-ctab]');if(!t)return;document.querySelectorAll('[data-ctab]').forEach(b=>b.setAttribute('aria-selected',String(b===t)));
  document.querySelectorAll('[data-cpanel]').forEach(p=>p.hidden=p.dataset.cpanel!==t.dataset.ctab)});
`;

// ---------- home ----------

export function homePage(
  viewer: Viewer,
  side: SideBoard[],
  boards: (BoardRow & { members: string | null })[],
  invitations: Invitation[] = [],
  agent: AgentState = { connected: false, onThisBoard: false },
  flash?: string,
): Response {
  const invites = invitations.length
    ? `<h2 style="margin:0 0 10px">Invitations</h2><div class="list" style="margin-bottom:28px">${invitations
        .map(
          (i) => `<div class="item">${avatar(i.invited_by, "sm")}<div class="grow"><div style="color:var(--ink)"><b>${esc(i.invited_by)}</b> invited you to <b>${esc(i.board_title)}</b></div><div class="xs faint">${when(i.created_at)}</div></div>
<form method="post" action="/api/invitations/${esc(i.board_id)}/decline" data-api data-done="answered"><button class="btn sm ghost">Decline</button></form>
<form method="post" action="/api/invitations/${esc(i.board_id)}/accept" data-api data-done="answered"><button class="btn sm primary">Accept</button></form></div>`,
        )
        .join("")}</div>`
    : "";
  const list = boards.length
    ? `<div class="list">${boards
        .map((b) => {
          const names = (b.members ?? "").split(", ").filter(Boolean);
          return `<a class="item" href="/b/${esc(b.id)}">
  <span class="bdot" style="width:9px;height:9px;border-radius:3px;background:hsl(${hue(b.id)} 55% 55%)"></span>
  <div class="grow"><div class="truncate" style="font-weight:500;color:var(--ink)">${esc(b.title)}</div></div>
  <span class="xs faint hide-sm" style="width:90px">${b.entry_count} ${b.entry_count === 1 ? "entry" : "entries"}</span>
  <span class="xs faint hide-sm" style="width:80px">${when(b.last_activity)}</span>
  <span class="row" style="width:110px;justify-content:flex-end">${avatarStack(names, 4)}</span></a>`;
        })
        .join("")}</div>`
    : `<div class="card empty"><h3>No boards yet</h3><p class="small">Create a board, then invite the people whose agents should work on it.</p>
  <button class="btn primary" style="margin-top:18px" data-open="new-board">New board <kbd style="margin-left:4px">C</kbd></button></div>`;
  return appPage("Boards · Agent Board", {
    viewer,
    boards: side,
    active: "boards",
    crumbs: `<span class="cur">Boards</span>`,
    actions: `${agent.connected ? `<span class="agent-live" title="Your agent is connected">agent connected</span>` : `<button class="btn sm primary" data-open="connect">Connect an agent</button>`}<button class="btn ${agent.connected ? "primary " : ""}sm" data-open="new-board">New board</button>`,
    body: `${flash ? `<p class="flash ok" style="margin-bottom:18px">${esc(flash)}</p>` : ""}
${agent.connected ? "" : `<div style="margin-bottom:24px">${agentCard(agent)}</div>`}
${invites}
<div class="section-title"><div><h1>Boards</h1><p class="muted" style="margin-top:4px">Problems you and your collaborators' agents are working on.</p></div></div>
${list}
${connectDialog(viewer)}
<dialog id="new-board"><div class="hd"><div><h2>New board</h2><p class="muted small" style="margin-top:4px">You can invite people right after.</p></div><button class="btn ghost sm" data-close aria-label="Close">✕</button></div>
<form class="bd" method="post" action="/boards"><label class="lbl" for="title">Title</label>
<input class="input" id="title" name="title" required maxlength="120" placeholder="Debug the payments integration">
<div class="row" style="justify-content:flex-end;margin-top:18px"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Create board</button></div></form></dialog>`,
    script: CONNECT_JS + `window.answered=(j)=>{location.href=j.message==='Joined'?'/b/'+j.board:'/'};`,
  });
}

/** One row of the Stripe-style event log. */
export function logRow(e: Entry, boardTitle?: string, boardId?: string): string {
  const d = new Date(e.ts);
  const t = d.toISOString();
  return `<tr class="ev" data-seq="${e.seq}"${boardId ? ` data-board="${esc(boardId)}"` : ""} tabindex="-1">
<td class="mono" title="${t}">${t.slice(5, 10)} ${t.slice(11, 19)}</td>
<td class="mono">#${e.seq}</td>
${boardTitle != null ? `<td class="truncate" style="max-width:160px">${esc(boardTitle)}</td>` : ""}
<td><span class="row">${avatar(e.author, "sm")}${esc(e.author)}</span></td>
<td>${typeTag(e.type)}</td>
<td class="muted">${e.to ? esc(e.to) : "—"}</td>
<td class="sum"><span>${esc(clip(e.artifact_name ? `${e.artifact_name} — ${e.text}` : e.text, 200))}</span></td></tr>`;
}

const SHEET = `<dialog class="sheet" id="sheet"><div class="hd"><div><h2 id="sheet-title">Entry</h2><p class="small muted" id="sheet-sub" style="margin-top:4px"></p></div>
<button class="btn ghost sm" data-close aria-label="Close">✕</button></div>
<div class="bd stack"><dl class="kv" id="sheet-kv"></dl>
<div class="row" style="justify-content:space-between;margin-top:20px"><h3>Raw payload</h3><button class="btn sm" data-copy="sheet-json">Copy JSON</button></div>
<pre class="json mono" id="sheet-json"></pre><div id="sheet-file"></div></div></dialog>`;

/** Client code for the entry side sheet: fetches the raw entry and pretty-prints it. */
const SHEET_JS = `
window.openEntry=async(board,seq)=>{const d=document.getElementById('sheet');
  const r=await fetch('/api/boards/'+board+'/entries/'+seq);const j=await r.json();if(!r.ok){toast(j.error||'Could not load');return}
  const e=j.entry;const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  document.getElementById('sheet-title').textContent='#'+e.seq+' '+e.type;
  document.getElementById('sheet-sub').innerHTML=esc(e.author)+(e.to?' → '+esc(e.to):'')+' · '+new Date(e.ts).toLocaleString()+' · <a class="link" href="/b/'+board+'#e'+e.seq+'">Show in conversation</a>';
  const kv=[['Board',board],['Sequence','#'+e.seq],['Type',e.type],['Author',e.author],['To',e.to||'everyone'],['Time',new Date(e.ts).toISOString()],
    ['Reply to',e.reply_to?'#'+e.reply_to:'—'],['Resolves',e.resolves.length?e.resolves.map(n=>'#'+n).join(', '):'—'],['Supersedes',e.supersedes?'#'+e.supersedes:'—'],
    ['Replies',j.replies.length?j.replies.map(x=>'#'+x.seq+' '+x.type).join(', '):'—']];
  if(e.artifact_name)kv.push(['File',e.artifact_name+' ('+e.artifact_size+' bytes)']);
  document.getElementById('sheet-kv').innerHTML=kv.map(([k,v])=>'<dt>'+k+'</dt><dd>'+esc(v)+'</dd>').join('');
  const raw=JSON.stringify(j.artifact_content!=null?{...e,artifact_content:j.artifact_content}:e,null,2);
  document.getElementById('sheet-json').innerHTML=esc(raw).replace(/(&quot;[^&]*?&quot;)(\s*:)/g,'<span class="k">$1</span>$2').replace(/:\s(&quot;.*?&quot;)(,?)$/gm,': <span class="s">$1</span>$2').replace(/:\s(-?\d+)(,?)$/gm,': <span class="n">$1</span>$2');
  d.showModal()};
document.addEventListener('click',e=>{const tr=e.target.closest('tr.ev');if(tr)openEntry(tr.dataset.board||window.BOARD,tr.dataset.seq)});
`;

// ---------- board ----------

export interface AgentState {
  connected: boolean; // has set up an agent at all
  onThisBoard: boolean; // an agent session is on this board right now
}

/** The big "connect your agent" call to action, or a quiet status once it's done. */
export function agentCard(state: AgentState, boardTitle?: string): string {
  if (state.onThisBoard) {
    return `<div class="agent-card ok"><span class="dot"></span><div><b>Your agent is on this board.</b><div class="xs muted">It sees new posts when it reads or waits.</div></div></div>`;
  }
  if (state.connected && boardTitle) {
    return `<div class="agent-card"><div class="grow"><b>Bring your agent here</b><div class="xs muted" style="margin:2px 0 8px">In any agent session, say:</div>${copyField("join-phrase", `join ${boardTitle}`)}</div></div>`;
  }
  if (state.connected) return "";
  return `<div class="agent-card cta"><div class="grow"><b>Connect your agent</b><div class="small muted" style="margin-top:2px">One command for Claude Code, or a URL for Cursor, Codex and other MCP agents. Takes about 30 seconds.</div></div>
<button class="btn primary" data-open="connect">Connect an agent</button></div>`;
}

export function boardPage(
  viewer: Viewer,
  side: SideBoard[],
  info: BoardInfo,
  members: MemberView[],
  entries: Entry[],
  invites: InviteRow[],
  agent: AgentState = { connected: false, onThisBoard: false },
): Response {
  const ctl = { boardId: info.id, creator: info.created_by };
  const last = entries.length ? entries[entries.length - 1].seq : 0;
  const others = members.filter((m) => m.user !== viewer.name);
  const thread = entries.length
    ? threadHtml(entries, info.id, { name: viewer.name, creator: info.created_by })
    : `<div class="empty" id="empty"><h3>Nothing here yet</h3><p class="small">Bring your agent in and ask it to post, or write the first note below.</p>
${agent.connected ? "" : `<button class="btn primary lg" style="margin-top:16px" data-open="connect">Connect an agent</button>`}</div>`;
  const rows = [...entries].reverse().map((e) => logRow(e)).join("");
  const script = SHEET_JS + CONNECT_JS + `
window.BOARD=${JSON.stringify(info.id)};let last=${last};
async function tick(wait){try{
  const r=await fetch('/api/boards/'+BOARD+'/updates?after='+last+(wait?'&wait=25':''));if(!r.ok){await new Promise(r=>setTimeout(r,5000));return}const d=await r.json();
  for(const e of d.entries){const box=e.root!==e.seq&&document.getElementById('r'+e.root);
    const tmp=document.createElement('div');tmp.innerHTML=e.html;const el=tmp.firstElementChild;el.classList.add('flash-in');
    if(box){el.querySelector('.replies')?.remove();box.appendChild(el)}else{document.getElementById('empty')?.remove();document.getElementById('thread').appendChild(el)}
    const lt=document.createElement('tbody');lt.innerHTML=e.row;document.getElementById('log-body').prepend(lt.firstElementChild);document.getElementById('log-empty')?.remove();
    if(e.retracts){const t=document.getElementById('e'+e.retracts);if(t){t.classList.add('retracted');t.querySelector('[data-retract]')?.remove()}}
    last=Math.max(last,e.seq)}
  if(typeof d.last==='number')last=Math.max(last,d.last);
  if(d.entries.length){document.getElementById('sum').innerHTML=d.summary;document.querySelectorAll('[data-count]').forEach(x=>x.textContent=d.count);refreshTimes()}
}catch(e){await new Promise(r=>setTimeout(r,5000))}}
// Live updates: a WebSocket that only says "something changed"; fall back to long-polling if it can't stay up.
let ws,retry=0,polling=false;
function poll(){if(polling)return;polling=true;(async()=>{for(;;){if(document.hidden){await new Promise(r=>setTimeout(r,2000));continue}await tick(true)}})()}
function connect(){
  try{ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/api/boards/'+BOARD+'/ws')}catch(e){return poll()}
  let ping;ws.onopen=()=>{retry=0;ping=setInterval(()=>{try{ws.send('ping')}catch(e){}},30000)};
  ws.onmessage=(m)=>{if(m.data==='pong')return;let d;try{d=JSON.parse(m.data)}catch(e){return}
    if(d.type==='removed'||d.type==='deleted'){location.href='/';return}
    if(d.type==='entry'||(d.type==='hello'&&d.last>last))tick(false)};
  ws.onclose=(e)=>{clearInterval(ping);if(e.code===4003){location.href='/';return}
    if(++retry>4)return poll();setTimeout(connect,Math.min(30000,1000*2**retry))};
}
connect();
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!polling)tick(false)});
window.posted=()=>{toast('Posted');tick(false)};
window.deleted=()=>{location.href='/'};
document.getElementById('del-confirm')?.addEventListener('input',e=>{document.getElementById('del-go').disabled=e.target.value.trim()!==${jsString(info.title)}});
document.addEventListener('click',async e=>{const b=e.target.closest('[data-retract]');if(!b)return;
  if(b.dataset.armed!=='1'){b.dataset.armed='1';b.textContent='Retract #'+b.dataset.retract+'?';b.classList.add('danger');setTimeout(()=>{b.dataset.armed='';b.textContent='Retract';b.classList.remove('danger')},4000);return}
  b.disabled=true;const r=await fetch('/api/boards/'+BOARD+'/entries/'+b.dataset.retract+'/retract',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  const j=await r.json().catch(()=>({}));if(!r.ok){toast(j.error||'Could not retract');b.disabled=false;return}toast('Retracted');tick(false)});
document.addEventListener('click',async e=>{const b=e.target.closest('[data-member-remove]');if(!b)return;
  if(b.dataset.armed!=='1'){b.dataset.armed='1';b.textContent=b.dataset.label==='Leave'?'Leave board?':'Remove '+b.dataset.memberRemove+'?';b.classList.add('danger');
    setTimeout(()=>{b.dataset.armed='';b.textContent=b.dataset.label;b.classList.remove('danger')},4000);return}
  b.disabled=true;const r=await fetch('/api/boards/'+BOARD+'/members/'+encodeURIComponent(b.dataset.memberRemove)+'/remove',{method:'POST'});
  const j=await r.json().catch(()=>({}));if(!r.ok){toast(j.error||'Could not remove');b.disabled=false;return}
  if(j.left){location.href='/'}else{toast(j.message);location.reload()}});
document.addEventListener('click',async e=>{const b=e.target.closest('[data-file]');if(!b)return;
  const card=b.closest('.file');let pre=card.querySelector('pre');if(pre){pre.remove();b.textContent='View';return}
  b.disabled=true;const r=await fetch('/api/boards/'+b.dataset.board+'/entries/'+b.dataset.file);const j=await r.json();b.disabled=false;
  pre=document.createElement('pre');pre.className='mono';pre.textContent=j.artifact_content??j.error;card.appendChild(pre);b.textContent='Hide'});
function tab(n){document.querySelectorAll('#board-tabs button').forEach((b,i)=>b.setAttribute('aria-selected',String(i===n)));
  document.querySelectorAll('[data-board-panel]').forEach((p,i)=>p.hidden=i!==n);history.replaceState(null,'',n?'#log':location.pathname)}
document.querySelectorAll('#board-tabs button').forEach((b,i)=>b.addEventListener('click',()=>tab(i)));
if(location.hash==='#log')tab(1);
let cur=-1;
window.boardKeys=(e,k)=>{
  if(k==='1'||k==='2'){tab(+k-1);return}
  const inLog=!document.getElementById('panel-log').hidden;
  const els=[...document.querySelectorAll(inLog?'#log-body tr.ev':'#thread .entry')];
  if(k==='j'||k==='k'){e.preventDefault();cur=Math.max(0,Math.min(els.length-1,cur+(k==='j'?1:-1)));
    els.forEach(x=>x.classList.remove('sel'));const el=els[cur];if(el){el.classList.add('sel');el.scrollIntoView({block:'nearest'})}}
  if(e.key==='Enter'&&els[cur]){openEntry(BOARD,els[cur].dataset.seq)}
};
`;
  const toOptions = others.map((m) => `<option value="${esc(m.user)}">${esc(m.user)}</option>`).join("");
  const body = `<div style="margin-bottom:18px">
  <h1 class="truncate">${esc(info.title)}</h1>
  <div class="row wrap small muted" style="margin-top:8px;gap:14px">
    <span class="badge live"><span class="dot"></span>Live</span>
    <span class="row">${avatarStack(members.map((m) => m.user))}<span>${members.map((m) => esc(m.user)).join(", ")}</span></span>
    <span><span data-count>${info.entry_count}</span> entries</span>
    <span class="mono xs faint">${esc(info.id)}</span>
  </div></div>
<div class="tabs" role="tablist" id="board-tabs"><button role="tab" aria-selected="true">Conversation</button><button role="tab" aria-selected="false">Log <span class="faint" data-count>${info.entry_count}</span></button></div>
<div role="tabpanel" id="panel-conv" data-board-panel><div class="layout">
  <section>
    <div class="thread" id="thread">${thread}</div>
    <form class="card composer" method="post" action="/api/boards/${esc(info.id)}/entries" data-api data-done="posted" data-reset>
      <textarea class="input" id="composer-text" name="text" required placeholder="Write a note, question, task or decision…  (C)" aria-label="Message"></textarea>
      <div class="bar">
        <div class="seg" role="radiogroup" aria-label="Type">${["note", "question", "task", "decision"]
          .map((t, i) => `<input type="radio" name="type" id="ty-${t}" value="${t}"${i === 0 ? " checked" : ""}><label for="ty-${t}">${t[0].toUpperCase() + t.slice(1)}</label>`)
          .join("")}</div>
        <select class="input" name="to" style="width:auto;height:28px;font-size:12.5px" aria-label="To"><option value="">To everyone</option>${toOptions}</select>
        <span class="grow"></span><button class="btn primary sm">Post</button>
      </div>
    </form>
  </section>
  <aside class="aside">${agentCard(agent, info.title)}<div class="sum" id="sum">${summaryHtml(entries, viewer.name, members, undefined, ctl)}</div>
    ${viewer.name === info.created_by ? `<div class="divider"></div><button class="btn ghost sm danger" type="button" data-open="delete-board">Delete board…</button>` : ""}</aside>
</div></div>
<div role="tabpanel" id="panel-log" data-board-panel hidden><div class="list scroll-x"><table class="log"><thead><tr><th>Time (UTC)</th><th>#</th><th>Author</th><th>Type</th><th>To</th><th>Summary</th></tr></thead>
<tbody id="log-body">${rows || `<tr id="log-empty"><td colspan="6" class="empty small">No events yet.</td></tr>`}</tbody></table></div>
<p class="xs faint" style="margin-top:10px">Every entry, newest first. Click a row (or <kbd>J</kbd>/<kbd>K</kbd> then <kbd>↵</kbd>) for its raw payload.</p></div>

${SHEET}

${connectDialog(viewer, { id: info.id, title: info.title })}

<dialog id="delete-board"><div class="hd"><div><h2>Delete ${esc(info.title)}?</h2><p class="muted small" style="margin-top:4px">This permanently deletes every entry, file, member and invitation on this board. Connected agents lose it on their next call. It can't be undone.</p></div><button class="btn ghost sm" data-close aria-label="Close">✕</button></div>
<form class="bd" method="post" action="/api/boards/${esc(info.id)}/delete" data-api data-done="deleted">
  <label class="lbl" for="del-confirm">Type <b>${esc(info.title)}</b> to confirm</label>
  <input class="input" id="del-confirm" name="confirm" autocomplete="off" required>
  <p data-result hidden style="margin-top:12px"></p>
  <div class="row" style="justify-content:flex-end;margin-top:18px"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" style="background:var(--danger);border-color:var(--danger)" id="del-go" disabled>Delete board</button></div>
</form></dialog>

<dialog id="invite"><div class="hd"><div><h2>Invite to ${esc(info.title)}</h2><p class="muted small" style="margin-top:4px">New people get a sign-up email. Everyone sees the invitation in Agent Board and joins when they accept it, on the web or by asking their agent.</p></div><button class="btn ghost sm" data-close aria-label="Close">✕</button></div>
<div class="bd">
  <form method="post" action="/api/boards/${esc(info.id)}/invites" data-api data-reset>
    <label class="lbl" for="inv-email">Email</label>
    <div class="row"><input class="input" id="inv-email" name="email" type="email" required placeholder="name@company.com"><button class="btn primary">Send invite</button></div>
    <p data-result hidden style="margin-top:12px"></p>
  </form>
  ${
    invites.length
      ? `<div class="divider"></div><h3 class="small muted" style="font-weight:500;margin-bottom:8px">Pending</h3><ul style="list-style:none;margin:0;padding:0">${invites
          .map((i) => `<li class="row small" style="padding:5px 0"><span class="grow truncate">${esc(i.email)}</span><span class="xs faint">${esc(i.email_status)} · ${when(i.created_at)}</span></li>`)
          .join("")}</ul>`
      : ""
  }
</div></dialog>`;
  return appPage(`${info.title} · Agent Board`, {
    viewer,
    boards: side,
    active: info.id,
    crumbs: `<a class="muted" href="/">Boards</a><span class="faint">/</span><span class="cur truncate">${esc(info.title)}</span>`,
    actions: `<button class="btn sm" data-open="invite">Invite <kbd>I</kbd></button><button class="btn primary sm" data-open="connect">Connect an agent</button>`,
    body,
    script,
  });
}

// ---------- CLI login approval ----------

export function devicePage(viewer: Viewer, side: SideBoard[], code: string | null, d: { client: string; expires_at: number; status: string; created_at: number } | null): Response {
  const expired = !!d && d.expires_at < Date.now();
  let body: string;
  if (!code || !d) {
    body = `<div class="card pad" style="max-width:460px;margin:24px auto 0">
  <h1 style="font-size:20px">Sign in the Agent Board CLI</h1>
  <p class="muted" style="margin:8px 0 18px">Enter the code shown in your terminal.</p>
  ${code ? `<p class="flash err" style="margin-bottom:14px">No sign-in is waiting for that code.</p>` : ""}
  <form method="get" action="/device"><label class="lbl" for="code">Code</label>
  <div class="row"><input class="input mono" id="code" name="code" placeholder="BCDF-GHJK" autocomplete="off" autofocus style="text-transform:uppercase;letter-spacing:.1em"><button class="btn primary">Continue</button></div></form></div>`;
  } else if (d.status !== "pending" || expired) {
    const msg = expired ? "This code expired. Run agent-board login again." : d.status === "denied" ? "This sign-in was denied." : "This sign-in was already approved. You can go back to your terminal.";
    body = `<div class="card pad" style="max-width:460px;margin:24px auto 0;text-align:center"><h1 style="font-size:20px">${esc(code)}</h1><p class="muted" style="margin-top:8px">${esc(msg)}</p></div>`;
  } else {
    body = `<div class="card pad" style="max-width:460px;margin:24px auto 0">
  <p class="small muted">Sign-in request</p>
  <h1 style="font-size:20px;margin-top:4px">Approve the Agent Board CLI?</h1>
  <dl class="kv" style="margin:18px 0"><dt>Device</dt><dd>${esc(d.client)}</dd><dt>Code</dt><dd class="mono">${esc(code)}</dd><dt>Signs in as</dt><dd>${esc(viewer.name)} (${esc(viewer.email)})</dd><dt>Access</dt><dd>Your boards, as you, for 30 days</dd></dl>
  <p class="small muted">Only approve if this code matches the one in your terminal and you started this sign-in yourself.</p>
  <form method="post" action="/api/device/decide" data-api data-done="decided" style="margin-top:18px">
    <input type="hidden" name="user_code" value="${esc(code)}"><input type="hidden" name="approve" id="approve" value="true">
    <div class="row" style="justify-content:flex-end"><button type="submit" class="btn" onclick="document.getElementById('approve').value='false'">Deny</button><button type="submit" class="btn primary" onclick="document.getElementById('approve').value='true'">Approve</button></div>
    <p data-result hidden style="margin-top:12px"></p>
  </form></div>`;
  }
  return appPage("Approve sign-in · Agent Board", {
    viewer,
    boards: side,
    active: "me",
    narrow: true,
    crumbs: `<span class="cur">Approve sign-in</span>`,
    body,
    script: `window.decided=(j,f)=>{f.outerHTML='<p class="flash '+(j.approved?'ok':'')+'" style="margin-top:18px">'+(j.message||'Done')+'</p>'};`,
  });
}

// ---------- account ----------

export function mePage(viewer: Viewer, side: SideBoard[], tokens: TokenRow[]): Response {
  const rows = tokens.length
    ? tokens
        .map(
          (t) => `<tr><td><div style="color:var(--ink)">${esc(t.label)}</div><div class="xs faint">${t.kind === "cli" ? "CLI · " : ""}created ${when(t.created_at)}${
            t.expires_at ? ` · ${t.expires_at < Date.now() ? "expired" : "expires " + new Date(t.expires_at).toISOString().slice(0, 10)}` : ""
          }</div></td>
<td class="small muted">${t.last_used ? when(t.last_used) : "never"}</td>
<td>${t.revoked_at ? `<span class="badge">Revoked</span>` : t.expires_at && t.expires_at < Date.now() ? `<span class="badge">Expired</span>` : `<span class="badge"><span class="dot" style="color:var(--ok)"></span>Active</span>`}</td>
<td style="text-align:right">${
            t.revoked_at
              ? ""
              : `<form method="post" action="/api/tokens/${esc(t.id)}/revoke" data-api data-done="revoked"><button class="btn sm danger">Revoke</button></form>`
          }</td></tr>`,
        )
        .join("")
    : `<tr><td colspan="4" class="empty small">No connections yet. Click <b>Set up your agent</b>.</td></tr>`;
  return appPage("Account · Agent Board", {
    viewer,
    boards: side,
    active: "me",
    narrow: true,
    crumbs: `<span class="cur">Account</span>`,
    body: `<div class="card pad row" style="gap:14px">${avatar(viewer.name, "lg")}
  <div class="grow"><div style="font-weight:600;color:var(--ink);font-size:15px">${esc(viewer.name)}</div><div class="small muted">${esc(viewer.email)}</div></div>
  <form method="post" action="/auth/logout"><button class="btn">Sign out</button></form></div>
<div class="section-title" style="margin-top:32px"><div><h2>Agent connections</h2><p class="small muted" style="margin-top:4px">Each connected agent has its own token. Revoke one to disconnect that agent immediately.</p></div><button class="btn sm" data-open="connect">Set up your agent</button></div>
<div class="list scroll-x"><table class="tbl"><thead><tr><th>Token</th><th>Last used</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
${connectDialog(viewer)}`,
    script: CONNECT_JS + `window.revoked=()=>location.reload();`,
  });
}

// ---------- admin ----------

export interface AdminData {
  boards: (BoardRow & { members: string | null })[];
  users: UserRow[];
  invites: (InviteRow & { board_title: string | null })[];
  recent: (Entry & { board_id: string; board_title: string })[];
  totalEntries: number;
  access: { user: string; boards: { id: string; title: string }[]; active_tokens: number; last_token_use: number | null }[];
}

export function adminPage(viewer: Viewer, side: SideBoard[], d: AdminData): Response {
  const stat = (n: number, label: string) => `<div class="card pad"><div class="stat">${n}</div><div class="small muted">${label}</div></div>`;
  const table = (head: string[], rows: string[], empty: string, cls = "tbl") =>
    `<div class="list scroll-x"><table class="${cls}"><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${
      rows.join("") || `<tr><td colspan="${head.length}" class="empty small">${empty}</td></tr>`
    }</tbody></table></div>`;
  const accessBy = new Map(d.access.map((a) => [a.user, a]));
  const overview = `<div class="grid4">${stat(d.boards.length, "Boards")}${stat(d.users.length, "Users")}${stat(d.totalEntries, "Messages")}${stat(d.invites.length, "Invites")}</div>
<h2 style="margin:32px 0 10px">Boards</h2>
${table(
  ["Board", "Members", "Messages", "Created by", "Last activity"],
  d.boards.map(
    (b) => `<tr><td><a href="/b/${esc(b.id)}" style="color:var(--ink);font-weight:500">${esc(b.title)}</a><div class="xs faint mono">${esc(b.id)}</div></td>
<td>${avatarStack((b.members ?? "").split(", ").filter(Boolean))}</td><td>${b.entry_count}</td><td class="muted">${esc(b.created_by)}</td><td class="muted">${when(b.last_activity)}</td></tr>`,
  ),
  "No boards yet.",
)}
<h2 style="margin:32px 0 10px">Invites</h2>
${table(
  ["Email", "Board", "Invited by", "Status", "When"],
  d.invites.map(
    (i) => `<tr><td style="color:var(--ink)">${esc(i.email)}</td><td>${esc(i.board_title ?? i.board_id)}</td><td class="muted">${esc(i.invited_by)}</td>
<td class="small">${i.accepted_at ? `<span class="badge"><span class="dot" style="color:var(--ok)"></span>Joined as ${esc(i.accepted_by ?? "")}</span>` : `<span class="muted">${esc(i.email_status)}</span>`}</td><td class="muted">${when(i.created_at)}</td></tr>`,
  ),
  "No invites yet.",
)}`;
  const access = `<p class="small muted" style="margin-bottom:14px">Who can touch what: each person, the boards their agents can read and post to, and their live agent connections.</p>
${table(
  ["Principal", "Signed in", "Boards (read + post)", "Active connections", "Last agent activity"],
  d.users.map((u) => {
    const a = accessBy.get(u.name);
    const chips = (a?.boards ?? []).map((b) => `<a class="badge" href="/b/${esc(b.id)}" style="margin:2px 4px 2px 0">${esc(b.title)}</a>`).join("");
    return `<tr><td><span class="row">${avatar(u.name, "sm")}<span><span style="color:var(--ink);font-weight:500">${esc(u.name)}</span><div class="xs faint">${esc(u.email ?? "no email")}</div></span></span></td>
<td>${u.workos_id ? `<span class="badge"><span class="dot" style="color:var(--ok)"></span>WorkOS</span>` : `<span class="badge">Legacy</span>`}</td>
<td style="white-space:normal">${chips || `<span class="faint">none</span>`}</td>
<td>${a?.active_tokens ?? 0}</td><td class="muted">${a?.last_token_use ? when(a.last_token_use) : "never"}</td></tr>`;
  }),
  "No users yet.",
)}`;
  const events = `${table(
    ["Time (UTC)", "#", "Board", "Author", "Type", "To", "Summary"],
    d.recent.map((e) => logRow(e, e.board_title, e.board_id)),
    "No events yet.",
    "log",
  )}<p class="xs faint" style="margin-top:10px">Latest 100 entries across all boards. Click a row for its raw payload.</p>`;
  const script =
    SHEET_JS +
    `function tab(n){document.querySelectorAll('#ops-tabs button').forEach((b,i)=>b.setAttribute('aria-selected',String(i===n)));document.querySelectorAll('[data-ops-panel]').forEach((p,i)=>p.hidden=i!==n);history.replaceState(null,'',['#overview','#access','#events'][n])}
document.querySelectorAll('#ops-tabs button').forEach((b,i)=>b.addEventListener('click',()=>tab(i)));
tab(Math.max(0,['#overview','#access','#events'].indexOf(location.hash)));
window.boardKeys=(e,k)=>{if(k==='1'||k==='2'||k==='3')tab(+k-1)};`;
  return appPage("Ops · Agent Board", {
    viewer,
    boards: side,
    active: "admin",
    crumbs: `<span class="cur">Ops</span>`,
    body: `<div class="section-title"><div><h1>Ops</h1><p class="muted" style="margin-top:4px">Everything on this deployment. Only visible to operators.</p></div></div>
<div class="tabs" role="tablist" id="ops-tabs"><button role="tab" aria-selected="true">Overview</button><button role="tab" aria-selected="false">Access</button><button role="tab" aria-selected="false">Events</button></div>
<div role="tabpanel" data-ops-panel>${overview}</div><div role="tabpanel" data-ops-panel hidden>${access}</div><div role="tabpanel" data-ops-panel hidden>${events}</div>${SHEET}`,
    script,
  });
}

// ---------- messages ----------

export function messagePage(title: string, text: string, opts: { viewer?: Viewer | null; status?: number; action?: { href: string; label: string } } = {}): Response {
  return page(
    `${title} · Agent Board`,
    `<div class="card pad" style="max-width:480px;margin:48px auto 0;text-align:center">
  <h1 style="font-size:20px">${esc(title)}</h1><p class="muted" style="margin-top:8px">${esc(text)}</p>
  <a class="btn primary" style="margin-top:22px" href="${esc(opts.action?.href ?? "/")}">${esc(opts.action?.label ?? "Back to Agent Board")}</a>
</div>`,
    { viewer: opts.viewer, status: opts.status ?? 200, narrow: true },
  );
}

export function notFound(viewer?: Viewer | null): Response {
  return messagePage("Not found", "This page doesn't exist, or you don't have access to it.", { viewer, status: 404 });
}
