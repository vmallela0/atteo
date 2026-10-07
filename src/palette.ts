// The existing command palette and board search, loaded on demand by the shell.
// Keep markup and styles here so unopened palettes cost no page HTML or CSS.
import { fnv } from "./codecolor";

export const PALETTE_CSS = `/* command palette */
dialog.palette{margin:auto;width:min(600px,calc(100vw - 24px));border-radius:12px}
.palette input{border:0;border-radius:0;height:48px;padding:0 4px;font-size:15px;background:transparent;box-shadow:none!important}
.palette ul{list-style:none;margin:0;padding:6px;max-height:50vh;overflow:auto}
.pal-in{display:flex;align-items:center;gap:8px;padding:0 12px;border-bottom:1px solid var(--line);color:var(--muted)}
.pal-in input{flex:1;min-width:80px;box-shadow:none!important}
.pal-chips{display:inline-flex;gap:6px;flex-wrap:wrap}
.pal-chip{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 4px 0 8px;border-radius:6px;font-size:12.5px;font-weight:500;color:var(--accent);background:color-mix(in srgb,var(--accent) 10%,transparent);white-space:nowrap}
.pal-chip button{border:0;background:none;color:inherit;opacity:.6;cursor:pointer;font-size:10px;padding:2px 3px}.pal-chip button:hover{opacity:1}
.pal-filters{display:flex;gap:6px;flex-wrap:wrap;padding:8px 12px;border-bottom:1px solid var(--line)}.pal-filters[hidden]{display:none}
.pal-opt{height:24px;padding:0 9px;border-radius:999px;border:1px solid var(--line);background:var(--bg-subtle);color:var(--muted);font:inherit;font-size:12px;cursor:pointer}
.pal-opt:hover{color:var(--ink);border-color:var(--line-strong)}
.palette li.pal-g{padding:8px 10px 2px;font-size:11.5px;color:var(--faint);cursor:default;text-transform:uppercase;letter-spacing:.04em}
.palette .pal-l{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.palette .pal-l mark{background:var(--mark);color:inherit;border-radius:3px;padding:0 1px}
.palette li{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:7px;cursor:pointer;font-size:13.5px;color:var(--text)}
.palette li[aria-selected=true]{background:var(--bg-hover);color:var(--ink)}
.palette li .k{flex:none;white-space:nowrap;margin-left:auto;color:var(--faint);font-size:12px}
.palette .foot{display:flex;gap:14px;padding:8px 14px;border-top:1px solid var(--line);font-size:12px;color:var(--faint)}
@media (pointer:coarse){.palette .foot{display:none}}
@media (max-width:640px){.palette li:not(.pal-g){flex-wrap:wrap;row-gap:1px}.palette li .pal-l{flex:1 1 100%}.palette li .k{margin-left:0;font-size:11.5px}}`;
export const PALETTE_CSS_SRC = `/palette.css?v=${fnv(PALETTE_CSS)}`;

