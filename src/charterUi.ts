// Board info → Charter: the room's goal, data classes, retention, and a note for each member.
// The page renders it (so it shows with the board). The client refreshes it from GET /api/boards/:id/charter
// and, for an owner, saves with POST. Without the API the server-rendered charter stays.

import type { Lang } from "./i18n";
import { tr } from "./i18n";
import type { BoardCharter, CharterRole } from "./charter";
import { esc } from "./util";

const ROLE: Record<CharterRole, string> = { owner: "Owner", contributor: "Can post", viewer: "View only" };

const FOLD_CHEVRON = `<svg class="fold-c" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 3l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function peek(c: BoardCharter, lang?: Lang): string {
  if (c.goal) return c.goal.split("\n")[0];
  if (c.data_classes.length) return c.data_classes.join(", ");
  if (c.retention_days) return tr(lang, "Keep messages {n} days", { n: c.retention_days });
  return "";
}

function keepLine(days: number | null, lang?: Lang): string {
  return days ? tr(lang, "Keep messages {n} days", { n: days }) : tr(lang, "Keep everything");
}

/** The side-panel section. `canEdit`: an owner looking at a board that isn't archived. */
export function charterSide(c: BoardCharter, canEdit: boolean, lang?: Lang): string {
  const T = (s: string, v?: Record<string, string | number>) => esc(tr(lang, s, v));
  const classes = c.data_classes.length
    ? c.data_classes.map((x) => `<span class="badge">${esc(x)}</span>`).join("")
    : `<span class="faint">${T("None")}</span>`;
  const people = c.members
    .map((m) => {
      const role = T(ROLE[m.role] ?? "Can post");
      const note = m.note ? ` <span class="faint">· ${esc(m.note)}</span>` : "";
      return `<li data-user="${esc(m.user)}" data-role="${esc(m.role)}" data-note="${esc(m.note ?? "")}"><b>${esc(m.user)}</b> <span class="faint">${role}</span>${note}</li>`;
    })
    .join("");
  const form = canEdit
    ? `<button class="btn sm ghost" type="button" id="ch-edit">${T("Edit")}</button>
<form id="ch-form" hidden>
<label class="lbl" for="ch-goal-in">${T("Goal")}</label>
<textarea class="input" id="ch-goal-in" rows="3" maxlength="500" aria-label="${T("Goal")}"></textarea>
<label class="lbl" for="ch-classes-in">${T("Data classes")}</label>
<input class="input" id="ch-classes-in" maxlength="400" placeholder="${T("internal, customer")}" aria-label="${T("Data classes")}">
<label class="lbl" for="ch-days-in">${T("Retention (days)")}</label>
<input class="input" id="ch-days-in" inputmode="numeric" placeholder="${T("empty keeps everything")}" aria-label="${T("Retention (days)")}">
<div class="lbl">${T("Members")}</div>
<div class="ch-notes" id="ch-notes"></div>
<p class="xs ch-err" id="ch-err" role="alert"></p>
<div class="row"><button class="btn sm" type="button" id="ch-cancel">${T("Cancel")}</button><button class="btn sm primary" type="submit">${T("Save")}</button></div>
</form>`
    : "";
  return `<div class="ag charter-side" id="charter-side"><section class="fold" data-fold="charter"><h3><button type="button" class="fold-h" aria-expanded="true" aria-controls="fold-charter">${FOLD_CHEVRON}<span class="fold-t">${T("Charter")}</span><span class="faint fold-n"></span><span class="fold-peek truncate" id="ch-peek">${esc(peek(c, lang))}</span></button></h3>
<div class="fold-b" id="fold-charter"><p class="xs muted ch-lead">${T("What this board is for, the data it may hold, and how long messages stay.")}</p>
<dl class="ch-dl"><dt>${T("Goal")}</dt><dd id="ch-goal"${c.goal ? "" : ' data-empty="1"'}>${c.goal ? esc(c.goal) : T("No goal yet.")}</dd>
<dt>${T("Data classes")}</dt><dd class="ch-classes" id="ch-classes" data-classes="${esc(c.data_classes.join(","))}">${classes}</dd>
<dt>${T("Retention")}</dt><dd id="ch-keep" data-days="${c.retention_days ?? ""}">${esc(keepLine(c.retention_days, lang))}</dd>
<dt>${T("Members")}</dt><dd><ul class="ch-members" id="ch-members">${people || `<li class="faint">${T("No members")}</li>`}</ul></dd></dl>
${form}</div></section></div>`;
}

/** Refreshes the section from the API and saves an owner's edits. No-op when the section isn't on the page. */
export function charterJs(): string {
  return `
