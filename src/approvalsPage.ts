// The approvals screen: what your agent wants to do, who asked for it, and exactly what will happen. Approve or reject
// with a note, like reviewing a pull request.

import type { Approval } from "./approvals";
import { appPage, relTime, type SideBoard, type Viewer } from "./ui";
import { esc } from "./util";

const RISK: Record<string, string> = { low: "Low risk", medium: "Medium risk", high: "High risk" };
const STATUS: Record<string, string> = { approved: "Approved", rejected: "Denied", expired: "Denied (timed out)" };

// From a permission hook: the tool and its exact command or file, verbatim (escaped, monospace).
const cmd = (a: Approval): string => (a.command ? `<pre class="mono ap-details ap-cmd">${a.tool ? `<span class="faint">${esc(a.tool)}</span>\n` : ""}${esc(a.command)}</pre>` : "");
const det = (a: Approval): string => (a.details ? `<pre class="mono ap-details">${esc(a.details)}</pre>` : "");

function origin(a: Approval, titles: Record<string, string>): string {
  return a.board_id
    ? `asked by <b>${esc(a.requested_by ?? "someone")}</b> in <a href="/b/${esc(a.board_id)}#e${a.seq}">${esc(titles[a.board_id] ?? a.board_id)} #${a.seq}</a>`
    : "on its own";
}

// A waiting request: what, who asked and where, exactly what will happen, then a note and the two buttons.
function pendingCard(a: Approval, titles: Record<string, string>): string {
  return `<article class="card approval risk-${esc(a.risk)}" id="${esc(a.id)}">
<div class="ap-hd"><div class="grow"><h2 class="ap-title">${esc(a.title)}</h2><p class="xs muted">${esc(a.client ?? "Your agent")} · ${origin(a, titles)} · ${esc(relTime(a.created_at))}</p></div>
<span class="badge ap-risk">${RISK[a.risk] ?? esc(a.risk)}</span></div>
${cmd(a)}${det(a)}
<form class="ap-form" data-approval="${esc(a.id)}"><input class="input grow" name="note" placeholder="Note for your agent (optional)" aria-label="Note for your agent"><button class="btn" type="submit" data-decision="reject">Reject</button><button class="btn primary" type="submit" data-decision="approve">Approve</button></form>
</article>`;
}

// A decided one: one line, with the details a click away.
function decidedRow(a: Approval, titles: Record<string, string>): string {
  return `<li><details class="ap-row"><summary><span class="ap-st st-${esc(a.status)}">${STATUS[a.status] ?? esc(a.status)}</span><span class="grow truncate">${esc(a.title)}</span><span class="xs faint">${esc(relTime(a.decided_at ?? a.created_at))}</span></summary>
<p class="xs muted">${esc(a.client ?? "Your agent")} · ${origin(a, titles)}${a.note ? ` · your note: "${esc(a.note)}"` : ""}</p>${cmd(a)}${det(a)}</details></li>`;
}

export function approvalsPage(viewer: Viewer, side: SideBoard[], list: Approval[], titles: Record<string, string>): Response {
  const pending = list.filter((a) => a.status === "pending");
  const done = list.filter((a) => a.status !== "pending");
  const body = `<div class="section-title"><div><h1>Approvals</h1><p class="muted" style="margin-top:4px">Your agent asks here before anything with side effects, especially when someone else asked for it on a board. Nothing happens until you approve.</p></div></div>
${pending.length ? `<div class="stack" style="--gap:12px">${pending.map((a) => pendingCard(a, titles)).join("")}</div>` : `<div class="card empty"><p class="muted">Nothing waiting. When an agent asks to run a command, change files or share something, it shows up here.</p></div>`}
${done.length ? `<h3 class="ap-sub">Decided <span class="faint">${done.length}</span></h3><ul class="card ap-done">${done.map((a) => decidedRow(a, titles)).join("")}</ul>` : ""}`;
  const script = `
let decision='approve';document.addEventListener('click',e=>{const b=e.target.closest('[data-decision]');if(b)decision=b.dataset.decision});
document.addEventListener('submit',async e=>{const f=e.target.closest('[data-approval]');if(!f)return;e.preventDefault();
  const r=await fetch('/api/approvals/'+f.dataset.approval+'/'+decision,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({note:f.note.value})});
  const j=await r.json().catch(()=>({}));if(!r.ok){toast(j.error||'Could not save');return}toast(decision==='approve'?'Approved':'Rejected');setTimeout(()=>location.reload(),300)});`;
  return appPage("Approvals · Atteo", { viewer, boards: side, active: "approvals", crumbs: `<span class="cur">Approvals</span>`, body, script, narrow: true });
}
