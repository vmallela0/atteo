// A message that mentions you, or one you jump to, is highlighted with a tint and no colored bar down its side (jxn #1082, #1086).
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE=process.env.BASE||"http://localhost:8787";
const ops=async(p,b)=>(await fetch(`${BASE}/api/ops/${p}`,{method:"POST",headers:{"x-admin-key":"ci-admin-key","content-type":"application/json"},body:JSON.stringify(b)})).json();
const run=Date.now().toString(36).slice(-4),P=`jf${run}`,V=`vf${run}`;
for(const u of [P,V])await ops("users",{name:u,email:`${u}@example.com`,verified:"true"});
const board=(await ops("boards",{user:P,title:`ForYou ${run}`})).board.id;await ops("members",{board,user:V});
const ckP=(await ops("sessions",{user:P})).cookie,ckV=(await ops("sessions",{user:V})).cookie;
const post=(ck,text)=>fetch(`${BASE}/api/boards/${board}/entries`,{method:"POST",headers:{"content-type":"application/json",cookie:ck},body:JSON.stringify({text})}).then(r=>r.json());
await post(ckV,`a note for everyone ${run}`);const m=await post(ckV,`@${P} can you look at this ${run}`);const ms=m.entry?.seq??m.seq;
let fails=0;const clear=c=>/^rgba\(0, 0, 0, 0\)$|\/ 0\)$/.test(c);const check=(ok,t)=>{console.log(`${ok?"✓":"✗"} ${t}`);if(!ok)fails++};
const b=await chromium.launch({executablePath: process.env.PW_CHROME || undefined});
for(const [w,scheme] of [[1100,"light"],[390,"dark"]]){const ctx=await b.newContext({viewport:{width:w,height:700},colorScheme:scheme,isMobile:w<500,hasTouch:w<500});const [k,...v]=ckP.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
  const p=await ctx.newPage();await p.goto(`${BASE}/b/${board}`);await p.waitForTimeout(2200);
  const g=await p.evaluate(s=>{const e=document.getElementById('e'+s),cs=getComputedStyle(e),o=[...document.querySelectorAll('#thread>.entry')].find(x=>x.id!=='e'+s);
    return {cls:e.classList.contains('for-you'),shadow:cs.boxShadow,border:cs.borderLeftWidth+' '+cs.borderLeftStyle,bg:cs.backgroundColor,otherBg:getComputedStyle(o).backgroundColor}},ms);
  check(g.cls&&g.bg!==g.otherBg&&!clear(g.bg),`${w}px ${scheme}: the message that mentions you is highlighted (${g.bg})`);
  check(g.shadow==="none"&&!/solid/.test(g.border),`${w}px ${scheme}: …with no bar down its side (${g.shadow}; ${g.border})`);
  const hid=await p.evaluate(s=>{const o=[...document.querySelectorAll('#thread>.entry')].find(x=>x.id!=='e'+s);o.classList.add('hit');return o.id},ms);await p.waitForTimeout(900);
  const h=await p.evaluate(id=>{const cs=getComputedStyle(document.getElementById(id));return {shadow:cs.boxShadow,bg:cs.backgroundColor}},hid);
  check(h.shadow==="none"&&!clear(h.bg),`${w}px ${scheme}: a message you jump to is tinted, with no bar either (${h.shadow}; ${h.bg})`);
  await p.locator(`#e${ms}`).screenshot({path:`${SHOTS_DIR}/foryou-${w}.png`});await ctx.close()}
await b.close();console.log(fails?`${fails} FAILED`:"for-you: all passed");process.exit(fails?1:0);
