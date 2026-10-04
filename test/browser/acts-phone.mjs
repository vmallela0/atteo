// Phones: a tapped message's actions (reactions, Reply, Unsend) fit on screen, top level and replies (which sit in the conversation since #1040), 320-430px.
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE=process.env.BASE||"http://localhost:8787";
const ops=async(p,b)=>(await fetch(`${BASE}/api/ops/${p}`,{method:"POST",headers:{"x-admin-key":"ci-admin-key","content-type":"application/json"},body:JSON.stringify(b)})).json();
const run=Date.now().toString(36).slice(-4),P=`ja${run}`,V=`va${run}`;
for(const u of [P,V])await ops("users",{name:u,email:`${u}@example.com`,verified:"true"});
const tokV=(await ops("tokens",{user:V})).token;
const board=(await ops("boards",{user:P,title:`Acts ${run}`})).board.id;await ops("members",{board,user:V});
const ckP=(await ops("sessions",{user:P})).cookie;
const api=(m,p,b,h={})=>fetch(BASE+p,{method:m,headers:{"content-type":"application/json",...h},body:b?JSON.stringify(b):undefined}).then(r=>r.json());
const s=(await api("POST","/api/sessions",{suggest:"builder",client:"Claude Code"},{authorization:`Bearer ${tokV}`})).session;await api("POST",`/api/sessions/${s.id}/boards`,{board},{authorization:`Bearer ${tokV}`});
const mcp=async(name,args)=>(await (await fetch(`${BASE}/mcp?board=${board}`,{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream",authorization:`Bearer ${tokV}`,"x-agent-soup-session":s.id},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})})).json()).result.content[0].text;
await mcp("read",{});
const r=await api("POST",`/api/boards/${board}/entries`,{text:"which port does staging use?"},{cookie:ckP});const root=r.entry?.seq??r.seq;
await mcp("read",{});const rep=Number((await mcp("post",{type:"note",text:"8443, per the load balancer config.",reply_to:root})).match(/#(\d+)/)[1]);
const mine=(await api("POST",`/api/boards/${board}/entries`,{text:"thanks, that matches",reply_to:root},{cookie:ckP}));const myRep=mine.entry?.seq??mine.seq;
const top=Number((await mcp("post",{type:"note",text:"Top-level note from the agent.",reply_to:0})).match(/#(\d+)/)[1]);
let fails=0;const check=(ok,m)=>{console.log(`${ok?"✓":"✗"} ${m}`);if(!ok)fails++};
const b=await chromium.launch({executablePath: process.env.PW_CHROME || undefined});
const errors=[];
for(const [w,scheme] of [[320,"dark"],[360,"light"],[390,"dark"],[430,"light"]]){
  const ctx=await b.newContext({viewport:{width:w,height:780},colorScheme:scheme,hasTouch:true,isMobile:true});const [k,...v]=ckP.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
  const p=await ctx.newPage();p.on("pageerror",e=>errors.push(e.message));await p.goto(`${BASE}/b/${board}`);await p.waitForTimeout(900);
  for(const [seq,label] of [[top,"top-level"],[rep,"agent's reply in the conversation"],[myRep,"your reply in the conversation"]]){
    await p.locator(`#e${seq} .body`).tap({position:{x:10,y:8}});await p.waitForTimeout(250);
    const g=await p.evaluate(s=>{const a=document.querySelector(`#e${s}>.grow>.meta>.acts`),c=document.getElementById('thread').getBoundingClientRect(),r=a.getBoundingClientRect();
      const btns=[...a.querySelectorAll('button')].filter(x=>x.offsetParent).map(x=>x.getBoundingClientRect());
      return {right:Math.round(r.right),left:Math.round(r.left),clip:Math.round(c.right),lastRight:Math.round(Math.max(...btns.map(x=>x.right))),sw:document.documentElement.scrollWidth}},seq);
    check(g.lastRight<=g.clip&&g.left>=0&&g.sw<=w,`${w}px ${scheme}, ${label}: every action is on screen (${JSON.stringify(g)})`);
    await p.screenshot({path:`${SHOTS_DIR}/acts-${w}-${seq===top?'top':seq===rep?'rep':'mine'}.png`});
  }
  await ctx.close();
}
check(errors.length===0,`no page errors ${errors.join(" | ")}`);
await b.close();console.log(fails?`${fails} FAILED`:"phone actions: all passed");process.exit(fails?1:0);
