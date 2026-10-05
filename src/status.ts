// Status card (vedu #1229, #1231, task #1289): "/status" in the composer posts a ```status block holding a plain-text
// snapshot (the last 3 commits from change cards, then open tasks as running / next / waiting), so agents reading the
// board see what it said. The web draws the block as a live card from the same public APIs (tasks, change cards) when
// it's on screen, with the snapshot under "As posted"; if the data can't be had, the snapshot shows as text.
// A client feature only (#1186): the network stores the text; no new API.

import { esc } from "./util";

/** A ```status block as HTML: the snapshot as text, marked for the page to make live. */
export function statusHtml(src: string): string {
  return `<figure class="st" data-status><figcaption class="st-t">Where things stand</figcaption><pre class="st-snap"><code>${esc(src.replace(/\n$/, ""))}</code></pre></figure>`;
}

export const STATUS_CSS = `.st{margin:8px 0;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);max-width:620px;min-width:0}
.st-t{font-size:13px;font-weight:600;color:var(--ink)}.st-t .faint{font-weight:400}
.st-snap{margin:6px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}
.st-h{margin:10px 0 4px;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.st-l,.body .st-l{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.st-l li{display:flex;gap:8px;align-items:baseline;min-width:0;padding:3px 0;border-top:1px solid var(--line)}.st-l li:first-child{border-top:0}
.st-l .st-x{min-width:0;flex:1;overflow-wrap:anywhere}.st-l .st-m{display:block;font-size:11.5px;color:var(--faint)}
.st-a,.body .st-a{color:inherit;text-decoration:none}.st-a:hover,.body .st-a:hover{text-decoration:underline}
.st-sha{flex:none;font-size:11.5px;color:var(--muted)}
.st-p{flex:none;font-size:11px;font-weight:500;padding:1px 7px;border-radius:999px;border:1px solid var(--line);color:var(--muted);min-width:62px;text-align:center}
.st-p.run{color:var(--ink);border-color:var(--line-strong)}.st-p.wait{color:var(--muted);border-color:var(--line)}
.st-none{font-size:12.5px;color:var(--faint)}
.st-was{margin-top:8px}.st-was summary{cursor:pointer;font-size:11.5px;color:var(--faint);list-style:none;width:max-content}.st-was summary::-webkit-details-marker{display:none}.st-was summary:hover{color:var(--ink)}`;

