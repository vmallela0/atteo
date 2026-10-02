// Voice rooms on a board page. Browsers call each other directly (WebRTC: audio is encrypted peer to peer and never
// passes through the server); the board's WebSocket only relays the connection setup and runs the floor. One person
// holds the floor at a time; others raise a hand and get it in order. Click Talk (or hold Space) to ask for it.
// Kept free of backslashes and template literals: this is inlined into a page script.

/** The bar under the board header: who's in the room, who has the floor, and your controls. */
export const VOICE_HTML = `<style>
.vbtn .vn{font-variant-numeric:tabular-nums}
.vbtn.live{color:var(--ok);border-color:var(--ok)}
.voice-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 12px;margin:0 0 10px;border:1px solid var(--line);border-radius:var(--r);background:var(--bg-subtle)}
.voice-bar[hidden],.voice-bar [hidden]{display:none!important}
.voice-bar .vpeople{display:flex;gap:6px;flex-wrap:wrap;flex:1;min-width:0}
.voice-bar .vp{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:999px;border:1px solid var(--line);background:var(--bg);font-size:12px;white-space:nowrap}
.voice-bar .vp.floor{border-color:var(--ok);color:var(--ok);box-shadow:0 0 0 2px color-mix(in srgb,var(--ok) 25%,transparent)}
.voice-bar .vp .dot{width:7px;height:7px;border-radius:50%;background:var(--faint)}
.voice-bar .vp.floor .dot{background:var(--ok);animation:vpulse 1s ease-in-out infinite}
.voice-bar .vp .q{color:var(--warn);font-weight:600}
.voice-bar .vstatus{font-size:12px;color:var(--muted)}
.voice-bar .vtalk[aria-pressed=true]{background:var(--ok);border-color:var(--ok);color:var(--on-ink)}
@keyframes vpulse{50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){.voice-bar .vp.floor .dot{animation:none}}
</style>
<div class="voice-bar" id="voice-bar" hidden role="region" aria-label="Voice room">
  <div class="vpeople" id="voice-people" aria-live="polite"></div>
  <span class="vstatus" id="voice-status"></span>
  <button class="btn sm vtalk" type="button" id="voice-talk" aria-pressed="false" title="Ask for the floor (or hold Space)">Talk</button>
  <button class="btn sm" type="button" id="voice-join">Join voice</button>
  <button class="btn ghost sm" type="button" id="voice-leave" hidden>Leave</button>
</div>`;

/** The header button: opens the room (and shows how many are in it). */
export const VOICE_BUTTON = `<button class="btn ghost sm vbtn" type="button" id="voice-btn" title="Voice room" aria-controls="voice-bar"><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="5.5" y="1.75" width="5" height="8.5" rx="2.5"/><path d="M3 8a5 5 0 0 0 10 0M8 13v1.75"/></svg> Voice <span class="vn" id="voice-n"></span></button>`;

