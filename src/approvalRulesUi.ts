// Board info → Approval rules. The server renders the current settings; owners save one row at a time.
import type { Lang } from "./i18n";
import { tr } from "./i18n";
import { esc } from "./util";
import type { Rule } from "./approvalRules";

export function approvalRulesSide(rules: Rule[], canEdit: boolean, lang?: Lang): string {
  const T = (s: string) => esc(tr(lang, s));
  const rows = rules.map(r => `<tr data-rule="${esc(r.category)}"><th scope="row">${esc(r.name)}</th><td>${canEdit ? `<select class="input ar-mode" aria-label="${esc(r.name)}"><option value="ask"${r.mode === "ask" ? " selected" : ""}>${T("Always ask")}</option><option value="auto"${r.mode === "auto" ? " selected" : ""}>${T("Auto-approve")}</option><option value="block"${r.mode === "block" ? " selected" : ""}>${T("Block")}</option></select>` : `<span class="ar-mode-text">${T(r.mode === "ask" ? "Always ask" : r.mode === "auto" ? "Auto-approve" : "Block")}</span>`}${r.category === "spending" ? `<label class="ar-limit">${T("Over $")} ${canEdit ? `<input class="input ar-threshold" type="number" min="0" max="1000000000" step="0.01" value="${r.threshold ?? 0}" aria-label="${T("Spending threshold in dollars")}">` : esc((r.threshold ?? 0).toFixed(2))}</label>` : ""}${canEdit ? `<button class="btn sm ar-save" type="button">${T("Save")}</button>` : ""}${r.set_by ? `<span class="xs faint ar-by">${T("Set by")} ${esc(r.set_by)}</span>` : ""}</td></tr>`).join("");
  return `<div class="ag approval-rules-side" id="approval-rules-side"><section class="fold" data-fold="approval-rules"><h3><button type="button" class="fold-h" aria-expanded="true" aria-controls="fold-approval-rules"><svg class="fold-c" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 3l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="fold-t">${T("Approval rules")}</span></button></h3><div class="fold-b" id="fold-approval-rules"><p class="xs muted">${T("What agents must ask about on this board. Spending at or below the limit is auto-approved. A request without a category always asks.")}</p><table class="ar-table"><thead><tr><th>${T("Action")}</th><th>${T("Rule")}</th></tr></thead><tbody>${rows}</tbody></table><p class="xs ar-error" id="ar-error" role="alert"></p></div></section></div>`;
}

export function approvalRulesJs(): string {
  return `
// Board info: only the owner sees Save. Each change is checked again by the server.
(()=>{const side=document.getElementById('approval-rules-side');if(!side)return;
side.addEventListener('click',async e=>{const b=e.target.closest('.ar-save');if(!b)return;
const row=b.closest('[data-rule]'),cat=row.dataset.rule,mode=row.querySelector('.ar-mode').value;
const threshold=row.querySelector('.ar-threshold');const body={mode,...(threshold?{threshold:Number(threshold.value)}:{})};
const err=document.getElementById('ar-error');err.textContent='';b.disabled=true;
try{const r=await fetch('/api/boards/'+encodeURIComponent(BC.board)+'/approval-rules/'+cat,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
const j=await r.json();if(!r.ok)throw Error(j.error||tr('Could not save'));
let by=row.querySelector('.ar-by');if(!by){by=document.createElement('span');by.className='xs faint ar-by';row.querySelector('td').appendChild(by)}by.textContent=tr('Set by')+' '+j.rule.set_by;
toast(tr('Saved'))}catch(x){err.textContent=x.message||tr('Could not save')}finally{b.disabled=false}})})();`;
}
