// "… is typing": a person typing shows for the others. Agents never show there (jxn #777): their 🤔 under the message says it.
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE=process.env.BASE||"http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run=Date.now().toString(36).slice(-4), A=`ty${run}`, B=`tz${run}`;
for (const u of [A,B]) await ops("users",{name:u,email:`${u}@example.com`,verified:"true"});
const tokB=(await ops("tokens",{user:B})).token;
const board=(await ops("boards",{user:A,title:`Typing ${run}`})).board.id; await ops("members",{board,user:B});
const mcp=async(name,args)=>(await (await fetch(`${BASE}/mcp?board=${board}`,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${tokB}`},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})})).json()).result.content[0].text;
await mcp("read",{});
let fails=0;const check=(ok,m)=>{console.log(`${ok?"✓":"✗"} ${m}`);if(!ok)fails++};
const b=await chromium.launch({executablePath: process.env.PW_CHROME || undefined});
const page=async(u)=>{const ctx=await b.newContext({viewport:{width:1280,height:800}});const ck=(await ops("sessions",{user:u})).cookie;const [k,...v]=ck.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);const p=await ctx.newPage();const errors=[];p.on("pageerror",e=>errors.push(e.message));await p.goto(`${BASE}/b/${board}`);await p.waitForTimeout(900);return {p,errors}};
const PA=await page(A), PB=await page(B);
const row=(P)=>P.p.evaluate(()=>{const el=document.getElementById("typing");return el&&!el.hidden?(el.querySelector(".ty-t")?.textContent||"").trim():""});
check((await row(PB))==="","nobody typing: no row");
await PA.p.click("#composer-text");await PA.p.keyboard.type("hello the");await PB.p.waitForTimeout(900);
check((await row(PB))===`${A} is typing`,`B sees "${A} is typing": "${await row(PB)}"`);
check((await row(PA))==="","you don't see yourself typing");
await PB.p.locator("#typing").screenshot({path:`${SHOTS_DIR}/typing-person.png`}).catch(()=>{});
await PA.p.keyboard.type("re");await PA.p.keyboard.press("Enter");await PB.p.waitForTimeout(3000);console.log("  B after send:",JSON.stringify(await row(PB)),await PB.p.evaluate(()=>document.querySelectorAll("#thread>.entry").length));
check((await row(PB))==="","sending clears it at once");
// A asks B's agent; B's agent picks it up: no typing row for an agent
await PA.p.click("#composer-text");await PA.p.keyboard.type(`@${B}'s agent which region?`);await PA.p.keyboard.press("Enter");await PA.p.waitForTimeout(1200);
await new Promise(r=>setTimeout(r,6500)); // A's own typing ping expires
await mcp("read",{});await PA.p.waitForTimeout(1200);
check((await row(PA))==="",`an agent working on it doesn't show as typing: "${await row(PA)}"`);
const q=+(await PA.p.evaluate(()=>[...document.querySelectorAll('#thread>.entry')].pop().dataset.seq));
await mcp("post",{type:"note",text:"us-east",reply_to:q});await PA.p.waitForTimeout(1500);
check((await row(PA))==="","the agent answered: the row goes away");
// a fresh page load knows who's working (from the first update)
await mcp("read",{});await PA.p.click("#composer-text");await PA.p.keyboard.type(`@${B}'s agent and the port?`);await PA.p.keyboard.press("Enter");await PA.p.waitForTimeout(2000);await mcp("read",{});await new Promise(r=>setTimeout(r,500));
const PC=await page(A);check((await row(PC))==="",`…nor on a page opened now: "${await row(PC)}"`);
check([...PA.errors,...PB.errors,...PC.errors].length===0,`no page errors ${[...PA.errors,...PB.errors,...PC.errors].join(" | ")}`);
await b.close();console.log(fails?`${fails} FAILED`:"all typing checks passed");
