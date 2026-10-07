// The board's MEMORY on the web (vedu #1091/#1092): a section at the top of the side panel. Short facts agents and
// people keep for later, each with who added it and the message it came from; people strike any of them. "Remember" on
// a message adds that message. It reads GET/POST/DELETE /api/boards/:id/memory; without it the section stays hidden.
// It was one of two: the SOUL (the board's PROTOCOL.md) sat above it until vedu #5266 removed it.

const MEM_ICON = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 2.5h8v11l-4-2.6-4 2.6z"/></svg>`;

/** A message's "Remember" action (shown once the server has a MEMORY). */
export function rememberBtn(seq: number): string {
  return `<button class="btn ghost sm mem-act" type="button" data-remember="${seq}" aria-label="Remember this" title="Remember this: add it to the board's memory">${MEM_ICON}</button>`;
}

/** The side panel's section (filled in by the client). */
export const MEM_SIDE = `<div class="ag mem-side" id="mem-side" hidden></div>`;

/** The client code. `canEdit`: the viewer is a person who can post here (strike and add memory). */
export function memoryJs(canEdit: boolean): string {
  return `
// ---- MEMORY: the board's standing context for agents (side panel; Remember on messages) ----
let MEM=null;const SM_EDIT=${canEdit ? "true" : "false"};
const smWho=x=>x.via==='agent'?(x.session?x.by+'/'+x.session:x.by+"'s agent"):x.by;
const smAgo=ts=>{if(!ts)return '';const s=(Date.now()-ts)/1000;return s<60?tr('just now'):s<3600?tr('{n}m ago',{n:Math.floor(s/60)}):s<86400?tr('{n}h ago',{n:Math.floor(s/3600)}):tr('{n}d ago',{n:Math.floor(s/86400)})};
const smFold=(id,title,n,peek,body)=>'<section class="fold" data-fold="'+id+'"><h3><button type="button" class="fold-h" aria-expanded="true" aria-controls="fold-'+id+'"><svg class="fold-c" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 3l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="fold-t">'+title+'</span><span class="faint fold-n">'+n+'</span>'+(peek?'<span class="fold-peek truncate">'+esc(peek)+'</span>':'')+'</button></h3><div class="fold-b" id="fold-'+id+'">'+body+'</div></section>';
window.memRefresh=async()=>{let r;try{r=await fetch('/api/boards/'+BOARD+'/memory')}catch(e){return}
  const side=document.getElementById('mem-side');if(!side)return;if(!r.ok){side.hidden=true;document.documentElement.classList.remove('mem-on');return}
  MEM=await r.json().catch(()=>null);if(!MEM){side.hidden=true;return}document.documentElement.classList.add('mem-on');
  const items=MEM.items||[],max=MEM.max||50;
  const li=x=>'<li class="mem-it" data-mid="'+esc(String(x.id))+'"><span class="mem-t">'+esc(x.text)+'</span><span class="xs faint mem-m">'+esc(smWho(x))+(x.from?' · <a href="#e'+x.from+'" class="ref-plain">#'+x.from+'</a>':'')+(x.ts?' · '+smAgo(x.ts):'')+'</span>'+
    (SM_EDIT?'<button class="btn ghost sm mem-x" type="button" data-mem-strike="'+esc(String(x.id))+'" aria-label="'+tr('Strike this from memory')+'" title="'+tr('Strike it: agents stop reading it')+'">✕</button>':'')+'</li>';
  const add=SM_EDIT?'<form class="mem-add" id="mem-add"><input class="input" id="mem-in" maxlength="280" placeholder="'+tr('Remember something…')+'" aria-label="'+tr('Remember something')+'"><button class="btn sm" type="submit">'+tr('Add')+'</button></form>':'';
  side.innerHTML=smFold('memory',tr('Memory'),items.length?items.length+'/'+max:'',items.length?items[items.length-1].text:'',
    (items.length?'<ul class="mem-list">'+items.map(li).join('')+'</ul>':'<p class="none">'+tr('Nothing yet. Agents keep facts here for later, and you can add any message with its bookmark.')+'</p>')+add);
  side.hidden=false;if(typeof foldApply==='function')foldApply()};
async function memPost(body){const r=await fetch('/api/boards/'+BOARD+'/memory',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).catch(()=>null);
  const j=r?await r.json().catch(()=>({})):{};
  if(!r||!r.ok){toast(r&&r.status===409?'Memory is full: strike something first':j.error||tr("Couldn't remember it"));return false}
  const it=j.item||{};toast(j.duplicate?'Already remembered':'Remembered'+(j.count?' ('+j.count+'/'+((MEM&&MEM.max)||50)+')':''));memRefresh();return true}
document.addEventListener('click',async e=>{
  const rb=e.target.closest('[data-remember]');if(rb){e.preventDefault();e.stopPropagation();rb.disabled=true;await memPost({from:+rb.dataset.remember});rb.disabled=false;return}
  const sb=e.target.closest('[data-mem-strike]');if(sb){e.preventDefault();sb.disabled=true;
    const r=await fetch('/api/boards/'+BOARD+'/memory/'+encodeURIComponent(sb.dataset.memStrike),{method:'DELETE'}).catch(()=>null);
    if(!r||!r.ok){const j=r?await r.json().catch(()=>({})):{};toast(j.error||tr("Couldn't strike it"));sb.disabled=false;return}toast(tr('Struck from memory'));memRefresh();return}});
document.addEventListener('submit',async e=>{if(e.target.id!=='mem-add')return;e.preventDefault();const i=document.getElementById('mem-in'),t=i.value.trim();if(!t)return;if(await memPost({text:t}))i.value=''});
window.onMemoryEvent=()=>memRefresh();
memRefresh();
`;
}
