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
    ? `<span class="apc-acts"${mine ? "" : " hidden"}><button class="btn ghost sm" type="button" data-apc-do="reject">Deny</button><button class="btn sm primary" type="button" data-apc-do="approve">Approve</button></span>`
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
function mark(root){(root||document).querySelectorAll('.apc.st-pending').forEach(c=>{if(c.dataset.apcUser!==ME)return;const s=c.querySelector('.apc-acts');if(s)s.hidden=false;const l=c.querySelector('.apc-lbl');if(l)l.textContent='Waiting on you'})}
function apply(a){if(!a||!a.id)return;document.querySelectorAll('.apc[data-apc="'+a.id+'"]').forEach(c=>{const st=a.status==='pending'?'pending':a.status==='approved'?'approved':a.status==='rejected'?'rejected':'expired';
  c.className='apc st-'+st;const l=c.querySelector('.apc-lbl');if(l)l.textContent=lbl(a,a.user===ME);if(st!=='pending')c.querySelector('.apc-acts')?.remove();
  if(a.note&&!c.querySelector('.apc-note')){const p=document.createElement('p');p.className='xs muted apc-note';p.textContent='Note: '+a.note;c.appendChild(p)}})}
window.apcMark=mark;window.apcApply=apply;mark();
document.addEventListener('click',async e=>{const b=e.target.closest('[data-apc-do]');if(!b)return;e.preventDefault();e.stopPropagation();const c=b.closest('.apc');
  c.querySelectorAll('[data-apc-do]').forEach(x=>x.disabled=true);
  const r=await fetch('/api/approvals/'+encodeURIComponent(c.dataset.apc)+'/'+b.dataset.apcDo,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  const j=await r.json().catch(()=>({}));
  if(!r.ok){toast(j.error||'Could not save');c.querySelectorAll('[data-apc-do]').forEach(x=>x.disabled=false);return}
  apply(j.approval||{id:c.dataset.apc,user:ME,status:b.dataset.apcDo==='approve'?'approved':'rejected'});toast(b.dataset.apcDo==='approve'?'Approved':'Denied')},true)})();`;
