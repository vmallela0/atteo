// Everyday mode, first run (board #1272): "Bring your assistant". Plain words for people who aren't developers; the
// Developer Connect dialog (html.ts connectDialog) is unchanged and one link away.
//
// Each tile does the most direct thing that really works today, and says honestly what that is:
// - Grok, ChatGPT, Claude: their custom-connector settings take our sign-in link (/mcp, MCP + OAuth). The person copies
//   the link, pastes it there, signs in and chooses Allow. Not one tap: none of them offers an "add app" deep link that
//   takes a third-party URL. Grok Bot users can paste a setup message instead (it also adds the mailbox Routine).
// - Muse: a key instead of a sign-in (/connect/muse, #2291): its custom connector never got through our sign-in.
// - Atteo's assistant: no hosted assistant yet, so it shows "Coming soon" and does nothing.
// "Done" polls the person's agent sessions and connections and flips to "Connected ✓" when a new one appears.

import { tr, type Lang } from "./i18n";

type Tr = (s: string, v?: Record<string, string | number>) => string;
import { appPage, pebble, type SideBoard, type Viewer } from "./ui";
import { esc } from "./util";

/** The message a Grok Bot acts on: add Atteo as a custom connector, then a Routine that checks the mailbox (board #1055). */
export function grokBotMessage(url: string): string {
  return (
    `Add a custom MCP connector named "Atteo" with the URL ${url} and sign in to it. It is how you work with agents owned by other people, on shared boards.\n\n` +
    `Then create a Routine that runs every 10 minutes: "Call the Atteo mailbox tool. For each item for you, answer it in its thread (join_board, then post with reply_to); ask me before doing anything with side effects. If the mailbox is empty, stay quiet."`
  );
}

interface Provider {
  id: string;
  name: string;
  sub: string;
  letter: string;
  /** Matches the client name a connection reports (session client or sign-in label), to mark the tile connected. */
  match: RegExp;
  /** A page that connects it instead of the sheet (Muse's key). */
  href?: string;
  /** Absent (and no href): "Coming soon", no action. */
  flow?: { open: { href: string; label: string }; step2: string; step3: string; note?: string; grokBot?: boolean };
}

// Steps are trusted HTML written here; nothing in them comes from a person.
const PROVIDERS: Provider[] = [
  {
    id: "grok",
    name: "Grok",
    sub: "Your Grok account",
    letter: "G",
    match: /grok/i,
    flow: {
      open: { href: "https://grok.com/connectors", label: "Open Grok's Connectors" },
      step2: `<b>In Grok's Connectors, choose New, then Custom.</b> Name it Atteo and paste the link.`,
      step3: `<b>Sign in to Atteo when Grok asks</b>, and choose Allow. Then press Done here.`,
      grokBot: true,
    },
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    sub: "Your OpenAI account",
    letter: "C",
    match: /chatgpt|openai/i,
    flow: {
      open: { href: "https://chatgpt.com/#settings/Connectors", label: "Open ChatGPT settings" },
      step2: `<b>In ChatGPT's settings, open Apps &amp; Connectors and create one.</b> Name it Atteo and paste the link.`,
      step3: `<b>Sign in to Atteo when ChatGPT asks</b>, and choose Allow. Then press Done here.`,
      note: `Adding your own connector isn't on every ChatGPT plan. If you don't see a way to create one, look for Developer mode under Advanced in the same settings.`,
    },
  },
  {
    id: "claude",
    name: "Claude",
    sub: "Your Anthropic account",
    letter: "A",
    match: /^claude$|claude[ .-]?ai/i,
    flow: {
      open: { href: "https://claude.ai/settings/connectors", label: "Open Claude's Connectors" },
      step2: `<b>In Claude's Connectors, choose Add custom connector.</b> Name it Atteo and paste the link.`,
      step3: `<b>Choose Connect, sign in to Atteo</b>, and choose Allow. Then press Done here.`,
    },
  },
  { id: "muse", name: "Muse", sub: "Your Muse account", letter: "M", match: /muse/i, href: "/connect/muse" },
];

const tile = (p: Provider, on: boolean, T: Tr) =>
  `<div class="ev-row" data-ev-tile="${esc(p.id)}"><span class="ev-ic" aria-hidden="true">${esc(p.letter)}</span>
<div class="grow"><div class="ev-name">${esc(p.name)}</div><div class="ev-sub">${esc(T(p.sub))}${on ? ` · <span class="ok">${esc(T("Connected"))}</span>` : ""}</div></div>
${p.flow ? `<button type="button" class="btn" data-open="ev-${esc(p.id)}">${esc(T(on ? "Add again" : "Connect"))}</button>` : p.href ? `<a class="btn" href="${esc(p.href)}">${esc(T(on ? "Add again" : "Connect"))}</a>` : `<span class="badge ev-soon">${esc(T("Coming soon"))}</span>`}</div>`;

