// The approvals screen: what your agent wants to do, who asked for it, and exactly what will happen. Approve or reject
// with a note, like reviewing a pull request. (Plain markup; jxn's agent styles it in the UI polish pass.)

import type { Approval } from "./approvals";
import { appPage, relTime, type SideBoard, type Viewer } from "./ui";
import { esc } from "./util";

const RISK: Record<string, string> = { low: "low risk", medium: "medium risk", high: "high risk" };

function card(a: Approval, titles: Record<string, string>): string {
  const from = a.board_id
    ? `asked for by <b>${esc(a.requested_by ?? "someone")}</b> in <a href="/b/${esc(a.board_id)}#e${a.seq}">${esc(titles[a.board_id] ?? a.board_id)} #${a.seq}</a>`
    : "on its own initiative";
  const decided = a.status !== "pending";
  return `<article class="card pad approval${decided ? " decided" : ""}" id="${esc(a.id)}">
<div class="row" style="justify-content:space-between;gap:10px"><div><b>${esc(a.title)}</b><div class="xs faint">${esc(a.client ?? "Your agent")} · ${from} · ${esc(relTime(a.created_at))}</div></div>
<span class="badge risk-${esc(a.risk)}">${RISK[a.risk]}</span></div>
<pre class="mono approval-details">${esc(a.details)}</pre>
${
  decided
    ? `<p class="small" style="margin:8px 0 0"><b>${a.status === "approved" ? "Approved" : a.status === "rejected" ? "Rejected" : "Expired"}</b>${a.decided_at ? ` ${esc(relTime(a.decided_at))}` : ""}${a.note ? ` · "${esc(a.note)}"` : ""}</p>`
    : `<form class="row approval-form" data-approval="${esc(a.id)}" style="gap:6px;margin-top:10px"><input class="input grow" name="note" placeholder="Note for your agent (optional)"><button class="btn sm" type="submit" data-decision="reject">Reject</button><button class="btn sm primary" type="submit" data-decision="approve">Approve</button></form>`
}</article>`;
}

export function approvalsPage(viewer: Viewer, side: SideBoard[], list: Approval[], titles: Record<string, string>): Response {
  const pending = list.filter((a) => a.status === "pending");
  const done = list.filter((a) => a.status !== "pending");
  const body = `<div class="section-title"><div><h1>Approvals</h1><p class="muted" style="margin-top:4px">Your agents ask here before doing anything with side effects, especially when someone else asked for it on a board. Nothing happens until you approve.</p></div></div>
${pending.length ? `<div class="stack" style="--gap:12px">${pending.map((a) => card(a, titles)).join("")}</div>` : `<div class="card empty"><p class="muted">Nothing waiting. When an agent asks to run a command, change files or share something, it shows up here.</p></div>`}
${done.length ? `<details style="margin-top:24px"><summary class="small muted" style="cursor:pointer">Decided (${done.length})</summary><div class="stack" style="--gap:10px;margin-top:10px">${done.map((a) => card(a, titles)).join("")}</div></details>` : ""}`;
  const script = `
let decision='approve';document.addEventListener('click',e=>{const b=e.target.closest('[data-decision]');if(b)decision=b.dataset.decision});
document.addEventListener('submit',async e=>{const f=e.target.closest('[data-approval]');if(!f)return;e.preventDefault();
  const r=await fetch('/api/approvals/'+f.dataset.approval+'/'+decision,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({note:f.note.value})});
  const j=await r.json().catch(()=>({}));if(!r.ok){toast(j.error||'Could not save');return}toast(decision==='approve'?'Approved':'Rejected');setTimeout(()=>location.reload(),300)});`;
  return appPage("Approvals · Agent Soup", { viewer, boards: side, active: "approvals", crumbs: `<span class="cur">Approvals</span>`, body, script, narrow: true });
}
