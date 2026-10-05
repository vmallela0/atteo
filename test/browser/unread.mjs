// Opening a board starts at your first unread message, with a "New" line (jxn #1011); all read → the newest.
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
import { until, stable } from "./lib/wait.mjs";
const BASE=process.env.BASE||"http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run=Date.now().toString(36).slice(-4), A=`un${run}`, B=`uo${run}`;
for(const u of [A,B])await ops("users",{name:u,email:`${u}@example.com`,verified:"true"});
const tokB=(await ops("tokens",{user:B})).token;const board=(await ops("boards",{user:A,title:`Unread ${run}`})).board.id;await ops("members",{board,user:B});
const call=async(name,args)=>(await (await fetch(`${BASE}/mcp?board=${board}`,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${tokB}`},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})})).json()).result.content[0].text;
const post=async t=>{await call("read",{});return +(await call("post",{type:"note",text:t,reply_to:0})).match(/#(\d+)/)[1]};
let last=0;for(let i=1;i<=12;i++)last=await post(`older message ${i}\n\nwith a second paragraph so the page scrolls`);
const ck=(await ops("sessions",{user:A})).cookie;
await fetch(`${BASE}/api/boards/${board}/seen`,{method:"POST",headers:{"content-type":"application/json",cookie:ck},body:JSON.stringify({seq:last})});
let first=0;
let fails=0;const check=(ok,m)=>{console.log(`${ok?"✓":"✗"} ${m}`);if(!ok)fails++};
const b=await chromium.launch({executablePath: process.env.PW_CHROME || undefined});
for(const [w,h] of [[1280,800],[390,780]]){
  first=0;let newest=0;for(let i=1;i<=12;i++){const s=await post(`new message ${i} at ${w}px\n\nalso long enough to scroll`);if(!first)first=s;newest=s}
  const ctx=await b.newContext({viewport:{width:w,height:h}});const [k,...v]=ck.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
  const p=await ctx.newPage();const errors=[];p.on("pageerror",e=>errors.push(e.message));// Where the thread sits once it has opened and stopped scrolling.
  const settled=()=>stable(()=>p.evaluate(()=>{const sc=document.getElementById("thread-scroll");return sc&&[sc.scrollTop,sc.scrollHeight]}));
  await p.goto(`${BASE}/b/${board}`);await until(()=>p.evaluate(()=>!!document.getElementById("new-line")));await settled();
  const g=await p.evaluate(f=>{const l=document.getElementById('new-line'),sc=document.getElementById('thread-scroll'),e=document.getElementById('e'+f);if(!l)return null;const r=l.getBoundingClientRect(),s=sc.getBoundingClientRect();
    return {next:l.nextElementSibling?.id,top:Math.round(r.top-s.top),bottom:sc.scrollHeight-sc.scrollTop-sc.clientHeight,pill:!document.getElementById('new-pill').hidden}},first);
  check(g&&g.next===`e${first}`,`${w}px: a "New" line sits above the first unread (#${first}): ${JSON.stringify(g)}`);
  check(g&&g.top>=0&&g.top<120&&g.bottom>100&&g.pill,`${w}px: it opens there, near the top, with Jump to latest`);
  await p.screenshot({path:`${SHOTS_DIR}/unread-${w}.png`});
  // read to the end, then a fresh visit opens at the newest
  await p.evaluate(()=>{const sc=document.getElementById('thread-scroll');sc.scrollTop=sc.scrollHeight});
  // the page tells the server what you've read; then a fresh visit
  await until(async()=>((await (await p.request.get(`${BASE}/api/boards/${board}/updates?after=${newest}`)).json()).reads?.[A]?.person_seen??0)>=newest,10000);
  await p.reload();await until(()=>p.evaluate(()=>{const sc=document.getElementById("thread-scroll");return sc&&sc.scrollHeight-sc.scrollTop-sc.clientHeight<30}));await settled();
  const g2=await p.evaluate(()=>{const sc=document.getElementById('thread-scroll');return {line:!!document.getElementById('new-line'),bottom:sc.scrollHeight-sc.scrollTop-sc.clientHeight}});
  check(!g2.line&&g2.bottom<30,`${w}px: once all is read, it opens at the newest: ${JSON.stringify(g2)}`);
  check(!errors.length,`${w}px: no page errors ${errors.join(" | ")}`);await ctx.close();
}
await b.close();console.log(fails?`${fails} FAILED`:"all unread checks passed");process.exit(fails?1:0);
