// Ask (Everyday mode, part 4 of #1273): a voice-first page for asking your assistant something. Tap the big mic and
// talk (the words appear as you say them), tap again and it goes to your assistant's chat ("Your agent", made on first
// use); the answer shows here and is read aloud. "Type instead" where you'd rather type, or where the browser has no
// speech recognition. Suggestions come from your own chats and friends. Nothing new on the server: the page uses the
// agent chat, posting, entries?after=&wait= and read aloud (/api/app/tts, else the device's voice).

import { appPage, ASK_CSS_SRC, pebble, type SideBoard, type Viewer } from "./ui";
import { esc } from "./util";
import { TALK_JS, talkBtn } from "./talk";

/** Up to four things to try, from the person's own chats (most active first) and friends; generic ones fill the rest. */
export function askSuggestions(me: string, side: SideBoard[]): { icon: "cal" | "chat" | "bell" | "list"; text: string }[] {
  const groups = side.filter((b) => b.kind !== "direct" && b.kind !== "agent");
  const friends = side
    .filter((b) => b.kind === "direct")
    .map((b) => b.title.split("↔").map((x) => x.trim()).find((n) => n && n !== me))
    .filter((n): n is string => !!n);
  const out: { icon: "cal" | "chat" | "bell" | "list"; text: string }[] = [];
  if (friends[0]) out.push({ icon: "cal", text: `Find a time to talk with ${friends[0]} next week` });
  if (groups[0]) out.push({ icon: "chat", text: `What did I miss in ${groups[0].title}?` });
  if (groups[1]) out.push({ icon: "list", text: `What's still open in ${groups[1].title}?` });
  out.push({ icon: "bell", text: "What's waiting for me today?" });
  for (const t of [
    { icon: "list" as const, text: "What did you get done for me today?" },
    { icon: "cal" as const, text: "Remind me tomorrow morning about this week's plans" },
  ])
    if (out.length < 4) out.push(t);
  return out.slice(0, 4);
}

const ICONS: Record<string, string> = {
  cal: '<rect x="2.5" y="3.5" width="11" height="10" rx="2"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3"/>',
  chat: '<path d="M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 2.5v-2.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z"/>',
  bell: '<path d="M4 10.5V7a4 4 0 0 1 8 0v3.5l1 1.5H3zM6.5 13.5a1.5 1.5 0 0 0 3 0"/>',
  list: '<path d="M5.5 4.5h8M5.5 8h8M5.5 11.5h8"/><circle cx="2.8" cy="4.5" r=".6"/><circle cx="2.8" cy="8" r=".6"/><circle cx="2.8" cy="11.5" r=".6"/>',
};
const icon = (k: string, size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k] ?? ""}</svg>`;
const MIC = '<svg width="40" height="40" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><rect x="5.5" y="1.8" width="5" height="8.2" rx="2.5"/><path d="M3.2 7.6a4.8 4.8 0 0 0 9.6 0M8 12.4v2"/></svg>';
const KBD = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><rect x="1.5" y="4" width="13" height="8" rx="1.5"/><path d="M4 6.5h.01M6.5 6.5h.01M9 6.5h.01M11.5 6.5h.01M5 9.5h6"/></svg>';

export function askPage(viewer: Viewer, side: SideBoard[], opts: { assistant: string | null; agentChat: string | null }): Response {
  const name = opts.assistant ? `${opts.assistant} · your assistant` : "Your assistant";
  const sugg = askSuggestions(viewer.name, side);
  const body = `<div class="ask" id="ask">
  <div class="ask-who">${pebble(20)}<span>${esc(name)}</span></div>
  <button type="button" class="ask-mic" id="ask-mic" aria-label="Talk to your assistant" aria-pressed="false"><span class="core">${MIC}</span></button>
  <div class="ask-wave" aria-hidden="true">${"<i></i>".repeat(13)}</div>
  <p class="ask-said" id="ask-said" aria-live="polite">What can I help with?</p>
  <p class="ask-status" id="ask-status" role="status">Tap the circle and say it</p>
  <form class="ask-type" id="ask-type" hidden autocomplete="off"><input class="input" id="ask-text" name="text" maxlength="4000" placeholder="Ask your assistant…" aria-label="Ask your assistant" enterkeyhint="send"><button class="btn primary lg" type="submit">Send</button></form>
  <section class="ask-answer" id="ask-answer" hidden aria-live="polite"><div class="card"><div class="hd"><span class="grow" id="ask-from">Your assistant</span><button type="button" class="btn ghost sm" id="ask-replay" hidden>Read again</button><a class="btn ghost sm" id="ask-open" href="#">Open the chat</a></div><div class="tx" id="ask-tx"></div></div></section>
  <section class="ask-try" id="ask-try"><h2>Or try</h2>${sugg.map((s) => `<button type="button" class="ask-s" data-ask="${esc(s.text)}">${icon(s.icon)}<span>${esc(s.text)}</span></button>`).join("")}</section>
  <div class="ask-foot"><button type="button" class="btn lg" id="ask-mode">${KBD}<span>Type instead</span></button>${talkBtn(null, viewer.name, "btn lg ask-talk")}</div>
