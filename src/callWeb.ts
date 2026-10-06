// Board calls on the web (vedu #5383; the server is src/calls.ts). A Call button in a board's header loads /call.js
// (only then: the board page carries just CALL_LOADER_JS) and opens the call in a dialog; /b/:id/call is the same call on
// a page of its own (the app opens that one). The page sends its mic to the SFU (Cloudflare Realtime) and plays the
// others'; with the stub room (a localhost server with no Realtime app) it shows who's in and skips audio.
//
// Ask Atteo: the server gives this person the Atteo turn (one at a time) and a voice session (src/voice.ts, the same
// minutes as Talk); only then does their mic reach xAI, for one question. Atteo's answer plays here and goes into the
// room as their "atteo" track. "Listen for Atteo" (off unless ticked) uses the browser's speech recognition: words said
// to Atteo (callAddressed, the same rule as calls.ts addressesAtteo) are sent as text, and nothing else is.

import { esc } from "./util";
import { fnv } from "./codecolor";

const PEOPLE = `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="6" cy="5.5" r="2.5"/><path d="M1.5 13.5c.5-2.5 2.3-4 4.5-4s4 1.5 4.5 4"/><path d="M10.5 3.2a2.5 2.5 0 0 1 0 4.6M12 9.8c1.3.5 2.2 1.8 2.5 3.7"/></svg>`;

/** The header's Call button (a board that isn't encrypted or your agent chat). */
export function callBtn(board: string): string {
  return `<button class="btn ghost sm bcall-btn" type="button" data-call="${esc(board)}" aria-label="Call" title="Call (up to 4 people)">${PEOPLE}</button>`;
}

// The words-to-Atteo rule, as page script (test/calls.test.ts checks it against calls.ts addressesAtteo).
export const CALL_GATE_JS = String.raw`
function callAddressed(text){var t=String(text==null?'':text).toLowerCase().normalize('NFKC').replace(/[’‘]/g,"'").trim();if(!t)return false;
  var N="@?(?:atteo|ateo|a teo|attayo|ateyo)";
  if(new RegExp("^[\\s\"'(\\[]*(?:(?:hey|hi|hello|ok|okay|so|and|um|uh|yo|right)[\\s,.!]+)*"+N+"(?!['\\w])").test(t))return true;
  return new RegExp(",\\s*"+N+"\\s*[?.!]*\\s*$").test(t)}
`;

export const CALL_CSS = `
.call{display:flex;flex-direction:column;gap:10px;padding:16px}
.call-hd{display:flex;align-items:center;gap:10px}.call-hd b{font-size:15px}.call-hd .grow{flex:1}.call-len{font-size:12.5px;color:var(--faint);font-variant-numeric:tabular-nums}
.call-people{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;min-height:28px}
.call-people li{display:flex;align-items:center;gap:8px;font-size:14px}.call-people .tag{font-size:12px;color:var(--faint)}.call-people .atteo{color:var(--voice,var(--accent))}
.call-st{margin:0;font-size:13.5px;color:var(--text);min-height:1.4em}.call-st.err{color:var(--danger)}
.call-qa{font-size:13.5px;color:var(--text);max-height:160px;overflow:auto;margin:0}
.call-ft{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.call-ft label{display:flex;gap:6px;align-items:center;font-size:13px;color:var(--text)}
.call-ft .btn.danger{background:var(--danger);border-color:var(--danger);color:var(--on-ink)}
.call-ft .btn[aria-pressed="true"]{background:var(--bg-hover);color:var(--danger)}
dialog.call-dlg{width:min(420px,calc(100vw - 24px));padding:0;border:1px solid var(--line);border-radius:16px;background:var(--bg);color:var(--ink);box-shadow:var(--shadow-lg)}
dialog.call-dlg::backdrop{background:rgba(0,0,0,.25)}
.bcall-btn.in-call{color:var(--accent)}
`;

