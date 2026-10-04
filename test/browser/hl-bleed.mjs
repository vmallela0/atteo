// Highlights have room on the left (jxn #1311): the mention tint and the new-message flash reach 12px past the avatar, also in compact; the New divider is one line.
import { chromium } from "playwright-core";
const BASE=process.env.BASE||"http://localhost:8787";
const ops=async(p,b)=>(await fetch(`${BASE}/api/ops/${p}`,{method:"POST",headers:{"x-admin-key":"ci-admin-key","content-type":"application/json"},body:JSON.stringify(b)})).json();
const run=Date.now().toString(36).slice(-4),P=`hl${run}`,V=`hm${run}`;for(const u of [P,V])await ops("users",{name:u,email:`${u}@example.com`,verified:"true",display:{mode:"developer",density:"compact"}});
const board=(await ops("boards",{user:P,title:`HL ${run}`})).board.id;await ops("members",{board,user:V});
const ckP=(await ops("sessions",{user:P})).cookie,ckV=(await ops("sessions",{user:V})).cookie;
const post=(ck,text)=>fetch(`${BASE}/api/boards/${board}/entries`,{method:"POST",headers:{"content-type":"application/json",cookie:ck},body:JSON.stringify({text})}).then(r=>r.json()).then(j=>j.entry?.seq??j.seq);
for(let i=0;i<3;i++)await post(ckV,`older ${i}`);const m=await post(ckV,`@${P} look at this ${run}`);
let fails=0;const check=(ok,t)=>{console.log(`${ok?"✓":"✗"} ${t}`);if(!ok)fails++};
const b=await chromium.launch({executablePath: process.env.PW_CHROME || undefined});
for(const dens of ["compact","comfortable"]){const ctx=await b.newContext({viewport:{width:1100,height:800}});const [k,...v]=ckP.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
  await ctx.addInitScript(d=>{try{localStorage.setItem('atteo-display',JSON.stringify({density:d,ev:false}));sessionStorage.setItem('atteo-display-sync','1')}catch{}},dens);
  const p=await ctx.newPage();await p.goto(`${BASE}/b/${board}`);await p.waitForTimeout(1200);
  const g=await p.evaluate(s=>{const e=document.getElementById('e'+s),r=e.getBoundingClientRect(),a=e.querySelector('.av').getBoundingClientRect();return {gap:Math.round(a.left-r.left)}},m);
  check(g.gap>=11,`${dens}: the mention tint starts ${g.gap}px left of the avatar`);
  const n=await post(ckV,`fresh ${dens} ${run}`);await p.locator(`#e${n}`).waitFor({timeout:8000});
  const f=await p.evaluate(s=>{const e=document.getElementById('e'+s),r=e.getBoundingClientRect(),a=e.querySelector('.av').getBoundingClientRect();return {flash:e.classList.contains('flash-in'),gap:Math.round(a.left-r.left)}},n);
  check(f.flash&&f.gap>=11,`${dens}: a new message's flash starts ${f.gap}px left of the avatar`);await ctx.close()}
await b.close();console.log(fails?`${fails} FAILED`:"highlight room: all passed");process.exit(fails?1:0);
