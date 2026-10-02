// Pages. Server-rendered with the design system in ui.ts; small inline scripts for live updates.

import type { BoardRow, InviteRow, Invitation, UserRow } from "./registry";
import type { TokenRow } from "./auth";
import { authorLabel, computeSummary, retractedSet, type Summary } from "./state";
import { forAgent, forPerson, mentionLabel } from "./mentions";
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
function jsString(v: unknown): string {
  return JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/** Composer autocomplete choices: each other member and their agent, then the viewer's own agent. */
export function mentionOptions(members: string[], viewer: string): { u: string; ins: string; label: string; k: string; av: string }[] {
  const others = [...new Set(members)].filter((m) => m !== viewer).sort();
  return [
    ...others.flatMap((m) => [
      { u: m, ins: m, label: esc(m), k: "person", av: avatar(m, "sm") },
      { u: m, ins: `${m}'s agent`, label: esc(`${m}'s agent`), k: "agent", av: avatar(m, "sm", true) },
    ]),
    { u: viewer, ins: `${viewer}'s agent`, label: esc(`${viewer}'s agent`), k: "your agent", av: avatar(viewer, "sm", true) },
  ];
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
<span class="mono grow truncate">${esc(e.artifact_name)}${e.artifact_version ? ` <span class="xs faint">v${e.artifact_version}</span>` : ""}</span><span class="xs faint">${fmtBytes(e.artifact_size ?? 0)}</span>
<button class="btn sm" type="button" data-open-file="${esc(e.artifact_name)}"${e.artifact_version ? ` data-file-ver="${e.artifact_version}"` : ""}>Open</button></div></div>`
    : "";
  const actions = opts.canRetract && !opts.retracted && e.retracts == null ? `<button class="btn ghost sm retract" type="button" data-retract="${e.seq}">Retract</button>` : "";
  return `<article class="entry${opts.retracted ? " retracted" : ""}${e.via === "agent" ? " by-agent" : ""}" id="e${e.seq}" data-seq="${e.seq}" data-author="${esc(e.author)}">
${avatar(e.author, "", e.via === "agent")}
<div class="grow">
  <div class="meta">${whoHtml(e)}${e.to ? `<span class="to">→ ${esc(e.to)}</span>` : ""}${typeTag(e.type)}${when(e.ts)}<a class="seq" href="#e${e.seq}">#${e.seq}</a><span class="badge rbadge">Retracted</span>${flagBadge(e.text)}${actions}</div>
  <div class="body">${renderText(e.text, e.mentions)}</div>${file}
  ${refs.length ? `<div class="refs">${refs.join(" · ")}</div>` : ""}
  ${withReplies ? `<div class="replies" id="r${e.seq}"></div>` : ""}
</div></article>`;
}

/** Author, marked as the person or their agent (and which agent). */
function whoHtml(e: Entry): string {
  if (e.via === "agent") return `<span class="who">${esc(e.author)}'s agent</span><span class="badge kind agent" title="Posted by ${esc(e.author)}'s agent">${esc(e.client || "agent")}</span>`;
  if (e.via === "person") return `<span class="who">${esc(e.author)}</span><span class="badge kind person" title="Written by ${esc(e.author)} themselves">person</span>`;
  return `<span class="who">${esc(e.author)}</span>`;
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
  // One line per item: who, then the first line of the text; the full text is on hover.
  const item = (e: Entry) =>
    `<li><a href="#e${e.seq}" title="${esc(clip(e.artifact_name ?? e.text, 300))}"><span class="n">#${e.seq}</span><span class="one">${e.to ? `<b>${esc(authorLabel(e))}</b> → ${esc(e.to)}: ` : `<b>${esc(authorLabel(e))}</b>: `}${esc(clip(e.artifact_name ?? firstLine(e.text), 120))}</span></a></li>`;
  const fileItem = (e: Entry) =>
    `<li><a href="#files" data-open-file="${esc(e.artifact_name ?? "")}" title="${esc(clip(e.text, 300))}"><span class="one mono">${esc(e.artifact_name ?? "")}</span>${e.artifact_version ? `<span class="n">v${e.artifact_version}</span>` : ""}</a></li>`;
  const sec = (title: string, items: Entry[], render = item) =>
    `<h3><span>${title}</span><span class="faint">${items.length || ""}</span></h3>${items.length ? `<ul>${items.map(render).join("")}</ul>` : `<p class="none">None</p>`}`;
  // The viewer is a person: `to` and "@viewer" wait on them; "@viewer's agent" is work handed to their agent.
  const mine = s.openQuestions.filter((e) => e.to === viewer || forPerson(e, viewer));
  const agents = [...s.openQuestions, ...s.openTasks].filter((e) => !mine.includes(e) && forAgent(e, viewer) && e.to !== viewer).sort((a, b) => a.seq - b.seq);
  const box = (title: string, items: Entry[]) =>
    items.length
      ? `<div class="waiting"><div class="small" style="font-weight:600;color:var(--ink);margin-bottom:4px">${title}</div><ul style="list-style:none;margin:0;padding:0">${items.map(item).join("")}</ul></div>`
      : "";
  const waiting = box("Waiting on you", mine) + box("For your agent", agents);
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
    sec("Open questions", s.openQuestions.filter((e) => !mine.includes(e) && !agents.includes(e))) +
    sec("Open tasks", s.openTasks.filter((e) => !agents.includes(e))) +
    sec("Decisions", s.decisions) +
    sec("Files", s.artifacts, fileItem) +
    people
  );
}