</div>`;
  return appPage("Ask · Atteo", {
    viewer,
    boards: side,
    active: "ask",
    crumbs: `<span class="cur">Ask</span>`,
    narrow: true,
    body,
    script: TALK_JS + ASK_JS.replace("__CHAT__", JSON.stringify(opts.agentChat).replace(/</g, "\\u003c")).replace("__ME__", JSON.stringify(viewer.name).replace(/</g, "\\u003c")),
    css: [ASK_CSS_SRC],
  });
}

// The page's script. Plain string (no template interpolation): __CHAT__ and __ME__ are filled in above.
const ASK_JS = String.raw`
(()=>{let CHAT=__CHAT__;const ME=__ME__,$=s=>document.querySelector(s);
const box=$('#ask'),mic=$('#ask-mic'),said=$('#ask-said'),st=$('#ask-status'),form=$('#ask-type'),inp=$('#ask-text'),ans=$('#ask-answer'),tx=$('#ask-tx'),
  open=$('#ask-open'),replay=$('#ask-replay'),mode=$('#ask-mode'),SR=window.SpeechRecognition||window.webkitSpeechRecognition,syn=window.speechSynthesis,LANG=navigator.language||'en-US';
let rec=null,fin='',busy=false,waiting=false,gen=0,last=null,tts=null,audio=null;
const status=t=>{st.textContent=t};
function show(f,m){said.textContent='';said.append(document.createTextNode(f));if(m){const s=document.createElement('span');s.className='mid';s.textContent=(f?' ':'')+m;said.append(s)}}
function typing(on){box.classList.toggle('typing',on);form.hidden=!on;mode.querySelector('span').textContent=on?'Use your voice':'Type instead';mode.hidden=on&&!SR;
  if(on){if(rec)try{rec.abort()}catch(e){}inp.focus();if(!busy&&!waiting)status(SR?'Type it, then Send':'Voice isn’t available in this browser: type it instead')}else if(!busy&&!waiting)status('Tap the circle and say it')}
if(!SR)typing(true);
mode.addEventListener('click',()=>typing(!box.classList.contains('typing')));
// Talk: the words appear as you say them; tap again (or say "send it") and it goes.
mic.addEventListener('click',()=>{if(rec){try{rec.stop()}catch(e){}return}if(busy)return;stopVoice();fin='';
  rec=new SR();rec.lang=LANG;rec.interimResults=true;rec.continuous=true;let go=false;
  rec.onstart=()=>{box.classList.add('listening');mic.setAttribute('aria-pressed','true');show('','');status('Listening… tap the circle when you’re done')};
  rec.onresult=ev=>{let mid='';for(let i=ev.resultIndex;i<ev.results.length;i++){const r=ev.results[i];if(r.isFinal)fin+=r[0].transcript;else mid+=r[0].transcript}
    if(/(^|[ ,.])send it[.!]?$/i.test(fin.trim())){fin=fin.trim().replace(/[ ,.]*send it[.!]?$/i,'');go=true;try{rec.stop()}catch(e){}}show(fin.trim(),go?'':mid.trim())};
  rec.onerror=ev=>{if(ev.error==='not-allowed'||ev.error==='service-not-allowed'){status('The microphone is blocked: allow it for this site, or type instead');typing(true)}};
  rec.onend=()=>{rec=null;box.classList.remove('listening');mic.setAttribute('aria-pressed','false');const t=fin.trim();if(t)send(t);else if(!busy)status('Didn’t catch that. Tap the circle and try again')};
  try{rec.start()}catch(e){rec=null}});
form.addEventListener('submit',e=>{e.preventDefault();const t=inp.value.trim();if(t)send(t)});
document.querySelectorAll('[data-ask]').forEach(b=>b.addEventListener('click',()=>{if(rec)try{rec.abort()}catch(e){}send(b.dataset.ask)}));
// Send to your assistant's chat, then wait for its answer here (a few minutes; after that it's in the chat).
async function send(text){if(busy)return;busy=true;const my=++gen;show(text,'');ans.hidden=true;stopVoice();status('Sending…');
  try{if(!CHAT){const r=await fetch('/api/me/agent-chat',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});const j=await r.json().catch(()=>({}));
      if(!r.ok||!j.board)throw new Error(j.error||'Couldn’t open your assistant’s chat');CHAT=j.board}
    open.href='/b/'+CHAT;
    const r=await sendReliably('/api/boards/'+CHAT+'/entries',{text},()=>status('Still sending…'));const j=await r.json().catch(()=>({}));
    if(!r.ok||!j.entry)throw new Error(j.error||'Couldn’t send it');inp.value='';
    status('Sent. Your assistant is on it…');busy=false;wait(j.entry.seq,my)}
  catch(e){busy=false;status(e.message||'Couldn’t send it. Try again')}}
async function wait(seq,my){let after=seq;const until=Date.now()+180000;waiting=true;try{
  while(my===gen&&Date.now()<until){let d=null;try{const r=await fetch('/api/boards/'+CHAT+'/entries?after='+after+'&wait=25');if(r.ok)d=await r.json()}catch(e){}
    if(my!==gen)return;if(!d){await new Promise(r=>setTimeout(r,3000));continue}after=Math.max(after,d.last||after);
    const a=(d.entries||[]).find(e=>e.via==='agent'&&!e.retracts&&(e.text||'').trim());if(a){answer(a);return}}
  if(my===gen)status('Your assistant hasn’t answered yet. Its answer will be in the chat.'),ans.hidden=true,showOpen()}finally{if(my===gen)waiting=false}}
function showOpen(){if(!CHAT)return;tx.textContent='';ans.hidden=false;$('#ask-from').textContent='Your assistant’s chat';replay.hidden=true}
function answer(e){last=e;ans.hidden=false;const who=bidi(e.agent_name||e.client||'');$('#ask-from').textContent=who?'Your assistant · '+who:'Your assistant';tx.textContent=bidi(e.text);status('');replay.hidden=!syn&&!(tts&&tts.enabled);speak(e)}
// Read aloud: the read-aloud voice when it's on, else the device's.
fetch('/api/app/tts/status').then(r=>r.ok?r.json():null).then(j=>{tts=j}).catch(()=>{});
function stopVoice(){if(audio){audio.pause();audio=null}if(syn)syn.cancel()}
window.voiceHush=()=>{if(rec)try{rec.abort()}catch(e){}stopVoice()}; // Talk to Atteo (talk.ts) takes the mic and the speaker
async function speak(e){stopVoice();const text=(e.text||'').replace(/https?:[^ ]+/g,'a link').slice(0,900);
  if(tts&&tts.enabled){try{const r=await fetch('/api/app/tts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({board:CHAT,seq:e.seq})});
    if(r.ok){audio=new Audio(URL.createObjectURL(await r.blob()));await audio.play();return}}catch(x){}}
  if(!syn)return;const u=new SpeechSynthesisUtterance(text);u.lang=LANG;window.__utt=u;syn.speak(u)}
replay.addEventListener('click',()=>{if(last)speak(last)});
// Opened from For you's mic (/ask?talk=1): listening starts right away; the address goes back to plain /ask.
if(SR&&new URLSearchParams(location.search).has('talk')){history.replaceState(null,'','/ask');setTimeout(()=>mic.click(),0)}
})();`;
