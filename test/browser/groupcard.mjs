// Tapping @agents shows the board's agents (working first, then idle); @humans shows the people and their presence.
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE=process.env.BASE||"http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run=Date.now().toString(36).slice(-4), A=`ga${run}`, B=`gb${run}`;
for (const u of [A,B]) await ops("users",{name:u,email:`${u}@example.com`,verified:"true"});
const tokB=(await ops("tokens",{user:B})).token;const board=(await ops("boards",{user:A,title:`Group ${run}`})).board.id;await ops("members",{board,user:B});
const api=(m,p,b,h={})=>fetch(BASE+p,{method:m,headers:{"content-type":"application/json",...h},body:b?JSON.stringify(b):undefined}).then(r=>r.json());
const sess=(await api("POST","/api/sessions",{suggest:"scout",client:"Claude Code"},{authorization:`Bearer ${tokB}`})).session;
await api("POST",`/api/sessions/${sess.id}/boards`,{board},{authorization:`Bearer ${tokB}`});
await fetch(`${BASE}/mcp?board=${board}`,{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream",authorization:`Bearer ${tokB}`,"x-agent-soup-session":sess.id},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"read",arguments:{}}})});
const cookie=(await ops("sessions",{user:A})).cookie;
await fetch(`${BASE}/api/boards/${board}/entries`,{method:"POST",headers:{"content-type":"application/json",cookie},body:JSON.stringify({text:"@agents and @humans: standup in 5"})});
let fails=0;const check=(ok,m)=>{console.log(`${ok?"✓":"✗"} ${m}`);if(!ok)fails++};
const b=await chromium.launch({executablePath: process.env.PW_CHROME || undefined});
const errors=[];
for(const [w,h,label] of [[1280,800,"desktop"],[390,800,"phone"]]){
  const ctx=await b.newContext({viewport:{width:w,height:h},hasTouch:w<500});const [k,...v]=cookie.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
  const p=await ctx.newPage();p.on("pageerror",e=>errors.push(e.message));await p.goto(`${BASE}/b/${board}`);await p.waitForSelector('.mention[data-user="agents"]');
  await p.locator('.mention[data-user="agents"]').first().click();await p.waitForTimeout(700);
  const card=await p.locator('.hcard').innerText().catch(()=>"");
  if(label==="phone")check(!(await p.locator('.entry.tap').count()),"phone: tapping a mention doesn't also open the message's actions");
  check(/Agents on this board/.test(card)&&/1 working now/.test(card)&&card.includes(`${B}/scout`),`${label}: @agents lists the board's agents, working first: ${JSON.stringify(card.slice(0,120))}`);
  if(label==="phone")check(await p.locator('.hcard.sheet').count()===1,"phone: it opens as a bottom sheet");
  await p.screenshot({path:`${SHOTS_DIR}/groupcard-${label}.png`});
  await p.keyboard.press("Escape");await p.waitForTimeout(200);
  await p.locator('.mention[data-user="humans"]').first().click();await p.waitForTimeout(900);
  const card2=await p.locator('.hcard').innerText().catch(()=>"");
  check(/People on this board/.test(card2)&&card2.includes(A)&&card2.includes(B),`${label}: @humans lists the people: ${JSON.stringify(card2.slice(0,120))}`);
  await ctx.close();
}
check(!errors.length,`no page errors ${errors.join(" | ")}`);
await b.close();console.log(fails?`${fails} FAILED`:"all group-card checks passed");process.exit(fails?1:0);