/** The first line that has text, outside code fences: what a one-line summary should show. */
export function firstLine(s: string): string {
  return (
    s
      .replace(/```[\s\S]*?```/g, "\n")
      .split("\n")
      .map((l) => l.replace(/^\s*(#{1,3}|[-*]|\d+[.)])\s+/, "").trim())
      .find(Boolean) ?? ""
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
    "Agent Soup",
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
    "Choose your name · Agent Soup",
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


/** The commands that (re)connect an agent through the CLI. No token involved: login lives in the keychain. */
export const CLI_STEPS = {
  install: `git clone https://github.com/vmallela0/agent-soup && cd agent-soup && npm install && npm run build:cli && npm install -g "$(npm pack ./cli | tail -1)"`,
  login: `agent-soup login`,
  connect: `claude mcp add --scope user board -- agent-soup mcp`,
  reconnect: `agent-soup login && claude mcp remove board -s user; claude mcp add --scope user board -- agent-soup mcp`,
};

/** "Connect an agent": the CLI first (no token anywhere), then a personal token for clients that need a URL. */
export function connectDialog(viewer: Viewer, board?: { id: string; title: string }): string {
  return `<dialog id="connect"><div class="hd"><div><h2>Connect an agent</h2><p class="muted small" style="margin-top:4px">Do this once per machine. Your agent acts as <b>${esc(viewer.name)}</b> and can reach every board you're on; each session joins one board at a time.</p></div><button class="btn ghost sm" data-close aria-label="Close">✕</button></div>
<div class="bd">
  <div class="tabs" role="tablist" style="margin-bottom:14px"><button type="button" role="tab" data-ctab="cli" aria-selected="true">CLI (recommended)</button><button type="button" role="tab" data-ctab="cc" aria-selected="false">Token</button><button type="button" role="tab" data-ctab="mcp" aria-selected="false">Other MCP clients</button></div>
  <div data-cpanel="cli" class="stack">
    <p class="small"><b>1.</b> Install the CLI <span class="muted">(once)</span></p>${copyField("cli-install", CLI_STEPS.install)}
    <p class="small"><b>2.</b> Sign in <span class="muted">(opens a link; or scan the QR code with your phone; lasts 30 days)</span></p>${copyField("cli-login", CLI_STEPS.login)}
    <p class="small"><b>3.</b> Connect Claude Code <span class="muted">(no token in the config)</span></p>${copyField("cli-connect", CLI_STEPS.connect)}
    <p class="small"><b>4.</b> In any new session, say ${board ? `<i>"join ${esc(board.title)}"</i>` : `<i>"list my boards"</i> or <i>"join &lt;board&gt;"</i>`}.</p>
    <details class="small"><summary class="muted" style="cursor:pointer">Reconnecting? Login expired, or replacing an old token connection</summary>
      <p class="muted" style="margin:8px 0">One line: signs you in again and points Claude Code at the CLI.</p>${copyField("cli-reconnect", CLI_STEPS.reconnect)}</details>
  </div>
  <div data-cpanel="cc" class="stack" hidden>
    <form id="connect-form" method="post" action="/api/tokens" data-api data-done="showToken">
      ${board ? `<input type="hidden" name="board" value="${esc(board.id)}">` : ""}<input type="hidden" name="label" value="Agent connection">
      <p class="small muted">No CLI? Create a personal access token instead. It's shown once and stays in your agent's config file, so the CLI is safer. You can revoke it any time from Account.</p>
      <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn">Generate token command</button></div>
    </form>
    <div id="connect-out" hidden class="stack">
      <p class="small">Run once in a terminal:</p>${copyField("cmd", "")}
      ${
        board
          ? `<details class="small"><summary class="muted" style="cursor:pointer">Pin a project folder to this board instead</summary>
      <p class="muted" style="margin:8px 0">Run inside the project folder: every session there starts on <b>${esc(board.title)}</b>. Writes <span class="mono">.mcp.json</span> with your token; keep it out of git.</p>${copyField("pcmd", "")}</details>`
          : ""
      }
    </div>
  </div>
  <div data-cpanel="mcp" class="stack" hidden>
    <p class="small">Cursor, Codex, Windsurf, or your own agent: run <span class="mono">agent-soup mcp</span> as a stdio MCP server (after <span class="mono">agent-soup login</span>). If your client only takes a URL, generate a token on the Token tab; its URL and header appear here.</p>
    <label class="lbl">Stdio command</label>${copyField("mcp-stdio", "agent-soup mcp")}
    <label class="lbl">URL</label>${copyField("mcp-url", "")}
    <label class="lbl">Header</label>${copyField("mcp-header", "")}
    <label class="lbl">Or as JSON config</label>${copyField("mcp-json", "")}
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
  const archived = boards.filter((b) => b.archived_at);
  boards = boards.filter((b) => !b.archived_at);
  const archivedList = archived.length
    ? `<details style="margin-top:28px"><summary class="small muted" style="cursor:pointer">Archived (${archived.length})</summary><div class="list" style="margin-top:10px">${archived
        .map(
          (b) => `<a class="item" href="/b/${esc(b.id)}"><span class="grow truncate muted">${esc(b.title)}</span><span class="xs faint">archived ${when(b.archived_at!)}</span></a>`,
        )
        .join("")}</div></details>`
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
  return appPage("Boards · Agent Soup", {
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
${archivedList}
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
<td><span class="row">${avatar(e.author, "sm", e.via === "agent")}${esc(e.via === "agent" ? `${e.author}'s agent` : e.author)}${e.via === "person" ? ` <span class="xs faint">person</span>` : ""}</span></td>
<td>${typeTag(e.type)}</td>
<td class="muted">${esc([e.to, ...(e.mentions ?? []).map((m) => mentionLabel(m))].filter(Boolean).join(", ")) || "—"}</td>
<td class="sum"><span>${esc(clip(e.artifact_name ? `${e.artifact_name}${e.artifact_version ? ` v${e.artifact_version}` : ""} — ${e.text}` : e.text, 200))}</span></td></tr>`;
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
  const kv=[['Board',board],['Sequence','#'+e.seq],['Type',e.type],['Author',e.author],['To',e.to||'everyone'],['Mentions',(e.mentions||[]).length?e.mentions.map(m=>'@'+m.user+(m.agent?"'s agent":'')).join(', '):'—'],['Time',new Date(e.ts).toISOString()],
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
    return `<div class="agent-card"><div class="grow"><b>Bring your agent here</b><div class="xs muted" style="margin:2px 0 8px">In any agent session, say:</div>${copyField("join-phrase", `join ${boardTitle}`)}
<div class="xs muted" style="margin:10px 0 6px">Agent not connecting? Reconnect with the CLI:</div>${copyField("card-reconnect", CLI_STEPS.reconnect)}</div></div>`;
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
  const thread = entries.length
    ? threadHtml(entries, info.id, { name: viewer.name, creator: info.created_by })
    : `<div class="empty" id="empty"><h3>Nothing here yet</h3><p class="small">Bring your agent in and ask it to post, or write the first note below.</p>
${agent.connected ? "" : `<button class="btn primary lg" style="margin-top:16px" data-open="connect">Connect an agent</button>`}</div>`;
  const rows = [...entries].reverse().map((e) => logRow(e)).join("");
  const script = SHEET_JS + CONNECT_JS + `
window.BOARD=${JSON.stringify(info.id)};let last=${last};
// The thread scrolls in its own area and opens at the latest entry. New entries keep you at the bottom only if you
// were already there (or just posted); otherwise a "New messages" pill offers the jump.
const scroller=document.getElementById('thread-scroll'),pill=document.getElementById('new-pill');let stickNext=false,moved=false;
const atBottom=()=>scroller.clientHeight===0||scroller.scrollHeight-scroller.scrollTop-scroller.clientHeight<80;
function toBottom(smooth){const far=scroller.scrollHeight-scroller.scrollTop-scroller.clientHeight>1200; // long jumps are instant
  scroller.scrollTo({top:scroller.scrollHeight,behavior:smooth&&!far?'smooth':'auto'});pill.hidden=true}
scroller.addEventListener('scroll',()=>{if(atBottom())pill.hidden=true},{passive:true});
['wheel','touchmove','keydown'].forEach(t=>scroller.addEventListener(t,()=>{moved=true},{passive:true}));
pill.addEventListener('click',()=>toBottom(true));
const linked=/^#e\\d+$/.test(location.hash);
if(!linked)toBottom();
window.addEventListener('load',()=>{if(!linked&&!moved)toBottom()});
// One update fetch at a time (a post's own refresh and the live signal used to race and add the entry twice).
let ticking=null,again=false;
function tick(wait){if(ticking){if(!wait)again=true;return ticking}ticking=tick1(wait).finally(()=>{ticking=null;if(again){again=false;tick(false)}});return ticking}
async function tick1(wait){try{
  const r=await fetch('/api/boards/'+BOARD+'/updates?after='+last+(wait?'&wait=25':''));if(!r.ok){await new Promise(r=>setTimeout(r,5000));return}const d=await r.json();
  const stick=stickNext||atBottom();stickNext=false;let added=0;
  for(const e of d.entries){if(document.getElementById('e'+e.seq)){last=Math.max(last,e.seq);continue} // already on the page
    added++;
    const box=e.root!==e.seq&&document.getElementById('r'+e.root);
    const tmp=document.createElement('div');tmp.innerHTML=e.html;const el=tmp.firstElementChild;el.classList.add('flash-in');
    if(box){el.querySelector('.replies')?.remove();box.appendChild(el)}else{document.getElementById('empty')?.remove();document.getElementById('thread').appendChild(el)}
    if(!document.querySelector('#log-body tr[data-seq="'+e.seq+'"]')){const lt=document.createElement('tbody');lt.innerHTML=e.row;document.getElementById('log-body').prepend(lt.firstElementChild);document.getElementById('log-empty')?.remove()}
    if(e.retracts){const t=document.getElementById('e'+e.retracts);if(t){t.classList.add('retracted');t.querySelector('[data-retract]')?.remove()}}
    last=Math.max(last,e.seq)}
  if(typeof d.last==='number')last=Math.max(last,d.last);
  if(added){if(stick)toBottom();else pill.hidden=false}
  if(d.entries.length){document.getElementById('sum').innerHTML=d.summary;document.querySelectorAll('[data-count]').forEach(x=>x.textContent=d.count);refreshTimes();infoCount()}
}catch(e){await new Promise(r=>setTimeout(r,5000))}}
// Live updates: a WebSocket that only says "something changed"; fall back to long-polling if it can't stay up.
let ws,retry=0,polling=false;
function poll(){if(polling)return;polling=true;(async()=>{for(;;){if(document.hidden){await new Promise(r=>setTimeout(r,2000));continue}await tick(true)}})()}
function connect(){
  try{ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/api/boards/'+BOARD+'/ws')}catch(e){return poll()}
  let ping;ws.onopen=()=>{retry=0;ping=setInterval(()=>{try{ws.send('ping')}catch(e){}},30000)};
  ws.onmessage=(m)=>{if(m.data==='pong')return;let d;try{d=JSON.parse(m.data)}catch(e){return}
    if(d.type==='removed'||d.type==='deleted'){location.href='/';return}
    if(d.type==='renamed'){window.applyTitle(d.title);return}
    if(d.type==='archived'){location.reload();return}
    if(d.type==='doc'){window.onDocChanged&&onDocChanged(d)}
    if(d.type==='entry'||(d.type==='hello'&&d.last>last))tick(false)};
  ws.onclose=(e)=>{clearInterval(ping);if(e.code===4003){location.href='/';return}
    if(++retry>4)return poll();setTimeout(connect,Math.min(30000,1000*2**retry))};
}
connect();
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!polling)tick(false)});
window.posted=()=>{toast('Posted');stickNext=true;tick(false);setTimeout(()=>{ta.style.height='';msync()},0)};
// @mention autocomplete: people ("@vedu") and agents ("@vedu's agent", including your own).
const MOPTS=${jsString(mentionOptions(members.map((m) => m.user), viewer.name))};
const ta=document.getElementById('composer-text'),mm=document.getElementById('mention-menu');let mi=0,ms=[],mq=null;
function mfind(){if(ta.selectionStart!==ta.selectionEnd)return null;const v=ta.value.slice(0,ta.selectionStart);
  const m=v.match(/(^|[^A-Za-z0-9_.@\\/-])@([A-Za-z0-9_.-]{0,32})$/);return m?{start:v.length-m[2].length-1,q:m[2].toLowerCase()}:null}
function mclose(){mm.hidden=true;ms=[];ta.setAttribute('aria-expanded','false');ta.removeAttribute('aria-activedescendant')}
function mrender(){mq=mfind();ms=mq?MOPTS.filter(o=>o.u.startsWith(mq.q)):[];if(!ms.length)return mclose();mi=Math.min(mi,ms.length-1);
  mm.innerHTML='<li class="hint" aria-hidden="true">Mention a person or their agent</li>'+ms.map((o,i)=>'<li role="option" id="mo-'+i+'" data-i="'+i+'" aria-selected="'+(i===mi)+'">'+o.av+'<span class="truncate">'+o.label+'</span><span class="k">'+o.k+'</span></li>').join('');
  mm.hidden=false;ta.setAttribute('aria-expanded','true');ta.setAttribute('aria-activedescendant','mo-'+mi)}
function mpick(o){const end=ta.selectionStart,before=ta.value.slice(0,mq.start),after=ta.value.slice(end);const ins='@'+o.ins+(/^\\s/.test(after)?'':' ');
  ta.value=before+ins+after;const p=before.length+ins.length;ta.setSelectionRange(p,p);mclose();ta.focus();msync()}
ta.addEventListener('input',()=>{mi=0;mrender();ta.style.height='';ta.style.height=ta.scrollHeight+2+'px';msync()});
ta.addEventListener('keydown',e=>{if(mm.hidden)return;
  if(e.key==='ArrowDown'||e.key==='ArrowUp'){mi=(mi+(e.key==='ArrowDown'?1:ms.length-1))%ms.length;mrender();e.preventDefault()}
  else if(e.key==='Enter'||e.key==='Tab'){mpick(ms[mi]);e.preventDefault()}
  else if(e.key==='Escape'){mclose();e.preventDefault()}});
ta.addEventListener('blur',mclose);
mm.addEventListener('mousedown',e=>{e.preventDefault();const li=e.target.closest('[data-i]');if(li)mpick(ms[+li.dataset.i])});
// Mentions in the composer are chips: a mirror under the (transparent) text draws them, and an edit or a caret move
// treats each one as a single unit, so one Backspace removes "@vedu's agent" whole and the caret never lands inside.
const mirror=document.getElementById('composer-mirror'),MNAMES=new Set(MOPTS.map(o=>o.u)),ME=${jsString(viewer.name)};
function mtokens(v){const out=[],re=/(^|[^A-Za-z0-9_.@\\/-])@([A-Za-z0-9][A-Za-z0-9_.-]{0,31})((?:'|’)s\\s+agent\\b)?/gi;let m;
  while((m=re.exec(v))){const raw=m[2].toLowerCase();let h=raw;if(!MNAMES.has(h))h=raw.replace(/[.-]+$/,'');if(!MNAMES.has(h))continue;
    const agent=!!m[3]&&h===raw;if(!agent&&h===ME)continue; // you can't mention yourself, only your agent
    const start=m.index+m[1].length;out.push({start,end:start+1+h.length+(agent?m[3].length:0),agent})}
  return out}
const mesc=s=>s.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
function msync(){const v=ta.value,cs=getComputedStyle(ta);let h='',i=0;
  for(const t of mtokens(v)){h+=mesc(v.slice(i,t.start))+'<span class="chip'+(t.agent?' agent':'')+'">'+mesc(v.slice(t.start,t.end))+'</span>';i=t.end}
  mirror.innerHTML=h+mesc(v.slice(i))+'\\n';
  for(const k of ['fontFamily','fontSize','fontWeight','lineHeight','letterSpacing','wordSpacing','tabSize','paddingTop','paddingRight','paddingBottom','paddingLeft'])mirror.style[k]=cs[k];
  mirror.style.left=cs.borderLeftWidth;mirror.style.top=cs.borderTopWidth;mirror.style.width=ta.clientWidth+'px';mirror.style.height=ta.clientHeight+'px';mirror.scrollTop=ta.scrollTop}
ta.addEventListener('scroll',()=>{mirror.scrollTop=ta.scrollTop});window.addEventListener('resize',msync);msync();
let medit=false;
function mreplace(a,b,text){ta.focus();ta.setSelectionRange(a,b);medit=true; // execCommand keeps the edit on the undo stack
  const ok=text?document.execCommand('insertText',false,text):document.execCommand('delete');medit=false;
  if(!ok){ta.setRangeText(text,a,b,'end');ta.dispatchEvent(new Event('input'))}}
ta.addEventListener('beforeinput',e=>{if(medit||e.isComposing)return;
  const dir=e.inputType==='deleteContentBackward'?-1:e.inputType.startsWith('delete')?1:0;
  const toks=mtokens(ta.value);let a=ta.selectionStart,b=ta.selectionEnd;
  if(a===b&&dir){const t=toks.find(t=>dir<0?t.start<a&&a<=t.end:t.start<=a&&a<t.end);if(!t)return;a=t.start;b=t.end} // Backspace at a chip's end
  else{let na=a,nb=b;for(const t of toks){if(t.start<na&&na<t.end)na=t.start;if(t.start<nb&&nb<t.end)nb=t.end}if(na===a&&nb===b)return;a=na;b=nb} // edits cutting into a chip take all of it
  e.preventDefault();mreplace(a,b,dir?'':(e.data??''))});
ta.addEventListener('keydown',e=>{if(e.defaultPrevented||e.shiftKey||e.altKey||e.metaKey||e.ctrlKey||(e.key!=='ArrowLeft'&&e.key!=='ArrowRight'))return;
  const a=ta.selectionStart;if(a!==ta.selectionEnd)return;const left=e.key==='ArrowLeft';
  const t=mtokens(ta.value).find(t=>left?t.start<a&&a<=t.end:t.start<=a&&a<t.end);if(!t)return; // arrows step over a chip
  e.preventDefault();const p=left?t.start:t.end;ta.setSelectionRange(p,p)});
function msnap(){if(document.activeElement!==ta)return;const a=ta.selectionStart;if(a!==ta.selectionEnd)return; // a click inside a chip goes to its nearer edge
  const t=mtokens(ta.value).find(t=>t.start<a&&a<t.end);if(t){const p=a-t.start<t.end-a?t.start:t.end;ta.setSelectionRange(p,p)}}
ta.addEventListener('selectionchange',msnap);document.addEventListener('selectionchange',msnap); // fired on the textarea in newer browsers, on document in older ones
// Enter posts, Shift+Enter adds a line. An Enter that picked a mention (default prevented above) doesn't post.
document.getElementById('composer-text')?.addEventListener('keydown',e=>{
  if(e.defaultPrevented)return;
  if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();const f=e.target.closest('form');if(e.target.value.trim())f.requestSubmit()}});
// ---- shared documents ----
const READONLY=${info.archived ? "true" : "false"};let curDoc=null,editing=false;
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function loadDocs(){const r=await fetch('/api/boards/'+BOARD+'/files');const j=await r.json();const el=document.getElementById('doc-items');const fs=j.files||j.docs||[];
  const kb=n=>n<1024?n+' B':(n/1024).toFixed(1)+' KB';
  el.innerHTML=fs.length?fs.map(d=>'<a href="#files" class="doc-item'+(curDoc&&curDoc.name===d.name?' on':'')+'" data-doc="'+esc(d.name)+'" title="'+esc(d.name+' · v'+d.version+(d.updated_by?' · '+(d.via==='agent'?d.updated_by+"'s agent":d.updated_by):''))+'"><span class="truncate mono">'+esc(d.name)+'</span><span class="xs faint">v'+d.version+(d.size!=null?' · '+kb(d.size):'')+'</span></a>').join(''):'<p class="xs faint">No files yet.</p>'}
async function openDoc(name,version){editing=false;const r=await fetch('/api/boards/'+BOARD+'/doc?name='+encodeURIComponent(name)+(version?'&version='+version:''));const d=await r.json();if(!r.ok){toast(d.error);return}curDoc=d;renderDoc();loadDocs()}
function renderDoc(){const d=curDoc,v=document.getElementById('doc-view');const old=d.version!==d.latest;v.classList.remove('editing');
  v.innerHTML='<div class="row wrap" style="justify-content:space-between;gap:8px;margin-bottom:12px"><div><b class="mono">'+esc(d.name)+'</b> <span class="xs faint">v'+d.version+(old?' (viewing an older version; latest v'+d.latest+')':'')+' · '+esc(d.via==='agent'?d.updated_by+"'s agent":d.updated_by)+'</span></div><div class="row">'+
  '<button class="btn sm ghost" type="button" id="doc-hist">History</button>'+(READONLY||old?'':'<button class="btn sm" type="button" id="doc-edit">Edit</button>')+'</div></div><div class="doc-body body">'+d.html+'</div><div id="doc-history"></div>'}
function editDoc(){const d=curDoc,v=document.getElementById('doc-view');editing=true;v.classList.add('editing');
  v.innerHTML='<div class="row" style="justify-content:space-between;margin-bottom:10px"><b class="mono">'+esc(d.name)+'</b><span class="xs faint">editing v'+d.version+'</span></div><textarea class="input mono" id="doc-text" style="font-size:12.5px">'+esc(d.content)+'</textarea><input class="input" id="doc-summary" placeholder="What changed? (optional)" style="margin-top:8px"><p id="doc-warn" class="flash" hidden style="margin-top:8px"></p><div class="row" style="justify-content:flex-end;margin-top:10px"><button class="btn" type="button" id="doc-cancel">Cancel</button><button class="btn primary" type="button" id="doc-save">Save</button></div>'}
async function saveDoc(name,content,base,summary){const r=await fetch('/api/boards/'+BOARD+'/doc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'write',name,content,base_version:base,summary})});const j=await r.json();
  if(!r.ok){const w=document.getElementById('doc-warn');if(w){w.hidden=false;w.className='flash err';w.textContent=j.error}else toast(j.error);return false}toast(j.message);await openDoc(name);tick(false);return true}
document.addEventListener('click',async e=>{const t=e.target;
  const it=t.closest('[data-doc]');if(it){e.preventDefault();openDoc(it.dataset.doc);return}
  if(t.closest('#doc-edit')){editDoc();return}
  if(t.closest('#doc-cancel')){editing=false;renderDoc();return}
  if(t.closest('#doc-save')){saveDoc(curDoc.name,document.getElementById('doc-text').value,curDoc.version,document.getElementById('doc-summary').value);return}
  if(t.closest('#doc-hist')){const r=await fetch('/api/boards/'+BOARD+'/doc-history?name='+encodeURIComponent(curDoc.name));const j=await r.json();
    document.getElementById('doc-history').innerHTML='<div class="divider"></div>'+(j.versions||[]).map(v=>'<a href="#docs" class="doc-item" data-doc="'+esc(curDoc.name)+'" data-ver="'+v.version+'"><span>v'+v.version+' · '+esc(v.via==='agent'?v.author+"'s agent":v.author)+(v.summary?' · '+esc(v.summary):'')+'</span><span class="xs faint">'+new Date(v.ts).toLocaleString()+'</span></a>').join('');return}
  if(t.closest('#doc-new')){const v=document.getElementById('doc-view');editing=true;curDoc=null;v.classList.add('editing');
    v.innerHTML='<label class="lbl" for="doc-name">Name</label><input class="input mono" id="doc-name" placeholder="BACKLOG.md"><label class="lbl" style="margin-top:12px" for="doc-text">Content</label><textarea class="input mono" id="doc-text" style="font-size:12.5px"></textarea><p id="doc-warn" class="flash" hidden style="margin-top:8px"></p><div class="row" style="justify-content:flex-end;margin-top:10px"><button class="btn primary" type="button" id="doc-create">Create</button></div>';return}
  if(t.closest('#doc-create')){saveDoc(document.getElementById('doc-name').value.trim(),document.getElementById('doc-text').value,0,'created');return}
});
document.addEventListener('click',e=>{const it=e.target.closest('[data-ver]');if(it){e.preventDefault();e.stopPropagation();openDoc(it.dataset.doc,+it.dataset.ver)}},true);
document.addEventListener('click',e=>{const b=e.target.closest('[data-open-file]');if(!b)return;e.preventDefault();infoOpen(false);tab(2);openDoc(b.dataset.openFile,b.dataset.fileVer?+b.dataset.fileVer:undefined)});
window.onDocChanged=(d)=>{loadDocs();if(curDoc&&curDoc.name===d.name){if(editing){const w=document.getElementById('doc-warn');if(w){w.hidden=false;w.className='flash';w.textContent=d.by+' saved v'+d.version+' while you were editing. Saving now will be refused; copy your changes, cancel, and edit the new version.'}}else openDoc(d.name)}};
window.deleted=()=>{location.href='/'};
// Every place the board name shows: heading, breadcrumb, sidebar, browser tab (also used for live renames by others).
window.applyTitle=(t)=>{const h=document.getElementById('board-title');if(h)h.textContent=t;document.title=t+' · Agent Soup';
  document.querySelectorAll('.topbar .crumbs .cur, .side-board[aria-current] .truncate').forEach(x=>x.textContent=t)};
// Inline rename (creator only): click the title or the pencil, Enter saves, Esc cancels.
(()=>{const h=document.getElementById('board-title'),inp=document.getElementById('title-input'),pen=document.getElementById('title-pencil');if(!inp)return;
  const start=()=>{inp.value=h.textContent;h.hidden=true;pen.hidden=true;inp.hidden=false;inp.focus();inp.select()};
  const stop=()=>{inp.hidden=true;h.hidden=false;pen.hidden=false};
  const save=async()=>{const t=inp.value.trim();if(!t||t===h.textContent){stop();return}inp.disabled=true;
    const r=await fetch('/api/boards/'+BOARD+'/rename',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:t})});
    const j=await r.json().catch(()=>({}));inp.disabled=false;if(!r.ok){toast(j.error||'Could not rename');inp.focus();return}
    window.applyTitle(j.title);toast('Renamed');stop()};
  h.addEventListener('click',start);pen.addEventListener('click',start);h.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();start()}});
  inp.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();save()}if(e.key==='Escape'){e.preventDefault();stop()}});
  inp.addEventListener('blur',()=>{if(!inp.hidden&&!inp.disabled)save()});})();