export const CALL_JS = String.raw`(()=>{
if(window.atteoCall)return;
${CALL_GATE_JS}
const RATE=24000;let C=null; // the call this page is in (or looking at)
const $=id=>document.getElementById(id),h=s=>String(s).replace(/[&<>"']/g,c=>'&#'+c.charCodeAt(0)+';');
function api(sub,body){return fetch('/api/boards/'+encodeURIComponent(C.board)+'/call'+(sub?'/'+sub:''),body===undefined?{cache:'no-store'}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
  .then(async r=>{const j=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(new Error(j.error||('Error '+r.status)),{j,status:r.status});return j})}
function say(msg,bad){const s=$('call-st');if(s){s.textContent=msg||'';s.classList.toggle('err',!!bad)}}
function mount(root,board){C={board,root,joined:false,st:null,timer:0,pc:null,mic:null,q:Promise.resolve(),pulled:new Set(),turn:null,ac:null,dest:null,atteoPub:false,rec:null};
  root.innerHTML='<div class="call" data-call-panel><div class="call-hd"><b>Call</b><span class="grow"></span><span class="call-len" id="call-len"></span></div>'+
  '<ul class="call-people" id="call-people" aria-label="In the call"></ul><p class="call-st" id="call-st" role="status" aria-live="polite"></p><p class="call-qa" id="call-qa" hidden></p>'+
  '<div class="call-ft"><button class="btn primary" type="button" id="call-join">Join call</button><button class="btn" type="button" id="call-mute" aria-pressed="false" hidden>Mute</button>'+
  '<button class="btn" type="button" id="call-ask" hidden>Ask Atteo</button><label id="call-wake-l" hidden><input type="checkbox" id="call-wake"> Listen for “Atteo, …”</label>'+
  '<button class="btn danger" type="button" id="call-leave" hidden>Leave</button></div><div id="call-audio" hidden></div></div>';
  $('call-join').onclick=join;$('call-leave').onclick=()=>leave();$('call-ask').onclick=()=>ask(null);
  $('call-mute').onclick=()=>{const b=$('call-mute'),on=b.getAttribute('aria-pressed')!=='true';b.setAttribute('aria-pressed',String(on));b.textContent=on?'Unmute':'Mute';if(C.mic)C.mic.getAudioTracks().forEach(t=>t.enabled=!on)};
  $('call-wake').onchange=e=>e.target.checked?wakeOn():wakeOff();
  if(!(window.SpeechRecognition||window.webkitSpeechRecognition))$('call-wake-l').remove();
  api().then(render).catch(e=>say(e.message,true))}
function render(st){if(!C)return;C.st=st;const c=st.call,ul=$('call-people');
  const people=c?c.members:[];ul.innerHTML=people.length?people.map(m=>'<li data-user="'+h(m.user)+'"><b>'+h(m.user)+'</b>'+(m.you?' <span class="tag">(you)</span>':'')+(c.atteo&&c.atteo.holder===m.user?' <span class="tag atteo">asking Atteo</span>':'')+'</li>').join(''):'<li class="tag">Nobody is in a call here.</li>';
  $('call-join').textContent=c?'Join call':'Start a call';$('call-join').hidden=C.joined;
  ['call-leave','call-mute','call-ask','call-wake-l'].forEach(id=>{const e=$(id);if(e)e.hidden=!C.joined});
  $('call-ask').disabled=!!(c&&c.atteo&&c.atteo.holder!==mine())||!!C.turn;
  if(st.stub&&C.joined&&!C.saidStub){C.saidStub=1;say('Test room: no audio on this server (no Cloudflare Realtime app). Who’s in and Ask Atteo still work.')}
  document.querySelectorAll('[data-call]').forEach(b=>b.classList.toggle('in-call',C.joined));
  if(C.joined&&!st.stub&&c)c.members.forEach(m=>{if(!m.you)m.tracks.forEach(t=>pull(m.user,t,m.joined_at))})}
function mine(){const c=C.st&&C.st.call;const m=c&&c.members.find(x=>x.you);return m?m.user:null}
function tick(){const c=C&&C.st&&C.st.call;if(c){const s=Math.max(0,Math.floor((Date.now()-c.started_at)/1000));$('call-len').textContent=Math.floor(s/60)+':'+String(s%60).padStart(2,'0')}else $('call-len').textContent=''}
async function join(){say('Joining…');let st;try{st=await api('join',{})}catch(e){return say(e.message,true)}
  C.joined=true;render(st);C.timer=setInterval(()=>{api('ping',{}).then(render).catch(()=>{});tick()},2000);tick();
  if(!st.stub)try{await media()}catch(e){say(e&&e.name==='NotAllowedError'?'The microphone is blocked. Allow it for this site to talk in the call.':'Audio couldn’t start: '+(e.message||e),true)}
  else if(!C.saidStub)render(st)}
async function leave(quiet){if(!C||!C.joined)return;C.joined=false;clearInterval(C.timer);wakeOff();if(C.turn)C.turn.end();
  try{C.pc&&C.pc.close()}catch(e){}C.pc=null;if(C.mic)C.mic.getTracks().forEach(t=>t.stop());C.mic=null;C.pulled.clear();$('call-audio').innerHTML='';
  if(quiet){try{navigator.sendBeacon('/api/boards/'+encodeURIComponent(C.board)+'/call/leave','{}')}catch(e){}return}
  try{render(await api('leave',{}));say('You left the call.')}catch(e){say(e.message,true)}}
// ---- audio through the SFU: publish once, pull each new track ----
async function media(){C.mic=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
  const pc=C.pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.cloudflare.com:3478'}],bundlePolicy:'max-bundle'});
  pc.ontrack=e=>{const a=document.createElement('audio');a.autoplay=true;a.srcObject=new MediaStream([e.track]);$('call-audio').appendChild(a)};
  await publish(C.mic.getAudioTracks()[0],'mic');say('')}
function publish(track,name){return C.q=C.q.then(async()=>{const pc=C.pc;if(!pc)return;const tr=pc.addTransceiver(track,{direction:'sendonly'});
  await pc.setLocalDescription(await pc.createOffer());const r=await api('sfu',{op:'publish',sdp:pc.localDescription.sdp,tracks:[{mid:tr.mid,trackName:name}]});
  await pc.setRemoteDescription(r.sessionDescription)})}
function pull(user,name,at){const k=user+'/'+name+'/'+at;if(C.pulled.has(k)||!C.pc)return;C.pulled.add(k);
  C.q=C.q.then(async()=>{const pc=C.pc;if(!pc)return;const r=await api('sfu',{op:'pull',tracks:[{user,trackName:name}]});
    if(r.requiresImmediateRenegotiation){await pc.setRemoteDescription(r.sessionDescription);await pc.setLocalDescription(await pc.createAnswer());await api('sfu',{op:'renegotiate',sdp:pc.localDescription.sdp})}
  }).catch(e=>{C.pulled.delete(k);console.warn('pull',e)})}
// ---- the Atteo turn ----
async function ask(text){if(C.turn)return;say(text?'Asking Atteo: “'+text+'”':'Ask Atteo now…');let j;
  try{j=await api('atteo',{op:'ask',...(text?{text}:{})})}catch(e){return say(e.j&&e.j.needs_consent?'Turn on Talk to Atteo first: it asks your OK to send your voice to xAI.':e.message,true)}
  const t=C.turn={q:text||'',a:'',opened:Date.now(),ws:null,proc:null,done:false,end:null,playUntil:0};render(C.st);
  try{if(!C.ac||C.ac.state==='closed'){C.ac=new (window.AudioContext||window.webkitAudioContext)();C.dest=C.ac.createMediaStreamDestination()}C.ac.resume&&C.ac.resume().catch(()=>{});
    if(C.pc&&!C.atteoPub){C.atteoPub=true;publish(C.dest.stream.getAudioTracks()[0],'atteo').catch(e=>console.warn('atteo track',e))}}catch(e){}
  const finish=async()=>{if(t.done)return;t.done=true;clearTimeout(t.cap);try{t.ws&&t.ws.close()}catch(e){}if(t.proc)try{t.proc.disconnect()}catch(e){}
    C.turn=null;const secs=Math.round((Date.now()-t.opened)/1000);
    try{await api('atteo',{op:'done',seconds:secs,question:t.q,answer:t.a})}catch(e){}
    if(t.a){const p=$('call-qa');p.hidden=false;p.textContent='Atteo: '+t.a}say('');if(C.st)render(C.st)};
  t.end=finish;t.cap=setTimeout(finish,Math.min(+j.max_seconds||120,120)*1000);
  try{t.ws=new WebSocket(j.url,j.protocols||[])}catch(e){say('The voice connection couldn’t open.',true);return finish()}
  t.ws.onopen=()=>{t.ws.send(JSON.stringify({type:'session.update',session:j.session}));
    if(text){t.ws.send(JSON.stringify({type:'conversation.item.create',item:{type:'message',role:'user',content:[{type:'input_text',text}]}}));t.ws.send(JSON.stringify({type:'response.create'}))}
    else if(C.ac&&C.mic){const src=C.ac.createMediaStreamSource(C.mic),proc=C.ac.createScriptProcessor(4096,1,1),mute=C.ac.createGain();mute.gain.value=0;const ratio=C.ac.sampleRate/RATE;
      proc.onaudioprocess=ev=>{if(t.done||t.answering)return;const x=ev.inputBuffer.getChannelData(0),n=Math.floor(x.length/ratio),out=new Int16Array(n);
        for(let i=0;i<n;i++){const v=x[Math.floor(i*ratio)]||0;out[i]=Math.max(-1,Math.min(1,v))*0x7fff}
        const u=new Uint8Array(out.buffer);let s='';for(let i=0;i<u.length;i+=0x8000)s+=String.fromCharCode.apply(null,u.subarray(i,i+0x8000));
        if(t.ws.readyState===1)t.ws.send(JSON.stringify({type:'input_audio_buffer.append',audio:btoa(s)}))};
      src.connect(proc);proc.connect(mute);mute.connect(C.ac.destination);t.proc=proc;say('Atteo is listening to you (only you)…')}};
  t.ws.onmessage=m=>{let e;try{e=JSON.parse(m.data)}catch(x){return}const ty=e.type||'';
    if(ty==='conversation.item.input_audio_transcription.completed')t.q=e.transcript||t.q;
    else if(ty==='response.created'){t.answering=true;say('Atteo is answering…')}
    else if(ty==='response.output_audio.delta'||ty==='response.audio.delta')play(t,e.delta);
    else if(ty==='response.output_audio_transcript.delta'||ty==='response.audio_transcript.delta')t.a+=e.delta||'';
    else if(ty==='response.done'){const wait=Math.max(0,(t.playUntil-(C.ac?C.ac.currentTime:0))*1000);setTimeout(finish,wait+300)}
    else if(ty==='error'){say((e.error&&e.error.message)||'Atteo couldn’t answer.',true);finish()}};
  t.ws.onclose=()=>{if(!t.done&&!t.answering)finish()}}
function play(t,data){const ac=C.ac;if(!ac||!data)return;const bin=atob(data),n=bin.length>>1;if(!n)return;const buf=ac.createBuffer(1,n,RATE),ch=buf.getChannelData(0);
  for(let i=0;i<n;i++){let v=bin.charCodeAt(2*i)|(bin.charCodeAt(2*i+1)<<8);if(v>=0x8000)v-=0x10000;ch[i]=v/0x8000}
  const src=ac.createBufferSource();src.buffer=buf;src.connect(ac.destination);if(C.dest)src.connect(C.dest);const t0=Math.max(ac.currentTime,t.playUntil);src.start(t0);t.playUntil=t0+n/RATE}
// ---- "Listen for Atteo": the browser's recognizer; only words said to Atteo leave the page, as text ----
function wakeOn(){const R=window.SpeechRecognition||window.webkitSpeechRecognition;if(!R||C.rec)return;const r=C.rec=new R();r.continuous=true;r.interimResults=false;
  r.onresult=e=>{for(let i=e.resultIndex;i<e.results.length;i++){const tx=e.results[i][0].transcript;if(e.results[i].isFinal&&callAddressed(tx)&&!C.turn)ask(tx.trim())}};
  r.onend=()=>{if(C.rec===r)try{r.start()}catch(e){}};try{r.start()}catch(e){}}
function wakeOff(){const r=C&&C.rec;if(!r)return;C.rec=null;try{r.stop()}catch(e){}const w=$('call-wake');if(w)w.checked=false}
addEventListener('pagehide',()=>leave(true));
// The board's dialog (the Call button) or the page of its own (#call-root).
function open(board){let d=document.querySelector('dialog.call-dlg');if(!d){d=document.createElement('dialog');d.className='call-dlg';d.setAttribute('aria-label','Call');document.body.appendChild(d);
  d.innerHTML='<div id="call-host"></div>';mount(d.firstChild,board)}else if(!C.joined)api().then(render).catch(()=>{});if(!d.open)d.showModal()}
window.atteoCall={open,mount,addressed:callAddressed};
const root=document.getElementById('call-root');if(root)mount(root,root.dataset.board);
})();`;

