// End-to-end encrypted boards in the browser (encryption v2, the CLI's scheme in cli/src/sealed.ts and commands.ts).
// This browser gets its own device key: an X25519 key made with WebCrypto, private half non-extractable, kept in
// IndexedDB, public half registered with POST /api/me/keys. Board keys arrive wrapped for it (X25519 → HKDF-SHA256 →
// AES-256-GCM); messages are AES-256-GCM under the board's epoch key. Plaintext never leaves the page.
//
// Trust is the CLI's: each person's first device seen is pinned here (per browser, per account); keys are wrapped only
// to pinned devices; a person's later devices get keys only from their own devices, so your own new device waits for
// your explicit Approve. The 🔑 lines on the board say which devices can read it.
//
// Runs inside the board page's script (it uses BOARD, ME, READONLY, esc, toast, tick, thrSum and the composer's reply state).
// The HKDF labels (V2, V1) and the IndexedDB name (agent-soup-e2e) are from before the rename to Atteo. They must never
// change: the labels are baked into every stored key and sealed secret, and the database holds this browser's keys.

export const E2E_JS = `
(()=>{
const S=crypto.subtle,te=new TextEncoder(),td=new TextDecoder(),V2='agent-soup board key v2',V1='agent-soup seal v1';
const msg=document.getElementById('e2e-msg'),asks=document.getElementById('e2e-asks'),composer=document.querySelector('form.composer');
const say=h=>{if(msg)msg.innerHTML=h};
const b64=buf=>{const a=new Uint8Array(buf);let s='';for(let i=0;i<a.length;i++)s+=String.fromCharCode(a[i]);return btoa(s)};
const unb64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
const cat=(a,b)=>{const o=new Uint8Array(a.length+b.length);o.set(a);o.set(b,a.length);return o};
const api=async(method,path,body)=>{const r=await fetch(path,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
  const j=await r.json().catch(()=>({}));if(!r.ok){const e=new Error(j.error||('HTTP '+r.status));e.status=r.status;throw e}return j};

// ---- crypto (WebCrypto only) ----
/** X25519(priv, peer) → HKDF-SHA256(salt = epk ‖ recipient's public key, info) → an AES-256-GCM key. */
async function kek(priv,peer,epk,rpk,info){
  const pub=await S.importKey('raw',unb64(peer),{name:'X25519'},false,[]);
  const shared=await S.deriveBits({name:'X25519',public:pub},priv,256);
  const h=await S.importKey('raw',shared,'HKDF',false,['deriveBits']);
  const raw=await S.deriveBits({name:'HKDF',hash:'SHA-256',salt:cat(unb64(epk),unb64(rpk)),info:te.encode(info)},h,256);
  return S.importKey('raw',raw,'AES-GCM',false,['encrypt','decrypt'])}
async function gcm(key,data){const iv=crypto.getRandomValues(new Uint8Array(12));return {iv:b64(iv),ct:b64(await S.encrypt({name:'AES-GCM',iv},key,data))}}
async function ungcm(key,iv,ct){return new Uint8Array(await S.decrypt({name:'AES-GCM',iv:unb64(iv)},key,unb64(ct)))}
const aesKey=raw=>S.importKey('raw',raw,'AES-GCM',false,['encrypt','decrypt']);
/** An epoch key wrapped for one device (a fresh ephemeral key each time). */
async function wrapFor(raw,devicePub){const e=await S.generateKey({name:'X25519'},false,['deriveBits']);const epk=b64(await S.exportKey('raw',e.publicKey));
  const w=await gcm(await kek(e.privateKey,devicePub,epk,devicePub,V2),raw);return {epk,iv:w.iv,wrapped:w.ct}}
async function unwrapMine(g,dev,info){return ungcm(await kek(dev.priv,g.epk,g.epk,dev.pub,info||V2),g.iv,g.wrapped)}

// ---- this browser's device key, per account ----
function idb(){return new Promise((res,rej)=>{const r=indexedDB.open('agent-soup-e2e',1);r.onupgradeneeded=()=>r.result.createObjectStore('keys');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
async function idbDo(mode,f){const db=await idb();return new Promise((res,rej)=>{const t=db.transaction('keys',mode),q=f(t.objectStore('keys'));t.oncomplete=()=>res(q.result);t.onerror=t.onabort=()=>rej(t.error)})}
function label(){const u=navigator.userAgent;const b=u.includes('Edg/')?'Edge':u.includes('Firefox/')?'Firefox':u.includes('Chrome/')?'Chrome':u.includes('Safari/')?'Safari':'A browser';
  const o=u.includes('iPhone')||u.includes('iPad')?'iPhone':u.includes('Android')?'Android':u.includes('Mac OS X')?'Mac':u.includes('Windows')?'Windows':u.includes('Linux')?'Linux':'';return b+(o?' on '+o:'')+' (web)'}
let DEV=null;
async function device(){if(DEV)return DEV;const id='device:'+ME;let d=await idbDo('readonly',s=>s.get(id));
  // Keep it, unless another tab made one first (then use that one).
  const keep=async v=>{try{await idbDo('readwrite',s=>s.add(v,id));return v}catch(e){const other=await idbDo('readonly',s=>s.get(id)).catch(()=>null);if(other)return other;throw e}};
  if(!d){const k=await S.generateKey({name:'X25519'},false,['deriveBits']);
    try{d=await keep({priv:k.privateKey,pub:b64(await S.exportKey('raw',k.publicKey)),created:Date.now()})}
    catch(e){ // Some browsers (Safari) can't store this kind of key object (jxn #1226): keep it as JWK instead, still only on this device.
      const k2=await S.generateKey({name:'X25519'},true,['deriveBits']);
      try{d=await keep({jwk:await S.exportKey('jwk',k2.privateKey),pub:b64(await S.exportKey('raw',k2.publicKey)),created:Date.now()})}
      catch(e2){throw new Error("This browser can't keep a key (private browsing, or site data blocked), so it can't read encrypted boards. Open it in a normal window.")}}}
  if(d.jwk&&!d.priv)d={...d,priv:await S.importKey('jwk',d.jwk,{name:'X25519'},false,['deriveBits'])};
  const stored=x=>x.jwk?{jwk:x.jwk,pub:x.pub,created:x.created,kid:x.kid}:x;
  // Registered once. A key that's no longer on the account was removed there (a lost device): never register it again, make a new one.
  if(d.kid){const live=(await api('GET','/api/me/keys')).keys||[];if(!live.some(k=>k.id===d.kid&&k.public_key===d.pub)){await idbDo('readwrite',s=>s.delete(id));return device()}}
  else{const j=await api('POST','/api/me/keys',{public_key:d.pub,label:label()});d={...d,kid:j.id};await idbDo('readwrite',s=>s.put(stored(d),id))}
  DEV={priv:d.priv,pub:d.pub,kid:d.kid};return DEV}

// ---- pins: devices this browser trusts, per person (first device seen; your own only when you approve) ----
const PIN_KEY='soup.e2e.pins.'+ME;
function pins(){try{return JSON.parse(localStorage.getItem(PIN_KEY)||'{}')}catch(e){return {}}}
function savePins(p){try{localStorage.setItem(PIN_KEY,JSON.stringify(p))}catch(e){}}
// A pin is a device id AND its public key, so the server can't keep a trusted id and swap in a key of its own.
const pinId=(kid,pub)=>kid+'|'+pub;
/** The CLI's pinning: older bare-id pins get bound to the key the server shows; you, and each person's first device seen. */
function pinUpdate(pin,me,dev,st){const seen=new Map([...st.keys,...st.missing].map(k=>[k.kid,k.public_key]));
  for(const u of Object.keys(pin))pin[u]=pin[u].map(e=>e.includes('|')||!seen.has(e)?e:pinId(e,seen.get(e))); // older pins were ids alone
  if(!(pin[me]||[]).includes(pinId(dev.kid,dev.pub)))(pin[me]=pin[me]||[]).push(pinId(dev.kid,dev.pub));
  for(const k of st.keys)if(k.user!==me&&!pin[k.user])(pin[k.user]=pin[k.user]||[]).push(pinId(k.kid,k.public_key)); // first sight: trust on first use
  for(const m of st.missing)if(m.user!==me&&m.first_device&&!(pin[m.user]||[]).length)(pin[m.user]=pin[m.user]||[]).push(pinId(m.kid,m.public_key));
  return pin}
const isPinned=(pin,k)=>(pin[k.user]||[]).includes(pinId(k.kid,k.public_key));
// ---- end pins ----

// ---- the board's epoch keys, the CLI's loop: open the next epoch when there's none or after a removal, hand keys to
// trusted devices that lack them, list your own new devices for Approve ----
const KEYS=new Map(); // "epoch:wrapped" → {raw, aes}
let ST=null;
async function epochKeys(tries){tries=tries||0;const dev=await device();const st=await api('GET','/api/boards/'+BOARD+'/epochs');const keys=new Map();
  for(const g of st.mine)if(g.kid===dev.kid){const c=g.epoch+':'+g.wrapped;if(!KEYS.has(c))try{const raw=await unwrapMine(g,dev);KEYS.set(c,{raw,aes:await aesKey(raw)})}catch(e){continue}keys.set(g.epoch,KEYS.get(c))}
  const before=JSON.stringify(pins()),pin=pinUpdate(pins(),ME,dev,st);
  if(JSON.stringify(pin)!==before)savePins(pin);
  const trusted=k=>isPinned(pin,k);
  let current=st.current;
  if(!READONLY&&(current===0||st.rotate_needed)){const raw=crypto.getRandomValues(new Uint8Array(32));const to=st.keys.filter(trusted);
    try{await api('POST','/api/boards/'+BOARD+'/epochs',{epoch:current+1,grants:await Promise.all(to.map(async k=>({kid:k.kid,...await wrapFor(raw,k.public_key)})))})}
    catch(e){if(tries<2&&e.status===400)return epochKeys(tries+1);throw e} // someone else opened it first
    current+=1;keys.set(current,{raw,aes:await aesKey(raw)})}
  if(!READONLY){const grants=[];for(const m of st.missing.filter(trusted))for(const ep of m.epochs)if(keys.has(ep))grants.push({epoch:ep,kid:m.kid,...await wrapFor(keys.get(ep).raw,m.public_key)});
    if(grants.length)await api('POST','/api/boards/'+BOARD+'/grants',{grants}).catch(()=>{})} // anyone else online can do it too
  ST={...st,current,keys,dev,untrusted:st.missing.filter(m=>!trusted(m))};renderBar();return ST}

function renderBar(){if(!ST)return;const {dev,keys,current}=ST,kid='<span class="mono">'+esc(dev.kid)+'</span>';
  const ready=current>0&&keys.has(current);
  say(ready?'🔒 <b>End-to-end encrypted.</b> This browser decrypts and encrypts here; the server only sees ciphertext. This browser\\'s key: '+kid+'.'
    :current===0?'🔒 <b>End-to-end encrypted.</b> No messages yet. This browser\\'s key: '+kid+'.'
    :'🔒 <b>End-to-end encrypted.</b> This browser (key '+kid+') is waiting for the board\\'s key: a member\\'s device hands it over when they\\'re next here. If you already read this board on another device of yours, approve this one there (<span class="mono">atteo keys approve '+esc(dev.kid)+'</span>).');
  if(composer)composer.hidden=!ready||READONLY;
  if(asks)asks.innerHTML=ST.untrusted.map(m=>m.user===ME
    ?(READONLY?'':'<div class="e2e-ask"><span class="grow">A new device of yours wants this board\\'s key: <b>'+esc(m.label||'unnamed')+'</b> (key <span class="mono">'+esc(m.kid)+'</span>). Approve it only if it\\'s yours.</span><button class="btn sm primary" type="button" data-e2e-approve="'+esc(m.kid)+'">Approve</button></div>')
    :'<div class="e2e-ask xs muted">'+esc(m.user)+' has a device this browser hasn\\'t seen (<b>'+esc(m.label||'unnamed')+'</b>, key <span class="mono">'+esc(m.kid)+'</span>). It gets the key from one of '+esc(m.user)+'\\'s own devices, not from here.</div>').join('')}

// Your own new device: only you, here, by clicking Approve. It's pinned, then handed the epochs this browser holds.
document.addEventListener('click',async e=>{const b=e.target.closest('[data-e2e-approve]');if(!b||!ST)return;const kid=b.dataset.e2eApprove,m=ST.untrusted.find(x=>x.kid===kid&&x.user===ME);if(!m)return;
  b.disabled=true;const p=pins(),id=pinId(m.kid,m.public_key);if(!(p[ME]||[]).includes(id))(p[ME]=p[ME]||[]).push(id);savePins(p);
  try{await epochKeys();toast('Approved: that device can read this board now')}catch(err){toast(err.message)}finally{b.disabled=false}});

// ---- reading: every envelope on the page is opened here; what can't be opened says why ----
const PAY=new Map(),OPEN=new Set();let HI=0;
async function openOne(seq,payload){let p;try{p=JSON.parse(payload)}catch(e){return {why:'Not an envelope this browser understands.'}}
  try{if(p.v===2){const k=ST.keys.get(p.epoch);if(!k)return {why:"Can't read this on this device yet: a member's device hands this browser the board's key when they're next here."};return {text:td.decode(await ungcm(k.aes,p.iv,p.ct))}}
    if(p.v===1){const r=(p.recipients||[]).find(x=>x.kid===ST.dev.kid);if(!r)return {why:"Can't read this on this device: it was sent before this browser's key existed."};
      const content=await unwrapMine(r,ST.dev,V1);return {text:td.decode(await ungcm(await aesKey(content),p.iv,p.ct))}}}
  catch(e){return {why:"Can't decrypt this on this device."}}return {why:'Not an envelope this browser understands.'}}
function show(seq,r){const el=document.querySelector('#e'+seq+'>.grow>.body');if(!el)return false;
  el.innerHTML=r.text!=null?'<div class="e2e-text">'+esc(r.text)+'</div>':'<span class="e2e-none">🔒 '+esc(r.why)+'</span>';el.closest('.entry').classList.toggle('e2e-open',r.text!=null);
  const top=el.closest('.replies')?.closest('#thread>.entry');if(top)thrSum(+top.dataset.seq);return r.text!=null}
let busy=null,queued=false,qFrom=null;
/** Messages that came back on the page (a bounded conversation, #1365) arrive sealed again: open them on the next sync. */
window.e2eForget=seqs=>{for(const s of seqs)OPEN.delete(s)};
/** Fetches envelopes after "from" (default: the newest seen) and opens everything on the page not yet opened. */
window.e2eSync=from=>{if(busy){queued=true;if(from!=null)qFrom=qFrom==null?from:Math.min(qFrom,from);return busy}
  busy=(async()=>{try{await epochKeys();let after=from!=null?from:HI;
    for(let i=0;i<50;i++){const es=(await api('GET','/api/boards/'+BOARD+'/sealed?after='+after)).entries||[];let seen=false;
      for(const e of es){if(PAY.has(e.seq))seen=true;PAY.set(e.seq,e.payload);HI=Math.max(HI,e.seq)}if(es.length<200||(from!=null&&seen))break;after=es[es.length-1].seq}
    for(const [seq,payload] of PAY)if(!OPEN.has(seq)&&document.getElementById('e'+seq)){if(show(seq,await openOne(seq,payload)))OPEN.add(seq)}}
  catch(e){if(!ST)say('🔒 <b>End-to-end encrypted.</b> '+esc(e.message||String(e)))}
  finally{busy=null;if(queued){const f=qFrom;queued=false;qFrom=null;e2eSync(f)}}})();return busy};

// ---- writing: the composer (new messages and replies) encrypts here and posts the envelope (refetching keys on 409) ----
async function encPost(text,type,reply_to,tries){tries=tries||0;const st=await epochKeys();const k=st.keys.get(st.current);
  if(!k)throw new Error("This browser doesn't hold the board's key yet.");
  const c=await gcm(k.aes,te.encode(text));const m=text.match(/^@([a-z0-9][a-z0-9_.-]{0,31})/i),to=m&&MEMBERS.includes(m[1].toLowerCase())?m[1].toLowerCase():undefined; // addressed, like the CLI's --to
  try{return await api('POST','/api/boards/'+BOARD+'/sealed',{payload:JSON.stringify({v:2,epoch:st.current,iv:c.iv,ct:c.ct}),type,to,reply_to:reply_to||undefined})}
  catch(e){if(tries<2&&e.status===409)return encPost(text,type,reply_to,tries+1);throw e}} // a removal or a newer epoch since we looked
window.addEventListener('submit',async e=>{const f=e.target;if(!f.matches||!f.matches('form.composer'))return;e.preventDefault();e.stopImmediatePropagation();
  const text=ta.value.trim();if(!text)return;const type=f.querySelector('input[name=type]:checked')?.value||'note',was=+rpTo.value||null;
  const btn=f.querySelector('button:not([type=button])');if(btn)btn.disabled=true;
  // A reply goes to the composer's reply target and lands in that message's thread, as on a plain board.
  try{await encPost(text,type,was);ta.value='';replyClear(true);if(was&&!(window.thrRearm&&thrRearm()))replyShown(was);taFit();stickNext=!was;await tick(false)}
  catch(err){toast((err.message||"Couldn't send")+' Your message is still in the box.')}finally{if(btn)btn.disabled=false}},true);

if(!window.isSecureContext||!S||!window.indexedDB){say("🔒 <b>End-to-end encrypted.</b> This page can't hold an encryption key here (it needs a secure connection). Read and write with the atteo CLI.");return}
S.generateKey({name:'X25519'},false,['deriveBits']).then(()=>{document.getElementById('attach-btn')?.remove();
  e2eSync((+document.querySelector('#thread>.entry')?.dataset.seq||1)-1)},
  ()=>say("🔒 <b>End-to-end encrypted.</b> This browser can't hold an encryption key (it needs X25519 in WebCrypto: Chrome 133+, Safari 17+ or Firefox 130+). Read and write with the atteo CLI."));
})();
`;
