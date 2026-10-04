// Drafts survive leaving and coming back; replies in threads count as read; viewing the inbox clears the badge.
import { chromium } from "playwright-core";
const BASE=process.env.BASE||"http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run=Date.now().toString(36).slice(-4), A=`da${run}`, B=`db${run}`, C=`dc${run}`;
for (const u of [A,B,C]) await ops("users",{name:u,email:`${u}@example.com`,verified:"true"});
const tokB=(await ops("tokens",{user:B})).token;
const board=(await ops("boards",{user:A,title:`Drafts ${run}`})).board.id; await ops("members",{board,user:B});
const other=(await ops("boards",{user:A,title:`Other ${run}`})).board.id;
const mcp=async(name,args)=>{await fetch(`${BASE}/mcp?board=${board}`,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${tokB}`},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"read",arguments:{}}})});return (await (await fetch(`${BASE}/mcp?board=${board}`,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${tokB}`},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})})).json()).result.content[0].text};
const root=+(await mcp("post",{type:"question",text:"which region?"})).match(/#(\d+)/)[1];
const ck={};for(const u of [A,C])ck[u]=(await ops("sessions",{user:u})).cookie;
await fetch(`${BASE}/api/friends/request`,{method:"POST",headers:{cookie:ck[C],"content-type":"application/json"},body:JSON.stringify({user:A})}); // an off-board inbox item for A
let fails=0;const check=(ok,m)=>{console.log(`${ok?"✓":"✗"} ${m}`);if(!ok)fails++};
const b=await chromium.launch({executablePath: process.env.PW_CHROME || undefined});
const ctx=await b.newContext({viewport:{width:1280,height:800}});const [k,...v]=ck[A].split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
const p=await ctx.newPage();const errors=[];p.on("pageerror",e=>errors.push(e.message));
await p.goto(`${BASE}/b/${board}`);await p.waitForTimeout(600);
await p.locator("#composer-text").click();await p.keyboard.type(`half-written thought ${run}`);await p.waitForTimeout(400);
await p.goto(`${BASE}/b/${other}`);await p.waitForTimeout(400);
check((await p.inputValue("#composer-text"))==="","another board has its own (empty) box");
await p.goto(`${BASE}/b/${board}`);await p.waitForTimeout(500);
check((await p.inputValue("#composer-text"))===`half-written thought ${run}`,"coming back restores what you were typing");
await p.locator("#composer-text").click();await p.keyboard.press("End");await p.keyboard.press("Enter");await p.waitForTimeout(900);await p.reload();await p.waitForTimeout(500);
check((await p.inputValue("#composer-text"))==="","posting clears the draft");
// a reply's draft (in the main composer) is its own, and survives a reload still pointed at that message
await p.locator("#composer-text").fill(`main draft ${run}`);await p.waitForTimeout(400);
await p.locator(`#e${root}`).hover();await p.locator(`#e${root} [data-reply]`).first().click({force:true});await p.waitForTimeout(200);
check((await p.inputValue("#composer-text")).trim()===`@${B}'s agent`,`replying starts its own draft ("${await p.inputValue("#composer-text")}")`);
await p.keyboard.type(`reply draft ${run}`);await p.waitForTimeout(400);await p.reload();await p.waitForTimeout(600);
check(await p.locator("#replying").isVisible()&&(await p.inputValue("#composer-text")).includes(`reply draft ${run}`),"after a reload it's still a reply, with its draft");
await p.locator("#composer-text").press("Escape");await p.waitForTimeout(150);
check(!(await p.locator("#replying").isVisible())&&(await p.inputValue("#composer-text"))===`main draft ${run}`,"Esc cancels the reply and your other draft comes back");
await p.locator(`#e${root}`).hover();await p.locator(`#e${root} [data-reply]`).first().click({force:true});await p.waitForTimeout(200);
check((await p.inputValue("#composer-text")).includes(`reply draft ${run}`),"replying again brings back that reply's draft");
await p.locator("#composer-text").fill("");await p.locator("#reply-cancel").click();await p.locator("#composer-text").fill("");await p.waitForTimeout(400);
// read receipt for a reply in a folded thread
const rep=+(await mcp("post",{type:"note",text:`us-east ${run}`,reply_to:root})).match(/#(\d+)/)[1];
await p.goto(`${BASE}/b/${board}`);await p.waitForTimeout(2200);
const reads=(await (await p.request.get(`${BASE}/api/boards/${board}/updates?after=${rep}`)).json()).reads;
check((reads?.[A]?.person_seen??0)>=rep,`a reply in a thread in view counts as read (person_seen ${reads?.[A]?.person_seen}, reply #${rep})`);
// inbox: viewing it clears the badge, off-board items included
const before=(await (await p.request.get(`${BASE}/api/inbox/count`)).json()).unread;
await p.goto(`${BASE}/inbox`);await p.waitForTimeout(800);
const after=(await (await p.request.get(`${BASE}/api/inbox/count`)).json()).unread;
check(before>0&&after===0,`viewing the inbox clears the badge (${before} → ${after})`);
check(errors.length===0,`no page errors ${errors.join(" | ")}`);
await b.close();console.log(fails?`${fails} FAILED`:"all drafts/receipt/inbox checks passed");