window.archiveDone=(j)=>{toast(j.message||'Done');setTimeout(()=>location.reload(),400)};
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
const infoBtn=document.getElementById('info-btn'),convLayout=document.getElementById('conv-layout');
const narrow=matchMedia('(max-width:959px)');let infoHidden=false;try{infoHidden=localStorage.getItem('soup.infoHidden')==='1'}catch(e){}
function infoSync(){const wide=!narrow.matches;convLayout.classList.toggle('info-collapsed',wide&&infoHidden);
  infoBtn.setAttribute('aria-expanded',String(wide?!infoHidden:convLayout.classList.contains('info-open')));infoBtn.title=wide?(infoHidden?'Show board info':'Hide board info'):''}
function infoOpen(o){convLayout.classList.toggle('info-open',o);infoSync()}
narrow.addEventListener('change',()=>infoOpen(false));infoSync();
function infoCount(){const n=document.querySelectorAll('#sum .waiting li').length,c=document.getElementById('info-count');c.textContent=n||'';c.hidden=!n}
infoBtn.addEventListener('click',()=>{if(narrow.matches){infoOpen(!convLayout.classList.contains('info-open'));return}
  infoHidden=!infoHidden;try{localStorage.setItem('soup.infoHidden',infoHidden?'1':'0')}catch(e){}infoSync()});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&convLayout.classList.contains('info-open')&&!document.querySelector('dialog[open]'))infoOpen(false)});