export const CALL_JS_PATH = "/call.js";
export const CALL_JS_SRC = `${CALL_JS_PATH}?v=${fnv(CALL_JS)}`;
export const CALL_CSS_PATH = "/call.css";
export const CALL_CSS_SRC = `${CALL_CSS_PATH}?v=${fnv(CALL_CSS)}`;

/** On the board: the Call button loads /call.js and /call.css the first time it's pressed. */
export const CALL_LOADER_JS = `
document.addEventListener('click',e=>{const b=e.target.closest('[data-call]');if(!b)return;e.preventDefault();const go=()=>window.atteoCall.open(b.dataset.call);
  if(window.atteoCall)return go();if(!document.querySelector('link[data-call-css]')){const l=document.createElement('link');l.rel='stylesheet';l.href=${JSON.stringify(CALL_CSS_SRC)};l.dataset.callCss='1';document.head.appendChild(l)}
  const s=document.createElement('script');s.src=${JSON.stringify(CALL_JS_SRC)};s.onload=go;document.head.appendChild(s)});
`;

/** GET /b/:id/call: the call on a page of its own (the app opens this in a web view). */
export function callPageBody(board: string, title: string): string {
  return `<h1 class="h2" style="margin:16px 16px 0">${esc(title)}</h1><div id="call-root" data-board="${esc(board)}"></div><p class="small" style="margin:0 16px"><a href="/b/${esc(board)}">Back to the board</a></p>`;
}
