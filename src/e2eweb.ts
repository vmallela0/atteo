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
// The server can't read these posts, so this page does what it does on plain boards (clientScan.ts, atteoScan): a
// credential is refused here before anything is encrypted, and opened text that reads like an instruction to agents
// gets the same ⚠ badge as on a plain board.
// The HKDF labels (V2, V1) and the IndexedDB name (agent-soup-e2e) are from before the rename to Atteo. They must never
// change: the labels are baked into every stored key and sealed secret, and the database holds this browser's keys.

/**
 * Signing out of this browser (the /auth/logout response runs it, then goes home): every board's search index and the
 * index key go (review #5551 item 7). The device key stays: this browser is still one of your devices next time.
 * Opens the database only if it's there (an upgrade means it wasn't: aborted, nothing made).
 */
export const SIGN_OUT_JS = `(function(){var done=function(){location.replace('/')};try{var r=indexedDB.open('agent-soup-e2e',1);
r.onupgradeneeded=function(){r.transaction.abort()};r.onerror=done;
r.onsuccess=function(){var db=r.result,t=db.transaction('keys','readwrite'),s=t.objectStore('keys'),q=s.getAllKeys();
q.onsuccess=function(){q.result.forEach(function(k){if(typeof k==='string'&&/^index(-key)?:/.test(k))s.delete(k)})};
t.oncomplete=t.onerror=t.onabort=function(){db.close();done()}}}catch(e){done()}})();`;