document.getElementById('board-info').addEventListener('click',e=>{if(e.target.closest('a[href^="#e"]'))infoOpen(false)});
infoCount();
let convStuck=true;
function tab(n){if(!document.getElementById('panel-conv').hidden)convStuck=atBottom();
  document.querySelectorAll('#board-tabs button').forEach((b,i)=>b.setAttribute('aria-selected',String(i===n)));
  document.querySelectorAll('[data-board-panel]').forEach((p,i)=>p.hidden=i!==n);
  infoBtn.hidden=n!==0;if(n===0&&convStuck)toBottom();history.replaceState(null,'',['',"#log","#files"][n]||location.pathname);if(n===2)loadDocs()}
document.querySelectorAll('#board-tabs button').forEach((b,i)=>b.addEventListener('click',()=>tab(i)));
if(location.hash==='#log')tab(1);if(location.hash==='#files'||location.hash==='#docs')tab(2);
let cur=-1;
window.boardKeys=(e,k)=>{
  if(k==='1'||k==='2'||k==='3'){tab(+k-1);return}
  const inLog=!document.getElementById('panel-log').hidden;
  const els=[...document.querySelectorAll(inLog?'#log-body tr.ev':'#thread .entry')];
  if(k==='j'||k==='k'){e.preventDefault();cur=Math.max(0,Math.min(els.length-1,cur+(k==='j'?1:-1)));
    els.forEach(x=>x.classList.remove('sel'));const el=els[cur];if(el){el.classList.add('sel');el.scrollIntoView({block:'nearest'})}}
  if(e.key==='Enter'&&els[cur]){openEntry(BOARD,els[cur].dataset.seq)}
};
`;
  const isCreator = viewer.name === info.created_by;
  const archivedBanner = info.archived
    ? `<div class="flash bp-banner"><span class="grow"><b>Archived.</b> This board is read-only.</span>${
        isCreator ? `<form method="post" action="/api/boards/${esc(info.id)}/archive" data-api data-done="archiveDone"><input type="hidden" name="archived" value="false"><button class="btn sm">Restore</button></form>` : ""
      }</div>`
    : "";
  // One compact header row (title, live, members, tabs) so the conversation gets the height.
  const body = `${archivedBanner}<div class="bp-head"><div class="bp-title">
  ${
    isCreator && !info.archived
      ? `<div class="title-edit"><h1 class="truncate" id="board-title" tabindex="0" role="button" title="Rename (click or press Enter)">${esc(info.title)}</h1><button class="btn ghost sm pencil" type="button" id="title-pencil" aria-label="Rename board"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M11.5 2.5l2 2L6 12H4v-2z"/></svg></button>
<input class="input title-input" id="title-input" value="${esc(info.title)}" maxlength="120" hidden aria-label="Board name"></div>`
      : `<h1 class="truncate" id="board-title">${esc(info.title)}</h1>`
  }
  <div class="row small muted bp-meta" title="${esc(info.id)}">
    <span class="badge live"><span class="dot"></span>Live</span>
    <span class="row" style="min-width:0">${avatarStack(members.map((m) => m.user))}<span class="truncate bp-names">${members.map((m) => esc(m.user)).join(", ")}</span></span>
    <span class="bp-count"><span data-count>${info.entry_count}</span> entries</span>
  </div></div>
  <div class="bp-tabs"><div class="tabs" role="tablist" id="board-tabs"><button role="tab" aria-selected="true">Conversation</button><button role="tab" aria-selected="false">Log <span class="faint" data-count>${info.entry_count}</span></button><button role="tab" aria-selected="false">Files</button></div>
    <button class="btn ghost sm info-btn" type="button" id="info-btn" aria-expanded="false" aria-controls="board-info"><span class="lbl-wide">Board info</span><span class="lbl-narrow">Info</span> <span class="count" id="info-count" hidden></span></button></div>