export const PALETTE_JS = `
(()=>{
const $=(s,r=document)=>r.querySelector(s);
const h=x=>String(x==null?'':x).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
document.body.insertAdjacentHTML('beforeend','<dialog class="palette" id="palette" role="dialog" aria-modal="true" aria-label="'+h(tr('Search'))+'"><div class="pal-in"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/></svg><span class="pal-chips" id="pal-chips"></span><input class="input" id="palette-q" placeholder="'+h(tr('Search or jump to…'))+'" autocomplete="off" aria-label="'+h(tr('Search'))+'" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="palette-list"></div><div class="pal-filters" id="pal-filters" aria-label="'+h(tr('Filters'))+'"></div><ul id="palette-list" role="listbox" aria-label="'+h(tr('Search'))+'"></ul><div class="foot"><span><kbd>↑</kbd> <kbd>↓</kbd> '+h(tr('move'))+'</span><span><kbd>↵</kbd> '+h(tr('open'))+'</span><span><kbd>⌫</kbd> '+h(tr('remove filter'))+'</span><span><kbd>esc</kbd> '+h(tr('close'))+'</span></div></dialog>');
// Search (⌘K everywhere; ⌘F on a board starts with "This board · Messages"): filters show up front like VS Code or Lark,
// and become chips; results mix boards and actions with ranked messages and files (this board, or all your boards).
const pal=$('#palette'),q=$('#palette-q'),list=$('#palette-list'),pChips=$('#pal-chips'),pFilt=$('#pal-filters');
let sel=0,items=[],chips=[],mode=null,run=0,timer=null,from=null;
const people=new Map();
const B=()=>window.BOARD_CTX||null; // on a board page: {id, me, members, jump(seq), openFile(name, version)}
const KINDS=[['messages',tr('Messages')],['files',tr('Files')],['boards',tr('Boards')],['actions',tr('Actions')]],TYPES=['question','task','decision','claim','note','change','artifact'];

const has=(k,v)=>chips.some(c=>c.k===k&&(v==null||c.v===v)),chip=k=>chips.find(c=>c.k===k);
const who=(u,agent)=>{const me=B()&&B().me;return u===me?(agent?tr('Your agent'):tr('You')):(agent?tr("{name}'s agent",{name:u}):u)};
const label=c=>c.k==='board'?tr('This board'):c.k==='kind'?KINDS.find(k=>k[0]===c.v)[1]:c.k==='type'?tr('type:')+' '+tr(c.v):tr('from')+' '+who(c.v,c.agent);
function paintChips(){pChips.innerHTML=chips.map((c,i)=>'<span class="pal-chip">'+h(label(c))+'<button type="button" data-pchip="'+i+'" aria-label="'+h(tr('Remove'))+' '+h(label(c))+'">✕</button></span>').join('');
  const o=[];if(B()&&!has('board'))o.push(['board','',tr('This board')]);if(!has('kind'))KINDS.forEach(([v,l])=>o.push(['kind',v,l]));
  if(B()&&!has('from'))o.push(['from','',tr('From…')]);if(!has('type'))o.push(['type','',tr('Type…')]);
  pFilt.innerHTML=o.map(x=>'<button type="button" class="pal-opt" data-popt="'+x[0]+'" data-v="'+x[1]+'">'+h(x[2])+'</button>').join('');pFilt.hidden=!o.length}
function paint(rows){items=rows;sel=Math.max(0,Math.min(sel,rows.length-1));let g='';
  list.innerHTML=rows.map((r,n)=>(r.g!==g?'<li class="pal-g" aria-hidden="true">'+h(g=r.g)+'</li>':'')+'<li role="option" data-n="'+n+'" id="po-'+n+'" aria-selected="'+(n===sel)+'"><span class="pal-l">'+r.label+'</span><span class="k">'+h(r.hint||'')+'</span></li>').join('')||'<li class="faint pal-none">'+h(tr(q.value.trim()?'No matches':'Type to search'))+'</li>';
  if(rows.length){q.setAttribute('aria-activedescendant','po-'+sel);$('#po-'+sel)?.scrollIntoView({block:'nearest'})}else q.removeAttribute('aria-activedescendant')}
function pickList(){const t=q.value.trim().replace(/^@/,'').toLowerCase();
  const rows=mode==='from'?(B()?B().members:[]).flatMap(u=>[{u,agent:false},{u,agent:true}]).filter(x=>x.u.startsWith(t)).map(x=>({g:tr('From'),label:h(who(x.u,x.agent)),pick:{k:'from',v:x.u,agent:x.agent}}))
    :TYPES.filter(x=>x.startsWith(t)).map(x=>({g:tr('Type'),label:h(tr(x)),pick:{k:'type',v:x}}));paint(rows)}
const snip=x=>h(x||'').split('«').join('<mark>').split('»').join('</mark>');
// Prefix, substring, then a small ordered-character match (e.g. stng → Settings).
const norm=s=>String(s).normalize('NFKD').replace(/[\\u0300-\\u036f]/g,'').toLowerCase();
function rank(label,query){const s=norm(label),t=norm(query).replace(/^@/,'');if(!t||s.startsWith(t))return 0;if(s.includes(t))return 1;
  if(t.length<2)return 99;let at=-1,start=-1;for(const c of t){at=s.indexOf(c,at+1);if(at<0)return 99;if(start<0)start=at}return at-start<t.length*3?2:99}
function remember(ps){for(const p of ps)people.set(p.name,{label:p.display_name||p.name,hint:'@'+p.name,href:'/u/'+encodeURIComponent(p.name),kind:'person'})}
function render(){clearTimeout(timer);const my=++run;if(mode){pickList();return}const t=q.value.trim(),kind=chip('kind')&&chip('kind').v,b=B(),scoped=b&&(has('board')||has('from')||has('type'));
  const rows=[];
  if((!kind||kind==='boards'||kind==='actions')&&!scoped){
    const all=[...(window.PALETTE||[]),...(!kind?people.values():[])];
    all.map(i=>({i,rank:Math.min(rank(i.label,t),i.kind==='person'?rank(i.hint.slice(1),t):99)}))
      .filter(x=>x.rank<99&&(!kind||(kind==='boards')===(x.i.kind==='board'))).sort((a,b)=>a.rank-b.rank)
      .forEach(({i})=>rows.push({g:i.kind==='board'?tr('Boards'):i.kind==='person'?tr('People'):tr('Actions'),label:h(i.label),hint:i.hint,href:i.href}));
  }
  paint(rows);
  if(kind==='boards'||kind==='actions'||(!t&&!has('from')&&!has('type')))return;
  timer=setTimeout(async()=>{const more=[];
    // Query the existing people directory alongside message search; stale results never repaint.
    if(t&&!kind&&!scoped)fetch('/api/people?q='+encodeURIComponent(t)).then(r=>r.ok?r.json():{}).then(j=>{
      if(my!==run)return;remember(j.people||[]);const seen=new Set(rows.map(r=>r.href));
      for(const p of j.people||[]){const i=people.get(p.name);if(!seen.has(i.href))rows.push({g:tr('People'),label:h(i.label),hint:i.hint,href:i.href})}
      paint(rows.concat(more));
    }).catch(()=>{});
    try{if(scoped){const p=new URLSearchParams({q:t});const f=chip('from');if(f){p.set('from',f.v);p.set('agent',f.agent?'1':'0')}if(chip('type'))p.set('type',chip('type').v);if(kind==='messages')p.set('in','chat');
        // An end-to-end encrypted board is searched on this device (e2eweb.ts): the server only has ciphertext.
        const j=window.e2eSearch?await e2eSearch(t,{from:f?f.v:null,agent:f?!!f.agent:null,type:chip('type')?chip('type').v:null}):await (await fetch('/api/boards/'+b.id+'/search?'+p)).json();
        if(kind!=='files')(j.entries||[]).forEach(x=>more.push({g:tr('Messages'),label:(x.title?'<b>'+h(x.title)+'</b> ':'')+snip(x.snippet),hint:who(x.author,x.via==='agent')+' · #'+x.seq,act:()=>b.jump(x.seq)}));
        if(kind!=='messages')(j.files||[]).forEach(x=>more.push({g:tr('Files'),label:'<span class="mono">'+h(x.name)+'</span> '+snip(x.snippet),hint:'v'+x.version,act:()=>b.openFile(x.name,x.version)}))}
      else if(t){if(window.e2eSearch&&b&&kind!=='files')(await e2eSearch(t)).entries.slice(0,8).forEach(x=>more.push({g:tr('Messages'),label:snip(x.snippet),hint:who(x.author,x.via==='agent')+' · #'+x.seq,act:()=>b.jump(x.seq)}));
        const j=await (await fetch('/api/boards/search?q='+encodeURIComponent(t))).json();
        (j.hits||[]).filter(x=>kind==='files'?x.kind==='file':kind==='messages'?x.kind==='entry':true).forEach(x=>{const here=b&&x.board===b.id;
          more.push({g:tr(x.kind==='file'?'Files':'Messages'),label:(x.kind==='file'?'<span class="mono">'+h(x.name)+'</span> ':'')+snip(x.snippet),hint:x.title+(x.seq?' · #'+x.seq:''),
            act:here?(x.kind==='file'?()=>b.openFile(x.name,x.version):()=>b.jump(x.seq)):null,href:'/b/'+x.board+(x.kind==='file'?'#files':'#e'+x.seq)})})}}catch(e){}
    if(my===run)paint(rows.concat(more))},150)}
function go(i){if(!i)return;if(i.pick){chips=chips.filter(c=>c.k!==i.pick.k);chips.push(i.pick);mode=null;q.value='';paintChips();sel=0;render();q.focus();return}
  pal.close();if(i.href==='#shortcuts'){$('#shortcuts').showModal();return}if(i.act){i.act();return}location.href=i.href}
window.openPalette=(preset)=>{chips=(preset||[]).slice();mode=null;q.value='';sel=0;paintChips();render();if(!pal.open){from=document.activeElement;pal.showModal()}q.setAttribute('aria-expanded','true');q.focus()};
q.addEventListener('input',()=>{sel=0;if(!mode&&has('board')&&q.value.startsWith('@')&&B())mode='from';if(mode&&!q.value&&mode==='from')mode=null;render()});
q.addEventListener('keydown',e=>{if(e.key==='ArrowDown'){sel=Math.min(sel+1,items.length-1);paint(items);e.preventDefault()}
  else if(e.key==='ArrowUp'){sel=Math.max(sel-1,0);paint(items);e.preventDefault()}else if(e.key==='Enter'){go(items[sel]);e.preventDefault()}
  else if(e.key==='Backspace'&&!q.value&&(mode||chips.length)){if(mode)mode=null;else chips.pop();paintChips();render();e.preventDefault()}});
list.addEventListener('click',e=>{const li=e.target.closest('[data-n]');if(li){e.preventDefault();go(items[+li.dataset.n])}});
pChips.addEventListener('click',e=>{const b=e.target.closest('[data-pchip]');if(!b)return;chips.splice(+b.dataset.pchip,1);paintChips();render();q.focus()});
pFilt.addEventListener('click',e=>{const b=e.target.closest('[data-popt]');if(!b)return;const k=b.dataset.popt;
  if(k==='from'||k==='type'){mode=k;q.value='';sel=0;render();q.focus();return}chips.push({k,v:b.dataset.v||null});paintChips();render();q.focus()});
// Native modality makes the page inert; explicitly cycle Tab through the input and filter buttons.
pal.addEventListener('keydown',e=>{if(e.key!=='Tab')return;const fs=[...pal.querySelectorAll('input,button')].filter(x=>x.getClientRects().length),i=fs.indexOf(document.activeElement);
  if(e.shiftKey&&i<=0){e.preventDefault();fs[fs.length-1].focus()}else if(!e.shiftKey&&i===fs.length-1){e.preventDefault();fs[0].focus()}});
pal.addEventListener('click',e=>{if(e.target===pal)pal.close()});
pal.addEventListener('close',()=>{++run;clearTimeout(timer);q.setAttribute('aria-expanded','false');if(from?.isConnected)from.focus({preventScroll:true})});
// Board members and friends are useful before typing; the directory handles the rest on demand.
remember((B()?.members||[]).map(name=>({name})));
fetch('/api/friends').then(r=>r.ok?r.json():{}).then(j=>{remember(j.friends||[]);if(pal.open&&!q.value)render()}).catch(()=>{});
})();`;
export const PALETTE_JS_SRC = `/palette.js?v=${fnv(PALETTE_JS)}`;
