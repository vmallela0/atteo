// The approvals screen: what your agent wants to do, who asked for it, and exactly what will happen. Approve or reject
// with a note, like reviewing a pull request.

import { shownDetails, type Approval } from "./approvals";
import { appPage, relTime, type SideBoard, type Viewer } from "./ui";
import { esc } from "./util";
import { commandHtml, nonAsciiNote } from "./approvalCard";
import { tr, type Lang } from "./i18n";
import { ruleName } from "./approvalRules";

type Tr = (s: string, v?: Record<string, string | number>) => string;

const RISK: Record<string, string> = { low: "Low risk", medium: "Medium risk", high: "High risk" };
const STATUS: Record<string, string> = { approved: "Approved", rejected: "Denied", expired: "Denied (timed out)" };

// From a permission hook: the tool and its exact command or file, verbatim (escaped, monospace).
// The command in full (never clipped), with any non-ASCII character flagged so a look-alike can't pass for plain text (#4929).
const cmd = (a: Approval): string => (a.command ? `<pre class="mono ap-details ap-cmd">${a.tool ? `<span class="faint">${esc(a.tool)}</span>\n` : ""}${commandHtml(a.command)}</pre>${nonAsciiNote(a.command)}` : "");
const det = (a: Approval): string => (a.details ? `<pre class="mono ap-details">${esc(shownDetails(a.details))}</pre>` : "");
// Whose agent asked: someone else's is named, never "Your agent" (#4930).
const asker = (a: Approval, T: Tr): string => (a.requested_by && a.requested_by !== a.user ? T("{name}'s agent", { name: a.requested_by }) : a.client ?? T("Your agent"));

function origin(a: Approval, titles: Record<string, string>, T: Tr): string {
  const where = esc(titles[a.board_id ?? ""] ?? a.board_id ?? "");
  return a.board_id
    ? `${esc(T("asked by"))} <b>${esc(a.requested_by ?? T("someone"))}</b> ${esc(T("in"))} ${a.seq != null ? `<a href="/b/${esc(a.board_id)}#e${a.seq}">${where} #${a.seq}</a>` : `<a href="/b/${esc(a.board_id)}">${where}</a>`}`
    : esc(T("on its own"));
}

// A waiting request: what, who asked and where, exactly what will happen, then a note and the two buttons.
function pendingCard(a: Approval, titles: Record<string, string>, T: Tr, L?: Lang): string {
  return `<article class="card approval risk-${esc(a.risk)}" id="${esc(a.id)}" tabindex="0" aria-keyshortcuts="Enter Backspace" aria-label="${esc(`${a.title}. ${T("Enter approves, Backspace denies")}`)}">
<div class="ap-hd"><div class="grow"><h2 class="ap-title">${esc(a.title)}</h2><p class="xs muted">${esc(asker(a, T))} · ${origin(a, titles, T)} · ${esc(relTime(a.created_at, Date.now(), L))}</p></div>
<span class="badge ap-risk">${RISK[a.risk] ? esc(T(RISK[a.risk])) : esc(a.risk)}</span></div>
${cmd(a)}${det(a)}
<form class="ap-form" data-approval="${esc(a.id)}"><input class="input grow" name="note" placeholder="${esc(T("Note for your agent (optional)"))}" aria-label="${esc(T("Note for your agent"))}"><button class="btn" type="submit" data-decision="reject">${esc(T("Reject"))}</button><button class="btn primary" type="submit" data-decision="approve">${esc(T("Approve"))}</button></form>
</article>`;
}

// A decided one: one line, with the details a click away.
function decidedRow(a: Approval, titles: Record<string, string>, T: Tr, L?: Lang): string {
  return `<li><details class="ap-row"><summary><span class="ap-st st-${esc(a.status)}">${a.rule_name ? esc(T("Approved by rule")) : STATUS[a.status] ? esc(T(STATUS[a.status])) : esc(a.status)}</span><span class="grow truncate">${esc(a.title)}</span><span class="xs faint">${esc(relTime(a.decided_at ?? a.created_at, Date.now(), L))}</span></summary>
<p class="xs muted">${esc(asker(a, T))} · ${origin(a, titles, T)}${a.rule_name ? ` · ${esc(ruleName(L, a.rule_name))} (${esc(T("set by"))} ${esc(a.rule_set_by ?? "")})` : a.note ? ` · ${esc(T("your note:"))} "${esc(a.note)}"` : ""}</p>${cmd(a)}${det(a)}</details></li>`;
}