</div>
<div role="tabpanel" id="panel-conv" class="bp-panel" data-board-panel><div class="layout" id="conv-layout">
  <section class="conv">
    <div class="thread-wrap"><div class="thread-scroll" id="thread-scroll"><div class="thread" id="thread">${thread}</div></div>
      <button class="btn sm new-pill" type="button" id="new-pill" hidden>New messages ↓</button></div>
    <form class="card composer" method="post" action="/api/boards/${esc(info.id)}/entries" data-api data-done="posted" data-reset${info.archived ? " hidden" : ""}>
      <div class="cmp-field"><div class="cmp-mirror" id="composer-mirror" aria-hidden="true"></div><textarea class="input" id="composer-text" name="text" required placeholder="Write a note, question, task or decision… (Enter to post, Shift+Enter for a new line, @ to mention)" aria-label="Message"
        role="combobox" aria-autocomplete="list" aria-controls="mention-menu" aria-expanded="false"></textarea></div>
      <ul class="mention-menu" id="mention-menu" role="listbox" aria-label="Mention" hidden></ul>
      <div class="bar">
        <div class="seg" role="radiogroup" aria-label="Type">${["note", "question", "task", "decision"]
          .map((t, i) => `<input type="radio" name="type" id="ty-${t}" value="${t}"${i === 0 ? " checked" : ""}><label for="ty-${t}">${t[0].toUpperCase() + t.slice(1)}</label>`)
          .join("")}</div>
        <span class="grow"></span><button class="btn primary sm">Post</button>
      </div>
    </form>
  </section>
  <aside class="aside" id="board-info" aria-label="Board info">${agentCard(agent, info.title)}<div class="sum" id="sum">${summaryHtml(entries, viewer.name, members, undefined, ctl)}</div>
    ${
      isCreator
        ? `<div class="divider"></div><div class="stack" style="--gap:4px"><form method="post" action="/api/boards/${esc(info.id)}/archive" data-api data-done="archiveDone" style="margin:0"><input type="hidden" name="archived" value="${info.archived ? "false" : "true"}"><button class="btn ghost sm">${info.archived ? "Restore board" : "Archive board"}</button></form>
<button class="btn ghost sm danger" type="button" data-open="delete-board">Delete board…</button></div>`
        : ""
    }</aside>
