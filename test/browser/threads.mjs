import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE=process.env.BASE||"http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run=Date.now().toString(36).slice(-4), A=`vedu${run}`, B=`jxn${run}`;
for (const u of [A,B]) await ops("users",{name:u,email:`${u}@example.com`,verified:"true"});
const tokA=(await ops("tokens",{user:A})).token;
const board=(await ops("boards",{user:B,title:"Threads"})).board.id; await ops("members",{board,user:A});
const cookie=(await ops("sessions",{user:B})).cookie;
const mcp=async(name,args)=>(await (await fetch(`${BASE}/mcp?board=${board}`,{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream",authorization:`Bearer ${tokA}`},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})})).json()).result.content[0].text;
await mcp("read",{}); const root=Number((await mcp("post",{type:"question",title:"Retry limit?",text:"What retry limit should checkout use?"})).match(/#(\d+)/)[1]);
await mcp("read",{}); await mcp("post",{type:"note",text:"I think 3, with backoff",reply_to:root});
await mcp("read",{}); await mcp("post",{type:"note",text:"Unrelated top-level note"});
let fails=0;const check=(ok,m)=>{console.log(`${ok?"✓":"✗"} ${m}`);if(!ok)fails++};
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
for (const [label,w,h] of [["desktop",1280,800],["mobile",390,844]]) {
const ctx=await b.newContext({viewport:{width:w,height:h}});const [k,...v]=cookie.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
const p=await ctx.newPage();const errors=[];p.on("pageerror",e=>errors.push(e.message));
await p.goto(`${BASE}/b/${board}`);await p.waitForTimeout(700);
if(label==="desktop"){await p.locator('[data-mention-for="composer-text"]').click();await p.waitForTimeout(250);
  check(await p.locator("#mention-menu").isVisible()&&(await p.inputValue("#composer-text")).endsWith("@"),"the @ button starts a mention and opens the menu of people and agents");
  await p.keyboard.press("Escape");await p.locator("#composer-text").fill("");}
const sum=p.locator(`#e${root} .thr-sum`);
check(await sum.isVisible()&&/[0-9]+ repl/.test(await sum.innerText()),`${label}: the message shows "N replies"`);
const inl=p.locator("#thread>.entry",{hasText:"I think 3"}).first();
check(await inl.isVisible()&&(await inl.locator(":scope>.grow>.rq").innerText()).includes("What retry limit"),`${label}: the reply is in the conversation, with a bar quoting the question (jxn #1040)`);
await sum.click();await p.waitForTimeout(350);
const dl=p.locator("dialog.thr-dlg");
check(await dl.isVisible()&&(await dl.innerText()).includes("What retry limit")&&(await dl.innerText()).includes("I think 3"),`${label}: "N replies" opens the thread as an overlay: the question and its replies`);
await p.locator("[data-thr-close]").click();await p.waitForTimeout(200);
check(!(await dl.isVisible()),`${label}: ✕ closes the overlay`);
await inl.locator(":scope>.grow>.rq").click();await p.waitForTimeout(350);
check(await dl.isVisible(),`${label}: the quote bar opens the same thread`);
await p.keyboard.press("Escape");await p.waitForTimeout(200);
// Reply writes in the main composer, under a slim "Replying to …" line (no box inside the thread).
await p.locator(`#e${root}`).hover();await p.locator(`#e${root} [data-reply]`).first().click({force:true});await p.waitForTimeout(300);
const rp=await p.locator("#replying").innerText().catch(()=>"");
check(await p.locator("#replying").isVisible()&&rp.includes(`Replying to ${A}'s agent`)&&rp.includes("What retry limit")&&await p.evaluate(()=>document.activeElement.id)==="composer-text",`${label}: Reply focuses the main composer with "Replying to …" above it ("${rp}")`);
if(label==="desktop"){await p.locator("#composer-text").press("End");await p.keyboard.type(" @"+B.slice(0,4));await p.waitForTimeout(250);
  check(await p.locator("#mention-menu").isVisible()&&(await p.locator("#mention-menu").innerText()).includes(B),"the @-mention menu works while replying");
  await p.keyboard.press("Escape");
  check(await p.locator("#replying").isVisible(),"Esc with the mention menu open closes only the menu");
  for(let i=0;i<6;i++)await p.keyboard.press("Backspace");}
if(label==="desktop"){const v=await p.inputValue("#composer-text");check(v.startsWith(`@${A}'s agent `),`Reply prefills an @mention of who you're replying to ("${v}")`);}
await p.locator("#replying-go").click();await p.waitForTimeout(400);
check(await p.locator(`#e${root}.hit`).count()===1,`${label}: clicking the indicator shows the message`);
await p.locator("#composer-text").fill(`going with 3 (${label})`);await p.locator("#composer-text").press("Enter");await p.waitForTimeout(1500);
const lastTop=async()=>p.evaluate(()=>{const e=[...document.querySelectorAll("#thread>.entry")].pop();return {body:e?.querySelector(":scope>.grow>.body")?.textContent||"",q:e?.querySelector(":scope>.grow>.rq")?.textContent||""}});
let lt=await lastTop();
check(lt.body.includes(`going with 3 (${label})`)&&lt.q.includes("What retry limit"),`${label}: the reply lands at the bottom as the newest message, quoting the question`);
check(!(await p.locator("#replying").isVisible())&&(await p.inputValue("#composer-text"))==="",`${label}: after sending, the composer is back to a new message`);
await mcp("read",{});await mcp("post",{type:"note",text:`agent follow-up ${label}`,reply_to:root});await p.waitForTimeout(2500);
lt=await lastTop();
check(lt.body.includes(`agent follow-up ${label}`)&&/[0-9]+ repl/.test(await sum.innerText()),`${label}: new replies arrive live at the bottom and the count follows`);
check(errors.length===0,`${label}: no page errors ${errors.join(" | ")}`);
await p.screenshot({path:`${SHOTS_DIR}/thread-inline-${label}.png`});
await ctx.close();
}
const ctx=await b.newContext({viewport:{width:1280,height:800}});const [k,...v]=cookie.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
const p=await ctx.newPage();const derr=[];p.on("pageerror",e=>derr.push(e.message));
await p.goto(`${BASE}/b/${board}#e${root+1}`);await p.waitForTimeout(900);
check(await p.evaluate(s=>{const e=document.getElementById("e"+s),r=e?.getBoundingClientRect();return !!r&&r.top>=0&&r.bottom<=innerHeight},root+1),"a link to a reply shows it in the conversation");
check(derr.length===0,`deep link: no page errors ${derr.join(" | ")}`);
await b.close();console.log(fails?`${fails} FAILED`:"all thread checks passed");
