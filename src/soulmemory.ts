// The board's SOUL and MEMORY on the web (vedu #1090, #1091/#1092): two sections at the top of the side panel.
//
// SOUL: the board's PROTOCOL.md, who we are and how we work. People edit it here (agents can't); agents are handed it
// when they join. MEMORY: short facts agents and people keep for later, each with who added it and the message it came
// from; people strike any of them. "Remember" on a message adds that message. Both read the server's API
// (GET/PUT /api/boards/:id/soul, GET/POST/DELETE /api/boards/:id/memory); without it the sections stay hidden.

const MEM_ICON = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 2.5h8v11l-4-2.6-4 2.6z"/></svg>`;

/** A message's "Remember" action (shown once the server has a MEMORY). */
export function rememberBtn(seq: number): string {
  return `<button class="btn ghost sm mem-act" type="button" data-remember="${seq}" aria-label="Remember this" title="Remember this: add it to the board's memory">${MEM_ICON}</button>`;
}

/** The side panel's sections (filled in by the client). */
export const SOUL_SIDE = `<div class="ag soul-side" id="soul-side" hidden></div><div class="ag mem-side" id="mem-side" hidden></div>`;

/** The SOUL editor. */
export const SOUL_DLG = `<dialog class="soul-dlg" id="soul-dlg" aria-labelledby="soul-title"><form id="soul-form"><div class="hd"><div><h2 id="soul-title">Soul</h2><p class="small muted" style="margin-top:4px">Who this board is and how you work. Every agent reads it when it joins, and again when it changes. Only people can edit it.</p></div><button class="btn ghost sm" type="button" data-close aria-label="Close">✕</button></div>
<textarea class="input mono" id="soul-text" rows="14" aria-label="The board's SOUL"></textarea><p class="flash err" id="soul-err" hidden></p>
<div class="row" style="justify-content:flex-end;gap:8px;margin-top:12px"><button class="btn sm" type="button" data-close>Cancel</button><button class="btn sm primary" id="soul-save">Save</button></div></form></dialog>`;

