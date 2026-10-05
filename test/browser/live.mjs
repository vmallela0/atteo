// #345: live / idle / gone per agent session in Board info → Agents, and "N working" on the Boards page and the sidebar.
// Fast (opus-a #2824): sessions' last_seen is set through the ops API (not a wrangler subprocess per change), reads are
// instant (no locator waits that sat out 30s on an expected-missing row), the page's own 30s refresh is reached by
// fast-forwarding its clock, and each step polls for its result instead of sleeping.
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE=process.env.BASE||"http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
/** A session's last_seen, through the ops API: what an agent acting (or going quiet) does to it. */
const seen = (key, ts) => ops("session-seen", { session: ids[key], last_seen: ts });
/** Polls get() until ok(value) (or ms pass) and returns the last value. */
const until=async(get,ok,ms=8000)=>{const t=Date.now();let v;for(;;){v=await get();if(ok(v)||Date.now()-t>ms)return v;await new Promise(r=>setTimeout(r,40))}};
const run=Date.now().toString(36).slice(-4), A=`lv${run}`, B=`lw${run}`;
for (const u of [A,B]) await ops("users",{name:u,email:`${u}@example.com`,verified:"true"});
const tokA=(await ops("tokens",{user:A})).token, tokB=(await ops("tokens",{user:B})).token;
const board=(await ops("boards",{user:A,title:`Live ${run}`})).board.id; await ops("members",{board,user:B});
const quiet=(await ops("boards",{user:A,title:`Quiet ${run}`})).board.id;
const api=(t,m,p,b)=>fetch(BASE+p,{method:m,headers:{authorization:`Bearer ${t}`,"content-type":"application/json"},body:b?JSON.stringify(b):undefined}).then(r=>r.json());
const ids={};
for (const [t,c,u] of [[tokA,"Claude Code",A],[tokA,"Codex",A],[tokB,"Codex",B]]){const s=(await api(t,"POST","/api/sessions",{suggest:c.split(" ")[0].toLowerCase(),client:c})).session;ids[`${u}/${s.name}`]=s.id;await api(t,"POST",`/api/sessions/${s.id}/boards`,{board});if(c==="Claude Code")await api(t,"POST",`/api/sessions/${s.id}`,{status:"reviewing the checkout PR"});}
// B's codex was last seen half an hour ago: idle.
await seen(`${B}/codex`, Date.now()-30*60e3);
const ck=(await ops("sessions",{user:A})).cookie;
let fails=0;const check=(ok,m)=>{console.log(`${ok?"✓":"✗"} ${m}`);if(!ok)fails++};
const b=await chromium.launch({executablePath: process.env.PW_CHROME || undefined});
const state=(p,k)=>p.evaluate(k=>document.querySelector(`#agents .ag-row[data-k="${k}"]`)?.dataset.state??null,k); // instant: null when the row isn't there
for (const scheme of ["light","dark"]) {
  const ctx=await b.newContext({viewport:{width:1280,height:800},colorScheme:scheme});const [k,...v]=ck.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
  const p=await ctx.newPage();const errors=[];p.on("pageerror",e=>errors.push(e.message));
  if(scheme==="light")await p.clock.install(); // so the Agents list's own 30s refresh can be fast-forwarded to
  // Boards page and sidebar: "N working"
  await p.goto(`${BASE}/`);
  const card=p.locator(`.bcard[data-id="${board}"] .working`), qcard=p.locator(`.bcard[data-id="${quiet}"] .working`);
  await until(()=>card.isVisible(),Boolean);
  check(await card.isVisible()&&(await card.innerText()).trim()==="2 working",`${scheme}: Boards page card says "2 working" (${await card.innerText().catch(()=>"")})`);
  check(!(await qcard.isVisible()),`${scheme}: a board with no live agents says nothing`);
  const side=p.locator(`.sidebar a[href="/b/${board}"] .working`);
  check(await side.isVisible()&&(await side.innerText()).trim()==="2 working",`${scheme}: sidebar board item says "2 working"`);
  check(!(await p.locator(`.sidebar a[href="/b/${quiet}"] .working`).isVisible()),`${scheme}: quiet board has no chip in the sidebar`);
  await p.locator(".bgrid").screenshot({path:`${SHOTS_DIR}/live-boards-${scheme}.png`});
  await p.locator(".sidebar").screenshot({path:`${SHOTS_DIR}/live-sidebar-${scheme}.png`});
  // Board info → Agents
  await p.goto(`${BASE}/b/${board}`);await until(()=>state(p,`${B}/codex`),Boolean);
  check(await state(p,`${A}/claude`)==="live"&&await state(p,`${A}/codex`)==="live",`${scheme}: ${A}'s two sessions are live`);
  check(await state(p,`${B}/codex`)==="idle",`${scheme}: ${B}/codex (seen 30 min ago) is idle`);
  const dot=p.locator(`#agents .ag-row[data-k="${A}/claude/"] .ag-dot, #agents .ag-row[data-k="${A}/claude"] .ag-dot`).first();
  check(await p.locator(`#agents .ag-row[data-state=live] .ag-dot.live[aria-label="working now"]`).count()===2,`${scheme}: live dots say "working now"`);
  check(await p.locator(`#agents .ag-row[data-state=idle] .ag-dot.idle[aria-label="idle"]`).count()===1,`${scheme}: idle dot says "idle"`);
  const anim=await p.locator(`#agents .ag-dot.live`).first().evaluate(e=>getComputedStyle(e).animationName);
  check(anim==="breathe",`${scheme}: live dot breathes (${anim})`);
  if(scheme==="light"){
    // Live without reload: claude goes quiet (10 min ago → idle), B's codex comes back (now → live).
    await seen(`${A}/claude`, Date.now()-10*60e3);
    await seen(`${B}/codex`, Date.now());
    const avBefore=await p.locator(`#agents .ag-row[data-k="${A}/codex"] .av`).evaluate(e=>(e.dataset.mark="kept",1));
    await p.clock.fastForward("00:31"); // past the list's own 30s refresh: no agentsRefresh() call here
    await until(()=>state(p,`${A}/claude`),v=>v==="idle");
    check(await state(p,`${A}/claude`)==="idle"&&await state(p,`${B}/codex`)==="live","within 30s, without reload: claude → idle, B's codex → live");
    check(await p.locator(`#agents .ag-row[data-k="${A}/codex"] .av[data-mark=kept]`).count()===1,"…avatars are kept across refreshes (no flicker)");
    check((await p.locator(`#agents .ag-row[data-k="${A}/claude"] .ag-status`).innerText())==="reviewing the checkout PR","…status line is still there");
    // A "gone" session, as the API would send it (the server lists the last day only, so stub one in).
    await p.route(`**/api/boards/${board}/agents`,async r=>{const j=await (await r.fetch()).json();j.agents.push({user:B,name:"old",client:"Codex",status:null,last_seen:Date.now()-3*86400e3,state:"gone"});r.fulfill({json:j})});
    await p.evaluate(()=>agentsRefresh());await until(()=>state(p,`${B}/old`),Boolean);
    check(await state(p,`${B}/old`)==="gone"&&await p.locator(`#agents .ag-dot.gone[aria-label="gone"]`).count()===1,"a gone session shows a hollow ring labelled gone");
    check((await p.locator("#agents .fold-n").innerText())==="4","…and the Agents count follows (4)");
    await p.unroute(`**/api/boards/${board}/agents`);
    // Silent for over an hour: off the list (jxn #845); it comes back when it acts again.
    await seen(`${B}/codex`, Date.now()-2*3600e3);await p.evaluate(()=>agentsRefresh());
    check(await until(()=>state(p,`${B}/codex`),v=>v===null)===null,"an agent silent for over an hour leaves the list");
    await seen(`${B}/codex`, Date.now());await p.evaluate(()=>agentsRefresh());
    check(await until(()=>state(p,`${B}/codex`),v=>v==="live")==="live","…and is back as soon as it acts");
    // Back to the real list, so dark mode starts from the same state.
    await seen(`${A}/claude`, Date.now());
    await seen(`${B}/codex`, Date.now()-30*60e3);
    await p.route(`**/api/boards/${board}/agents`,async r=>{const j=await (await r.fetch()).json();j.agents.push({user:B,name:"old",client:"Codex",status:null,last_seen:Date.now()-3*86400e3,state:"gone"});r.fulfill({json:j})});
    await p.evaluate(()=>agentsRefresh());await until(()=>state(p,`${B}/old`),Boolean);
  } else {
    await p.route(`**/api/boards/${board}/agents`,async r=>{const j=await (await r.fetch()).json();j.agents.push({user:B,name:"old",client:"Codex",status:null,last_seen:Date.now()-3*86400e3,state:"gone"});r.fulfill({json:j})});
    await p.evaluate(()=>agentsRefresh());await until(()=>state(p,`${B}/old`),Boolean);
  }
  await p.locator("#agents").screenshot({path:`${SHOTS_DIR}/live-agents-${scheme}.png`});
  check(errors.length===0,`${scheme}: no page errors ${errors.join(" | ")}`);await ctx.close();
}
// Reduced motion: no breathing.
{ const ctx=await b.newContext({viewport:{width:1280,height:800},reducedMotion:"reduce"});const [k,...v]=ck.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
  const p=await ctx.newPage();await p.goto(`${BASE}/b/${board}`);await until(()=>p.locator(`#agents .ag-dot.live`).count(),Boolean);await until(()=>p.locator(`.sidebar .working:not([hidden]) .dot`).count(),Boolean);
  const anim=await p.locator(`#agents .ag-dot.live`).first().evaluate(e=>getComputedStyle(e).animationName);
  const anim2=await p.locator(`.sidebar .working:not([hidden]) .dot`).first().evaluate(e=>getComputedStyle(e).animationName);
  check(anim==="none"&&anim2==="none",`prefers-reduced-motion: dots hold still (${anim}, ${anim2})`);await ctx.close(); }
