// The board's pinned doc and its Recap (vedu #977, #980): markup and the client code for the board page.
//
// Pinned doc: one board file pinned as the board's source of truth. It shows as a slim bar at the top of the
// conversation and as the first section of the side panel (a short preview), and the file viewer pins or unpins it.
// Recap: a button in the board header opens a sheet with what happened since you last looked: decisions, open
// questions, and who owes what. Both read the server's API (GET/POST/DELETE /api/boards/:id/pin, GET
// /api/boards/:id/recap?since=N); while a server doesn't have them yet, the pin stays hidden and Recap says so.

const PIN_ICON = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.8 2.2l4 4-2.1.7-2.6 2.6-.4 3-5.3-5.3 3-.4 2.6-2.6z"/><path d="M5.6 10.4 2.2 13.8"/></svg>`;

/** The bar at the top of the conversation (filled in by the client). */
export const PIN_BAR = `<div class="pin-bar" id="pin-bar" hidden><button class="pin-open" type="button" id="pin-open" title="Open the pinned file">${PIN_ICON}<span class="pin-name mono truncate" id="pin-name"></span><span class="pin-peek truncate" id="pin-peek"></span></button></div>`;

/** The side panel's first section (filled in by the client; folds like the others). */
export const PIN_SIDE = `<div class="ag pin-side" id="pin-side" hidden></div>`;

/** The Recap button for the board header (hidden until the server's API answers). */
export const RECAP_BTN = `<button class="btn ghost sm recap-btn" type="button" id="recap-btn" aria-haspopup="dialog" hidden title="What happened since you last looked"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M3 4h10M3 8h7M3 12h5"/></svg><span class="recap-l">Recap</span><span class="recap-dot" id="recap-dot" hidden></span></button>`;

/** The Recap sheet. */
export const RECAP_DLG = `<dialog class="recap-dlg" id="recap-dlg" aria-labelledby="recap-title"><div class="hd"><div><h2 id="recap-title">Recap</h2><p class="small muted" id="recap-sub" style="margin-top:4px"></p></div><button class="btn ghost sm" type="button" data-close aria-label="Close">✕</button></div><div class="bd" id="recap-body"></div></dialog>`;

/**
 * The client code. `lastSeen` is how far the viewer had read when the page was served: reading the board moves it
 * on at once, so the recap keeps the value from before this visit.
 */
