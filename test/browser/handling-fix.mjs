// "is on it" names the session the same way however it was taken (review #1335, task #1343): a reply over REST and a
// finished task show "<user>/<session> is on it" / "done by <user>/<session>" on the web, never "<user>/agent".
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE=process.env.BASE||"http://localhost:8787";
const KEY=process.env.ADMIN_KEY||"ci-admin-key";
const ops=async(p,b)=>(await fetch(`${BASE}/api/ops/${p}`,{method:"POST",headers:{"x-admin-key":KEY,"content-type":"application/json"},body:JSON.stringify(b)})).json();
const run=Date.now().toString(36).slice(-4),A=`fa${run}`,B=`fb${run}`;
for(const u of [A,B])await ops("users",{name:u,email:`${u}@example.com`,verified:"true",display:{mode:"developer"}});
const tokA=(await ops("tokens",{user:A})).token,tokB=(await ops("tokens",{user:B})).token;
const board=(await ops("boards",{user:A,title:`Handling fix ${run}`})).board.id;await ops("members",{board,user:B});
const api=(t,m,p,b,s)=>fetch(BASE+p,{method:m,headers:{authorization:`Bearer ${t}`,"content-type":"application/json",...(s?{"x-atteo-session":s.id}:{})},body:b?JSON.stringify(b):undefined}).then(r=>r.json());
const relay=(await api(tokB,"POST","/api/sessions",{suggest:"relay",client:"Claude Code"})).session;await api(tokB,"POST",`/api/sessions/${relay.id}/boards`,{board});
// A asks; B's relay answers over REST (an SDK or hosted agent), which takes it.
const q=(await api(tokA,"POST",`/api/boards/${board}/entries`,{type:"question",text:`@${B}'s agent which region? ${run}`})).entry.seq;
await api(tokB,"GET",`/api/sessions/${relay.id}/read?board=${board}`);
await api(tokB,"POST",`/api/boards/${board}/entries`,{type:"note",text:"eu-west",reply_to:q},relay);
// A task nobody took, finished by relay.
const t=(await api(tokA,"POST",`/api/boards/${board}/tasks`,{title:`rotate keys ${run}`})).task.seq;
await api(tokB,"POST",`/api/boards/${board}/tasks/${t}`,{action:"update",status:"done"},relay);
const ck=(await ops("sessions",{user:A})).cookie;
let fails=0;const check=(ok,m)=>{console.log(`${ok?"✓":"✗"} ${m}`);if(!ok)fails++};
const b=await chromium.launch({executablePath: process.env.PW_CHROME || undefined});
for(const [w,mobile] of [[1280,false],[390,true]]){const ctx=await b.newContext({viewport:{width:w,height:844},isMobile:mobile,hasTouch:mobile});const [k,...v]=ck.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
  const p=await ctx.newPage();const errors=[];p.on("pageerror",e=>errors.push(e.message));
  await p.goto(`${BASE}/b/${board}`);await p.waitForTimeout(900);
  const hq=(await p.locator(`#e${q} .hdl`).innerText().catch(()=>"")).trim();
  check(hq===`${B}/relay is on it`,`${w}px: a reply over REST shows the session on it ("${hq}")`);
  const ht=(await p.locator(`#e${t} .hdl`).innerText().catch(()=>"")).trim();
  check(ht.includes(`${B}/relay`)&&!ht.includes("/agent"),`${w}px: the finished task names the session that finished it ("${ht}")`);
  await p.screenshot({path:`${SHOTS_DIR}/handling-fix-${w}.png`});
  check(errors.length===0,`${w}px: no page errors ${errors.join(" | ")}`);await ctx.close();
}
await b.close();console.log(fails?`${fails} FAILED`:"all handling-fix checks passed");process.exit(fails?1:0);
