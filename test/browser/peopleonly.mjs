// People only (vedu #1264): the composer's lock sends a message only the @'d people see; agents never get it.
import { chromium } from "playwright-core";
const BASE=process.env.BASE||"http://localhost:8787";
const ops=async(p,b)=>(await fetch(`${BASE}/api/ops/${p}`,{method:"POST",headers:{"x-admin-key":"ci-admin-key","content-type":"application/json"},body:JSON.stringify(b)})).json();
const run=Date.now().toString(36).slice(-4),A=`pa${run}`,B=`pb${run}`;for(const u of [A,B])await ops("users",{name:u,email:`${u}@example.com`,verified:"true",display:{mode:"developer"}});
const board=(await ops("boards",{user:A,title:`PO ${run}`})).board.id;await ops("members",{board,user:B});
const ckA=(await ops("sessions",{user:A})).cookie,tokB=(await ops("tokens",{user:B})).token;
const mcp=async(name,args)=>(await (await fetch(`${BASE}/mcp?board=${board}`,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${tokB}`},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})})).json()).result.content[0].text;
let fails=0;const check=(ok,t)=>{console.log(`${ok?"✓":"✗"} ${t}`);if(!ok)fails++};
const b=await chromium.launch({executablePath: process.env.PW_CHROME || undefined});
for(const [w,mobile] of [[1200,false],[390,true]]){const ctx=await b.newContext({viewport:{width:w,height:800},isMobile:mobile,hasTouch:mobile});const [k,...v]=ckA.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
  const p=await ctx.newPage();const errors=[];p.on("pageerror",e=>errors.push(e.message));await p.goto(`${BASE}/b/${board}`);await p.waitForTimeout(900);
  await p.locator("#po-btn")[mobile?"tap":"click"]();check(await p.getAttribute("#po-btn","aria-pressed")==="true"&&await p.locator("#po-note").isVisible(),`${w}px: the lock turns People only on and says what it means`);
  await p.fill("#composer-text",`no recipient ${run}`);await p.locator("form.composer button.primary").click();await p.waitForTimeout(600);
  {const tt=await p.locator("#toast").innerText(),n=await p.locator(`#thread .body:has-text("no recipient ${run}")`).count();check(/@ the people/.test(tt)&&n===0,`${w}px: without an @person it doesn't send, and says why (toast "${tt}", posted ${n})`)}
  await p.fill("#composer-text",`@${B} just between us ${w} ${run}`);await p.locator("form.composer button.primary").click();await p.waitForTimeout(1500);
  const e=p.locator(`#thread>.entry:has-text("just between us ${w} ${run}")`);
  check(await e.count()===1&&await e.locator(".badge.po").count()===1,`${w}px: it posts with the 🔒 people only tag`);
  check(/Agents can't/.test(await p.locator("#toast").innerText()),`${w}px: the server's notice shows ("${await p.locator("#toast").innerText()}")`);
  check(await p.getAttribute("#po-btn","aria-pressed")==="false"&&await p.locator("#po-note").isHidden(),`${w}px: the lock turns off after sending`);
  check(!errors.length,`${w}px: no page errors ${errors.join(" | ")}`);await ctx.close()}
const r=await mcp("read",{});check(!r.includes("just between us"),"B's agent reading the board never sees them");
await b.close();console.log(fails?`${fails} FAILED`:"people only: all passed");process.exit(fails?1:0);