export const VOICE_JS = `
const V={on:false,joining:false,pid:null,stream:null,pcs:{},s:{peers:[],floor:null,queue:[]},open:false};
const VICE=[{urls:'stun:stun.cloudflare.com:3478'},{urls:'stun:stun.l.google.com:19302'}];
const vbar=document.getElementById('voice-bar');
function vsend(o){try{if(ws&&ws.readyState===1){ws.send(JSON.stringify(o));return true}}catch(e){}return false}
function vpc(pid,user){
  const pc=new RTCPeerConnection({iceServers:VICE}),p={pc,user,pending:[],audio:new Audio()};p.audio.autoplay=true;V.pcs[pid]=p;
  if(V.stream)for(const t of V.stream.getTracks())pc.addTrack(t,V.stream);
  pc.onicecandidate=e=>{if(e.candidate)vsend({op:'voice_signal',to:pid,data:{ice:e.candidate}})};
  pc.ontrack=e=>{p.audio.srcObject=e.streams[0];p.audio.play().catch(()=>{})};
  pc.onconnectionstatechange=()=>{if(pc.connectionState==='failed'){vdrop(pid);vrender()}};
  return p}
function vdrop(pid){const p=V.pcs[pid];if(!p)return;try{p.pc.close()}catch(e){}p.audio.srcObject=null;delete V.pcs[pid]}
async function vcall(pid,user){const p=vpc(pid,user);const o=await p.pc.createOffer();await p.pc.setLocalDescription(o);vsend({op:'voice_signal',to:pid,data:{sdp:p.pc.localDescription}})}
async function vsignal(d){if(!V.on)return;let p=V.pcs[d.from];
  try{
    if(d.data&&d.data.sdp){if(!p)p=vpc(d.from,d.user);await p.pc.setRemoteDescription(d.data.sdp);
      for(const c of p.pending.splice(0))await p.pc.addIceCandidate(c).catch(()=>{});
      if(d.data.sdp.type==='offer'){const a=await p.pc.createAnswer();await p.pc.setLocalDescription(a);vsend({op:'voice_signal',to:d.from,data:{sdp:p.pc.localDescription}})}}
    else if(d.data&&d.data.ice&&p){if(p.pc.remoteDescription)await p.pc.addIceCandidate(d.data.ice).catch(()=>{});else p.pending.push(d.data.ice)}
  }catch(e){vdrop(d.from)}}
function vmic(){const live=V.on&&V.s.floor===V.pid;if(V.stream)for(const t of V.stream.getAudioTracks())t.enabled=live}
function vstate(s){V.s={peers:s.peers||[],floor:s.floor||null,queue:s.queue||[]};const here=new Set(V.s.peers.map(p=>p.pid));
  for(const pid of Object.keys(V.pcs))if(!here.has(pid))vdrop(pid);vmic();vrender()}
async function vjoin(){if(V.on||V.joining)return;V.joining=true;vrender();
  try{if(!V.stream){V.stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}})}}
  catch(e){V.joining=false;vrender();toast('Microphone blocked: allow it in the address bar to join voice');return}
  for(const t of V.stream.getAudioTracks())t.enabled=false;
  V.joining=false;if(!vsend({op:'voice_join'})){toast('Not connected; try again in a moment');vrender();return}V.on=true;V.open=true;vrender()}
function vleave(stop){vsend({op:'voice_leave'});for(const pid of Object.keys(V.pcs))vdrop(pid);V.on=false;
  if(stop!==false&&V.stream){for(const t of V.stream.getTracks())t.stop();V.stream=null}vrender()}
function vtalk(){if(!V.on)return;const mine=V.s.floor===V.pid||V.s.queue.includes(V.pid);vsend({op:mine?'voice_release':'voice_talk'})}
const vname=u=>u===ME?'You':u;
function vrender(){
  const n=V.s.peers.length,btn=document.getElementById('voice-btn');
  if(btn){document.getElementById('voice-n').textContent=n?String(n):'';btn.classList.toggle('live',V.on);btn.setAttribute('aria-expanded',String(!vbar.hidden))}
  vbar.hidden=!(V.on||V.open);
  const box=document.getElementById('voice-people');box.textContent='';
  for(const p of V.s.peers){const c=document.createElement('span');c.className='vp'+(p.pid===V.s.floor?' floor':'');
    const dot=document.createElement('span');dot.className='dot';c.appendChild(dot);c.appendChild(document.createTextNode(vname(p.user)));
    const qi=V.s.queue.indexOf(p.pid);if(qi>=0){const q=document.createElement('span');q.className='q';q.textContent='hand '+(qi+1);c.appendChild(q)}
    if(p.pid===V.s.floor)c.title=vname(p.user)+' has the floor';box.appendChild(c)}
  const st=document.getElementById('voice-status'),talk=document.getElementById('voice-talk'),qi=V.s.queue.indexOf(V.pid),holder=V.s.peers.find(p=>p.pid===V.s.floor);
  st.textContent=V.joining?'Starting microphone…':!V.on?(n?n+' in voice':'Nobody in voice yet'):V.s.floor===V.pid?'You have the floor':qi>=0?'Hand raised ('+(qi===0?'next':(qi+1)+' in line')+')':holder?vname(holder.user)+' is talking':'Floor is open';
  talk.hidden=!V.on;talk.disabled=!!window.VOICE_VIEWER;talk.setAttribute('aria-pressed',String(V.s.floor===V.pid));
  talk.textContent=V.s.floor===V.pid?'Done talking':qi>=0?'Lower hand':holder?'Raise hand':'Talk';
  document.getElementById('voice-join').hidden=V.on;document.getElementById('voice-join').disabled=V.joining;document.getElementById('voice-leave').hidden=!V.on}
window.onVoice=function(d){
  if(d.type==='hello'){V.pid=d.pid;if(d.voice)vstate(d.voice);if(V.on){for(const pid of Object.keys(V.pcs))vdrop(pid);V.on=false;vjoin()}return}
  if(d.type==='voice'){vstate(d);return}
  if(d.type==='voice_error'){toast(d.error);if(!V.s.peers.some(p=>p.pid===V.pid))vleave();return}
  if(d.type==='voice_joined'){V.pid=d.pid;for(const p of d.peers)vcall(p.pid,p.user).catch(()=>vdrop(p.pid));return}
  if(d.type==='voice_signal')vsignal(d)};
document.getElementById('voice-btn')?.addEventListener('click',()=>{V.open=vbar.hidden||V.on;vrender()});
document.getElementById('voice-join').addEventListener('click',vjoin);
document.getElementById('voice-leave').addEventListener('click',()=>{vleave();V.open=false;vrender()});
document.getElementById('voice-talk').addEventListener('click',vtalk);
// Push to talk: hold Space (outside text fields) to ask for the floor; let go to pass it on.
const vtyping=t=>t&&(t.isContentEditable||/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(t.tagName));
let vheld=false;
addEventListener('keydown',e=>{if(e.code!=='Space'||e.repeat||!V.on||vtyping(e.target)||window.VOICE_VIEWER)return;e.preventDefault();
  if(V.s.floor!==V.pid&&!V.s.queue.includes(V.pid)){vheld=true;vsend({op:'voice_talk'})}});
addEventListener('keyup',e=>{if(e.code!=='Space'||!vheld)return;vheld=false;vsend({op:'voice_release'})});
addEventListener('pagehide',()=>{if(V.on)vleave()});
vrender();
`;