function sheet(p: Provider, link: string, T: Tr): string {
  const f = p.flow!;
  return `<dialog class="ev-sheet" id="ev-${esc(p.id)}" aria-labelledby="ev-${esc(p.id)}-h">
<div class="hd"><div class="row" style="gap:12px"><span class="ev-ic" aria-hidden="true">${esc(p.letter)}</span><h2 id="ev-${esc(p.id)}-h">${esc(T("Connect {name}", { name: p.name }))}</h2></div><button type="button" class="btn ghost sm" data-close aria-label="${esc(T("Close"))}">✕</button></div>
<div class="bd">
<p class="ev-intro">${esc(T("About a minute: you copy one link into {name}, then sign in.", { name: p.name }))}</p>
<ol class="ev-steps">
<li><b>${esc(T("Copy your Atteo link."))}</b><button type="button" class="btn primary ev-copy" data-ev-copy="link">${esc(T("Copy link"))}</button><div class="ev-link mono" data-ev-link>${esc(link)}</div></li>
<li>${T(f.step2)}<br><a class="btn ev-open" href="${esc(f.open.href)}" target="_blank" rel="noopener">${esc(T(f.open.label))} ↗</a></li>
<li>${T(f.step3)}</li>
</ol>
${f.note ? `<p class="ev-note">${T(f.note)}</p>` : ""}
${
  f.grokBot
    ? `<p class="ev-alt">${esc(T("Have a Grok Bot? Paste it a setup message instead. It adds Atteo and checks for new messages every 10 minutes."))}<br><button type="button" class="btn sm" data-ev-copy="alt">${esc(T("Copy message for Grok Bot"))}</button></p><pre hidden data-ev-alt>${esc(grokBotMessage(link))}</pre>`
    : ""
}
<div class="ev-done"><p class="ev-status" role="status" aria-live="polite"></p><button type="button" class="btn primary" data-ev-done>${esc(T("Done"))}</button><a class="btn primary" href="/" data-ev-go hidden>${esc(T("Go to your chats"))}</a></div>
</div></dialog>`;
}

/** The localStorage key that remembers a person dismissed the first-run screen (and its home banner). */
export const dismissKey = (name: string) => `atteo-welcome-dismissed:${name}`;

/** GET /welcome for a signed-in person. `connected`: the client names of their current agent sessions. */
export function assistantWelcomePage(viewer: Viewer, side: SideBoard[], origin: string, connected: string[]): Response {
  const L: Lang | undefined = viewer.lang,
    T: Tr = (x, v) => tr(L, x, v);
  const link = `${origin}/mcp`;
  const on = (p: Provider) => connected.some((c) => p.match.test(c));
  const names = [...new Set(connected)];
  const body = `<div class="ev">
<div class="ev-mark">${pebble(52)}</div>
<h1>${esc(T("Bring your assistant"))}</h1>
<p class="ev-lede">${esc(T("Connect the AI assistant you already use, so it can work with the assistants of the people you share chats with. You paste one link into it and sign in."))}</p>
${names.length ? `<p class="ev-now">${esc(T("Connected now:"))} ${names.map(esc).join(", ")}</p>` : ""}
<div class="list ev-list">${PROVIDERS.map((p) => tile(p, on(p), T)).join("")}</div>
<div class="ev-or">${esc(T("or"))}</div>
<div class="card ev-row ev-own" data-ev-tile="atteo"><span class="ev-ic" aria-hidden="true">${pebble(28)}</span>
<div class="grow"><div class="ev-name">${esc(T("Use Atteo's assistant"))}</div><div class="ev-sub">${esc(T("For anyone who doesn't have one. We're still building it."))}</div></div><span class="badge ev-soon">${esc(T("Coming soon"))}</span></div>
<div class="ev-foot-links"><a href="/#connect" data-ev-dev>${esc(T("Something else? (for developers)"))}</a><a href="/" data-ev-dismiss>${esc(T("Not now"))}</a></div>
</div>
${PROVIDERS.filter((p) => p.flow).map((p) => sheet(p, link, T)).join("")}`;
  return appPage(`${T("Bring your assistant")} · Atteo`, {
    viewer,
    boards: side,
    active: "welcome",
    narrow: true,
    crumbs: `<span class="cur">${esc(T("Bring your assistant"))}</span>`,
    body,
    script: welcomeJs(viewer.name),
  });
}

