// Pinned doc + Recap on the web (vedu #977, #980), against the server's /pin and /recap (MOCK=1 fakes /pin, as
// before the API landed). A server without them shows nothing (checked with a stubbed 404). Usage: BASE=http://localhost:8787 node pinrecap.mjs
import { SHOTS_DIR } from "../lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE=process.env.BASE||"http://localhost:8787",MOCK=process.env.MOCK==="1";
const ops=async(p,b)=>(await fetch(`${BASE}/api/ops/${p}`,{method:"POST",headers:{"x-admin-key":"ci-admin-key","content-type":"application/json"},body:JSON.stringify(b)})).json();
const run=Date.now().toString(36).slice(-4),P=`jp${run}`,V=`vp${run}`,W=`wv${run}`;
for(const u of [P,V,W])await ops("users",{name:u,email:`${u}@example.com`,verified:"true"});
const tokV=(await ops("tokens",{user:V})).token;
const board=(await ops("boards",{user:P,title:`Pins ${run}`})).board.id;await ops("members",{board,user:V});await ops("members",{board,user:W});
const ckP=(await ops("sessions",{user:P})).cookie,ckW=(await ops("sessions",{user:W})).cookie;
const api=(m,p,b,h={})=>fetch(BASE+p,{method:m,headers:{"content-type":"application/json",...h},body:b?JSON.stringify(b):undefined}).then(r=>r.json());
console.log("  viewer role:",JSON.stringify(await api("POST",`/api/boards/${board}/members/${W}`,{role:"viewer"},{cookie:ckP})));
const mcp=async(name,args)=>(await (await fetch(`${BASE}/mcp?board=${board}`,{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream",authorization:`Bearer ${tokV}`},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})})).json()).result.content[0].text;
const seqOf=t=>Number(String(t).match(/#(\d+)/)[1]);
await mcp("read",{});
await mcp("doc",{action:"write",name:"STATUS.md",content:"# Release 1.4 status\n\n- Checkout fix: shipped\n- Payments retry: in review\n- iOS build: waiting on Xcode\n\n## Runbook\n\nDeploy with ship.sh, then check /health.\n",base_version:0,summary:"created"});
await mcp("doc",{action:"write",name:"NOTES.md",content:"Scratch notes.\n",base_version:0,summary:"created"});
const say=async(text,extra={})=>{const r=await api("POST",`/api/boards/${board}/entries`,{text,...extra},{cookie:ckP});return r.entry?.seq??r.seq};
const first=await say("Kickoff: let's ship 1.4 this week");
let fails=0;const check=(ok,m)=>{console.log(`${ok?"✓":"✗"} ${m}`);if(!ok)fails++};
const b=await chromium.launch({executablePath: process.env.PW_CHROME || undefined});
const errors=[];
// The mock server side: one pinned file per board; recap answers with what the board has.
let PINNED=null;
async function mock(ctx){if(!MOCK)return;
  await ctx.route(`**/api/boards/${board}/pin`,async route=>{const m=route.request().method();
    if(m==="GET")return route.fulfill({json:{pinned:PINNED}});
    if(m==="POST"){const {name}=JSON.parse(route.request().postData()||"{}");PINNED={name,version:2,by:P,via:"person",ts:Date.now()};return route.fulfill({json:{ok:true,pinned:PINNED}})}
    if(m==="DELETE"){PINNED=null;return route.fulfill({json:{ok:true,pinned:null}})}
    return route.fulfill({status:405,json:{error:"method not allowed"}})});}
async function open(ck,{w=1280,h=860,scheme="light",touch=false}={}){const ctx=await b.newContext({viewport:{width:w,height:h},colorScheme:scheme,hasTouch:touch,isMobile:touch});const [k,...v]=ck.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
  await mock(ctx);const p=await ctx.newPage();p.on("pageerror",e=>errors.push(e.message));await p.goto(`${BASE}/b/${board}`);await p.waitForTimeout(1200);return {p,ctx}}
const vis=async(p,sel)=>p.locator(sel).isVisible().catch(()=>false);

// 1) Nothing pinned: no bar, no section; the file viewer offers Pin
let {p,ctx}=await open(ckP,{scheme:"dark"});
check(!(await vis(p,"#pin-bar"))&&!(await vis(p,"#pin-side")),"nothing pinned: no bar, no side section");
await p.click('#board-tabs button[aria-controls="panel-docs"]');await p.waitForTimeout(600);
await p.click('[data-doc="STATUS.md"]');await p.waitForTimeout(600);
check(await vis(p,"#doc-pin")&&(await p.locator("#doc-pin").innerText()).trim()==="Pin","the file viewer offers Pin");
await p.click("#doc-pin");await p.waitForTimeout(900);
check((await p.locator("#doc-pin").innerText()).trim()==="Unpin","…and once pinned it offers Unpin");
await p.screenshot({path:`${SHOTS_DIR}/pin-viewer-dark.png`,clip:await p.locator("#doc-view").boundingBox()});
await p.click('[data-doc="NOTES.md"]');await p.waitForTimeout(600);
check((await p.locator("#doc-pin").innerText()).trim()==="Pin","another file still offers Pin");
// 2) Back in the conversation: the bar on top, the side section with a preview
await p.click('#board-tabs button[aria-controls="panel-conv"]');await p.waitForTimeout(400);
check(await vis(p,"#pin-bar")&&(await p.locator("#pin-name").innerText())==="STATUS.md"&&(await p.locator("#pin-peek").innerText())==="Release 1.4 status",`the bar shows the pinned file and its first line ("${await p.locator("#pin-bar").innerText()}")`);
const side=await p.locator("#pin-side").innerText().catch(()=>"");
check(await vis(p,"#pin-side")&&/Pinned/.test(side)&&/Checkout fix: shipped/.test(side),`the side panel's first section previews it (${JSON.stringify(side.slice(0,90))})`);
const order=await p.evaluate(()=>[...document.getElementById('board-info').children].map(x=>x.id||x.className).slice(0,2));
check(order[0]==="pin-side",`…as the first section (${order})`);
await p.screenshot({path:`${SHOTS_DIR}/pin-board-dark.png`});
await p.click("#pin-open");await p.waitForTimeout(700);
check(!(await p.locator("#panel-docs").evaluate(x=>x.hidden))&&(await p.locator("#doc-view b.mono").first().innerText())==="STATUS.md","clicking the bar opens the file");
await p.click('#board-tabs button[aria-controls="panel-conv"]');await p.waitForTimeout(300);
await p.click("#pin-side [data-pin-open]");await p.waitForTimeout(600);
check(!(await p.locator("#panel-docs").evaluate(x=>x.hidden)),"…and so does the side card");
// 3) An edit to the pinned file shows live; unpinning (from elsewhere) clears it on refresh
await mcp("doc",{action:"write",name:"STATUS.md",content:"# Release 1.4 shipped\n\nAll done.\n",base_version:1,summary:"shipped"});await p.waitForTimeout(1500);
await p.click('#board-tabs button[aria-controls="panel-conv"]');await p.waitForTimeout(300);
check((await p.locator("#pin-peek").innerText())==="Release 1.4 shipped",`an edit to the pinned file shows live ("${await p.locator("#pin-peek").innerText()}")`);
const {p:pl,ctx:cl}=await open(ckP,{scheme:"light"});await pl.screenshot({path:`${SHOTS_DIR}/pin-board-light.png`});await cl.close();
// 4) A viewer sees the pin but can't change it
{const {p:pw,ctx:cw}=await open(ckW);check(await vis(pw,"#pin-bar"),"a view-only member sees the pin");
  await pw.click('#board-tabs button[aria-controls="panel-docs"]');await pw.waitForTimeout(500);await pw.click('[data-doc="STATUS.md"]');await pw.waitForTimeout(500);
  check(!(await vis(pw,"#doc-pin")),"…but gets no Pin/Unpin");await cw.close()}
// 5) Phones: the bar fits
{const {p:pm,ctx:cm}=await open(ckP,{w:360,h:740,touch:true,scheme:"dark"});
  const g=await pm.evaluate(()=>{const r=document.getElementById('pin-bar').getBoundingClientRect(),i=document.getElementById('info-btn').getBoundingClientRect(),h=document.querySelector('.bp-head').getBoundingClientRect();return {l:Math.round(r.left),r:Math.round(r.right),top:Math.round(r.top),head:Math.round(h.bottom),info:Math.round(i.left),infoBottom:Math.round(i.bottom),sw:document.documentElement.scrollWidth,iw:innerWidth}});
  check(await vis(pm,"#pin-bar")&&g.l>=0&&g.r<=g.iw&&g.sw<=g.iw,`phone: the bar fits the screen (${JSON.stringify(g)})`);
  check(g.r<=g.info||g.top>=g.infoBottom,"phone: …clear of the board-info button");check(g.top>=g.head+4,"phone: …with a gap under the header");
  await pm.screenshot({path:`${SHOTS_DIR}/pin-phone-dark.png`});await cm.close()}
// Unpin from the viewer
await p.click('#board-tabs button[aria-controls="panel-docs"]');await p.click('[data-doc="STATUS.md"]');await p.waitForTimeout(500);await p.click("#doc-pin");await p.waitForTimeout(900);
await p.click('#board-tabs button[aria-controls="panel-conv"]');await p.waitForTimeout(300);
check(!(await vis(p,"#pin-bar"))&&!(await vis(p,"#pin-side")),"Unpin takes the bar and the section away");
await ctx.close();

// ---- Recap ----
// P has read up to here; then others post: a decision, a question to P, a task for V's agent.
const seenUpTo=(await api("GET",`/api/boards/${board}/updates?after=0`,null,{cookie:ckP})).last;
await api("POST",`/api/boards/${board}/seen`,{seq:seenUpTo},{cookie:ckP}).catch(()=>{});
const dec=seqOf(await mcp("post",{type:"decision",title:"Ship 1.4 Friday",text:"We ship 1.4 on Friday.",reply_to:0}));
const q=seqOf(await mcp("post",{type:"question",title:"Who signs off?",text:`@${P} who signs off on the release?`,reply_to:0}));
const t=seqOf(await mcp("task",{action:"create",title:"Write the release notes"}));
const recapCalls=[];
for(const [w,h,scheme,touch] of [[1280,860,"light",false],[1280,860,"dark",false],[320,700,"dark",true],[360,740,"dark",true],[390,780,"light",true]]){
  const firstVisit=w===1280&&scheme==="light";
  const fresh=firstVisit?dec:seqOf(await mcp("post",{type:"note",text:`New since your last visit (${w} ${scheme})`,reply_to:0}));
  const {p,ctx}=await open(ckP,{w,h,scheme,touch});const L=`${w}px ${scheme}`;
  p.on("request",r=>{if(/\/recap\?/.test(r.url()))recapCalls.push(new URL(r.url()).searchParams.get("since"))});
  const since=await p.evaluate(()=>RECAP_SINCE);
  check(since>=first&&since<fresh,`${L}: Recap starts from where you had read (${since}, before the new #${fresh})`);
  check(await vis(p,"#recap-btn")&&await vis(p,"#recap-dot"),`${L}: a Recap button in the header, dotted (something new)`);
  const hb=await p.locator("#recap-btn").boundingBox();check(hb&&hb.x>=0&&hb.x+hb.width<=w&&await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${L}: the button is on screen (${JSON.stringify(hb&&{x:Math.round(hb.x),w:Math.round(hb.width)})})`);
  const want=await api("GET",`/api/boards/${board}/recap?since=${since}`,null,{cookie:ckP});
  await p.click("#recap-btn");await p.waitForTimeout(700);
  const txt=await p.locator("#recap-dlg").innerText(),sub=await p.locator("#recap-sub").innerText();
  check(await vis(p,"#recap-dlg")&&sub===`${want.entries} new message${want.entries===1?"":"s"} since you last looked`,`${L}: the sheet opens: "${sub}" (server: ${want.entries} entries)`);
  if(firstVisit){
    check(/Decisions\s*1[\s\S]*Ship 1.4 Friday/.test(txt)&&/Open questions\s*1[\s\S]*Who signs off\?/.test(txt),`${L}: decisions and open questions`);
    check(/Who owes what[\s\S]*You[\s\S]*Who signs off\?/.test(txt),`${L}: who owes what (you owe the question)`);
    check(/New tasks[\s\S]*Write the release notes[\s\S]*unassigned/.test(txt),`${L}: a new task nobody owes yet still shows`);
  }else check(/No new decisions\./.test(txt)&&(want.questions.length?/Who signs off\?/.test(txt):true),`${L}: only what's new, open questions still listed (${want.decisions.length} decisions, ${want.questions.length} questions)`);
  const db=await p.locator("#recap-dlg").boundingBox();check(db.x>=0&&db.x+db.width<=w+1&&db.y+db.height<=h+1,`${L}: the sheet fits the screen (${JSON.stringify({x:Math.round(db.x),y:Math.round(db.y),w:Math.round(db.width),h:Math.round(db.height)})})`);
  await p.screenshot({path:`${SHOTS_DIR}/recap-${w}-${scheme}.png`});
  const go=firstVisit?dec:q;
  await p.locator(`#recap-dlg [data-recap-go="${go}"]`).first().click();await p.waitForTimeout(700);
  check(!(await vis(p,"#recap-dlg"))&&await p.locator(`#e${go}.hit`).count()===1,`${L}: tapping an item closes the sheet and shows that message`);
  await ctx.close();
}
check(recapCalls.length>=5&&recapCalls.every(s=>s&&+s>0),`Recap asks the server for since=<your last read> (${recapCalls.join(",")})`);
// Nothing new: says so, and offers the whole board
{const {p,ctx}=await open(ckP);await p.waitForTimeout(400);await p.click("#recap-btn");await p.waitForTimeout(600);
  check((await p.locator("#recap-sub").innerText())==="Nothing new since you last looked"&&/Still open[\s\S]*Who signs off\?/.test(await p.locator("#recap-body").innerText()),"nothing new: it says so, and still lists what is open");
  await p.screenshot({path:`${SHOTS_DIR}/recap-nothing.png`});
  await p.click("[data-recap-all]");await p.waitForTimeout(600);
  check(/^The whole board/.test(await p.locator("#recap-sub").innerText())&&/Ship 1.4 Friday/.test(await p.locator("#recap-body").innerText()),`…and Recap the whole board shows everything ("${await p.locator("#recap-sub").innerText()}")`);
  await p.keyboard.press("Escape");await p.waitForTimeout(200);check(!(await vis(p,"#recap-dlg")),"Esc closes it");await ctx.close()}
// A server without the API: no pin, and Recap says it isn't available
{const ctx2=await b.newContext({viewport:{width:1280,height:860}});const [k,...v]=ckP.split(";")[0].split("=");await ctx2.addCookies([{name:k,value:v.join("="),url:BASE}]);
  await ctx2.route(`**/api/boards/${board}/pin`,r=>r.fulfill({status:404,json:{error:"not found"}}));await ctx2.route(`**/api/boards/${board}/recap*`,r=>r.fulfill({status:404,json:{error:"not found"}}));
  const p=await ctx2.newPage();p.on("pageerror",e=>errors.push(e.message));await p.goto(`${BASE}/b/${board}`);await p.waitForTimeout(900);
  await p.click('#board-tabs button[aria-controls="panel-docs"]');await p.waitForTimeout(400);await p.click('[data-doc="STATUS.md"]');await p.waitForTimeout(500);
  check(!(await vis(p,"#doc-pin"))&&!(await vis(p,"#pin-bar")),"no pin API: no Pin button, no bar");
  await p.click('#board-tabs button[aria-controls="panel-conv"]');await p.waitForTimeout(300);
  check(!(await vis(p,"#recap-btn")),"no API yet: no Recap button either");
  await p.evaluate(()=>{document.getElementById('recap-btn').hidden=false});await p.click("#recap-btn");await p.waitForTimeout(400);
  check(/isn't available/.test(await p.locator("#recap-body").innerText()),"…and if it's opened anyway, it says it isn't available yet");await ctx2.close()}
check(errors.length===0,`no page errors ${errors.join(" | ")}`);
await b.close();console.log(fails?`${fails} FAILED`:"pinned doc + recap: all passed");process.exit(fails?1:0);
