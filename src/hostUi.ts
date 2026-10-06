// atteo host on the web (docs/HOST.md; vedu #4807/#4815): /host.js, loaded only on boards with a machine attached (or
// when someone opens Attach a machine), so other pages don't carry it. A red banner while any machine is online, the
// machines in the side panel with Stop (the machine's owner, or the board's owner), and the Attach dialog: its button
// stays disabled until the person has typed "I understand what I'm doing" exactly; the server checks it again.

import { fnv } from "./codecolor";
import { HOST_PHRASE } from "./hostCore";

const HOST_JS = `
(()=>{if(window.HOSTJS)return;window.HOSTJS=1;
const B=window.BC||{},ME=(window.BOARD_CTX&&BOARD_CTX.me)||'',PH=${JSON.stringify(HOST_PHRASE)};
const t=s=>window.tr?tr(s):s,h=x=>String(x==null?'':x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const api=(p,o)=>fetch('/api/boards/'+B.board+'/hosts'+p,o).then(async r=>{const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||r.status);return j});
const canStop=x=>x.owner===ME||B.isOwner;
let hosts=[];
function paint(){const live=hosts.filter(x=>!x.stopped_at),on=live.filter(x=>x.online);
  let ban=document.getElementById('host-ban');
  if(on.length){if(!ban){ban=document.createElement('div');ban.id='host-ban';ban.setAttribute('role','alert');
      ban.style.cssText='display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:8px 12px;padding:10px 12px;border-radius:var(--r);background:var(--intervene);color:var(--on-intervene);font-size:13px';
      const at=document.getElementById('thread-scroll');(at&&at.parentNode?at.parentNode:document.body).insertBefore(ban,at&&at.parentNode?at:null)}
    ban.innerHTML='<b>⚠️ '+h(t('Machine attached'))+'</b><span style="flex:1;min-width:200px">'+on.map(x=>h(x.owner)+"'s "+h(x.name)).join(', ')+' · '+h(t('agents here can ask to run commands on it; its owner approves each one.'))+'</span>'+
      on.filter(canStop).map(x=>'<button type="button" class="btn sm" data-host-stop="'+h(x.id)+'">'+h(t('Stop'))+' '+h(x.name)+'</button>').join('')}
  else if(ban)ban.remove();
  const side=document.getElementById('host-side');if(!side)return;
  let list=side.querySelector('.host-list');if(!list){list=document.createElement('div');list.className='host-list';side.insertBefore(list,side.firstChild)}
  list.innerHTML=live.length?'<h3 class="xs faint" style="margin:0 0 6px">'+h(t('Machines'))+'</h3>'+live.map(x=>'<div class="small" style="display:flex;gap:8px;align-items:center;margin-bottom:6px"><span aria-hidden="true">'+(x.online?'●':'○')+'</span><span style="flex:1;min-width:0;overflow-wrap:anywhere"><b>'+h(x.name)+'</b> · '+h(x.owner)+' · '+h(x.online?t('online'):t('offline'))+'<br><span class="xs faint">'+h(x.shares.join(', '))+'</span></span>'+(canStop(x)?'<button type="button" class="btn sm intervene" data-host-stop="'+h(x.id)+'">'+h(t('Stop'))+'</button>':'')+'</div>').join(''):''}
async function load(){try{hosts=(await api('',{cache:'no-store'})).hosts||[];paint()}catch(e){}}
document.addEventListener('click',async e=>{const s=e.target.closest('[data-host-stop]');if(s){s.disabled=true;try{await api('/'+s.dataset.hostStop+'/stop',{method:'POST'});window.toast&&toast(t('Stopped. Nothing more runs on it.'))}catch(x){window.toast&&toast(String(x.message||x))}load();return}
  if(e.target.closest('[data-host-attach]'))attach()});
function attach(){let d=document.getElementById('host-dlg');
  if(!d){d=document.createElement('dialog');d.id='host-dlg';d.style.maxWidth='520px';d.setAttribute('aria-labelledby','host-dlg-h');
    d.innerHTML='<form method="dialog" style="display:grid;gap:12px;padding:20px 22px"><h2 id="host-dlg-h" style="margin:0;color:var(--intervene)">⚠️ '+h(t('Attach a machine: very dangerous'))+'</h2>'+
      '<p class="small" style="margin:0">'+h(t('Agents on this board, yours and other people’s, will be able to ask to run shell commands on your computer, as you, in the folders you share. You approve every command (or allowlist exact ones), and you can stop it any time. Only do this on a board you trust.'))+'</p>'+
      '<label class="small" for="host-ph">'+h(t('Type exactly:'))+' <b>'+h(PH)+'</b></label><input id="host-ph" autocomplete="off" spellcheck="false" style="font:inherit;padding:8px 10px;border:1px solid var(--line-strong);border-radius:8px;background:var(--bg);color:var(--ink)">'+
      '<div id="host-cmd" hidden class="small"></div><p id="host-err" class="small" role="alert" hidden style="margin:0;color:var(--intervene)"></p>'+
      '<div style="display:flex;justify-content:flex-end;gap:8px"><button type="submit" class="btn ghost sm" value="cancel">'+h(t('Cancel'))+'</button><button type="button" class="btn sm intervene" id="host-go" disabled>'+h(t('I understand, attach a machine'))+'</button></div></form>';
    document.body.appendChild(d);
    const inp=d.querySelector('#host-ph'),go=d.querySelector('#host-go');
    inp.addEventListener('input',()=>{go.disabled=inp.value.replace(/[\\u2018\\u2019]/g,"'")!==PH});
    go.addEventListener('click',async()=>{go.disabled=true;const err=d.querySelector('#host-err');err.hidden=true;
      try{const j=await api('/confirm',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phrase:inp.value})});
        const cmd='atteo host --board '+B.board+' --token '+j.token+' --share .',box=d.querySelector('#host-cmd');box.hidden=false;
        box.innerHTML=h(t('In a terminal on that machine, in the folder you want to share, run (good for 10 minutes, once):'))+'<pre class="mono" style="white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0 0;padding:8px;border:1px solid var(--line);border-radius:8px">'+h(cmd)+'</pre>';
        inp.disabled=true}catch(x){err.hidden=false;err.textContent=String(x.message||x);go.disabled=false}})}
  d.querySelector('#host-ph').value='';d.querySelector('#host-ph').disabled=false;d.querySelector('#host-go').disabled=true;d.querySelector('#host-cmd').hidden=true;d.querySelector('#host-err').hidden=true;
  d.showModal();d.querySelector('#host-ph').focus()}
window.hostAttach=attach;
load();setInterval(()=>{if(!document.hidden)load()},20000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)load()});
})();`;

