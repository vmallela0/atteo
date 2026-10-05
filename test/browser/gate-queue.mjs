// Browser check for #3209: board info shows the gate's queue — open handoffs oldest first (branch, who, age, LGTM),
// each a jump to its message; hidden when the queue is empty; a queue idle 30 min is flagged. 1280 and 390.
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE=process.env.BASE||"http://localhost:8787";
const ops=async(p,b)=>(await fetch(`${BASE}/api/ops/${p}`,{method:"POST",headers:{"x-admin-key":"ci-admin-key","content-type":"application/json"},body:JSON.stringify(b)})).json();
const run=Date.now().toString(36).slice(-4),A=`gq${run}`,B=`gq${run}x`;
for(const u of [A,B])await ops("users",{name:u,email:`${u}@example.com`,verified:"true"});
const board=(await ops("boards",{user:A,title:`Gate ${run}`})).board.id;await ops("members",{board,user:B});
const tokA=(await ops("tokens",{user:A})).token;
const ckB=(await ops("sessions",{user:B})).cookie;
const mcp=async(name,args)=>(await (await fetch(`${BASE}/mcp?board=${board}`,{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream",authorization:`Bearer ${tokA}`},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})})).json()).result.content[0].text;
const apiB=(path,body)=>fetch(`${BASE}${path}`,{method:"POST",headers:{"content-type":"application/json",cookie:ckB},body:JSON.stringify(body)}).then(r=>r.json());
let fails=0;const check=(ok,m)=>{console.log(`${ok?"✓":"✗"} ${m}`);if(!ok)fails++};
await mcp("read",{});
// Two open handoffs. Only another session can land one (the author can only withdraw), so B closes them from its cookie.
const h1=Number((await mcp("post",{type:"handoff",title:"Ready to gate: fix-cart",text:"the cart fix",handoff:{branch:"fix-cart",sha:"a".repeat(40),base:"main",checks:"vitest 12/12"}})).match(/#(\d+)/)[1]);
const h2=Number((await mcp("post",{type:"handoff",title:"Ready to gate: docs-page",text:"the docs page",handoff:{branch:"docs-page",sha:"b".repeat(40),base:"main",checks:"tsc clean"}})).match(/#(\d+)/)[1]);
const b=await chromium.launch({executablePath: process.env.PW_CHROME || undefined});
const open=async(w,phone)=>{const ctx=await b.newContext({viewport:{width:w,height:820},...(phone?{hasTouch:true,isMobile:true}:{})});const [k,...v]=ckB.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);const p=await ctx.newPage();const errors=[];p.on("pageerror",e=>errors.push(e.message));return {ctx,p,errors}};
const seeQueue=async(p)=>{await p.locator('[data-open="invite"]').first().click();await p.locator("#acc-gate:not([hidden])").waitFor()};
for(const [label,w,phone,first,left] of [
  ["desktop",1280,false,h1,h2],
  // the phone pass runs after the desktop one landed h1: a third handoff keeps two in the queue for it
  ["phone",390,true,null,null],
]){
  if(!first)var h3=Number((await mcp("post",{type:"handoff",title:"Ready to gate: third",text:"one more",handoff:{branch:"third",sha:"d".repeat(40),base:"main",checks:"ok"}})).match(/#(\d+)/)[1]);
  const f=first??h2,l=left??h3,branch=label==="desktop"?"fix-cart":"docs-page";
  const {ctx,p,errors}=await open(w,phone);
  await p.goto(`${BASE}/b/${board}`);await p.locator("#composer-text").waitFor();
  await seeQueue(p); // board info opens: the queue loads with it
  check((await p.locator("#gate-h").innerText()).includes("2"),`${label}: the section says two are waiting`);
  const rows=p.locator("#acc-handoffs .acc-row");
  check(await rows.count()===2,`${label}: two rows`);
  check((await rows.nth(0).locator("a").getAttribute("href"))===`#e${f}`,`${label}: the oldest is first`);
  check((await rows.nth(0).innerText()).includes(branch),`${label}: …with its branch`);
  check((await rows.nth(0).locator("time[data-ts]").count())===1,`${label}: the age shows (a live time element)`);
  check(!(await p.locator("#gate-h").innerText()).toLowerCase().includes("30"),`${label}: not flagged stalled yet`);
  await p.screenshot({path:`${SHOTS_DIR}/gate-queue-${label}.png`});
  // The queue updates live: B (another session) lands the oldest; the closing reply is a handoff entry, so the open
  // dialog's refresh drops the queue to one without reopening anything.
  await apiB(`/api/boards/${board}/entries`,{type:"handoff",reply_to:f,text:"landed",handoff:{state:"landed",sha:"c".repeat(40)}});
  await p.locator("#gate-h").filter({hasText:"1"}).waitFor({timeout:15000});
  check(await rows.count()===1,`${label}: a landed handoff leaves the queue (2 → 1)`);
  check((await rows.nth(0).locator("a").getAttribute("href"))===`#e${l}`,`${label}: …and the one left is the right one`);
  // A row is a jump: clicking it closes board info and jumps to the handoff's message.
  await rows.nth(0).locator("a").click();
  await p.waitForFunction(()=>!document.getElementById("invite").open);
  await p.waitForFunction(()=>location.hash===`#e${l}`);
  check(true,`${label}: clicking a row closes the dialog and jumps to the message`);
  // The stalled flag: the queue hasn't moved in 30 min (the page's clock moves forward, board info reopens).
  await p.clock.setFixedTime(Date.now()+31*60000);
  await seeQueue(p);
  check((await p.locator("#gate-h").innerText()).toLowerCase().includes("30"),`${label}: a queue idle 30 min is flagged`);
  check(await p.locator("#gate-h .xs").isVisible(),`${label}: the stalled mark shows beside the count`);
  check(await p.locator("#acc-handoffs .acc-row").first().boundingBox().then(r=>r&&r.x>=0&&r.x+r.width<=w),`${label}: rows fit ${w}px`);
  check(errors.length===0,`${label}: no page errors ${errors.join(" | ")}`);
  await ctx.close();
}
await b.close();console.log(fails?`${fails} FAILED`:"all gate-queue checks passed");process.exit(fails?1:0);
