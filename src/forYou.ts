// For you: the home page of Atteo's Everyday mode (board #1272; design: ios/qa/design/everyday, screen "home").
// Plain words for people who aren't developers: what needs your OK (your assistant's approval requests), quick
// decisions and questions waiting on you, what your assistant finished today, and an Ask bar that writes to your
// "Your agent" chat. Everything comes from existing data: approvals (D1), unread inbox rows (D1), and each recent
// board's own state (Board.forYou: open human decisions, open questions naming you, tasks and change cards your agent
// finished). Board content is untrusted: every string from it is escaped here.

import { shownName } from "./names";
import type { Approval } from "./approvals";
import type { InboxItem } from "./inbox";
import { appPage, avatar, directPeer, FY_CSS_SRC, relTime, type SideBoard, type Viewer } from "./ui";
import { esc } from "./util";
import { tr, type Lang } from "./i18n";

/** What one board contributes (computed in the board object). Titles are "" on an encrypted board. */
export interface ForYouCore {
  board: { id: string; title: string; encrypted: boolean };
  decisions: ForYouItem[]; // open human decisions the viewer hasn't voted on, newest first
  questions: ForYouItem[]; // open questions that @mention the viewer (the person), newest first
  done: { seq: number; title: string; kind: "task" | "change"; ts: number }[]; // what the viewer's agent finished since `since`
}
export interface ForYouItem {
  seq: number;
  title: string;
  author: string;
  via: string | null;
  ts: number;
}

export interface ForYouData {
  approvals: Approval[]; // pending, newest first
  boards: ForYouCore[];
  mentions: InboxItem[]; // unread mentions / replies to the viewer (not questions or decisions: those come from the boards)
  now?: number;
}

/** How many boards the page looks at: the most recently active ones (plus any with unread mail for you). */
export const FOR_YOU_BOARDS = 10;
/** Done items are fetched for the last 26 hours; the page keeps the ones from the viewer's own today. */
export const DONE_WINDOW_MS = 26 * 3600_000;

// ---------- words (pure, unit-tested) ----------

/** "Good morning" before noon, "Good afternoon" until 6pm, "Good evening" after (and in the small hours). */
export function greetingFor(hour: number, lang?: Lang): string {
  if (hour < 4 || hour >= 18) return tr(lang, "Good evening");
  return tr(lang, hour < 12 ? "Good morning" : "Good afternoon");
}

/** The name to greet: the whole display name as shown ("The Puppeteer", jxn #4438), else the handle. */
export function firstName(v: Pick<Viewer, "name" | "display_name">): string {
  return shownName(v.name, v.display_name);
}

/** The line under the greeting: "3 things need you. Your assistant did 5 more." */
export function summaryLine(need: number, done: number, lang?: Lang): string {
  const a = need ? tr(lang, need === 1 ? "{n} thing needs you." : "{n} things need you.", { n: need }) : tr(lang, "You're all caught up.");
  if (!done) return a;
  // Two sentences: a space between them in English, none in Chinese ("{a} {b}" in the tables).
  return tr(lang, "{a} {b}", { a, b: need ? tr(lang, "Your assistant did {n} more.", { n: done }) : tr(lang, done === 1 ? "Your assistant did {n} thing for you today." : "Your assistant did {n} things for you today.", { n: done }) });
}

/** "vedu" → "Vedu" (handles are lowercase; Everyday writes names like names). */
export const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** Who wrote it, in Everyday words: "Your assistant", "Sam's assistant", "Sam" (or "You"). */
export function whoLabel(author: string, via: string | null | undefined, me: string, lang?: Lang): string {
  if (via === "agent") return author === me ? tr(lang, "Your assistant") : tr(lang, "{name}'s assistant", { name: cap(author) });
  return author === me ? tr(lang, "You") : cap(author);
}

/** A board as a chat: "Your agent" is "Your assistant", a direct board is the other person, else its title. */
export function chatLabel(b: Pick<SideBoard, "title" | "kind"> | null | undefined, me: string, lang?: Lang): string {
  if (!b) return tr(lang, "a chat");
  if (b.kind === "agent") return tr(lang, "Your assistant");
  if (b.kind === "direct") return cap(directPeer(b as SideBoard, me));
  return b.title;
}