// ---- Charter: goal, data classes, retention, member notes (Board info). Owners edit; everyone else reads. ----
(function(){
const side=document.getElementById('charter-side');if(!side)return;
const roleName={owner:tr('Owner'),contributor:tr('Can post'),viewer:tr('View only')};
function fromDom(){const g=document.getElementById('ch-goal');if(!g)return null;
  const box=document.getElementById('ch-classes'),k=document.getElementById('ch-keep'),ul=document.getElementById('ch-members');
  const members=ul?[...ul.querySelectorAll('[data-user]')].map(li=>({user:li.dataset.user,role:li.dataset.role||'contributor',note:li.dataset.note||null})):[];
  const classes=box&&box.dataset.classes?box.dataset.classes.split(',').filter(Boolean):[];
  const days=k&&k.dataset.days?Number(k.dataset.days):null;
  return {goal:g.hasAttribute('data-empty')?null:g.textContent,data_classes:classes,retention_days:days||null,members}}
let CH=fromDom(),chEditing=false;
function keepLine(n){return n?tr('Keep messages {n} days',{n:n}):tr('Keep everything')}
function peek(c){if(c.goal)return String(c.goal).split('\\n')[0];if(c.data_classes&&c.data_classes.length)return c.data_classes.join(', ');if(c.retention_days)return keepLine(c.retention_days);return ''}
function paint(c){
  CH=c;
  const g=document.getElementById('ch-goal');if(g){if(c.goal){g.removeAttribute('data-empty');g.textContent=c.goal}else{g.dataset.empty='1';g.textContent=tr('No goal yet.')}}
  const box=document.getElementById('ch-classes');
  if(box){box.dataset.classes=(c.data_classes||[]).join(',');box.replaceChildren();
    if(!(c.data_classes||[]).length){const s=document.createElement('span');s.className='faint';s.textContent=tr('None');box.appendChild(s)}
    else for(const x of c.data_classes){const s=document.createElement('span');s.className='badge';s.textContent=x;box.appendChild(s)}}
  const k=document.getElementById('ch-keep');if(k){k.dataset.days=c.retention_days||'';k.textContent=keepLine(c.retention_days)}
  const pk=document.getElementById('ch-peek');if(pk)pk.textContent=peek(c);
  const ul=document.getElementById('ch-members');
  if(ul){ul.replaceChildren();const ms=c.members||[];
    if(!ms.length){const li=document.createElement('li');li.className='faint';li.textContent=tr('No members');ul.appendChild(li)}
    for(const m of ms){const li=document.createElement('li');li.dataset.user=m.user;li.dataset.role=m.role||'contributor';li.dataset.note=m.note||'';
      const b=document.createElement('b');b.textContent=m.user;li.appendChild(b);
      const r=document.createElement('span');r.className='faint';r.textContent=' '+(roleName[m.role]||m.role||'');li.appendChild(r);
      if(m.note){const n=document.createElement('span');n.className='faint';n.textContent=' · '+m.note;li.appendChild(n)}
      ul.appendChild(li)}}
  if(!chEditing) noteFields(c.members||[]);
}
function noteFields(ms){const box=document.getElementById('ch-notes');if(!box)return;box.replaceChildren();
  for(const m of ms){const row=document.createElement('div');row.className='ch-note';
    const name=document.createElement('span');name.className='xs truncate';name.textContent=m.user;row.appendChild(name);
    const inp=document.createElement('input');inp.className='input grow';inp.maxLength=120;inp.dataset.chUser=m.user;inp.value=m.note||'';inp.setAttribute('aria-label',tr('Note for {name}',{name:m.user}));
    row.appendChild(inp);box.appendChild(row)}}
function openEdit(){if(!CH)return;chEditing=true;const f=document.getElementById('ch-form');if(!f)return;
  document.getElementById('ch-goal-in').value=CH.goal||'';
  document.getElementById('ch-classes-in').value=(CH.data_classes||[]).join(', ');
  document.getElementById('ch-days-in').value=CH.retention_days||'';
  noteFields(CH.members||[]);
  const err=document.getElementById('ch-err');if(err)err.textContent='';
  f.hidden=false;document.getElementById('ch-goal-in').focus()}
document.getElementById('ch-edit')?.addEventListener('click',openEdit);
document.getElementById('ch-cancel')?.addEventListener('click',()=>{chEditing=false;const f=document.getElementById('ch-form');if(f)f.hidden=true});
document.getElementById('ch-form')?.addEventListener('submit',async e=>{e.preventDefault();const err=document.getElementById('ch-err');if(err)err.textContent='';
  const btn=e.target.querySelector('[type=submit]');btn.disabled=true;
  const days=document.getElementById('ch-days-in').value.trim();
  const members=[...document.querySelectorAll('#ch-notes [data-ch-user]')].map(i=>({user:i.dataset.chUser,note:i.value}));
  const body={goal:document.getElementById('ch-goal-in').value,data_classes:document.getElementById('ch-classes-in').value,retention_days:days===''?null:Number(days),members};
  const r=await fetch('/api/boards/'+BOARD+'/charter',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).catch(()=>null);
  const j=r?await r.json().catch(()=>({})):{};btn.disabled=false;
  if(!r||!r.ok){if(err)err.textContent=j.error||tr('Could not save the charter');return}
  chEditing=false;document.getElementById('ch-form').hidden=true;if(j.charter)paint(j.charter);toast(tr('Charter saved'))});
window.charterRefresh=async()=>{let r;try{r=await fetch('/api/boards/'+BOARD+'/charter')}catch(e){return}
  if(!r.ok)return;const j=await r.json().catch(()=>null);if(!j||!j.charter)return;paint(j.charter);
  const edit=document.getElementById('ch-edit');if(edit)edit.hidden=j.can_edit===false}; // the page renders it fresh: no fetch on load
})();
`;
}