</div></div>
<div role="tabpanel" id="panel-log" class="bp-panel" data-board-panel hidden><div class="list scroll-x"><table class="log"><thead><tr><th>Time (UTC)</th><th>#</th><th>Author</th><th>Type</th><th>To</th><th>Summary</th></tr></thead>
<tbody id="log-body">${rows || `<tr id="log-empty"><td colspan="6" class="empty small">No events yet.</td></tr>`}</tbody></table></div>
<p class="xs faint" style="margin-top:10px">Every entry, newest first. Click a row (or <kbd>J</kbd>/<kbd>K</kbd> then <kbd>↵</kbd>) for its raw payload.</p></div>
<div role="tabpanel" id="panel-docs" class="bp-panel" data-board-panel hidden>
  <div class="docs">
    <div class="doc-list"><div class="row" style="justify-content:space-between;margin-bottom:8px"><span class="small muted">Files</span>${info.archived ? "" : `<button class="btn sm" type="button" id="doc-new">New</button>`}</div><div id="doc-items" class="small muted">Loading…</div></div>
    <div class="doc-view card pad" id="doc-view"><p class="muted small">Pick a file, or create one, e.g. BACKLOG.md. Files posted on the board and documents are the same thing: people and agents edit them together, and every save or post is a new version.</p></div>
  </div>
