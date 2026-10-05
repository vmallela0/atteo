// Drafts survive leaving and coming back; replies in threads count as read; viewing the inbox clears the badge.
import { chromium } from "playwright-core";
import { until } from "./lib/wait.mjs";
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
// What the page has saved as this board's draft (k: "" for the main box, "r<seq>" for a reply); drafts save 250ms after typing.
const saved=(k="")=>p.evaluate(([b,k])=>localStorage.getItem("soup.draft."+b+(k?"."+k:""))||"",[board,k]);
const box=p.locator("#composer-text");
await p.goto(`${BASE}/b/${board}`);await box.waitFor();
await box.click();await p.keyboard.type(`half-written thought ${run}`);await until(async()=>(await saved())===`half-written thought ${run}`);
await p.goto(`${BASE}/b/${other}`);await box.waitFor();
check((await p.inputValue("#composer-text"))==="","another board has its own (empty) box");
await p.goto(`${BASE}/b/${board}`);await box.waitFor();
check((await p.inputValue("#composer-text"))===`half-written thought ${run}`,"coming back restores what you were typing");
await p.locator("#composer-text").click();await p.keyboard.press("End");await p.keyboard.press("Enter");
await until(async()=>(await saved())===""&&await p.locator("#thread .entry",{hasText:`half-written thought ${run}`}).count()>0,10000);await p.reload();await box.waitFor();
check((await p.inputValue("#composer-text"))==="","posting clears the draft");
// starting a reply keeps what's typed (#1469); the reply and its text survive a reload; cancelling leaves the text
await p.locator("#composer-text").fill(`main draft ${run}`);await until(async()=>(await saved())===`main draft ${run}`);
await p.locator(`#e${root}`).hover();await p.locator(`#e${root} [data-reply]`).first().click({force:true});await until(()=>p.locator("#replying").isVisible());
check((await p.inputValue("#composer-text")).includes(`main draft ${run}`),`starting a reply keeps what you'd typed (vedu #1469: "${await p.inputValue("#composer-text")}")`);
await p.keyboard.type(`reply draft ${run}`);await until(async()=>(await saved(`r${root}`)).includes(`reply draft ${run}`));await p.reload();
await until(async()=>await p.locator("#replying").isVisible()&&(await p.inputValue("#composer-text")).includes(`reply draft ${run}`));
check(await p.locator("#replying").isVisible()&&(await p.inputValue("#composer-text")).includes(`reply draft ${run}`),"after a reload it's still a reply, with its draft");
await p.locator("#composer-text").press("Escape");await until(async()=>!(await p.locator("#replying").isVisible()));
check(!(await p.locator("#replying").isVisible())&&(await p.inputValue("#composer-text")).includes(`reply draft ${run}`),"Esc cancels the reply and leaves the text in the box (#1469)");
await p.locator(`#e${root}`).hover();await p.locator(`#e${root} [data-reply]`).first().click({force:true});await until(async()=>await p.locator("#replying").isVisible()&&(await p.inputValue("#composer-text")).includes(`reply draft ${run}`));
check((await p.inputValue("#composer-text")).includes(`reply draft ${run}`),"replying again brings back that reply's draft");
await p.locator("#composer-text").fill("");await p.locator("#reply-cancel").click();await p.locator("#composer-text").fill("");
await until(()=>p.evaluate(b=>!Object.keys(localStorage).some(k=>k.startsWith("soup.draft."+b)),board)); // both drafts gone
// read receipt for a reply in a folded thread
const rep=+(await mcp("post",{type:"note",text:`us-east ${run}`,reply_to:root})).match(/#(\d+)/)[1];
await p.goto(`${BASE}/b/${board}`);
const readsNow=async()=>(await (await p.request.get(`${BASE}/api/boards/${board}/updates?after=${rep}`)).json()).reads;
await until(async()=>((await readsNow())?.[A]?.person_seen??0)>=rep,10000); // the page reports what's in view
const reads=await readsNow();
check((reads?.[A]?.person_seen??0)>=rep,`a reply in a thread in view counts as read (person_seen ${reads?.[A]?.person_seen}, reply #${rep})`);
// inbox: viewing it clears the badge, off-board items included
const before=(await (await p.request.get(`${BASE}/api/inbox/count`)).json()).unread;
await p.goto(`${BASE}/inbox`);
const unreadNow=async()=>(await (await p.request.get(`${BASE}/api/inbox/count`)).json()).unread;
await until(async()=>(await unreadNow())===0,10000);
const after=(await (await p.request.get(`${BASE}/api/inbox/count`)).json()).unread;
check(before>0&&after===0,`viewing the inbox clears the badge (${before} → ${after})`);
check(errors.length===0,`no page errors ${errors.join(" | ")}`);
await b.close();console.log(fails?`${fails} FAILED`:"all drafts/receipt/inbox checks passed");
