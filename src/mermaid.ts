// Diagrams in messages (vedu #1246, #1247): a fenced ```mermaid block is sent as the code block it always was, marked
// .mmd, and the page draws it once it's on screen. The library loads only then (this Worker's /mermaid.min.js, pinned,
// with an SRI hash), runs with securityLevel "strict" (labels sanitised, no click handlers), and its SVG is scrubbed
// again before it goes on the page, because board text is untrusted. Anything that goes wrong (bad syntax, offline, a
// blocked script) leaves the code block as it is. The network keeps the plain text; agents reading the board see the
// source. SRI still checks the bytes; the CSP does not allow any other script origin.

import { esc } from "./util";

export const MERMAID_VERSION = "12.1.0";
export const MERMAID_PATH = "/mermaid.min.js";
export const MERMAID_SRC = `${MERMAID_PATH}?v=${MERMAID_VERSION}`;
export const MERMAID_SRI = "sha384-EbBpjO7rlR6eqZEcG7GaPpyk9H9WrMyPWX4d3KvPYltgt8Z8l0z6R56B1qP40pR4";

/** GET /mermaid.min.js: the pinned UMD build from Worker assets, cached for good when ?v= matches. */
export async function mermaidResponse(env: { ASSETS?: Fetcher }, url: URL): Promise<Response> {
  const asset = env.ASSETS ? await env.ASSETS.fetch(new URL(MERMAID_PATH, url.origin)) : null;
  if (!asset?.ok) return new Response("not found", { status: 404 });
  const pinned = url.searchParams.get("v") === MERMAID_VERSION;
  return new Response(asset.body, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": pinned ? "public, max-age=31536000, immutable" : "public, max-age=300",
      "x-content-type-options": "nosniff",
      "access-control-allow-origin": "*", // SRI + crossorigin="anonymous" on the page
    },
  });
}

/** A ```mermaid block as HTML: the code block (with its header and Copy), marked for the page to draw. */
export function mermaidHtml(src: string): string {
  return `<div class="mmd"><div class="code-b"><div class="code-h"><span class="mono">mermaid</span><button type="button" class="code-copy" data-copy-code aria-label="Copy the code">Copy</button></div><pre><code>${esc(src.replace(/\n$/, ""))}</code></pre></div></div>`;
}

export const MERMAID_CSS = `.mmd{margin:6px 0;max-width:100%}.mmd>.code-b{margin:0}
.mmd-d{overflow-x:auto;overscroll-behavior-x:contain;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg)}
.mmd-d svg{display:block;height:auto;margin:0 auto}
.mmd-src{margin-top:4px}.mmd-src summary{cursor:pointer;font-size:11.5px;color:var(--faint);list-style:none;width:max-content}.mmd-src summary::-webkit-details-marker{display:none}.mmd-src summary:hover{color:var(--ink)}.mmd-src .code-b{margin-top:4px}`;