export const HOST_PAGE_JS = HOST_JS;
export const HOST_JS_SRC = `/host.js?v=${fnv(HOST_PAGE_JS)}`;

/** The board page's hook (board.js): loads /host.js when a machine is attached here, or on Attach a machine. */
export const HOST_LOADER_JS = `
(()=>{const go=a=>{if(window.HOSTJS){a&&window.hostAttach&&hostAttach();return}if(document.getElementById('host-js'))return;
  const s=document.createElement('script');s.id='host-js';s.src='${HOST_JS_SRC}';if(a)s.onload=()=>window.hostAttach&&hostAttach();document.head.appendChild(s)};
if(window.BC&&!BC.encrypted)fetch('/api/boards/'+BC.board+'/hosts').then(r=>r.ok?r.json():{}).then(j=>{if((j.hosts||[]).some(x=>!x.stopped_at))go()}).catch(()=>{});
document.addEventListener('click',e=>{if(!window.HOSTJS&&e.target.closest('[data-host-attach]'))go(true)})})();`;

/** Attach a machine, in the board's side panel (not on encrypted, archived or read-only boards, nor your agent chat). */
export const hostSide = (label: string) => `<div class="side-sec" id="host-side"><button type="button" class="btn ghost sm" data-host-attach>⚠️ ${label}</button></div>`;