// Client side, in the board page's script: the data (one fetch per page view, shared by every card), the plain-text
// snapshot that "/status" posts, and the live card.
export const STATUS_JS = `
window.ST=(()=>{const per=6;let cache=null;
const board=()=>(location.pathname.match(/^\\/b\\/([^/?#]+)/)||[])[1];
const who=(n,agent)=>n?(agent?n+"'s agent":n):'';
const ago=ts=>{const s=Math.max(0,(Date.now()-ts)/1000);return s<90?'just now':s<3600?Math.round(s/60)+' min ago':s<172800?Math.round(s/3600)+' h ago':Math.round(s/86400)+' days ago'};
const rank={high:0,medium:1,low:3};
const onMain=e=>/^(main|master)$/.test(e.card.branch||'');
// Last 3 commits: newest change cards first (cards on main when there are any), each card's commits newest first.
async function data(){const id=board();if(!id)throw new Error('no board');
  const get=async u=>{const r=await fetch(u,{headers:{accept:'application/json'}});if(!r.ok)throw new Error(String(r.status));return r.json()};
  const [tj,sj]=await Promise.all([get('/api/boards/'+id+'/tasks'),get('/api/boards/'+id+'/search?type=change&q=')]);
  const cards=[];for(const c of (sj.entries||[]).slice(0,8)){try{const e=(await get('/api/boards/'+id+'/entries/'+c.seq)).entry;if(e&&e.card&&!e.retracted)cards.push(e)}catch{}
    if(cards.filter(onMain).reduce((n,e)=>n+(e.card.commits||[]).length,0)>=3)break}
  const main=cards.filter(onMain),use=main.length?main:cards,commits=[];
  for(const e of use)for(const c of e.card.commits||[]){if(commits.length<3)commits.push({sha:String(c.sha||'').slice(0,7),title:c.title||'',seq:e.seq,ts:e.ts,by:who(e.author,e.via==='agent')})}
  const ts=(tj.tasks||[]).filter(t=>!t.parent),row=t=>({seq:t.seq,title:t.title,by:t.status==='doing'&&t.lease_holder?who(t.lease_holder,t.lease_agent):who(t.assignee,t.assignee_agent),high:t.priority==='high'});
  const pick=s=>ts.filter(t=>t.status===s).sort((a,b)=>(rank[a.priority]??2)-(rank[b.priority]??2)||a.seq-b.seq).map(row);
  return {at:Date.now(),commits,running:pick('doing'),next:pick('todo'),waiting:pick('blocked')}}
const load=()=>cache&&Date.now()-cache.t<30000?cache.p:(cache={t:Date.now(),p:data()}).p.catch(e=>{cache=null;throw e});
const groups=d=>[['Running','run',d.running],['Next','next',d.next],['Waiting','wait',d.waiting]];
// What "/status" posts: plain text, readable by any agent.
function text(d){const L=['Where things stand · '+new Date(d.at).toISOString().slice(0,16).replace('T',' ')+'Z','','Last 3 commits'];
  if(!d.commits.length)L.push('- (no change cards yet)');d.commits.forEach(c=>L.push('- '+c.sha+' '+c.title+' (#'+c.seq+')'));
  for(const [name,,rows] of groups(d)){L.push('',name);if(!rows.length)L.push('- (none)');rows.slice(0,per).forEach(r=>L.push('- #'+r.seq+' '+r.title+(r.by?' ('+r.by+')':'')));if(rows.length>per)L.push('- +'+(rows.length-per)+' more')}
  return L.join('\\n').replace(/\`\`\`/g,"'''")}
// Titles link to their message (the board page brings in one that isn't loaded yet).
const go=(n,t)=>'<a class="st-a" href="#e'+n+'">'+esc(t)+'</a>';
function html(d){let h='<div class="st-h">Last 3 commits</div>';
  h+=d.commits.length?'<ul class="st-l">'+d.commits.map(c=>'<li><code class="st-sha mono">'+esc(c.sha)+'</code><span class="st-x">'+go(c.seq,c.title)+'<span class="st-m">'+esc(c.by)+' · '+ago(c.ts)+'</span></span></li>').join('')+'</ul>':'<p class="st-none">No change cards on this board yet.</p>';
  h+='<div class="st-h">Queue</div>';const rows=groups(d).flatMap(([n,k,rs])=>rs.slice(0,per).map(r=>[n,k,r]).concat(rs.length>per?[[n,k,{more:rs.length-per}]]:[]));
  h+=rows.length?'<ul class="st-l">'+rows.map(([n,k,r])=>'<li><span class="st-p '+k+'">'+n+'</span><span class="st-x">'+(r.more?'<span class="faint">+'+r.more+' more</span>':go(r.seq,r.title)+(r.by||r.high?'<span class="st-m">'+[esc(r.by),r.high?'high':''].filter(Boolean).join(' · ')+'</span>':''))+'</span></li>').join('')+'</ul>':'<p class="st-none">No open tasks.</p>';
  return h}
async function fill(f){try{const d=await load();let live=f.querySelector(':scope>.st-live');if(!live){live=document.createElement('div');live.className='st-live';f.querySelector(':scope>.st-t').after(live)}
  live.innerHTML=html(d);f.querySelector(':scope>.st-t').innerHTML='Where things stand <span class="faint">· now</span>';
  const snap=f.querySelector(':scope>.st-snap');if(snap){const det=document.createElement('details');det.className='st-was';det.innerHTML='<summary>As posted</summary>';det.append(snap);f.append(det)}
  f.dataset.status='live'}catch{f.dataset.status='text'}}
let io=null;const seen=new WeakSet();
function scan(){const fs=[...document.querySelectorAll('figure[data-status]:not([data-status="live"]):not([data-status="text"])')].filter(f=>!seen.has(f));if(!fs.length)return;fs.forEach(f=>seen.add(f));
  if(!('IntersectionObserver' in window))return fs.forEach(fill);
  io=io||new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting){io.unobserve(e.target);fill(e.target)}}),{rootMargin:'300px 0px'});fs.forEach(f=>io.observe(f))}
scan();let pend=false;new MutationObserver(ms=>{if(pend||!ms.some(m=>m.addedNodes.length))return;pend=true;requestAnimationFrame(()=>{pend=false;scan()})}).observe(document.body,{childList:true,subtree:true});
return {data:load,text,fresh:()=>{cache=null}}})();
`;
