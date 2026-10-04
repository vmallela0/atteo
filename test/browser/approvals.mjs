import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE=process.env.BASE||"http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run=Date.now().toString(36).slice(-4), A=`apr${run}`;
await ops("users",{name:A,email:`${A}@example.com`,verified:"true"});
const tok=(await ops("tokens",{user:A})).token;
const board=(await ops("boards",{user:A,title:`Approvals ${run}`})).board.id;
const mcp=async(name,args)=>(await (await fetch(`${BASE}/mcp?board=${board}`,{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream",authorization:`Bearer ${tok}`},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})})).json()).result.content[0].text;
await mcp("read",{});
await mcp("request_approval",{title:"Deploy staging",details:"npm run deploy -- --env staging\n".repeat(3),risk:"high",wait_seconds:0});
await mcp("request_approval",{title:"Rename the payments module",details:"git mv src/pay src/payments",risk:"low",wait_seconds:0});
const ck=(await ops("sessions",{user:A})).cookie;
let fails=0;const check=(ok,m)=>{console.log(`${ok?"✓":"✗"} ${m}`);if(!ok)fails++};
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
for (const [w,h,name] of [[1280,820,"approvals"],[390,800,"approvals-m"]]) {
  const ctx=await b.newContext({viewport:{width:w,height:h},colorScheme:name==="approvals"?"light":"dark"});const [k,...v]=ck.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
  const p=await ctx.newPage();const errors=[];p.on("pageerror",e=>errors.push(e.message));
  await p.goto(`${BASE}/b/${board}`);await p.waitForTimeout(700);
  if(w>800){check((await p.locator("#approvals-count").innerText())==="2","the nav shows 2 approvals waiting");
    check(await p.locator('.side-link[href="/approvals"] svg path').count()===2,"Approvals has its own icon");}
  await p.goto(`${BASE}/approvals`);await p.waitForTimeout(500);
  check(await p.locator(".approval.risk-high").count()===1,"the high-risk request is marked high");
  const ov=await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth);check(!ov,`no sideways scroll at ${w}px`);
  if(w>800){await p.locator(".approval.risk-low [name=note]").fill("fine");await p.locator(".approval.risk-low [data-decision=approve]").click();await p.waitForTimeout(900);
    check(await p.locator(".ap-done li").count()===1&&(await p.locator(".ap-done").innerText()).includes("Approved"),"approving moves it to Decided as one line");
    check((await p.locator("#approvals-count").innerText())==="1","…and the nav count drops to 1");}
  await p.screenshot({path:`${SHOTS_DIR}/${name}.png`,fullPage:true});
  check(errors.length===0,`no page errors ${errors.join(" | ")}`);
}
await b.close();console.log(fails?`${fails} FAILED`:"all approvals checks passed");
