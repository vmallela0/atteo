// In a thread, @ opens the mention menu on phones and desktop, fully on screen (vedu #1268).
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE=process.env.BASE||"http://localhost:8787";
const ops=async(p,b)=>(await fetch(`${BASE}/api/ops/${p}`,{method:"POST",headers:{"x-admin-key":"ci-admin-key","content-type":"application/json"},body:JSON.stringify(b)})).json();
const run=Date.now().toString(36).slice(-4),A=`ta${run}`,B=`tb${run}`;for(const u of [A,B])await ops("users",{name:u,email:`${u}@example.com`,verified:"true"});
const board=(await ops("boards",{user:A,title:`ThrAt ${run}`})).board.id;await ops("members",{board,user:B});const ck={};for(const u of [A,B])ck[u]=(await ops("sessions",{user:u})).cookie;
const post=(u,b)=>fetch(`${BASE}/api/boards/${board}/entries`,{method:"POST",headers:{"content-type":"application/json",cookie:ck[u]},body:JSON.stringify(b)}).then(r=>r.json()).then(j=>j.entry?.seq??j.seq);
const root=await post(B,{text:`question ${run}`});await post(A,{text:`answer ${run}`,reply_to:root});
let fails=0;const check=(ok,t)=>{console.log(`${ok?"✓":"✗"} ${t}`);if(!ok)fails++};
const b=await chromium.launch({executablePath: process.env.PW_CHROME || undefined});
for(const [w,h,mobile] of [[390,700,true],[1200,800,false]]){const ctx=await b.newContext({viewport:{width:w,height:h},isMobile:mobile,hasTouch:mobile});const [k,...v]=ck[A].split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
  const p=await ctx.newPage();await p.goto(`${BASE}/b/${board}`);await p.waitForTimeout(900);
  await p.locator(`#e${root} .thr-sum`)[mobile?"tap":"click"]();await p.waitForTimeout(400);
  await p.locator(".thr-dlg #composer-text")[mobile?"tap":"click"]();await p.locator(".thr-dlg #composer-text").fill("");await p.keyboard.type("@");await p.waitForTimeout(400);
  const g=await p.evaluate(()=>{const m=document.getElementById('mention-menu'),r=m.getBoundingClientRect(),d=document.querySelector('.thr-dlg').getBoundingClientRect();
    const at=document.elementFromPoint(r.left+r.width/2,r.top+Math.min(20,r.height/2));return {hidden:m.hidden,top:Math.round(r.top),bottom:Math.round(r.bottom),h:Math.round(r.height),dTop:Math.round(d.top),onTop:!!(at&&m.contains(at)),items:m.querySelectorAll('li[data-u],li[role=option]').length}});
  check(!g.hidden&&g.h>20&&g.top>=g.dTop-1&&g.onTop&&g.items>0,`${w}px: @ in a thread shows the mention menu, on screen and on top (${JSON.stringify(g)})`);
  await p.screenshot({path:`${SHOTS_DIR}/thr-at-${w}.png`});await ctx.close()}
await b.close();console.log(fails?`${fails} FAILED`:"thread @: all passed");process.exit(fails?1:0);