export function approvalsPage(viewer: Viewer, side: SideBoard[], list: Approval[], titles: Record<string, string>): Response {
  const L = viewer.lang,
    T: Tr = (x, v) => tr(L, x, v);
  const pending = list.filter((a) => a.status === "pending");
  const done = list.filter((a) => a.status !== "pending");
  const body = `<div class="section-title"><div><h1>${esc(T("Approvals"))}</h1><p class="muted" style="margin-top:4px">${esc(T("Your agent asks here before side effects. Board rules can approve or block categorized work; other requests wait for you."))}</p></div></div>
${pending.length ? `<p class="xs faint ap-keys"><kbd>J</kbd> <kbd>K</kbd> ${esc(T("pick a request"))} · <kbd>↵</kbd> ${esc(T("approve"))} · <kbd>⌫</kbd> ${esc(T("deny"))}</p><div class="stack" style="--gap:12px">${pending.map((a) => pendingCard(a, titles, T, L)).join("")}</div>` : `<div class="card empty"><p class="muted">${esc(T("Nothing waiting. When an agent asks to run a command, change files or share something, it shows up here."))}</p></div>`}
${done.length ? `<h3 class="ap-sub">${esc(T("Decided"))} <span class="faint">${done.length}</span></h3><ul class="card ap-done">${done.map((a) => decidedRow(a, titles, T, L)).join("")}</ul>` : ""}`;
  const script = `
let decision='approve';document.addEventListener('click',e=>{const b=e.target.closest('[data-decision]');if(b)decision=b.dataset.decision});
document.addEventListener('submit',async e=>{const f=e.target.closest('[data-approval]');if(!f)return;e.preventDefault();
  const r=await fetch('/api/approvals/'+f.dataset.approval+'/'+decision,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({note:f.note.value})});
  const j=await r.json().catch(()=>({}));if(!r.ok){toast(j.error||tr('Could not save'));return}toast(decision==='approve'?tr('Approved'):tr('Rejected'));setTimeout(()=>location.reload(),300)});
// Keyboard (Conductor notes, #1276): J/K picks a request; Enter approves and Backspace denies the picked or focused one
// (never while typing a note); a high-risk one asks first.
document.addEventListener('keydown',e=>{if(e.metaKey||e.ctrlKey||e.altKey||e.shiftKey||e.isComposing)return;const t=e.target;
  if(t.closest('input,textarea,select,[contenteditable]')||document.querySelector('dialog[open]'))return;const cs=[...document.querySelectorAll('.approval')];if(!cs.length)return;
  if(e.key==='j'||e.key==='k'){e.preventDefault();let i=cs.findIndex(c=>c.classList.contains('sel'));i=i<0?0:Math.max(0,Math.min(cs.length-1,i+(e.key==='j'?1:-1)));
    cs.forEach(c=>c.classList.remove('sel'));cs[i].classList.add('sel');cs[i].focus();cs[i].scrollIntoView({block:'nearest'});return}
  if(e.key!=='Enter'&&e.key!=='Backspace')return;if(e.key==='Enter'&&t.closest('button,a,summary'))return;
  const c=t.closest('.approval')||document.querySelector('.approval.sel');if(!c)return;const b=c.querySelector('[data-decision="'+(e.key==='Enter'?'approve':'reject')+'"]');if(!b)return;
  e.preventDefault();e.stopPropagation();if(e.key==='Enter'&&c.classList.contains('risk-high')&&!confirm(tr('This one is high risk. Approve it?')))return;b.click()},true);`;
  return appPage(`${T("Approvals")} · Atteo`, { viewer, boards: side, active: "approvals", crumbs: `<span class="cur">${esc(T("Approvals"))}</span>`, body, script, narrow: true });
}