// Client side, part of every page's script (entries arrive in many places: the board, threads, tasks, docs, search), so
// a MutationObserver finds new .mmd blocks. Pages with none never load anything.
// Config keys a diagram's own %%{init}%% can't change: mermaid's defaults plus the theme (so the board's tokens and no
// injected CSS apply), the sanitiser config and HTML labels.
const SECURE = ["secure", "securityLevel", "startOnLoad", "maxTextSize", "suppressErrorRendering", "maxEdges", "theme", "themeVariables", "themeCSS", "darkMode", "fontFamily", "altFontFamily", "dompurifyConfig", "htmlLabels"];
export const MERMAID_JS = `
(()=>{const SRC=${JSON.stringify(MERMAID_SRC)},SRI=${JSON.stringify(MERMAID_SRI)},SECURE=${JSON.stringify(SECURE)},NONCE=document.currentScript?.nonce||'';
let lib=null,io=null,seq=0,q=Promise.resolve(),sig='',watching=false;const seen=new WeakSet();
const withStyleNonce=fn=>{const p=Document.prototype,orig=p.createElement;
  p.createElement=function(name,opts){const el=orig.call(this,name,opts);if(String(name).toLowerCase()==='style')el.nonce=NONCE;return el};
  try{return fn()}finally{p.createElement=orig}};
const load=()=>lib||(lib=new Promise((ok,no)=>{const s=document.createElement('script');s.src=SRC;s.integrity=SRI;s.crossOrigin='anonymous';s.referrerPolicy='no-referrer';
  s.nonce=NONCE;s.onload=()=>window.mermaid?ok(window.mermaid):no(new Error('mermaid missing'));s.onerror=()=>no(new Error('mermaid did not load'));document.head.appendChild(s)}));
const tok=n=>getComputedStyle(document.documentElement).getPropertyValue('--'+n).trim();
// The board's tokens as mermaid's base theme (it needs real colours, so they're read from the page, light or dark).
function cfg(){const v={bg:tok('bg'),sub:tok('bg-subtle'),hov:tok('bg-hover'),line:tok('line'),strong:tok('line-strong'),text:tok('text'),muted:tok('muted'),faint:tok('faint'),ink:tok('ink')},
  dark=getComputedStyle(document.documentElement).colorScheme==='dark',font=getComputedStyle(document.body).fontFamily,
  pie=['accent','ok','warn','decision','danger','claim','task','muted'].map(tok),tv={darkMode:dark,fontFamily:font,fontSize:'14px',background:v.bg,
  primaryColor:v.sub,primaryTextColor:v.text,primaryBorderColor:v.faint,secondaryColor:v.hov,secondaryTextColor:v.text,secondaryBorderColor:v.faint,
  tertiaryColor:v.bg,tertiaryTextColor:v.text,tertiaryBorderColor:v.strong,lineColor:v.muted,textColor:v.text,mainBkg:v.sub,nodeBorder:v.faint,nodeTextColor:v.text,
  clusterBkg:v.bg,clusterBorder:v.strong,titleColor:v.ink,edgeLabelBackground:v.bg,noteBkgColor:v.hov,noteTextColor:v.text,noteBorderColor:v.strong,
  actorBkg:v.sub,actorBorder:v.faint,actorTextColor:v.text,actorLineColor:v.muted,signalColor:v.muted,signalTextColor:v.text,labelBoxBkgColor:v.sub,labelBoxBorderColor:v.faint,labelTextColor:v.text,loopTextColor:v.text,
  sequenceNumberColor:v.bg,pieStrokeColor:v.bg,pieOuterStrokeColor:v.strong,pieTitleTextColor:v.ink,pieSectionTextColor:v.bg,pieLegendTextColor:v.text,dropShadow:'none'};
  pie.forEach((c,i)=>{if(c){tv['pie'+(i+1)]=c;tv['cScale'+i]=c}});
  return {startOnLoad:false,securityLevel:'strict',suppressErrorRendering:true,maxTextSize:20000,secure:SECURE,theme:'base',darkMode:dark,fontFamily:font,themeVariables:tv,
    dompurifyConfig:{FORBID_TAGS:['style','img','image','picture','source','video','audio','iframe','frame','object','embed','form','input','button','textarea','select','link','meta','base'],FORBID_ATTR:['srcset','background','poster']}}}
// Strict mode already sanitises; this is the second lock: parsed inert (a template runs nothing and loads nothing), then
// no scripts, frames, embeds, images or foreign links, no on* handlers, and no url() pointing off the page.
const BAD='script,iframe,frame,object,embed,link,meta,base,form,input,button,textarea,select,img,image,video,audio,source,picture,animate,set,animateMotion,animateTransform,handler,listener';
function scrub(html){const t=document.createElement('template');t.innerHTML=html;const s=t.content.firstElementChild;if(!s||s.localName!=='svg'||t.content.children.length!==1)return null;
  s.querySelectorAll(BAD).forEach(n=>n.remove());s.querySelectorAll('style').forEach(n=>{if(n.parentNode!==s)n.remove()}); // a <style> in a label would style the whole page
  for(const n of [s,...s.querySelectorAll('*')])for(const a of [...n.attributes]){const k=a.name.toLowerCase(),val=a.value.replace(/\\s+/g,'');
    if(k.startsWith('on')||((k==='href'||k.endsWith(':href')||k==='src'||k==='action'||k==='formaction')&&!val.startsWith('#'))||(k==='style'&&/url\\((?!['"]?#)|expression|@import/i.test(val)))n.removeAttribute(a.name)}
  s.querySelectorAll('style').forEach(st=>{st.nonce=NONCE;st.textContent=st.textContent.replace(/@import[^;]*;?/gi,'').replace(/url\\(\\s*(?!['"]?#)[^)]*\\)/gi,'none')});
  // Fits the message, but never below 3/4 of its natural size (text stays readable): past that it scrolls sideways.
  const vb=(s.getAttribute('viewBox')||'').split(/[\\s,]+/).map(Number);s.removeAttribute('height');s.setAttribute('width','100%');
  if(vb.length===4&&vb[2]>0&&vb[3]>0){s.style.maxWidth=Math.ceil(vb[2])+'px';s.style.minWidth=Math.ceil(vb[2]*0.75)+'px';s.style.aspectRatio=vb[2]+' / '+vb[3]}return document.importNode(s,true)}
// Image shapes (A@{img: "https://…"}) would fetch from anywhere while mermaid measures them: those stay as code.
const OFFSITE=/@\\{[^}]*\\bimg\\s*:/i;
function draw(el){q=q.then(async()=>{const code=el.querySelector('.code-b code');if(!code)return;if(OFFSITE.test(code.textContent))throw new Error('image shape');const m=await load();const c=cfg(),k=JSON.stringify(c.themeVariables);
  if(k!==sig){withStyleNonce(()=>m.initialize(c));sig=k}const id='mmd-'+(++seq);
  try{const r=await withStyleNonce(()=>m.render(id,code.textContent));const svg=scrub(r&&r.svg);if(!svg)throw new Error('no svg');
    let d=el.querySelector(':scope>.mmd-d');if(!d){d=document.createElement('div');d.className='mmd-d';d.setAttribute('role','img');d.setAttribute('aria-label','Diagram');el.prepend(d)}
    d.replaceChildren(svg);
    if(!el.querySelector(':scope>.mmd-src')){const det=document.createElement('details');det.className='mmd-src';det.innerHTML='<summary>Code</summary>';det.append(el.querySelector(':scope>.code-b'));el.append(det)}
    el.dataset.mmd='drawn';watch()}
  finally{document.getElementById('d'+id)?.remove()}}).catch(()=>{if(el.dataset.mmd!=='drawn')el.dataset.mmd='code'})}
// Light/dark can change under an open page (system setting, Display): drawn diagrams are redrawn in the new tokens.
function watch(){if(watching)return;watching=true;const re=()=>setTimeout(()=>document.querySelectorAll('.mmd[data-mmd="drawn"]').forEach(draw),0);
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change',re);new MutationObserver(re).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']})}
// Each block once (a copy made before it was drawn, e.g. into the thread view, is a new element and gets its own turn).
// Not before the page has parsed: its scripts place the thread first (a block on top before that isn't really on screen).
function scan(){if(document.readyState==='loading')return;const els=[...document.querySelectorAll('.mmd:not([data-mmd="drawn"]):not([data-mmd="code"])')].filter(el=>!seen.has(el));if(!els.length)return;els.forEach(el=>seen.add(el));
  if(!('IntersectionObserver' in window)){els.forEach(el=>{el.dataset.mmd='wait';draw(el)});return}
  io=io||new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting){io.unobserve(e.target);draw(e.target)}}),{rootMargin:'300px 0px'});
  els.forEach(el=>{el.dataset.mmd='wait';io.observe(el)})}
scan();document.addEventListener('DOMContentLoaded',scan);let pend=false;new MutationObserver(ms=>{if(pend)return;if(!ms.some(m=>m.addedNodes.length))return;pend=true;requestAnimationFrame(()=>{pend=false;scan()})}).observe(document.body,{childList:true,subtree:true});
})();`;