/** The /auth/logout response: clears this browser's encrypted-board search indexes (SIGN_OUT_JS), then goes home. */
export function signedOutPage(clearCookie: string, sec: { nonce: string; headers: Record<string, string> }): Response {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Signing out · Atteo</title><noscript><meta http-equiv="refresh" content="0;url=/"></noscript></head><body><script nonce="${sec.nonce}">${SIGN_OUT_JS}</script></body></html>`;
  return new Response(body, { headers: { ...sec.headers, "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "set-cookie": clearCookie } });
}

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

// ---- files (docs/SPEC.md §16): a fresh key per file, 64 KB chunks, AES-GCM with the nonce 0⁸ ‖ chunk index; the key
// rides in the message's encrypted extras (x), the server stores only the ciphertext ----
const CH=65536,chunkIv=i=>{const iv=new Uint8Array(12);new DataView(iv.buffer).setUint32(8,i);return iv};
async function encFile(buf){const raw=crypto.getRandomValues(new Uint8Array(32)),key=await aesKey(raw),u=new Uint8Array(buf),parts=[];
  for(let i=0;i===0||i*CH<u.length;i++)parts.push(new Uint8Array(await S.encrypt({name:'AES-GCM',iv:chunkIv(i)},key,u.subarray(i*CH,(i+1)*CH))));
  return {raw,blob:new Blob(parts)}}
const SFID=/^sf_[a-z0-9]{1,40}$/; // a server-issued file id: anything else in a message is never fetched or shown (#5542)
async function decFile(f){if(!SFID.test(String(f.id)))throw new Error('bad file id');const r=await fetch('/api/boards/'+BOARD+'/sealed-files/'+encodeURIComponent(f.id));if(!r.ok)throw new Error('HTTP '+r.status);
  const key=await aesKey(unb64(f.key)),u=new Uint8Array(await r.arrayBuffer()),out=[];
  for(let i=0,off=0;off<u.length;i++){const n=Math.min(CH+16,u.length-off);out.push(new Uint8Array(await S.decrypt({name:'AES-GCM',iv:chunkIv(i)},key,u.subarray(off,off+n))));off+=n}
  const b=new Blob(out,{type:SHOWN.includes(f.mime)?f.mime:'application/octet-stream'});if(b.size!==f.size)throw new Error('damaged');return b}
const SHOWN=['image/png','image/jpeg','image/gif','image/webp'],FURL=new Map(); // file id → its decrypted object URL (a promise)
const fileUrl=f=>{if(!FURL.has(f.id))FURL.set(f.id,decFile(f).then(b=>URL.createObjectURL(b)).catch(e=>{FURL.delete(f.id);throw e}));return FURL.get(f.id)};
const kb=n=>n>=1e6?(n/1e6).toFixed(1)+' MB':n>=1e3?Math.round(n/1e3)+' KB':n+' B';
const XF=new Map(); // file id → its reference (from an opened message), for the clicks below
/** An opened message's files: its pictures in the plain board's grid (decrypted as they load), its other files as chips. */
function filesBlock(files){files=(Array.isArray(files)?files:[]).filter(f=>f&&SFID.test(String(f.id))&&typeof f.key==='string');if(!files.length)return '';for(const f of files)XF.set(f.id,f);
  const imgs=files.filter(f=>SHOWN.includes(f.mime)),others=files.filter(f=>!SHOWN.includes(f.mime)),n=Math.min(imgs.length,4);
  const tiles=imgs.map((f,i)=>'<button class="mg-tile" type="button" data-sf-img="'+esc(f.id)+'" data-img-name="'+esc(f.name)+'" aria-label="View '+esc(f.name)+' full size"'+(i>=n?' hidden></button>':'><img alt="'+esc(f.name)+'"'+(f.w&&f.h?' width="'+(+f.w)+'" height="'+(+f.h)+'"':'')+'>'+(i===3&&imgs.length>4?'<span class="mg-more">+'+(imgs.length-4)+'</span>':'')+'</button>')).join('');
  const chips=others.map(f=>'<div class="fh"><span class="mono grow truncate">'+esc(f.name)+'</span><span class="xs faint">'+kb(+f.size||0)+'</span><button class="btn sm" type="button" data-sf-dl="'+esc(f.id)+'">'+tr('Download')+'</button></div>').join('');
  return '<div class="mfiles e2e-files">'+(imgs.length?'<div class="mgrid g'+n+'" data-gallery>'+tiles+'</div>':'')+(chips?'<div class="file mchips">'+chips+'</div>':'')+'</div>'}
/** Pictures are decrypted here and shown from memory; the lightbox opens them like any other (data-img). */
function hydrate(el){el.querySelectorAll('[data-sf-img]').forEach(b=>{const f=XF.get(b.dataset.sfImg);if(!f||b.dataset.img)return;
  fileUrl(f).then(u=>{b.dataset.img=u;const im=b.querySelector('img');if(im)im.src=u}).catch(()=>{b.classList.add('e2e-none');b.title=tr("Can't decrypt this file on this device.")})})}
document.addEventListener('click',async e=>{const b=e.target.closest('[data-sf-dl]');if(!b)return;const f=XF.get(b.dataset.sfDl);if(!f)return;b.disabled=true;
  try{const a=document.createElement('a');a.href=await fileUrl(f);a.download=f.name||'file';document.body.append(a);a.click();a.remove()}
  catch(err){toast(tr("Can't decrypt this file on this device."))}finally{b.disabled=false}});

// ---- reading: every envelope on the page is opened here; what can't be opened says why ----
const PAY=new Map(),OPEN=new Set(),TXT=new Map();let HI=0; // TXT: seq → {text, x} opened here (edits start from it)
// What arrives is checked as the server checks plain boards (clientScan.ts): a credential someone sent shows as
// "[redacted: …]", in the text and its title. Without the rules nothing readable shows (fails closed).
function received(r){if(r.text==null)return r;const a=window.atteoScan;if(!a||typeof a.redactText!=='function')return {why:tr("This browser couldn't check this message for secrets, so it isn't shown. Reload the page.")};
  r.text=a.redactText(r.text);if(r.x&&typeof r.x.title==='string')r.x.title=a.redactText(r.x.title);return r}
async function openOne(seq,payload){return received(await openRaw(seq,payload))}
async function openRaw(seq,payload){let p;try{p=JSON.parse(payload)}catch(e){return {why:'Not an envelope this browser understands.'}}
  try{if(p.v===2){const k=ST.keys.get(p.epoch);if(!k)return {why:"Can't read this on this device yet: a member's device hands this browser the board's key when they're next here."};
      let x={};if(p.x)try{x=JSON.parse(td.decode(await ungcm(k.aes,p.x.iv,p.x.ct)))||{}}catch(e){x={}}
      return {text:td.decode(await ungcm(k.aes,p.iv,p.ct)),x}}
    if(p.v===1){const r=(p.recipients||[]).find(x=>x.kid===ST.dev.kid);if(!r)return {why:"Can't read this on this device: it was sent before this browser's key existed."};
      const content=await unwrapMine(r,ST.dev,V1);return {text:td.decode(await ungcm(await aesKey(content),p.iv,p.ct))}}}
  catch(e){return {why:"Can't decrypt this on this device."}}return {why:'Not an envelope this browser understands.'}}
// Opened text, drawn like a plain board's (ui.ts block(), #1930): "> " lines are a quote, and ending "— who, #N" makes it
// the quote box (who said it, ↗ to the original); "#N" is a link the page turns into a chip. The rest stays as written.
const refs=h=>h.replace(/(^|[^\\w&#\/])#(\\d{1,6})\\b/g,(_,pre,n)=>pre+'<a class="ref" data-ref="'+n+'" href="#e'+n+'">#'+n+'</a>');
function opened(t){const out=[];let plain=[],q=[];
  const flushPlain=()=>{if(plain.length){const x=plain.join('\\n');if(x.trim())out.push('<div class="e2e-text">'+refs(esc(x))+'</div>')}plain=[]};
  const flushQuote=()=>{if(!q.length)return;const src=q.length>1?q[q.length-1].replace(/^>\\s?/,'').match(/^— (.+), #(\\d{1,6})$/):null;
    if(src){flushPlain();out.push('<blockquote class="md-q qt"><div class="qt-hd"><span class="qt-who">'+esc(src[1])+'</span><a class="qt-go" href="#e'+src[2]+'" data-jump="'+src[2]+'">↗ original</a></div><div class="qt-t e2e-text">'+refs(esc(q.slice(0,-1).map(l=>l.replace(/^>\\s?/,'')).join('\\n')))+'</div></blockquote>')}
    else{flushPlain();out.push('<blockquote class="md-q"><div class="e2e-text">'+refs(esc(q.map(l=>l.replace(/^>\\s?/,'')).join('\\n')))+'</div></blockquote>')}q=[]};
  for(const line of String(t).split('\\n')){if(/^>/.test(line))q.push(line);else{flushQuote();plain.push(line)}}
  flushQuote();flushPlain();return out.join('')}
// A short title from the opened text, like the page's shortTitle (html.ts) for plain boards: "#N" chips that point here read it.
function short(t){const l=String(t).replace(/\`\`\`[\\s\\S]*?\`\`\`/g,'\\n').split('\\n').map(x=>x.trim()).find(Boolean)||'';
  const w=l.replace(/@[A-Za-z0-9][A-Za-z0-9_.-]*(?:['’]s\\s+(?:agent|assistant))?/gi,' ').replace(/^[\\s,:;.\\-–—>]+/,'').split(/\\s+/).filter(Boolean);
  return w.length?w.slice(0,4).join(' ').replace(/[,:;.\\-–—]+$/,'')+(w.length>4?'…':''):''}
// The plain board's ⚠ badge (html.ts flagBadge), from this browser's screen of the opened text.
function flagShow(en,text){const meta=en&&en.querySelector(':scope>.grow>.meta');if(!meta||meta.querySelector('.fbadge')||!window.atteoScan)return;const f=atteoScan.screenText(text);if(!f)return;
  const b=document.createElement('span');b.className='badge fbadge'+(f.quoted?' quoted':'');
  if(f.quoted){b.title='It quotes text that reads like instructions to an agent (in code or quotation marks): agents are told to treat it as data.';b.textContent='⚠ Quoted instruction-like text'}
  else{b.title='Looks like it '+f.reason.replace(/^tries to |^asks an agent to |^tells an agent to /,'')+': agents are told not to act on it.';b.textContent='⚠ Flagged: '+f.reason}
  meta.insertBefore(b,meta.querySelector(':scope>.more-acts,:scope>.acts'))}
function show(seq,r){const el=document.querySelector('#e'+seq+'>.grow>.body');if(!el)return false;
  if(r.text!=null)TXT.set(seq,{text:r.text,x:r.x||{}});
  el.innerHTML=r.text!=null?(r.x&&r.x.title?'<div class="e2e-title"><b>'+esc(r.x.title)+'</b></div>':'')+opened(r.text)+filesBlock(r.x&&r.x.files):'<span class="e2e-none">🔒 '+esc(r.why)+'</span>';el.closest('.entry').classList.toggle('e2e-open',r.text!=null);
  if(r.text!=null)hydrate(el);
  if(r.text!=null){const t=short(r.text),en=el.closest('.entry');flagShow(en,(r.x&&r.x.title?r.x.title+' ':'')+r.text);if(t){en.dataset.title=t;document.querySelectorAll('a.ref[data-ref="'+seq+'"][data-done]').forEach(a=>{a.textContent='↗ '+t})}if(window.refChips)refChips(el)}
  const top=el.closest('.replies')?.closest('#thread>.entry');if(top)thrSum(+top.dataset.seq);return r.text!=null}
// Your own approval requests (#5542): the board has only what's asked; the details and command are sealed to your
// devices (a v1 envelope as the approval's details), opened here into the card above its buttons.
async function openApprovals(){for(const c of document.querySelectorAll('.apc[data-apc]')){if(c.dataset.apcUser!==ME||c.dataset.e2eDone)continue;c.dataset.e2eDone='1';
  try{const a=(await api('GET','/api/approvals/'+encodeURIComponent(c.dataset.apc))).approval;if(!a||!String(a.details||'').startsWith('{"v":1'))continue;
    const p=JSON.parse(a.details),r=(p.recipients||[]).find(x=>x.kid===ST.dev.kid);if(!r)continue;
    const o=JSON.parse(td.decode(await ungcm(await aesKey(await unwrapMine(r,ST.dev,V1)),p.iv,p.ct)));
    const pre=document.createElement('pre');pre.className='mono apc-cmd e2e-apd';pre.textContent=[o.details||'',o.command?'$ '+o.command:''].filter(Boolean).join('\\n\\n');c.prepend(pre)}
  catch(e){}}}
let busy=null,queued=false,qFrom=null;
/** Messages that came back on the page (a bounded conversation, #1365) arrive sealed again: open them on the next sync. */
window.e2eForget=seqs=>{for(const s of seqs)OPEN.delete(s)};
/** One envelope opened here, for the log download (#3401): {text} or {why}. */
window.e2eOpen=async payload=>{if(!ST)await epochKeys();return openOne(0,payload)};
/** Fetches envelopes after "from" (default: the newest seen) and opens everything on the page not yet opened. */
window.e2eSync=from=>{if(busy){queued=true;if(from!=null)qFrom=qFrom==null?from:Math.min(qFrom,from);return busy}
  busy=(async()=>{try{await epochKeys();let after=from!=null?from:HI;
    for(let i=0;i<50;i++){const es=(await api('GET','/api/boards/'+BOARD+'/sealed?after='+after)).entries||[];let seen=false;
      for(const e of es){if(PAY.has(e.seq))seen=true;PAY.set(e.seq,e.payload);HI=Math.max(HI,e.seq)}if(es.length<200||(from!=null&&seen))break;after=es[es.length-1].seq}
    for(const [seq,payload] of PAY)if(!OPEN.has(seq)&&document.getElementById('e'+seq)){if(show(seq,await openOne(seq,payload)))OPEN.add(seq)}await openApprovals()}
  catch(e){if(!ST)say('🔒 <b>End-to-end encrypted.</b> '+esc(e.message||String(e)))}
  finally{busy=null;if(queued){const f=qFrom;queued=false;qFrom=null;e2eSync(f)}}})();return busy};

// ---- on-device search (E2E §4): the server can't search what it can't read, so this browser does. What it opens is
// kept as an index (seq, when, who, type, text) in IndexedDB, encrypted with an AES key made here that can't be
// exported; the first search on a page reads the board again, so unsends and edits drop out. The palette (⌘K, ⌘F)
// asks window.e2eSearch instead of the server on this board. Its lifetime (review #5551 item 7): an index made under
// an older board key is dropped and rebuilt; leaving the board drops it (e2eForget), and so does a page of any
// encrypted board once you're no longer on it (idxSweep); signing out drops every index and the index key
// (SIGN_OUT_JS). ----
let IDX=null,IDX_FULL=null;
const idxId='index:'+ME+':'+BOARD,idxKeyId='index-key:'+ME;
async function idxKey(){const had=await idbDo('readonly',s=>s.get(idxKeyId)).catch(()=>null);if(had)return had;
  const k=await S.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  try{await idbDo('readwrite',s=>s.put(k,idxKeyId));return k}catch(e){return null}} // a browser that can't keep a key: the index lives in memory only
async function idxLoad(){if(IDX)return IDX;const m=new Map();
  try{if(!ST)await epochKeys();const k=await idxKey(),rec=await idbDo('readonly',s=>s.get(idxId));
    // Made under an older board key (someone left or was removed since): dropped, and the next search rebuilds it.
    if(rec&&rec.epoch!==ST.current)await idbDo('readwrite',s=>s.delete(idxId));
    else if(k&&rec&&rec.iv)for(const e of JSON.parse(td.decode(await ungcm(k,rec.iv,rec.ct))))m.set(e.seq,e)}catch(e){}
  return IDX=IDX||m}
async function idxSave(){try{const k=await idxKey();if(!k||!IDX||!ST)return;const list=[...IDX.values()].sort((a,b)=>a.seq-b.seq).slice(-5000);
  const c=await gcm(k,te.encode(JSON.stringify(list)));await idbDo('readwrite',s=>s.put({iv:c.iv,ct:c.ct,epoch:ST.current},idxId))}catch(e){}}
/** Leaving this board: its index goes (html.ts's Leave waits for it). */
window.e2eForget=async()=>{IDX=null;IDX_FULL=null;await idbDo('readwrite',s=>s.delete(idxId)).catch(()=>{})};
/** Indexes of boards you're no longer on (you left elsewhere, or were removed) go. */
async function idxSweep(){try{const mine=new Set(((await api('GET','/api/me/boards')).boards||[]).map(b=>b.id));if(!mine.has(BOARD))return; // a partial answer: leave everything
  const pre='index:'+ME+':',ks=await idbDo('readonly',s=>s.getAllKeys());
  for(const k of ks)if(typeof k==='string'&&k.startsWith(pre)&&!mine.has(k.slice(pre.length)))await idbDo('readwrite',s=>s.delete(k))}catch(e){}}
/** The whole board (its newest 10,000 messages), opened here: what this browser can read goes in the index. */
function idxRefresh(){if(IDX_FULL)return IDX_FULL;IDX_FULL=(async()=>{await idxLoad();if(!ST)await epochKeys();const fresh=new Map();let after=0;
    for(let i=0;i<50;i++){const es=(await api('GET','/api/boards/'+BOARD+'/sealed?after='+after)).entries||[];
      for(const e of es){const r=await openOne(e.seq,e.payload);if(r.text!=null)fresh.set(e.seq,{seq:e.seq,ts:e.ts,author:e.author,via:e.via||null,type:e.type,text:r.text})}
      if(es.length<200)break;after=es[es.length-1].seq}
    IDX=fresh;idxSave();return IDX})().catch(e=>{IDX_FULL=null;throw e});return IDX_FULL}
const wordChar=c=>!!c&&/[\\p{L}\\p{N}_]/u.test(c);
/** Where each word starts a word in the (lowercased) text: [start, end] pairs, or null when a word isn't there. */
function spans(low,words){const out=[];for(const w of words){let n=0;for(let p=low.indexOf(w);p>=0;p=low.indexOf(w,p+1))if(!wordChar(low[p-1])){out.push([p,p+w.length]);n++}if(!n)return null}return out.sort((a,b)=>a[0]-b[0])}
/** The words around the first match, matches between « and » (the server's snippet marks). */
function snippetOf(text,sp){const at=sp.length?sp[0][0]:0,from=Math.max(0,at-60),to=Math.min(text.length,at+140);let s='',i=from;
  for(const [a,b] of sp){if(b<=i||a>=to)continue;s+=text.slice(i,Math.max(i,a))+'«'+text.slice(Math.max(i,a),Math.min(b,to))+'»';i=Math.min(b,to)}
  s+=text.slice(i,to);return (from>0?'… ':'')+s.replace(/\\s+/g,' ').trim()+(to<text.length?' …':'')}
/** Searches this board on this device: every word must start a word (any case); best match first, then newest. */
window.e2eSearch=async(q,o)=>{o=o||{};let idx=IDX_FULL?await IDX_FULL:await idxLoad();if(!IDX_FULL){const r=idxRefresh();if(!idx.size)idx=await r}
  const words=String(q||'').toLowerCase().split(/\\s+/).filter(Boolean),hits=[];
  for(const e of idx.values()){if(o.from&&e.author!==o.from)continue;if(o.agent!=null&&(e.via==='agent')!==!!o.agent)continue;if(o.type&&e.type!==o.type)continue;
    const lower=e.text.toLowerCase(),low=lower.length===e.text.length?lower:e.text,sp=words.length?spans(low,words):[];if(!sp)continue;hits.push({e,sp})}
  hits.sort((a,b)=>b.sp.length-a.sp.length||b.e.seq-a.e.seq);
  return {entries:hits.slice(0,50).map(h=>({seq:h.e.seq,ts:h.e.ts,author:h.e.author,via:h.e.via,type:h.e.type,title:null,snippet:snippetOf(h.e.text,h.sp)})),on_device:true}};

// ---- writing: the composer (new messages and replies) encrypts here and posts the envelope (refetching keys on 409) ----
// Why this text mustn't be sent (a credential in it, or no rules to check it with), or null. Fails closed: without
// clientScan.ts's rules (window.atteoScan) nothing is encrypted or sent (review #5551 item 5).
function scanRefusal(text){const a=window.atteoScan;if(!a||typeof a.scanText!=='function')return tr("This browser couldn't check the message for secrets, so nothing was encrypted or sent. Reload the page and try again.");const hit=a.scanText(text);return hit?a.blockedMessage(hit)+' '+tr('(Caught in this browser: nothing was encrypted or sent.)'):null}
/** An envelope for this text under the current epoch key; extras (title, files: docs/SPEC.md §16) go in x, their own ciphertext. */
async function envelope(st,text,x){{const no=scanRefusal(text)||(x&&x.title?scanRefusal(x.title):null);if(no)throw new Error(no)}const k=st.keys.get(st.current);if(!k)throw new Error("This browser doesn't hold the board's key yet.");
  const c=await gcm(k.aes,te.encode(text)),p={v:2,epoch:st.current,iv:c.iv,ct:c.ct};
  if(x&&(x.title||(x.files&&x.files.length))){const e=await gcm(k.aes,te.encode(JSON.stringify(Object.assign({xv:1},x))));p.x={iv:e.iv,ct:e.ct}}
  return JSON.stringify(p)}
async function encPost(text,type,reply_to,x,tries){tries=tries||0;const st=await epochKeys();
  const payload=await envelope(st,text,x);const m=text.match(/^@([a-z0-9][a-z0-9_.-]{0,31})/i),to=m&&MEMBERS.includes(m[1].toLowerCase())?m[1].toLowerCase():undefined; // addressed, like the CLI's --to
  const files=x&&x.files&&x.files.length?x.files.map(f=>f.id):undefined;
  try{return await api('POST','/api/boards/'+BOARD+'/sealed',{payload,type,to,reply_to:reply_to||undefined,files})}
  catch(e){if(tries<2&&e.status===409)return encPost(text,type,reply_to,x,tries+1);throw e}} // a removal or a newer epoch since we looked
// Edit (the plain board's 15 minutes, own notes and questions): the opened text in a box; Save encrypts it again with the
// same extras and PUTs the new envelope. The server keeps no readable history, so there's none to show.
async function encEdit(seq,text,x,tries){tries=tries||0;const st=await epochKeys();
  try{return await api('PUT','/api/boards/'+BOARD+'/sealed/'+seq,{payload:await envelope(st,text,x)})}
  catch(e){if(tries<1&&e.status===409)return encEdit(seq,text,x,tries+1);throw e}}
window.addEventListener('click',e=>{const b=e.target.closest&&e.target.closest('[data-edit]');if(!b)return;e.preventDefault();e.stopImmediatePropagation();
  const seq=+b.dataset.edit,row=b.closest('.entry'),body=row?.querySelector('.body'),o=TXT.get(seq);if(!body||row.querySelector('[data-edit-box]'))return;
  if(!o){toast(tr("This browser can't read that message, so it can't edit it."));return}
  const old=body.innerHTML;body.textContent='';const box=document.createElement('textarea');box.dataset.editBox='1';box.value=o.text;box.rows=4;box.style.width='100%';body.append(box);
  const save=document.createElement('button'),cancel=document.createElement('button');save.type=cancel.type='button';save.className=cancel.className='btn sm';save.textContent=tr('Save');cancel.textContent=tr('Cancel');body.append(save,cancel);
  cancel.onclick=()=>{body.innerHTML=old;hydrate(body)};
  save.onclick=async()=>{const t=box.value.trim();if(!t&&!(o.x.files&&o.x.files.length))return;save.disabled=true;
    try{await encEdit(seq,t,o.x);location.reload()}catch(err){toast(err.message||tr('Could not save'));save.disabled=false}};box.focus()},true);
/** The composer's attached files, each encrypted here and uploaded as ciphertext: their references for the message's extras. */
async function sealFiles(list){const out=[];for(const p of list){const {raw,blob}=await encFile(await p.blob.arrayBuffer());
    const r=await fetch('/api/boards/'+BOARD+'/sealed-files',{method:'POST',headers:{'content-type':'application/octet-stream'},body:blob});
    const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||tr("Couldn't post ")+p.name+'.');
    const f={id:j.id,name:p.name,mime:p.blob.type||'application/octet-stream',size:p.blob.size,key:b64(raw),chunk:CH};if(p.image&&p.w&&p.h){f.w=p.w;f.h=p.h}out.push(f)}
  return out}
window.addEventListener('submit',async e=>{const f=e.target;if(!f.matches||!f.matches('form.composer'))return;e.preventDefault();e.stopImmediatePropagation();if(window.micStop)micStop(); // it stops the submit, so the mic's own listener never hears it (#1711)
  const text=ta.value.trim(),atts=pending.slice();if(!text&&!atts.length)return;const type=f.querySelector('input[name=type]:checked')?.value||'note',was=+rpTo.value||null;
  {const no=scanRefusal(text);if(no){toast(no);return}}
  const btn=f.querySelector('button:not([type=button])');if(btn)btn.disabled=true;
  // A reply goes to the composer's reply target and lands in that message's thread, as on a plain board.
  const first=!was&&!document.querySelector('#thread>.entry');
  try{const files=atts.length?await sealFiles(atts):null;await encPost(text,type,was,files?{files}:null);
    if(atts.length){atts.forEach(x=>{if(x.url)URL.revokeObjectURL(x.url)});pending=pending.filter(x=>!atts.includes(x));renderAtt()}if(first)try{window.atteoTrack&&atteoTrack('first_message')}catch(x){}ta.value='';replyClear(true);if(was&&!(window.thrRearm&&thrRearm()))replyShown(was);taFit();stickNext=!was;await tick(false)}
  catch(err){toast((err.message||tr("Couldn't send"))+(atts.length?' Your message and files are still there.':' Your message is still in the box.'))}finally{if(btn)btn.disabled=false}},true);

if(!window.isSecureContext||!S||!window.indexedDB){say("🔒 <b>End-to-end encrypted.</b> This page can't hold an encryption key here (it needs a secure connection). Read and write with the atteo CLI.");return}
S.generateKey({name:'X25519'},false,['deriveBits']).then(()=>{
  e2eSync((+document.querySelector('#thread>.entry')?.dataset.seq||1)-1);setTimeout(idxSweep,3000)},
  ()=>say("🔒 <b>End-to-end encrypted.</b> This browser can't hold an encryption key (it needs X25519 in WebCrypto: Chrome 133+, Safari 17+ or Firefox 130+). Read and write with the atteo CLI."));
})();
`;
