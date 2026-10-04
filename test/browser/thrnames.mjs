// #658: agent names in the chat: message headers, folded thread lines, "Replying to", hover card name all say jxn/builder
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE=process.env.BASE||"http://localhost:8787";
const ops=async(p,b)=>(await fetch(`${BASE}/api/ops/${p}`,{method:"POST",headers:{"x-admin-key":"ci-admin-key","content-type":"application/json"},body:JSON.stringify(b)})).json();
const run=Date.now().toString(36).slice(-4),P=`jt${run}`,V=`vt${run}`;
for(const u of [P,V])await ops("users",{name:u,email:`${u}@example.com`,verified:"true"});
const tokV=(await ops("tokens",{user:V})).token;
const board=(await ops("boards",{user:P,title:`Names ${run}`})).board.id;await ops("members",{board,user:V});
const ckP=(await ops("sessions",{user:P})).cookie;
const api=(m,p,b,h={})=>fetch(BASE+p,{method:m,headers:{"content-type":"application/json",...h},body:b?JSON.stringify(b):undefined}).then(r=>r.json());
const s=(await api("POST","/api/sessions",{suggest:"builder",client:"Claude Code"},{authorization:`Bearer ${tokV}`})).session;await api("POST",`/api/sessions/${s.id}/boards`,{board},{authorization:`Bearer ${tokV}`});
const mcp=async(name,args)=>(await (await fetch(`${BASE}/mcp?board=${board}`,{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream",authorization:`Bearer ${tokV}`,"x-agent-soup-session":s.id},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})})).json()).result.content[0].text;
await mcp("read",{});
const r=await api("POST",`/api/boards/${board}/entries`,{text:"which port does staging use?"},{cookie:ckP});const root=r.entry?.seq??r.seq;
await mcp("read",{});await mcp("post",{type:"note",text:"8443, per the load balancer config.",reply_to:root});
let fails=0;const check=(ok,m)=>{console.log(`${ok?"✓":"✗"} ${m}`);if(!ok)fails++};
// a person's reply and an agent reply that also resolves: its refs line stays
const pr=await api("POST",`/api/boards/${board}/entries`,{text:"thanks, that matches",reply_to:root},{cookie:ckP});
const other=await api("POST",`/api/boards/${board}/entries`,{text:"Is staging on 8443 too?"},{cookie:ckP});const q2=other.entry?.seq??other.seq;
await mcp("read",{});const res=Number((await mcp("post",{type:"note",text:"Yes, both use 8443.",reply_to:root,resolves:[q2]})).match(/#(\d+)/)[1]);
const b=await chromium.launch({executablePath: process.env.PW_CHROME || undefined});
const errors=[];
for(const [w,h,scheme] of [[1280,800,"light"],[1280,800,"dark"],[390,780,"dark"]]){
const ctx=await b.newContext({viewport:{width:w,height:h},colorScheme:scheme,hasTouch:w<500,isMobile:w<500});const [k,...v]=ckP.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
const p=await ctx.newPage();p.on("pageerror",e=>errors.push(e.message));await p.goto(`${BASE}/b/${board}`);await p.waitForTimeout(1000);
const L=`${w}px ${scheme}`;
const q=await p.evaluate(r=>{const head=document.querySelector('#e'+r+'>.grow>.meta>.who')?.textContent;return {head,bars:[...document.querySelectorAll('#thread>.entry[data-reply="'+r+'"] .rq-who')].map(x=>x.textContent)}},root);
check(q.bars.length>=2&&q.bars.every(x=>x===q.head),`${L}: #658 replies' quote bars name the message's author like its header (${q.head}): ${JSON.stringify(q.bars)}`);
{const bx=await p.locator(`#e${root}`).boundingBox();await p.screenshot({path:`${SHOTS_DIR}/thrnames-folded-${w}-${scheme}.png`,clip:{x:Math.max(0,bx.x-8),y:bx.y-4,width:Math.min(w,bx.width+16),height:bx.height+8}})}
const rep=root+1;
const refsVis=async s=>p.evaluate(s=>{const r=document.querySelector(`#e${s}>.grow>.refs`);return !!r&&!r.hidden&&r.offsetParent!==null?r.innerText:""},s);
check(await refsVis(rep)==="",`${L}: no "reply to #N" line under a reply: its quote bar says it ("${await refsVis(rep)}")`);
check(await refsVis(pr.entry?.seq??pr.seq)==="",`${L}: …on a person's reply either`);
const rr=await refsVis(res);check(/resolves/.test(rr),`${L}: a reply that also resolves something keeps its line ("${rr.replace(/\s+/g," ")}")`);
if(w<500)await p.locator(`#e${rep} .body`).tap({position:{x:10,y:8}});else await p.hover(`#e${rep} .body`);
await p.locator(`#e${rep} [data-reply]`).first().click();await p.waitForTimeout(300);
const who=await p.locator("#replying-who").innerText(),val=await p.locator("#composer-text").inputValue();
check(who===`${V}/builder`&&val===`@${V}'s agent `,`${L}: Reply says "Replying to ${who}" and still mentions "${val.trim()}"`);
{const bx=await p.locator(`#e${root}`).boundingBox();await p.mouse.move(0,0);await p.screenshot({path:`${SHOTS_DIR}/thrnames-open-${w}-${scheme}.png`,clip:{x:Math.max(0,bx.x-8),y:Math.max(0,bx.y-4),width:Math.min(w,bx.width+16),height:Math.min(h-Math.max(0,bx.y-4),bx.height+8)}})}
await p.screenshot({path:`${SHOTS_DIR}/thrnames-page-${w}-${scheme}.png`});
await ctx.close()}
check(errors.length===0,`no page errors ${errors.join(" | ")}`);
await b.close();console.log(fails?`${fails} FAILED`:"thread names: all passed");process.exit(fails?1:0);
