// Phones (no hover): tapping a message shows its actions, so you can reply to any message, change cards included.
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium, devices } from "playwright-core";
const BASE=process.env.BASE||"http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run=Date.now().toString(36).slice(-4), A=`tr${run}`;
await ops("users",{name:A,email:`${A}@example.com`,verified:"true"});
const tok=(await ops("tokens",{user:A})).token;const board=(await ops("boards",{user:A,title:`Tap ${run}`})).board.id;
const call=async(name,args)=>(await (await fetch(`${BASE}/mcp?board=${board}`,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${tok}`},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})})).json()).result.content[0].text;
await call("read",{});const n1=+(await call("post",{type:"note",text:"First note.",reply_to:0})).match(/#(\d+)/)[1];
await call("read",{});const n2=+(await call("post",{type:"change",title:"Batch on main",text:"On main, needs a ship.",reply_to:0,card:{branch:"main",base:"abc1234",commits:[{sha:"abc1234",title:"Fix"}],files:[{path:"src/a.ts",added:1,removed:1}]}})).match(/#(\d+)/)[1];
const ck=(await ops("sessions",{user:A})).cookie;
let fails=0;const check=(ok,m)=>{console.log(`${ok?"✓":"✗"} ${m}`);if(!ok)fails++};
const b=await chromium.launch({executablePath: process.env.PW_CHROME || undefined});
const ctx=await b.newContext({...devices["iPhone 13"],defaultBrowserType:undefined});const [k,...v]=ck.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
const p=await ctx.newPage();const errors=[];p.on("pageerror",e=>errors.push(e.message));
await p.goto(`${BASE}/b/${board}`);await p.waitForSelector(`#e${n2} .body`);await p.waitForTimeout(500);
const replyBtn=s=>p.locator(`#e${s}>.grow>.meta .acts [data-reply], #e${s}>.grow>.meta .acts button[title*="Reply" i]`).first();
check(!(await replyBtn(n2).isVisible().catch(()=>false)),"actions start hidden on a phone");
await p.locator(`#e${n2} .body`).tap();await p.waitForTimeout(200);
await p.screenshot({path:`${SHOTS_DIR}/tapreply-phone.png`});check(await replyBtn(n2).isVisible(),"tapping the change card's message shows Reply");
await replyBtn(n2).tap();await p.waitForTimeout(300);
check(await p.locator('#replying').isVisible()&&(await p.locator('#reply-to').inputValue())===String(n2),`…and Reply sets the composer to answer #${n2}`);
await p.locator(`#e${n1} .body`).tap();await p.waitForTimeout(200);
check(await replyBtn(n1).isVisible()&&!(await replyBtn(n2).isVisible()),"tapping another message moves the actions to it");
await p.locator(`#e${n1} .body`).tap();await p.waitForTimeout(200);
check(!(await replyBtn(n1).isVisible()),"tapping it again hides them");
// The ⋯ at the end of the info line opens the same actions (jxn #891), and shows only on touch screens.
await p.locator(`#e${n1} .body`).tap();await p.waitForTimeout(150);if(await replyBtn(n1).isVisible()){await p.locator(`#e${n1} .body`).tap();await p.waitForTimeout(150)}
const more=p.locator(`#e${n2}>.grow>.meta>.more-acts`);
check(await more.isVisible(),"phone: each message has a ⋯ at the end of its info line");
const mb=await more.boundingBox(),meta=await p.locator(`#e${n2}>.grow>.meta`).boundingBox();
check(mb&&meta&&Math.abs((mb.x+mb.width)-(meta.x+meta.width))<4,`…at the right end (${mb&&Math.round(mb.x+mb.width)} vs ${meta&&Math.round(meta.x+meta.width)})`);
await more.tap();await p.waitForTimeout(200);
check(await replyBtn(n2).isVisible()&&(await more.getAttribute("aria-expanded"))==="true","…tapping it shows Reply and says it's open");
await p.screenshot({path:`${SHOTS_DIR}/tapreply-more.png`});
await more.tap();await p.waitForTimeout(200);
check(!(await replyBtn(n2).isVisible())&&(await more.getAttribute("aria-expanded"))==="false","…tapping it again hides them");
{const dctx=await b.newContext({viewport:{width:1280,height:800}});const [k2,...v2]=ck.split(";")[0].split("=");await dctx.addCookies([{name:k2,value:v2.join("="),url:BASE}]);const d=await dctx.newPage();await d.goto(`${BASE}/b/${board}`);await d.waitForSelector(`#e${n2} .body`);
  check(!(await d.locator(`#e${n2} .more-acts`).isVisible()),"desktop: no ⋯ (actions show on hover)");await dctx.close()}
check(!errors.length,`no page errors ${errors.join(" | ")}`);
await b.close();console.log(fails?`${fails} FAILED`:"all tap-reply checks passed");process.exit(fails?1:0);