// Phone: Board info opens as a sheet; the dots are there too.
{ const ctx=await b.newContext({viewport:{width:390,height:844}});const [k,...v]=ck.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
  const p=await ctx.newPage();await p.goto(`${BASE}/b/${board}`);await p.locator("#info-btn").click();
  check(await until(()=>p.locator(`#agents .ag-dot.live`).first().isVisible().catch(()=>false),Boolean),"390px: dots show in the Board info sheet");
  await p.screenshot({path:`${SHOTS_DIR}/live-phone.png`});await ctx.close(); }
// The sidebar's "N working" follows without a reload (it refreshes every minute; called directly here).
{ const ctx=await b.newContext({viewport:{width:1280,height:800}});const [k,...v]=ck.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
  const p=await ctx.newPage();await p.goto(`${BASE}/b/${quiet}`);await p.waitForFunction(()=>typeof liveRefresh==="function");const side=p.locator(`.sidebar a[href="/b/${board}"] .working`);
  const sideText=()=>p.evaluate(b=>{const e=document.querySelector(`.sidebar a[href="/b/${b}"] .working`);return e&&!e.hidden&&e.offsetParent!==null?e.innerText.trim():""},board);
  await seen(`${B}/codex`, Date.now());await p.evaluate(()=>liveRefresh());
  check(await until(sideText,v=>v==="3 working")==="3 working","sidebar: B's codex comes back → 3 working, no reload");
  for (const k of Object.keys(ids)) await seen(k, Date.now()-3600e3);await p.evaluate(()=>liveRefresh());
  check(await until(sideText,v=>v==="")==="" && !(await side.isVisible()),"sidebar: everyone idle → the chip goes away");await ctx.close(); }
await b.close();console.log(fails?`${fails} FAILED`:"all live/idle/gone checks passed");
