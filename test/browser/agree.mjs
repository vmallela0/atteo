// On a decision, 👍 reads as agree and is tallied ("👍 2 agree"); elsewhere it's a plain 👍 (vedu #1030).
import { chromium } from "playwright-core";
const BASE=process.env.BASE||"http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run=Date.now().toString(36).slice(-4), A=`ag${run}`, B=`ah${run}`;
for(const u of [A,B])await ops("users",{name:u,email:`${u}@example.com`,verified:"true"});
const tok={};for(const u of [A,B])tok[u]=(await ops("tokens",{user:u})).token;
const board=(await ops("boards",{user:A,title:`Agree ${run}`})).board.id;await ops("members",{board,user:B});
const call=async(u,name,args)=>(await (await fetch(`${BASE}/mcp?board=${board}`,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${tok[u]}`},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})})).json()).result.content[0].text;
await call(A,"read",{});const dec=+(await call(A,"post",{type:"decision",title:"Ship Friday",text:"We ship on Friday.",reply_to:0})).match(/#(\d+)/)[1];
await call(A,"read",{});const note=+(await call(A,"post",{type:"note",text:"a plain note",reply_to:0})).match(/#(\d+)/)[1];
for(const u of [A,B]){await call(u,"read",{});await call(u,"react",{seq:dec,emoji:"👍"});await call(u,"react",{seq:note,emoji:"👍"})}
const ck=(await ops("sessions",{user:A})).cookie;
let fails=0;const check=(ok,m)=>{console.log(`${ok?"✓":"✗"} ${m}`);if(!ok)fails++};
const b=await chromium.launch({executablePath: process.env.PW_CHROME || undefined});
const ctx=await b.newContext({viewport:{width:1280,height:800}});const [k,...v]=ck.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
const p=await ctx.newPage();const errors=[];p.on("pageerror",e=>errors.push(e.message));await p.goto(`${BASE}/b/${board}`);await p.waitForTimeout(1200);
const chip=s=>p.locator(`[data-rx="${s}"] .rx-chip[data-react="👍"]`).innerText().catch(()=>"");
check((await chip(dec)).replace(/\s+/g," ").trim()==="👍 2 agree",`a decision tallies 👍 as agree: "${await chip(dec)}"`);
check((await chip(note)).replace(/\s+/g," ").trim()==="👍 2",`a note keeps a plain 👍: "${await chip(note)}"`);
check(!errors.length,`no page errors ${errors.join(" | ")}`);
await b.close();console.log(fails?`${fails} FAILED`:"all agree checks passed");process.exit(fails?1:0);
