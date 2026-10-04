import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE=process.env.BASE||"http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run=Date.now().toString(36).slice(-4), A=`vedu${run}`, B=`jxn${run}`, C=`sam${run}`;
for (const u of [A,B,C]) await ops("users",{name:u,email:`${u}@example.com`,verified:"true"});
const tokA=(await ops("tokens",{user:A})).token;
const board=(await ops("boards",{user:B,title:`Social ${run}`})).board.id; await ops("members",{board,user:A});
const ck={};for(const u of [A,B,C])ck[u]=(await ops("sessions",{user:u})).cookie;
const api=(u,path,body)=>fetch(`${BASE}${path}`,{method:body?"POST":"GET",headers:{"content-type":"application/json",cookie:ck[u]},body:body?JSON.stringify(body):undefined}).then(r=>r.json());
await api(C,"/api/friends/request",{user:B,note:"from the payments thread"}); // incoming for B
const mcp=async(name,args)=>(await (await fetch(`${BASE}/mcp?board=${board}`,{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream",authorization:`Bearer ${tokA}`},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})})).json()).result.content[0].text;
await mcp("read",{});await mcp("post",{type:"note",text:`hi @${B}`});
let fails=0;const check=(ok,m)=>{console.log(`${ok?"✓":"✗"} ${m}`);if(!ok)fails++};
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const ctx=await b.newContext({viewport:{width:1280,height:820}});const [k,...v]=ck[B].split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
const p=await ctx.newPage();const errors=[];p.on("pageerror",e=>errors.push(e.message));
// hover card on the board: vedu's agent isn't a friend yet → Add friend
await p.goto(`${BASE}/b/${board}`);await p.waitForTimeout(700);
await p.locator(`#thread .entry`).last().locator(".who").hover();await p.waitForTimeout(800);
const hc=await p.locator(".hcard").innerText().catch(()=>"");
check(await p.locator(".hcard").isVisible()&&hc.includes(`${A}'s agent`)&&hc.includes("Add friend"),`hovering vedu's agent shows a card with Add friend (${hc.replace(/\n/g," · ")})`);
await p.screenshot({path:`${SHOTS_DIR}/hovercard.png`});
await p.locator(".hcard [data-add]").click();await p.waitForTimeout(500);
await api(A,`/api/friends/${B}/accept`,{});   // vedu accepts
// People page: request from sam, vedu as a friend
await p.goto(`${BASE}/people`);await p.waitForTimeout(500);
const pp=await p.locator(".content").innerText();
check(pp.includes("Requests")&&pp.includes(C)&&pp.includes("from the payments thread"),"People shows sam's request with its note");
check(pp.includes("Friends")&&pp.includes(A)&&pp.includes("Message agent"),"…and vedu as a friend with Message agent");
await p.screenshot({path:`${SHOTS_DIR}/people.png`,fullPage:true});
await p.locator(`[data-friend="accept"][data-name="${C}"]`).click();await p.waitForTimeout(800);
check((await p.locator(".content").innerText()).includes(C)&&!(await p.locator(".content").innerText()).includes("Requests"),"Accept moves sam into Friends");
await p.locator("#ppl-q").fill(A.slice(0,4));await p.waitForTimeout(600);
check(await p.locator("#ppl-res").isVisible(),"finding people shows results");
// Message agent → a direct board, which shows under Direct in the nav with the friend's name
await p.locator(`.list [data-direct="${A}"]`).first().click();await p.waitForURL(/\/b\//,{timeout:5000}).catch(()=>{});await p.waitForTimeout(600);
const nav=await p.locator(".sidebar").innerText();
check(nav.includes("DMs")&&nav.includes(A)&&!nav.includes("↔"),`Message agent opens a direct board, listed under DMs as "${A}"`);
check(!nav.includes("Account"),"the nav has no duplicate Account item (the avatar at the bottom is it)");
// profile page
await p.goto(`${BASE}/u/${A}`);await p.waitForTimeout(400);
const prof=await p.locator(".prof").innerText();
check(prof.includes(`@${A}`)&&prof.includes(`Message ${A}`),"profile shows the handle, presence and Message <name>");
await p.screenshot({path:`${SHOTS_DIR}/profile.png`});
check(errors.length===0,`no page errors ${errors.join(" | ")}`);
await b.close();console.log(fails?`${fails} FAILED`:"all social checks passed");
