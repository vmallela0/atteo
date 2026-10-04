// The scroll rail on a long board (jxn #1359): at most ~60 ticks, grouped; a message for you keeps its own tick.
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE=process.env.BASE||"http://localhost:8787";
const ops=async(p,b)=>(await fetch(`${BASE}/api/ops/${p}`,{method:"POST",headers:{"x-admin-key":"ci-admin-key","content-type":"application/json"},body:JSON.stringify(b)})).json();
const run=Date.now().toString(36).slice(-4),P=`rc${run}`,V=`rv${run}`;for(const u of [P,V])await ops("users",{name:u,email:`${u}@example.com`,verified:"true",display:{mode:"developer"}});
const board=(await ops("boards",{user:P,title:`Rail ${run}`})).board.id;await ops("members",{board,user:V});
const ckP=(await ops("sessions",{user:P})).cookie,ckV=(await ops("sessions",{user:V})).cookie;
const post=(ck,t)=>fetch(`${BASE}/api/boards/${board}/entries`,{method:"POST",headers:{"content-type":"application/json",cookie:ck},body:JSON.stringify({text:t})}).then(r=>r.json());
for(let i=0;i<90;i++)await post(ckV,`message ${i}`);await post(ckV,`@${P} this one is for you ${run}`);for(let i=0;i<20;i++)await post(ckV,`later ${i}`);
let fails=0;const check=(ok,t)=>{console.log(`${ok?"✓":"✗"} ${t}`);if(!ok)fails++};
const b=await chromium.launch({executablePath: process.env.PW_CHROME || undefined,ignoreDefaultArgs:["--hide-scrollbars"]});
for(const scheme of ["light","dark"]){const ctx=await b.newContext({viewport:{width:1280,height:800},colorScheme:scheme});const [k,...v]=ckP.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
  const p=await ctx.newPage();const errors=[];p.on("pageerror",e=>errors.push(e.message));await p.goto(`${BASE}/b/${board}`);await p.waitForTimeout(1300);
  const g=await p.evaluate(()=>({n:document.querySelectorAll('#thread>.entry,#thread>.ghost').length,t:document.querySelectorAll('#rail i').length,me:document.querySelectorAll('#rail i.me').length,on:document.querySelectorAll('#rail i.on').length}));
  check(g.n>60&&g.t<=61&&g.t>=20,`${scheme}: ${g.n} messages draw ${g.t} ticks`);check(g.me===1,`${scheme}: the message for you keeps its own tick (${g.me})`);check(g.on>0,`${scheme}: ticks in view are marked (${g.on})`);
  await p.locator("#rail").hover({position:{x:6,y:20}});await p.waitForTimeout(300);check(await p.locator("#rail-tip").isVisible(),`${scheme}: hovering still names the message`);
  await p.locator("#rail").screenshot({path:`${SHOTS_DIR}/railcap-${scheme}.png`});check(!errors.length,`${scheme}: no page errors ${errors.join(" | ")}`);await ctx.close()}
await b.close();console.log(fails?`${fails} FAILED`:"rail cap: all passed");process.exit(fails?1:0);