/** One plain sentence from a post's first line: leading @mentions and markdown marks dropped, first letter capitalized. */
export function plainTitle(s: string, fallback = "A message for you"): string {
  let t = (s ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  t = t.replace(/^(#{1,6}\s+|[-*>]\s+)/, "").replace(/\*\*|__/g, "");
  t = t.replace(/^((?:@[\w.-]+(?:\/[\w.-]+)?(?:['’]s (?:agent|assistant))?)[,:]?\s+)+/i, "").trim();
  if (!t) return fallback;
  t = t.length > 160 ? t.slice(0, 159) + "…" : t;
  return t[0].toUpperCase() + t.slice(1);
}

/** The "Approve" button names an amount when the request has one: "Pay $42 to Lisa?" → "Approve $42". */
export function approveLabel(title: string, lang?: Lang): string {
  const m = (title ?? "").match(/[$€£]\s?\d[\d,]*(?:\.\d{1,2})?/);
  return m ? tr(lang, "Approve {amount}", { amount: m[0].replace(/\s/, "") }) : tr(lang, "Approve");
}

/** Up to `max` short lines from an approval's details: "From: Visa ··4821" splits into a label and a value. */
export function detailLines(details: string, max = 3): { label?: string; text: string }[] {
  const lines = (details ?? "")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, max);
  return lines.map((l) => {
    const cut = l.length > 140 ? l.slice(0, 139) + "…" : l;
    const m = cut.match(/^([A-Za-z][A-Za-z '.-]{0,23}):\s+(.+)$/);
    return m ? { label: m[1], text: m[2] } : { text: cut };
  });
}

// ---------- the page ----------


export function forYouPage(viewer: Viewer, side: SideBoard[], d: ForYouData): Response {
  const L = viewer.lang,
    T = (x: string, v?: Record<string, string | number>) => tr(L, x, v);
  const me = viewer.name;
  const now = d.now ?? Date.now();
  const byId = new Map(side.map((b) => [b.id, b]));
  const chatOf = (id: string | null | undefined, title?: string | null) => (id && byId.has(id) ? chatLabel(byId.get(id), me, L) : title ? title : T("a chat"));
  const agentChat = side.find((b) => b.kind === "agent")?.id ?? "";

  // 1. Needs your OK: every pending approval as a card; the first shows, the rest wait their turn (a peek of the stack).
  const aps = d.approvals.slice(0, 20);
  const apCards = aps
    .map((a, i) => {
      const where = a.board_id ? ` ${esc(T("asked in"))} <a href="/b/${esc(a.board_id)}${a.seq ? `#e${a.seq}` : ""}">${esc(chatOf(a.board_id))}</a>` : ` ${esc(T("asked"))}`;
      const forWhom = a.requested_by && a.requested_by !== me ? ` ${esc(T("for {name}", { name: cap(a.requested_by) }))}` : "";
      const lines = detailLines(a.details);
      const det = lines.length
        ? `<div class="det">${lines.map((l) => (l.label ? `<div class="ln"><span>${esc(l.label)}</span><span>${esc(l.text)}</span></div>` : `<div class="ln"><span class="one">${esc(l.text)}</span></div>`)).join("")}</div>`
        : "";
      return `<article class="nc fy-apc" data-ap="${esc(a.id)}"${i ? " hidden" : ""} aria-label="${esc(T("Needs your OK"))}">
<div class="type"><span class="dot"></span>${esc(T("Needs your OK"))} <b>· <span class="fy-pos">${i + 1}</span> ${esc(T("of"))} <span class="fy-tot">${aps.length}</span></b></div>
<h2 class="tt">${esc(plainTitle(a.title, T("Your assistant wants to do something")))}</h2>
<div class="who">${avatar(me, "sm", true)}<span><b>${esc(T("Your assistant"))}</b>${where}${forWhom} · <span class="faint">${esc(relTime(a.created_at, now, L))}</span></span></div>
${det}<div class="acts"><button class="btn xl" type="button" data-fy-ap="reject">${esc(T("Not now"))}</button><button class="btn xl primary" type="button" data-fy-ap="approve">${esc(approveLabel(a.title, L))}</button></div></article>`;
    })
    .join("");
  const okSec = aps.length
    ? `<section class="fy-ok" id="fy-ok">${apCards}<div class="stack-edge" id="fy-edge1"${aps.length > 1 ? "" : " hidden"}></div><div class="stack-edge" id="fy-edge2"${aps.length > 2 ? "" : " hidden"}></div>
<p class="fy-more" id="fy-more"${aps.length > 1 ? "" : " hidden"}><a class="link" href="/approvals">${esc(T("See all"))} <span id="fy-more-n">${aps.length}</span></a></p></section>`
    : "";

  // 2. Quick decisions and questions: decisions take a vote right here; questions and mentions open in their chat.
  const seen = new Set<string>();
  type Row = { ts: number; html: string };
  const rows: Row[] = [];
  for (const b of d.boards) {
    const chat = chatOf(b.board.id, b.board.title);
    for (const x of b.decisions) {
      seen.add(`${b.board.id}:${x.seq}`);
      rows.push({
        ts: x.ts,
        html: `<div class="item nrow k-decide" data-hd-board="${esc(b.board.id)}" data-hd-seq="${x.seq}"><div class="grow"><a class="tt" href="/b/${esc(b.board.id)}#e${x.seq}">${esc(plainTitle(x.title, T("A decision for you")))}</a><div class="sub">${esc(whoLabel(x.author, x.via, me, L))} · ${esc(chat)}</div></div><span class="fy-acts"><button class="btn" type="button" data-fy-vote="agree">${esc(T("Agree"))}</button><button class="btn" type="button" data-fy-vote="object">${esc(T("Object"))}</button></span></div>`,
      });
    }
    for (const x of b.questions) {
      seen.add(`${b.board.id}:${x.seq}`);
      rows.push({
        ts: x.ts,
        html: `<div class="item nrow k-reply"><div class="grow"><a class="tt" href="/b/${esc(b.board.id)}#e${x.seq}">${esc(plainTitle(x.title, T("A question for you")))}</a><div class="sub">${esc(whoLabel(x.author, x.via, me, L))} · ${esc(chat)}</div></div><span class="fy-acts"><a class="btn" href="/b/${esc(b.board.id)}#e${x.seq}">${esc(T("Reply"))}</a></span></div>`,
      });
    }
  }
  for (const m of d.mentions) {
    const k = `${m.board_id}:${m.seq}`;
    if (seen.has(k)) continue;
    seen.add(k);
    rows.push({
      ts: m.created_at,
      html: `<div class="item nrow k-reply"><div class="grow"><a class="tt" href="/b/${esc(m.board_id)}#e${m.seq}">${esc(plainTitle(m.excerpt, T("A message for you")))}</a><div class="sub">${esc(whoLabel(m.actor, m.actor_via, me, L))} · ${esc(chatOf(m.board_id, m.board_title))}</div></div><span class="fy-acts"><a class="btn" href="/b/${esc(m.board_id)}#e${m.seq}">${esc(T("Reply"))}</a></span></div>`,
    });
  }
  rows.sort((a, b) => b.ts - a.ts);
  const quick = rows.slice(0, 12);
  const quickSec = quick.length ? `<section class="list fy-quick" id="fy-quick" aria-label="${esc(T("Decisions and questions for you"))}">${quick.map((r) => r.html).join("")}</section>` : "";

  // 3. Done for you today: the newest first; the page drops what isn't from the viewer's own today and shows three.
  const done = d.boards
    .flatMap((b) => b.done.map((x) => ({ ...x, board: b.board.id, chat: chatOf(b.board.id, b.board.title) })))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 40);
  const doneRows = done
    .map(
      (x) =>
        `<a class="done-i" href="/b/${esc(x.board)}#e${x.seq}" data-ts="${x.ts}"><span class="ck" aria-hidden="true"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6.2l2.3 2.3 4.7-4.9"/></svg></span><span class="grow"><span class="tt">${esc(plainTitle(x.title || T(x.kind === "task" ? "Finished a to-do" : "Finished a change")))}</span><span class="sub">${esc(x.chat)} · <time data-at="${x.ts}">${esc(relTime(x.ts, now, L))}</time></span></span></a>`,
    )
    .join("");
  const doneSec = `<section class="fy-done" id="fy-done"${done.length ? "" : " hidden"}><div class="sec"><h2>${esc(T("Done for you today"))} <span class="faint">· <span id="fy-done-n">${done.length}</span></span></h2><button class="link" type="button" id="fy-done-all"${done.length > 3 ? "" : " hidden"}>${esc(T("See all"))}</button></div>
<div class="list" id="fy-done-list">${doneRows}</div></section>`;

  const need = aps.length + quick.length;
  const empty = `<div class="card empty fy-empty" id="fy-empty"${need ? " hidden" : ""}><h3>${esc(T("Nothing needs you right now"))}</h3><p class="muted">${esc(T("When your assistant needs your OK, or someone asks you something, it shows up here."))}</p></div>`;

  const body = `<div class="fy" id="fy">
<header class="fy-hi"><h1 id="fy-greet" data-name="${esc(firstName(viewer))}">${esc(greetingFor(new Date(now).getUTCHours(), L))}, ${esc(firstName(viewer))}</h1>
<p class="lede" id="fy-lede">${esc(summaryLine(need, done.length, L))}</p></header>
${okSec}${quickSec}${empty}${doneSec}
</div>
<div class="fy-askwrap"><form class="card composer fy-ask" id="fy-ask" autocomplete="off"><input class="grow" id="fy-ask-text" name="text" placeholder="${esc(T("Ask your assistant…"))}" aria-label="${esc(T("Ask your assistant"))}" maxlength="4000" enterkeyhint="send">
<button class="btn primary sm post-btn" type="submit" id="fy-send" hidden>${esc(T("Send"))}</button>
<button class="btn sm mic-btn" type="button" id="fy-mic" aria-label="${esc(T("Talk"))}" aria-pressed="false" title="${esc(T("Talk to your assistant (say “send it” at the end to send)"))}" hidden><svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><rect x="5.5" y="1.8" width="5" height="8.2" rx="2.5"/><path d="M3.2 7.6a4.8 4.8 0 0 0 9.6 0M8 12.4v2"/></svg></button></form>
<div class="fy-toast" id="fy-toast" role="status" aria-live="polite" hidden><span>${esc(T("Sent to your assistant"))}</span><a class="link" id="fy-toast-a" href="${agentChat ? `/b/${esc(agentChat)}` : "/agent"}">${esc(T("Open chat"))}</a></div></div>`;

  const chats = side.length;
  const actions = `<a class="btn sm" href="/">${esc(T("Chats"))} <span class="faint">${chats}</span></a>`;
  return appPage(`${T("For you")} · Atteo`, { viewer, boards: side, active: "foryou", crumbs: `<span class="cur">${esc(T("For you"))}</span>`, actions, body, script: forYouJs(agentChat), narrow: true, css: [FY_CSS_SRC] });
}

/** Page script: local-time greeting and "today", approve / not now, decision votes, and the Ask bar (with the mic). */
function forYouJs(agentChat: string): string {
  return `
(()=>{const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
// The viewer's own clock: the greeting, which done items are from today, and their times.
const g=$('#fy-greet');if(g){const h=new Date().getHours();g.textContent=(h<4||h>=18?tr('Good evening'):h<12?tr('Good morning'):tr('Good afternoon'))+', '+g.dataset.name}
const mid=new Date();mid.setHours(0,0,0,0);
$$('.done-i[data-ts]').forEach(r=>{if(+r.dataset.ts<mid.getTime())r.remove()});
$$('time[data-at]').forEach(t=>{try{t.textContent=new Date(+t.dataset.at).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}catch(e){}});

function counts(){const aps=$$('.fy-apc'),rows=$$('.fy-quick .nrow:not(.voted)'),done=$$('.done-i');
  const need=aps.length+rows.length,m=done.length;
  const a=need?tr(need===1?'{n} thing needs you.':'{n} things need you.',{n:need}):tr("You're all caught up.");
  $('#fy-lede').textContent=m?tr('{a} {b}',{a,b:need?tr('Your assistant did {n} more.',{n:m}):tr(m===1?'Your assistant did {n} thing for you today.':'Your assistant did {n} things for you today.',{n:m})}):a;
  aps.forEach((c,i)=>{c.hidden=i>0;c.querySelector('.fy-pos').textContent=i+1;c.querySelector('.fy-tot').textContent=aps.length});
  const e1=$('#fy-edge1'),e2=$('#fy-edge2'),more=$('#fy-more');if(e1)e1.hidden=aps.length<2;if(e2)e2.hidden=aps.length<3;if(more){more.hidden=aps.length<2;$('#fy-more-n').textContent=aps.length}
  const ok=$('#fy-ok');if(ok&&!aps.length)ok.hidden=true;const q=$('#fy-quick');if(q&&!$$('.fy-quick .nrow').length)q.hidden=true;
  $('#fy-empty').hidden=!!need;
  $('#fy-done').hidden=!m;$('#fy-done-n').textContent=m;done.forEach((r,i)=>r.classList.toggle('more',i>=3));$('#fy-done-all').hidden=m<=3}
counts();
$('#fy-done-all').addEventListener('click',e=>{const s=$('#fy-done'),all=s.classList.toggle('all');e.currentTarget.textContent=all?tr('Show less'):tr('See all')});
// Needs your OK: Approve or Not now (deny), through the same API as the Approvals page; the next one moves up.
document.addEventListener('click',async e=>{const b=e.target.closest('[data-fy-ap]');if(!b)return;const c=b.closest('.fy-apc'),yes=b.dataset.fyAp==='approve';
  c.querySelectorAll('[data-fy-ap]').forEach(x=>x.disabled=true);
  const r=await fetch('/api/approvals/'+encodeURIComponent(c.dataset.ap)+'/'+(yes?'approve':'reject'),{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).catch(()=>null);
  const j=r?await r.json().catch(()=>({})):{error:"Couldn't reach Atteo. Try again."};
  if(!r||!r.ok){toast(j.error||tr('Could not save'));c.querySelectorAll('[data-fy-ap]').forEach(x=>x.disabled=false);return}
  toast(yes?tr('Approved'):tr('OK, not now'));c.remove();counts()});
// Decisions: Agree / Object, the same vote as on the chat's decision card.
document.addEventListener('click',async e=>{const b=e.target.closest('[data-fy-vote]');if(!b)return;const row=b.closest('[data-hd-seq]'),v=b.dataset.fyVote;
  row.querySelectorAll('[data-fy-vote]').forEach(x=>x.disabled=true);
  const r=await fetch('/api/boards/'+encodeURIComponent(row.dataset.hdBoard)+'/entries/'+row.dataset.hdSeq+'/vote',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({vote:v})}).catch(()=>null);
  const j=r?await r.json().catch(()=>({})):{error:"Couldn't reach Atteo. Try again."};
  if(!r||!r.ok){toast(j.error||tr('Could not save'));row.querySelectorAll('[data-fy-vote]').forEach(x=>x.disabled=false);return}
  row.classList.add('voted');row.querySelector('.fy-acts').textContent=v==='agree'?tr('✓ You agreed'):tr('You objected');counts()});
// Ask your assistant: posts to your "Your agent" chat (made on first use), then says so with a link to it.
let CHAT=${JSON.stringify(agentChat)};
const f=$('#fy-ask'),ta=$('#fy-ask-text'),send=$('#fy-send'),mic=$('#fy-mic'),tst=$('#fy-toast');let tt=null;
const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
function sync(){const t=!!ta.value.trim();send.hidden=!!SR&&!t&&!rec;if(SR)mic.hidden=t&&!rec} // like the chat composer: the mic, or Send once there's text
var rec=null;
ta.addEventListener('input',sync);
f.addEventListener('submit',async e=>{e.preventDefault();const text=ta.value.trim();if(!text)return;if(rec){try{rec.stop()}catch(x){}}
  send.disabled=true;ta.disabled=true;
  try{if(!CHAT){const r=await fetch('/api/me/agent-chat',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});const j=await r.json().catch(()=>({}));if(!r.ok||!j.board)throw new Error(j.error||tr("Couldn't open your assistant's chat"));CHAT=j.board}
    const r=await sendReliably('/api/boards/'+CHAT+'/entries',{text});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||tr('Could not send'));
    ta.value='';$('#fy-toast-a').href='/b/'+CHAT;tst.hidden=false;clearTimeout(tt);tt=setTimeout(()=>{tst.hidden=true},6000)}
  catch(x){toast(x.message||tr('Could not send'))}
  finally{send.disabled=false;ta.disabled=false;sync();ta.focus()}});
// The mic: Web Speech, like the chat composer's (hidden where the browser can't); "send it" at the end sends.
// With nothing typed it opens Ask, the voice-first page, already listening (#1273 part 4); with words in the box it dictates the rest here.
if(SR){mic.hidden=false;mic.addEventListener('click',()=>{if(rec){try{rec.stop()}catch(e){}return}if(!ta.value.trim()){location.href='/ask?talk=1';return}
  const base=ta.value.trim()?ta.value.replace(/[ ]+$/,'')+' ':'';let fin='';
  rec=new SR();rec.lang=navigator.language||'en-US';rec.interimResults=true;rec.continuous=true;mic.setAttribute('aria-pressed','true');mic.classList.add('on');
  rec.onresult=ev=>{let midT='';for(let i=ev.resultIndex;i<ev.results.length;i++){const r=ev.results[i];if(r.isFinal)fin+=r[0].transcript;else midT+=r[0].transcript}
    const go=/(^|[ ,.])send it[.!]?$/i.test(fin.trim());
    ta.value=base+(go?fin.trim().replace(/[ ,.]*send it[.!]?$/i,''):(fin+midT).trim());sync();
    if(go){try{rec.stop()}catch(e){}if(ta.value.trim())f.requestSubmit()}};
  rec.onerror=ev=>{const e=ev.error;if(e==='not-allowed'||e==='service-not-allowed')toast(tr('The microphone is blocked: allow it for this site to talk'));else if(e==='audio-capture'||e==='no-speech')toast(tr("No sound from the microphone: pick the right one for this site in your browser's settings"));else if(e==='network')toast(tr("Speech recognition can't reach its service: check your connection and try again"))};
  rec.onend=()=>{rec=null;mic.setAttribute('aria-pressed','false');mic.classList.remove('on');sync()};
  try{rec.start()}catch(e){rec=null}})}
sync();
})();`;
}
