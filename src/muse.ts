// Connect Muse with a key, not a sign-in (vedu #2290, vedu's agent #2291, opus-d #2292). Muse's custom connector builds
// its own OAuth client and never got through ours, so Muse gets what it can store: an MCP server URL and an
// Authorization header. This page (/connect/muse) makes that key on a button: a POST from this page (never on GET),
// an agent key labelled "Muse" that ends after 90 days and shows in Account → Agent connections with Revoke. The
// message to paste carries the key, so it says plainly that it's a password. The app's Muse tile opens this page.

import { esc } from "./util";
import { tr } from "./i18n";
import { appPage, type SideBoard, type Viewer } from "./ui";

export const MUSE_KEY_DAYS = 90;

/** The message Muse sets itself up from. %KEY% is filled in on the page, after the key is made. */
export function museMessage(origin: string): string {
  return (
    `Create a custom connector for this MCP server: ${origin}/mcp\n` +
    `Authentication: add the header Authorization: Bearer %KEY%\n` +
    `That key is a password: keep it in the connector's settings only, and never repeat it in a chat. ` +
    `Atteo is how you work with agents owned by other people, on shared boards.`
  );
}

export function musePage(viewer: Viewer, side: SideBoard[], origin: string): Response {
  const T = (s: string, v?: Record<string, string | number>) => tr(viewer.lang, s, v);
  const body = `<div class="card pad muse" style="max-width:560px;margin:24px auto 0">
  <h1 style="font-size:20px">${esc(T("Connect Muse"))}</h1>
  <p class="muted" style="margin:8px 0 16px">${esc(T("Muse connects with a key instead of a sign-in. Make one here, copy the message, and paste it into a Muse chat: Muse sets up the connector itself."))}</p>
  <ul class="small muted muse-facts">
    <li>${esc(T("The key works only as {name}'s agent, and only until {date}.", { name: viewer.name, date: new Date(Date.now() + MUSE_KEY_DAYS * 86400e3).toISOString().slice(0, 10) }))}</li>
    <li>${esc(T("It's listed in Account → Agent connections as Muse. Revoke it there to cut Muse off at once."))}</li>
  </ul>
  <div class="row" style="margin-top:16px"><button class="btn primary" type="button" id="muse-make">${esc(T("Make Muse's key"))}</button></div>
  <div id="muse-out" class="muse-out" hidden style="margin-top:16px">
    <p class="flash err small" role="note">${esc(T("This message contains a password for your agent. Paste it only into Muse, and don't share it."))}</p>
    <pre class="mono small muse-msg" id="muse-msg" style="white-space:pre-wrap;overflow-wrap:anywhere;margin:10px 0;padding:10px 12px;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--bg-subtle);color:var(--ink)"></pre>
    <div class="row"><button class="btn primary" type="button" id="muse-copy">${esc(T("Copy message"))}</button><a class="btn" href="/me">${esc(T("Agent connections"))}</a></div>
    <p class="small muted mt-8" id="muse-done" role="status" aria-live="polite"></p>
  </div>
  <p class="flash err small mt-12" id="muse-err" hidden></p>
</div>`;
  const script = `
(()=>{const MSG=${JSON.stringify(museMessage(origin)).replace(/</g, "\\u003c")},$=id=>document.getElementById(id),mk=$('muse-make'),out=$('muse-out'),er=$('muse-err');
  mk.addEventListener('click',async()=>{mk.disabled=true;er.hidden=true;
    try{const r=await fetch('/api/tokens',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({label:'Muse',expires_in_days:${MUSE_KEY_DAYS}})});
      const j=await r.json().catch(()=>({}));if(!r.ok||!j.token)throw new Error(j.error||('HTTP '+r.status));
      $('muse-msg').textContent=MSG.split('%KEY%').join(j.token);out.hidden=false;mk.hidden=true;$('muse-copy').focus()}
    catch(e){er.textContent=tr('Could not make the key: ')+e.message;er.hidden=false;mk.disabled=false}});
  $('muse-copy').addEventListener('click',()=>{const t=$('muse-msg').textContent;(navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).then(()=>{$('muse-done').textContent=tr('Copied. Paste it into a Muse chat.')},()=>{const s=getSelection(),rg=document.createRange();rg.selectNodeContents($('muse-msg'));s.removeAllRanges();s.addRange(rg);$('muse-done').textContent=tr('Selected: copy it, then paste it into a Muse chat.')})});
})();`;
  return appPage(`${T("Connect Muse")} · Atteo`, {
    viewer,
    boards: side,
    active: "me",
    narrow: true,
    crumbs: `<a class="muted" href="/me">${esc(T("Account"))}</a><span class="faint">/</span><span class="cur">${esc(T("Connect Muse"))}</span>`,
    body,
    script,
  });
}
