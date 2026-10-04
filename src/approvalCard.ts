// An approval as a card in place (the conversation and the Inbox): the exact tool and command, where it stands, and
// Approve / Deny for the one person it was asked of. Everyone else on the board sees the same card without the buttons.

import { esc } from "./util";

/** The fields a card needs (an Approval, or the `approval` a board entry carries). */
export interface ApprovalCardData {
  id: string;
  user: string;
  status: "pending" | "approved" | "rejected" | "expired" | string;
  tool?: string | null;
  command?: string | null;
  risk?: string | null;
  note?: string | null;
  expires_at?: number | null;
}

const isPending = (a: ApprovalCardData) => a.status === "pending" && !(a.expires_at && a.expires_at < Date.now());

/** Where it stands, in words. `mine`: the viewer is the person asked. */
export function approvalLabel(a: ApprovalCardData, mine: boolean): string {
  if (isPending(a)) return mine ? "Waiting on you" : `Waiting on ${a.user}`;
  if (a.status === "approved") return "Approved";
  if (a.status === "rejected") return "Denied";
  return "Timed out, denied";
}

/**
 * `mine` is known on the server for the Inbox; in the conversation the page decides (APPROVAL_JS), so the card is
 * rendered for everyone with the buttons hidden.
 */
export function approvalCardHtml(a: ApprovalCardData, mine = false): string {
  const pending = isPending(a);
  const st = pending ? "pending" : a.status === "approved" ? "approved" : a.status === "rejected" ? "rejected" : "expired";
  const risk = a.risk === "high" ? `<span class="apc-risk">High risk</span>` : "";
  // The tool and the risk head the command; the command itself is verbatim.
  const head = [a.tool ? `<span class="faint">${esc(a.tool)}</span>` : "", risk].filter(Boolean).join(`<span class="faint"> · </span>`);
  const cmd = a.command ? `<pre class="mono apc-cmd">${head ? `${head}\n` : ""}${esc(a.command)}</pre>` : "";
  const acts = pending
    ? `<span class="apc-acts"${mine ? "" : " hidden"}><span class="apc-kbd xs faint" aria-hidden="true"><kbd>↵</kbd> approve · <kbd>⌫</kbd> deny</span><button class="btn ghost sm" type="button" data-apc-do="reject">Deny</button><button class="btn sm primary" type="button" data-apc-do="approve">Approve</button></span>`
    : "";
  return `<div class="apc st-${st}" data-apc="${esc(a.id)}" data-apc-user="${esc(a.user)}">${cmd}<div class="tk"><span class="tk-st"><span class="dot"></span><span class="apc-lbl">${esc(
    approvalLabel(a, mine),
  )}</span></span>${a.command ? "" : risk}<span class="grow"></span>${acts}</div>${a.note ? `<p class="xs muted apc-note">Note: ${esc(a.note)}</p>` : ""}</div>`;
}

/**
 * Page script (needs toast): shows the buttons to the person asked (`me`, the viewer), decides in place, and applies a
 * decision that arrives live (window.apcApply(approval), from the board's "approval" event).
 */
export const approvalJs = (me: string): string => `
(()=>{const ME=${JSON.stringify(me).replace(/</g, "\\u003c")};const lbl=(a,mine)=>a.status==='pending'?(mine?'Waiting on you':'Waiting on '+a.user):a.status==='approved'?'Approved':a.status==='rejected'?'Denied':'Timed out, denied';
function mark(root){(root||document).querySelectorAll('.apc.st-pending').forEach(c=>{if(c.dataset.apcUser!==ME)return;const s=c.querySelector('.apc-acts');if(s)s.hidden=false;const l=c.querySelector('.apc-lbl');if(l)l.textContent='Waiting on you';
  c.tabIndex=0;c.setAttribute('aria-keyshortcuts','Enter Backspace');c.setAttribute('aria-label','Approval waiting on you: Enter approves, Backspace denies')})}
function apply(a){if(!a||!a.id)return;document.querySelectorAll('.apc[data-apc="'+a.id+'"]').forEach(c=>{const st=a.status==='pending'?'pending':a.status==='approved'?'approved':a.status==='rejected'?'rejected':'expired';
  c.className='apc st-'+st;const l=c.querySelector('.apc-lbl');if(l)l.textContent=lbl(a,a.user===ME);if(st!=='pending'){c.querySelector('.apc-acts')?.remove();c.removeAttribute('tabindex');c.removeAttribute('aria-keyshortcuts');c.removeAttribute('aria-label')}
  if(a.note&&!c.querySelector('.apc-note')){const p=document.createElement('p');p.className='xs muted apc-note';p.textContent='Note: '+a.note;c.appendChild(p)}})}
window.apcMark=mark;window.apcApply=apply;mark();
document.addEventListener('click',async e=>{const b=e.target.closest('[data-apc-do]');if(!b)return;e.preventDefault();e.stopPropagation();const c=b.closest('.apc');
  c.querySelectorAll('[data-apc-do]').forEach(x=>x.disabled=true);
  const r=await fetch('/api/approvals/'+encodeURIComponent(c.dataset.apc)+'/'+b.dataset.apcDo,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  const j=await r.json().catch(()=>({}));
  if(!r.ok){toast(j.error||'Could not save');c.querySelectorAll('[data-apc-do]').forEach(x=>x.disabled=false);return}
  apply(j.approval||{id:c.dataset.apc,user:ME,status:b.dataset.apcDo==='approve'?'approved':'rejected'});toast(b.dataset.apcDo==='approve'?'Approved':'Denied')},true);
// Keyboard (from the Conductor notes, #1276): Enter approves and Backspace denies the card that has focus, or the one in
// the message selected with J/K. Never a global key, never while typing; a high-risk one asks first. Where the page has
// no J/K of its own (the Inbox), J/K moves between the cards waiting on you.
const mine=c=>c&&c.classList.contains('st-pending')&&c.dataset.apcUser===ME&&!!c.querySelector('.apc-acts:not([hidden])');
document.addEventListener('keydown',e=>{if(e.metaKey||e.ctrlKey||e.altKey||e.shiftKey||e.isComposing)return;const t=e.target;
  if(t.closest&&t.closest('input,textarea,select,[contenteditable]'))return;if(document.querySelector('dialog[open]'))return;
  if(!window.boardKeys&&(e.key==='j'||e.key==='k')){const cs=[...document.querySelectorAll('.apc')].filter(mine);if(!cs.length)return;e.preventDefault();
    let i=cs.findIndex(c=>c.classList.contains('kbd-sel'));i=i<0?0:Math.max(0,Math.min(cs.length-1,i+(e.key==='j'?1:-1)));
    cs.forEach(c=>c.classList.remove('kbd-sel'));cs[i].classList.add('kbd-sel');cs[i].focus();return}
  if(e.key!=='Enter'&&e.key!=='Backspace')return;
  if(e.key==='Enter'&&t.closest&&t.closest('button,a,summary'))return; // a focused button or link: Enter presses it
  const c=(t.closest&&t.closest('.apc'))||document.querySelector('#thread .entry.sel .apc.st-pending, .apc.kbd-sel');if(!mine(c))return;
  const b=c.querySelector('[data-apc-do="'+(e.key==='Enter'?'approve':'reject')+'"]');if(!b||b.disabled)return;
  e.preventDefault();e.stopPropagation();
  if(e.key==='Enter'&&c.querySelector('.apc-risk')&&!confirm('This one is high risk. Approve it?'))return;
  b.click()},true);
})();`;