/** The client code. `canEdit`: the viewer is a person who can post here (edit the SOUL, strike and add memory). */
export function soulMemoryJs(canEdit: boolean): string {
  return `
// ---- SOUL and MEMORY: the board's standing context for agents (side panel; Remember on messages) ----
let SOUL=null,MEM=null;const SM_EDIT=${canEdit ? "true" : "false"};
const smWho=x=>x.via==='agent'?(x.session?x.by+'/'+x.session:x.by+"'s agent"):x.by;
const smAgo=ts=>{if(!ts)return '';const s=(Date.now()-ts)/1000;return s<60?'just now':s<3600?Math.floor(s/60)+'m ago':s<86400?Math.floor(s/3600)+'h ago':Math.floor(s/86400)+'d ago'};
const smFold=(id,title,n,peek,body)=>'<section class="fold" data-fold="'+id+'"><h3><button type="button" class="fold-h" aria-expanded="true" aria-controls="fold-'+id+'"><svg class="fold-c" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 3l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="fold-t">'+title+'</span><span class="faint fold-n">'+n+'</span>'+(peek?'<span class="fold-peek truncate">'+esc(peek)+'</span>':'')+'</button></h3><div class="fold-b" id="fold-'+id+'">'+body+'</div></section>';
window.soulRefresh=async()=>{let r;try{r=await fetch('/api/boards/'+BOARD+'/soul')}catch(e){return}
  const side=document.getElementById('soul-side');if(!side)return;if(!r.ok){side.hidden=true;return}
  SOUL=((await r.json().catch(()=>({}))).soul)||null;if(!SOUL){side.hidden=true;return}
  const text=String(SOUL.text||'').trim(),first=(text.split('\\n').map(l=>l.replace(/^[#>*\\-\\s]+/,'').trim()).filter(Boolean)[0])||'';
  const body=text?'<div class="soul-prev">'+esc(text)+'</div><div class="xs faint soul-meta">v'+SOUL.version+(SOUL.updated_by?' · edited by '+esc(SOUL.updated_by):'')+(SOUL.updated_at?' · '+smAgo(SOUL.updated_at):'')+'</div>'
    :'<p class="none">No soul yet: who this board is and how you work. Agents read it when they join.</p>';
  side.innerHTML=smFold('soul','Soul','',first,body+(SM_EDIT?'<button class="btn sm ghost soul-edit" type="button" data-soul-edit>'+(text?'Edit':'Write it')+'</button>':''));
  side.hidden=false;if(typeof foldApply==='function')foldApply()};
window.memRefresh=async()=>{let r;try{r=await fetch('/api/boards/'+BOARD+'/memory')}catch(e){return}
  const side=document.getElementById('mem-side');if(!side)return;if(!r.ok){side.hidden=true;document.documentElement.classList.remove('mem-on');return}
  MEM=await r.json().catch(()=>null);if(!MEM){side.hidden=true;return}document.documentElement.classList.add('mem-on');
  const items=MEM.items||[],max=MEM.max||50;
  const li=x=>'<li class="mem-it" data-mid="'+esc(String(x.id))+'"><span class="mem-t">'+esc(x.text)+'</span><span class="xs faint mem-m">'+esc(smWho(x))+(x.from?' · <a href="#e'+x.from+'" class="ref-plain">#'+x.from+'</a>':'')+(x.ts?' · '+smAgo(x.ts):'')+'</span>'+
    (SM_EDIT?'<button class="btn ghost sm mem-x" type="button" data-mem-strike="'+esc(String(x.id))+'" aria-label="Strike this from memory" title="Strike it: agents stop reading it">✕</button>':'')+'</li>';
  const add=SM_EDIT?'<form class="mem-add" id="mem-add"><input class="input" id="mem-in" maxlength="280" placeholder="Remember something…" aria-label="Remember something"><button class="btn sm" type="submit">Add</button></form>':'';
  side.innerHTML=smFold('memory','Memory',items.length?items.length+'/'+max:'',items.length?items[items.length-1].text:'',
    (items.length?'<ul class="mem-list">'+items.map(li).join('')+'</ul>':'<p class="none">Nothing yet. Agents keep facts here for later, and you can add any message with its bookmark.</p>')+add);
  side.hidden=false;if(typeof foldApply==='function')foldApply()};
async function memPost(body){const r=await fetch('/api/boards/'+BOARD+'/memory',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).catch(()=>null);
  const j=r?await r.json().catch(()=>({})):{};
  if(!r||!r.ok){toast(r&&r.status===409?'Memory is full: strike something first':j.error||"Couldn't remember it");return false}
  const it=j.item||{};toast(j.duplicate?'Already remembered':'Remembered'+(j.count?' ('+j.count+'/'+((MEM&&MEM.max)||50)+')':''));memRefresh();return true}
document.addEventListener('click',async e=>{
  const rb=e.target.closest('[data-remember]');if(rb){e.preventDefault();e.stopPropagation();rb.disabled=true;await memPost({from:+rb.dataset.remember});rb.disabled=false;return}
  const sb=e.target.closest('[data-mem-strike]');if(sb){e.preventDefault();sb.disabled=true;
    const r=await fetch('/api/boards/'+BOARD+'/memory/'+encodeURIComponent(sb.dataset.memStrike),{method:'DELETE'}).catch(()=>null);
    if(!r||!r.ok){const j=r?await r.json().catch(()=>({})):{};toast(j.error||"Couldn't strike it");sb.disabled=false;return}toast('Struck from memory');memRefresh();return}
  if(e.target.closest('[data-soul-edit]')){e.preventDefault();soulOpen()}});
document.addEventListener('submit',async e=>{if(e.target.id!=='mem-add')return;e.preventDefault();const i=document.getElementById('mem-in'),t=i.value.trim();if(!t)return;if(await memPost({text:t}))i.value=''});
const soulDlg=document.getElementById('soul-dlg');
function soulOpen(){if(!soulDlg||!SOUL)return;document.getElementById('soul-text').value=SOUL.text||'';document.getElementById('soul-err').hidden=true;soulDlg.dataset.base=String(SOUL.version||0);soulDlg.showModal();document.getElementById('soul-text').focus()}
soulDlg?.addEventListener('click',e=>{if(e.target===soulDlg||e.target.closest('[data-close]'))soulDlg.close()});
document.getElementById('soul-form')?.addEventListener('submit',async e=>{e.preventDefault();const b=document.getElementById('soul-save'),err=document.getElementById('soul-err');b.disabled=true;err.hidden=true;
  const r=await fetch('/api/boards/'+BOARD+'/soul',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({text:document.getElementById('soul-text').value,base_version:+soulDlg.dataset.base})}).catch(()=>null);
  const j=r?await r.json().catch(()=>({})):{};b.disabled=false;
  if(r&&r.status===409){const cur=j.current&&(j.current.soul||j.current);err.textContent='Someone saved a newer version'+(cur&&cur.updated_by?' ('+cur.updated_by+')':'')+'. Copy your text, then close and reopen to see theirs.';err.hidden=false;return}
  if(!r||!r.ok){err.textContent=j.error||"Couldn't save it";err.hidden=false;return}
  soulDlg.close();toast('Soul saved: agents get the new version');soulRefresh()});
window.onSoulEvent=()=>soulRefresh();window.onMemoryEvent=()=>memRefresh();
soulRefresh();memRefresh();
`;
}
