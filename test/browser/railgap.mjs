// Rail overlap (jxn #1751): a seen-by ring stays clear of the rail's ticks even on a highlighted message (the 12px
// highlight bleed used to push it under them), and ticks never run into each other (closer than ~5px they fold together).
import { chromium } from "playwright-core";
const BASE=process.env.BASE||"http://localhost:8787";
const ops=async(p,b)=>(await fetch(`${BASE}/api/ops/${p}`,{method:"POST",headers:{"x-admin-key":process.env.ADMIN_KEY||"ci-admin-key","content-type":"application/json"},body:JSON.stringify(b)})).json();
const run=Date.now().toString(36).slice(-4),P=`rg${run}`,V=`rh${run}`;
for(const u of [P,V])await ops("users",{name:u,email:`${u}@example.com`,verified:"true"});
const board=(await ops("boards",{user:P,title:`Rail gap ${run}`})).board.id;await ops("members",{board,user:V});
const ck=(await ops("sessions",{user:P})).cookie.split(";")[0];
const post=(text)=>fetch(`${BASE}/api/boards/${board}/entries`,{method:"POST",headers:{cookie:ck,"content-type":"application/json"},body:JSON.stringify({text})});
// Clusters of short messages between very long ones crowd the rail: that is where ticks used to touch (and they're all mine, so each has a ring).
for(let i=0;i<58;i++)await post(i%12?`m${i}`:`long ${i} ${"word ".repeat(600)}`);
let fails=0;const check=(ok,m)=>{console.log(`${ok?"✓":"✗"} ${m}`);if(!ok)fails++};
const b=await chromium.launch({executablePath: process.env.PW_CHROME || undefined});
const errors=[];
for(const [w,mob] of [[1280,false],[390,true]]){
  const ctx=await b.newContext({viewport:{width:w,height:800},hasTouch:mob,isMobile:mob});const [k,...v]=ck.split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
  const p=await ctx.newPage();p.on("pageerror",e=>errors.push(e.message));await p.goto(`${BASE}/b/${board}`);await p.waitForTimeout(1200);
  const tag=`${w}px${mob?" touch":""}`;
  const m=await p.evaluate(()=>{const rail=document.getElementById('rail');if(!rail||!rail.offsetParent)return null;const rr=rail.getBoundingClientRect();
    const ticks=[...rail.querySelectorAll('i')].map(t=>t.getBoundingClientRect());const tickLeft=Math.min(...ticks.map(t=>t.left));
    const tops=ticks.map(t=>t.top).sort((a,b)=>a-b);let minGap=1e9;for(let i=1;i<tops.length;i++)minGap=Math.min(minGap,tops[i]-tops[i-1]);
    const rings=()=>[...document.querySelectorAll('#thread>.entry>.rd')].filter(r=>r.offsetParent).map(r=>r.getBoundingClientRect().right);
    const plain=Math.max(...rings());document.querySelectorAll('#thread>.entry').forEach(e=>e.classList.add('hit'));const lit=Math.max(...rings());
    document.querySelectorAll('#thread>.entry').forEach(e=>{e.classList.remove('hit');e.classList.add('for-you')});const fy=Math.max(...rings());
    document.querySelectorAll('#thread>.entry').forEach(e=>e.classList.remove('for-you'));
    return {tickLeft,plain,lit,fy,minGap,n:ticks.length}});
  if(!m){check(true,`${tag}: no rail at this width`);await ctx.close();continue}
  check(m.plain<=m.tickLeft-2,`${tag}: a ring sits clear of the ticks (ring right ${Math.round(m.plain)}, ticks from ${Math.round(m.tickLeft)})`);
  check(m.lit<=m.tickLeft-2,`${tag}: …also on a jumped-to (tinted) message (${Math.round(m.lit)})`);
  check(m.fy<=m.tickLeft-2,`${tag}: …and on a message for you (${Math.round(m.fy)})`);
  check(m.minGap>=4,`${tag}: ticks never run into each other (closest ${m.minGap.toFixed(1)}px apart, ${m.n} ticks)`);
  await ctx.close()}
check(errors.length===0,`no page errors ${errors.join(" | ")}`);
await b.close();console.log(fails?`${fails} FAILED`:"rail gap: all passed");process.exit(fails?1:0);