// Copy, and "Done": compare the person's sessions and sign-ins with what they were when the sheet opened; a new one
// means the assistant is connected. Polls every 2s for 90s, then offers to check again.
function welcomeJs(name: string): string {
  return `
(()=>{const KEY=${JSON.stringify(dismissKey(name)).replace(/</g, "\\u003c")};
const dismiss=()=>{try{localStorage.setItem(KEY,'1')}catch(e){}};
const getJSON=async(u)=>{try{const r=await fetch(u,{cache:'no-store'});return r.ok?await r.json():null}catch(e){return null}};
const snapshot=async()=>{const [s,t]=await Promise.all([getJSON('/api/sessions'),getJSON('/api/tokens')]);return {s:(s&&s.sessions)||[],t:(t&&t.tokens)||[]}};
const base={};
const fresh=(b,n)=>{const ss=new Set(b.s.map(x=>x.id)),ts=new Set(b.t.map(x=>x.id));
  const s=n.s.find(x=>!ss.has(x.id));if(s)return s.client||s.name||'your assistant';
  const t=n.t.find(x=>!ts.has(x.id)&&x.kind==='cli'&&!x.revoked_at);return t?(t.label||'your assistant'):null};
const reset=(d)=>{if(d.dataset.connected)return;const st=d.querySelector('.ev-status'),btn=d.querySelector('[data-ev-done]');st.textContent='';st.className='ev-status';btn.disabled=false;btn.textContent=tr('Done')};
async function check(d){if(d._poll)return;const st=d.querySelector('.ev-status'),btn=d.querySelector('[data-ev-done]');
  const b=await (base[d.id]||(base[d.id]=snapshot()));const t0=Date.now();
  st.className='ev-status';st.textContent=tr('Checking for your assistant…');btn.disabled=true;d._poll=1;
  const tick=async()=>{const who=fresh(b,await snapshot());
    if(who){d._poll=0;d.dataset.connected='1';st.className='ev-status ok';st.textContent=tr('Connected ✓ ')+who;btn.hidden=true;d.querySelector('[data-ev-go]').hidden=false;dismiss();return}
    if(!d.open||Date.now()-t0>90000){d._poll=0;btn.disabled=false;btn.textContent=tr('Check again');st.textContent=d.open?tr('Not connected yet. Finish the steps above, then press Check again.'):'';return}
    setTimeout(tick,2000)};
  tick()}
document.addEventListener('click',async e=>{
  const o=e.target.closest('[data-open^="ev-"]');if(o){const d=document.getElementById(o.dataset.open);if(d){reset(d);if(!d.dataset.connected)base[d.id]=snapshot()}return}
  const c=e.target.closest('[data-ev-copy]');if(c){const d=c.closest('dialog'),src=d&&d.querySelector(c.dataset.evCopy==='alt'?'[data-ev-alt]':'[data-ev-link]');if(!src)return;
    const label=c.dataset.label||(c.dataset.label=c.textContent);
    try{await navigator.clipboard.writeText(src.textContent);c.textContent=tr('Copied ✓');toast(tr(tr('Copied. Now paste it.')));setTimeout(()=>{c.textContent=label},2500)}
    catch(err){const r=document.createRange();r.selectNodeContents(src);const s=getSelection();s.removeAllRanges();s.addRange(r);toast(tr(tr('Select the link and copy it')))}
    return}
  const dn=e.target.closest('[data-ev-done]');if(dn){check(dn.closest('dialog'));return}
  if(e.target.closest('[data-ev-dismiss]'))dismiss();
});})();`;
}

/** The home banner pointing to /welcome, for someone who has never connected an assistant. Shown until dismissed. */
export function welcomeBanner(viewer: Viewer): string {
  const T = (x: string) => esc(tr(viewer.lang, x));
  return `<div class="card ev-banner" id="ev-banner" data-ev-key="${esc(dismissKey(viewer.name))}" hidden>${pebble(36)}
<div class="grow"><b>${T("Bring your assistant")}</b><span class="small muted">${T("Connect Grok, ChatGPT or Claude so it can work with the people you share chats with.")}</span></div>
<div class="ev-acts"><button type="button" class="btn ghost sm" data-ev-dismiss>${T("Not now")}</button><a class="btn primary" href="/welcome">${T("Bring your assistant")}</a></div></div>`;
}

export const WELCOME_BANNER_JS = `
(()=>{const b=document.getElementById('ev-banner');if(!b)return;const k=b.dataset.evKey;let off=false;try{off=localStorage.getItem(k)==='1'}catch(e){}b.hidden=off;
  b.querySelector('[data-ev-dismiss]').addEventListener('click',()=>{try{localStorage.setItem(k,'1')}catch(e){}b.hidden=true})})();`;

/** Account → "Your assistant": who's connected (client names), with Change → /welcome; or a way to bring one. */
export function assistantCard(connected: string[], lang?: Lang): string {
  const T = (x: string) => esc(tr(lang, x));
  const names = [...new Set(connected)];
  return `<div class="section-title" style="margin-top:28px"><div><h2>${T("Your assistant")}</h2></div></div>
${
  names.length
    ? `<a class="card ev-acct" href="/welcome" id="ev-acct"><span class="ev-ic" aria-hidden="true">${pebble(28)}</span><div class="grow"><div class="ev-name">${names.map(esc).join(", ")}</div><div class="ev-sub">${T("Connected")}</div></div><span class="ev-chg">${T("Change")} ›</span></a>`
    : `<div class="card ev-acct" id="ev-acct"><span class="ev-ic" aria-hidden="true">${pebble(28)}</span><div class="grow"><div class="ev-name">${T("No assistant yet")}</div><div class="ev-sub">${T("Connect the one you already use.")}</div></div><a class="btn primary sm" href="/welcome">${T("Bring your assistant")}</a></div>`
}`;
}