</div>

${SHEET}

${connectDialog(viewer, { id: info.id, title: info.title })}

<dialog id="delete-board"><div class="hd"><div><h2>Delete ${esc(info.title)}?</h2><p class="muted small" style="margin-top:4px">This permanently deletes every entry, file, member and invitation on this board. Connected agents lose it on their next call. It can't be undone.</p></div><button class="btn ghost sm" data-close aria-label="Close">✕</button></div>
<form class="bd" method="post" action="/api/boards/${esc(info.id)}/delete" data-api data-done="deleted">
  <label class="lbl" for="del-confirm">Type <b>${esc(info.title)}</b> to confirm</label>
  <input class="input" id="del-confirm" name="confirm" autocomplete="off" required>
  <p data-result hidden style="margin-top:12px"></p>
  <div class="row" style="justify-content:flex-end;margin-top:18px"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" style="background:var(--danger);border-color:var(--danger)" id="del-go" disabled>Delete board</button></div>
</form></dialog>

<dialog id="invite"><div class="hd"><div><h2>Invite to ${esc(info.title)}</h2><p class="muted small" style="margin-top:4px">New people get a sign-up email. Everyone sees the invitation in Agent Soup and joins when they accept it, on the web or by asking their agent.</p></div><button class="btn ghost sm" data-close aria-label="Close">✕</button></div>
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
  return appPage(`${info.title} · Agent Soup`, {
    viewer,
    boards: side,
    active: info.id,
    crumbs: `<a class="muted" href="/">Boards</a><span class="faint">/</span><span class="cur truncate">${esc(info.title)}</span>`,
    actions: `<button class="btn sm" data-open="invite">Invite <kbd>I</kbd></button><button class="btn primary sm" data-open="connect">Connect an agent</button>`,
    body,
    script,
    full: true,
  });
}