export function pinRecapJs(lastSeen: number, canPin: boolean): string {
  return `
// ---- pinned doc: a bar on top of the conversation, a section in the side panel, Pin/Unpin in the file viewer ----
let PIN=null,PIN_API=false;const CAN_PIN=${canPin ? "true" : "false"};
const pinBy=p=>p.via==='agent'?p.by+"'s agent":p.by;
function pinNorm(j){const p=j&&(j.pinned!==undefined?j.pinned:j.pin);if(!p||!p.name)return null;return {name:p.name,version:p.version||null,by:p.by||p.pinned_by||p.updated_by||'',via:p.via||'person',ts:p.ts||p.pinned_at||null}}
window.pinRefresh=async()=>{let r;try{r=await fetch('/api/boards/'+BOARD+'/pin')}catch(e){return}
  if(r.status===404||r.status===405){PIN_API=false;PIN=null;pinRender(null);return}if(!r.ok)return;PIN_API=true;
  // The pin and the recap arrive together on the server: Recap shows once the pin API answers.
  const rb=document.getElementById('recap-btn');if(rb)rb.hidden=false;
  PIN=pinNorm(await r.json().catch(()=>null));let doc=null;
  if(PIN){const d=await fetch('/api/boards/'+BOARD+'/doc?name='+encodeURIComponent(PIN.name)).catch(()=>null);if(d&&d.ok)doc=await d.json().catch(()=>null)}
  pinRender(doc);if(typeof curDoc!=='undefined'&&curDoc)pinSlot(curDoc)};
function pinRender(doc){const bar=document.getElementById('pin-bar'),side=document.getElementById('pin-side');if(!bar||!side)return;
  if(!PIN){bar.hidden=true;side.hidden=true;side.innerHTML='';return}
  // The preview: the doc's first heading or line, without markdown marks.
  const lines=String(doc&&doc.content||'').split('\\n').map(l=>l.replace(/^[#>*\\-\\s]+/,'').trim()).filter(Boolean);
  document.getElementById('pin-name').textContent=PIN.name;document.getElementById('pin-peek').textContent=lines[0]||'';bar.hidden=false;
  const meta=(doc&&doc.version?'v'+doc.version+' · ':'')+'edited by '+esc(doc?(doc.via==='agent'?doc.updated_by+"'s agent":doc.updated_by):pinBy(PIN));
  const body=doc?(doc.media?'<img class="pin-img" alt="" src="/api/boards/'+BOARD+'/image?name='+encodeURIComponent(doc.name)+'&version='+doc.version+'">':'<div class="pin-prev body">'+doc.html+'</div>'):'<p class="none">This file is gone. Pin another from Files.</p>';
  side.innerHTML='<section class="fold" data-fold="pinned"><h3><button type="button" class="fold-h" aria-expanded="true" aria-controls="fold-pinned"><svg class="fold-c" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 3l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="fold-t">Pinned</span><span class="faint fold-n"></span><span class="fold-peek truncate">'+esc(PIN.name)+'</span></button></h3>'+
    '<div class="fold-b" id="fold-pinned"><button class="pin-card" type="button" data-pin-open><span class="row" style="gap:6px;min-width:0">${PIN_ICON}<b class="mono truncate">'+esc(PIN.name)+'</b></span><span class="xs faint">'+meta+'</span>'+body+'</button></div></section>';
  side.hidden=false;if(typeof foldApply==='function')foldApply()}
function pinOpen(){if(!PIN)return;if(typeof infoOpen==='function')infoOpen(false);window.BOARD_CTX.openFile(PIN.name)}
document.getElementById('pin-open')?.addEventListener('click',pinOpen);
document.addEventListener('click',e=>{if(e.target.closest('[data-pin-open]')){e.preventDefault();pinOpen()}});
/** The file viewer's Pin / Unpin (people who can post; not for an older version). */
function pinSlot(d){const s=document.getElementById('doc-pin-slot');if(!s)return;
  if(!PIN_API||!CAN_PIN||!d||d.version!==d.latest){s.innerHTML='';return}const on=!!PIN&&PIN.name===d.name;
  s.innerHTML='<button class="btn sm ghost'+(on?' on':'')+'" type="button" id="doc-pin" aria-pressed="'+on+'" title="'+(on?'Unpin it from the top of the board':'Pin it to the top of the board as its source of truth')+'">${PIN_ICON}<span>'+(on?'Unpin':'Pin')+'</span></button>'}
window.pinSlot=pinSlot;
document.addEventListener('click',async e=>{const b=e.target.closest('#doc-pin');if(!b||!curDoc)return;b.disabled=true;const on=b.getAttribute('aria-pressed')==='true';
  const r=await fetch('/api/boards/'+BOARD+'/pin',on?{method:'DELETE'}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:curDoc.name})}).catch(()=>null);
  const j=r?await r.json().catch(()=>({})):{};if(!r||!r.ok){toast(j.error||(on?"Couldn't unpin it":"Couldn't pin it"));b.disabled=false;return}
  toast(on?'Unpinned':'Pinned to the top of the board');await pinRefresh()});
pinRefresh();

// ---- Recap: what happened since you last looked (decisions, open questions, who owes what) ----
const RECAP_SINCE=${Number.isFinite(lastSeen) ? Math.max(0, Math.floor(lastSeen)) : 0};
const rcDlg=document.getElementById('recap-dlg'),rcBody=document.getElementById('recap-body'),rcSub=document.getElementById('recap-sub');
const rcWho=x=>x.via==='agent'||x.agent?(x.session?x.author+'/'+x.session:x.author+"'s agent"):x.author;
const rcTime=ts=>{if(!ts)return '';const s=(Date.now()-ts)/1000;return s<60?'just now':s<3600?Math.floor(s/60)+'m ago':s<86400?Math.floor(s/3600)+'h ago':Math.floor(s/86400)+'d ago'};
function rcItem(x,line){return '<li><a href="#e'+x.seq+'" data-recap-go="'+x.seq+'"><span class="rc-t">'+esc(x.title||x.text||'(untitled)')+'</span><span class="rc-m xs faint">'+line+'</span></a></li>'}
function rcSec(title,items,empty){return '<section class="rc-sec"><h3>'+title+(items.length?' <span class="faint">'+items.length+'</span>':'')+'</h3>'+(items.length?'<ul>'+items.join('')+'</ul>':'<p class="xs faint">'+empty+'</p>')+'</section>'}
function rcRender(j,since){
  const dec=(j.decisions||[]).map(x=>rcItem(x,esc(rcWho(x))+(x.ts?' · '+rcTime(x.ts):'')));
  const qs=(j.questions||j.open_questions||[]).map(x=>rcItem(x,esc(rcWho(x))+(x.to?' → '+esc(x.to):'')+(x.ts?' · '+rcTime(x.ts):'')));
  const owed=(j.owed||j.owes||[]).filter(o=>(o.items||[]).length);
  const KIND={task:'task',question:'question',review:'review',approval:'approval'};
  const ow=owed.length?'<section class="rc-sec"><h3>Who owes what</h3>'+owed.map(o=>{const nm=o.agent?(o.session?o.who+'/'+o.session:o.who+"'s agent"):o.who;
    return '<div class="rc-owe"><div class="rc-owe-h">'+(typeof avatar16==='function'?avatar16(o.who,!!o.agent):'')+'<b>'+esc(o.who===ME&&!o.agent?'You':nm)+'</b><span class="faint xs">'+o.items.length+'</span></div><ul>'+
      o.items.map(x=>rcItem(x,esc(KIND[x.kind]||x.kind||'task')+(x.status?' · '+esc(x.status):''))).join('')+'</ul></div>'}).join('')+'</section>':rcSec('Who owes what',[],'Nobody owes anything open.');
  const n=j.count!=null?j.count:j.new_count;
  rcSub.textContent=since>0?(n!=null?n+' new message'+(n===1?'':'s')+' since you last looked':'Since you last looked'):'The whole board';
  const nothing=!dec.length&&!qs.length&&!owed.length;
  rcBody.innerHTML=(nothing&&since>0?'<p class="small muted rc-none">Nothing new since you last looked. <button class="linkish" type="button" data-recap-all>Recap the whole board</button></p>':'')+
    (nothing&&since>0?'':rcSec('Decisions',dec,'No new decisions.')+rcSec('Open questions',qs,'No open questions.')+ow)}
async function rcOpen(since){rcSub.textContent='Loading…';rcBody.innerHTML='<p class="small muted">Loading…</p>';if(!rcDlg.open)rcDlg.showModal();
  let r;try{r=await fetch('/api/boards/'+BOARD+'/recap'+(since>0?'?since='+since:''))}catch(e){r=null}
  if(!r||r.status===404||r.status===405){rcSub.textContent='';rcBody.innerHTML='<p class="small muted">Recap isn\\'t available on this server yet.</p>';return}
  const j=await r.json().catch(()=>({}));if(!r.ok){rcSub.textContent='';rcBody.innerHTML='<p class="flash err">'+esc(j.error||"Couldn't load the recap")+'</p>';return}
  rcRender(j,since)}
document.getElementById('recap-btn')?.addEventListener('click',()=>{const dot=document.getElementById('recap-dot');if(dot)dot.hidden=true;rcOpen(RECAP_SINCE)});
rcDlg?.addEventListener('click',e=>{if(e.target===rcDlg||e.target.closest('[data-close]')){rcDlg.close();return}
  if(e.target.closest('[data-recap-all]')){rcOpen(0);return}
  const a=e.target.closest('[data-recap-go]');if(a){e.preventDefault();rcDlg.close();window.BOARD_CTX.jump(+a.dataset.recapGo)}});
// A dot on Recap when there's something newer than where you'd read up to.
{const dot=document.getElementById('recap-dot');if(dot)dot.hidden=!(RECAP_SINCE>0&&last>RECAP_SINCE)}
`;
}