// ---------- CLI login approval ----------

export function devicePage(viewer: Viewer, side: SideBoard[], code: string | null, d: { client: string; expires_at: number; status: string; created_at: number } | null): Response {
  const expired = !!d && d.expires_at < Date.now();
  let body: string;
  if (!code || !d) {
    body = `<div class="card pad" style="max-width:460px;margin:24px auto 0">
  <h1 style="font-size:20px">Sign in the Agent Soup CLI</h1>
  <p class="muted" style="margin:8px 0 18px">Enter the code shown in your terminal.</p>
  ${code ? `<p class="flash err" style="margin-bottom:14px">No sign-in is waiting for that code.</p>` : ""}
  <form method="get" action="/device"><label class="lbl" for="code">Code</label>
  <div class="row"><input class="input mono" id="code" name="code" placeholder="BCDF-GHJK" autocomplete="off" autofocus style="text-transform:uppercase;letter-spacing:.1em"><button class="btn primary">Continue</button></div></form></div>`;
  } else if (d.status !== "pending" || expired) {
    const msg = expired ? "This code expired. Run agent-soup login again." : d.status === "denied" ? "This sign-in was denied." : "This sign-in was already approved. You can go back to your terminal.";
    body = `<div class="card pad" style="max-width:460px;margin:24px auto 0;text-align:center"><h1 style="font-size:20px">${esc(code)}</h1><p class="muted" style="margin-top:8px">${esc(msg)}</p></div>`;
  } else {
    body = `<div class="card pad" style="max-width:460px;margin:24px auto 0">
  <p class="small muted">Sign-in request</p>
  <h1 style="font-size:20px;margin-top:4px">Approve the Agent Soup CLI?</h1>
  <dl class="kv" style="margin:18px 0"><dt>Device</dt><dd>${esc(d.client)}</dd><dt>Code</dt><dd class="mono">${esc(code)}</dd><dt>Signs in as</dt><dd>${esc(viewer.name)} (${esc(viewer.email)})</dd><dt>Access</dt><dd>Your boards, as you, for 30 days</dd></dl>
  <p class="small muted">Only approve if this code matches the one in your terminal and you started this sign-in yourself.</p>
  <form method="post" action="/api/device/decide" data-api data-done="decided" style="margin-top:18px">
    <input type="hidden" name="user_code" value="${esc(code)}"><input type="hidden" name="approve" id="approve" value="true">
    <div class="row" style="justify-content:flex-end"><button type="submit" class="btn" onclick="document.getElementById('approve').value='false'">Deny</button><button type="submit" class="btn primary" onclick="document.getElementById('approve').value='true'">Approve</button></div>
    <p data-result hidden style="margin-top:12px"></p>
  </form></div>`;
  }
  return appPage("Approve sign-in · Agent Soup", {
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
  return appPage("Account · Agent Soup", {
    viewer,
    boards: side,
    active: "me",
    narrow: true,
    crumbs: `<span class="cur">Account</span>`,
    body: `<div class="card pad row" style="gap:14px">${avatar(viewer.name, "lg")}
  <div class="grow"><div style="font-weight:600;color:var(--ink);font-size:15px">${esc(viewer.name)}</div><div class="small muted">${esc(viewer.email)}</div></div>
  <form method="post" action="/auth/logout"><button class="btn">Sign out</button></form></div>
<div class="section-title" style="margin-top:32px"><div><h2>Agent connections</h2><p class="small muted" style="margin-top:4px">Each connected agent has its own token. Revoke one to disconnect that agent immediately.</p></div><button class="btn sm" data-open="connect">Set up your agent</button></div>
<div class="card pad" style="margin-bottom:16px"><div class="small" style="font-weight:500;color:var(--ink);margin-bottom:8px">Reconnect your agent</div>
<p class="xs muted" style="margin-bottom:8px">Login expired, new machine, or moving off an old token: run this, approve in the browser, and start a new session.</p>${copyField("me-reconnect", CLI_STEPS.reconnect)}</div>
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
  return appPage("Ops · Agent Soup", {
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
    `${title} · Agent Soup`,
    `<div class="card pad" style="max-width:480px;margin:48px auto 0;text-align:center">
  <h1 style="font-size:20px">${esc(title)}</h1><p class="muted" style="margin-top:8px">${esc(text)}</p>
  <a class="btn primary" style="margin-top:22px" href="${esc(opts.action?.href ?? "/")}">${esc(opts.action?.label ?? "Back to Agent Soup")}</a>
</div>`,
    { viewer: opts.viewer, status: opts.status ?? 200, narrow: true },
  );
}

export function notFound(viewer?: Viewer | null): Response {
  return messagePage("Not found", "This page doesn't exist, or you don't have access to it.", { viewer, status: 404 });
}
