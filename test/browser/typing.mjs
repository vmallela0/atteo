// "… is typing": a person typing shows for the others. Agents never show there (jxn #777): their 🤔 under the message says it.
// Steps wait for a positive signal (opus-a #2824) instead of sleeping: the typing row, a cleared row, the agent's 🤔
// receipt arriving (so "no typing row for the agent" is checked after the pickup has reached the page), its answer.
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
/** Polls get() until ok(value) (or ms pass) and returns the last value. */
const until=async(get,ok,ms=8000)=>{const t=Date.now();let v;for(;;){v=await get();if(ok(v)||Date.now()-t>ms)return v;await new Promise(r=>setTimeout(r,40))}};
const lastSeq=(P)=>P.p.evaluate(()=>+([...document.querySelectorAll('#thread>.entry')].pop()?.dataset.seq||0));
const thinking=(P,seq)=>P.p.evaluate(s=>(document.querySelector(`[data-rx="${s}"] .rx-rcpt`)?.innerText||"").includes("🤔"),seq);
const b=await chromium.launch({executablePath: process.env.PW_CHROME || undefined});
const page=async(u)=>{const ctx=await b.newContext({viewport:{width:1280,height:800}});const ck=(await ops("sessions",{user:u})).cookie;const [k,...v]=ck.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);const p=await ctx.newPage();const errors=[];p.on("pageerror",e=>errors.push(e.message));await p.goto(`${BASE}/b/${board}`);await p.waitForFunction(()=>!!window.BOARD_CTX);return {p,errors}};
const PA=await page(A), PB=await page(B);
const row=(P)=>P.p.evaluate(()=>{const el=document.getElementById("typing");return el&&!el.hidden?(el.querySelector(".ty-t")?.textContent||"").trim():""});
check((await row(PB))==="","nobody typing: no row");
await PA.p.click("#composer-text");await PA.p.keyboard.type("hello the");
{const v=await until(()=>row(PB),v=>v===`${A} is typing`);check(v===`${A} is typing`,`B sees "${A} is typing": "${v}"`);}
check((await row(PA))==="","you don't see yourself typing");
await PB.p.locator("#typing").screenshot({path:`${SHOTS_DIR}/typing-person.png`}).catch(()=>{});
await PA.p.keyboard.type("re");await PA.p.keyboard.press("Enter");
check(await until(()=>row(PB),v=>v==="",3000)==="","sending clears it at once");
// A asks B's agent; B's agent picks it up: no typing row for an agent
const n0=await lastSeq(PA);await PA.p.click("#composer-text");await PA.p.keyboard.type(`@${B}'s agent which region?`);await PA.p.keyboard.press("Enter");
const q=await until(()=>lastSeq(PA),v=>v>n0);
await mcp("read",{});await until(()=>thinking(PA,q),Boolean); // the agent's pickup has reached A's page
check((await row(PA))==="",`an agent working on it doesn't show as typing: "${await row(PA)}"`);
await mcp("post",{type:"note",text:"us-east",reply_to:q});await until(()=>lastSeq(PA),v=>v>q);
check(await until(()=>row(PA),v=>v==="",3000)==="","the agent answered: the row goes away");
// a fresh page load knows who's working (from the first update)
await mcp("read",{});const n1=await lastSeq(PA);await PA.p.click("#composer-text");await PA.p.keyboard.type(`@${B}'s agent and the port?`);await PA.p.keyboard.press("Enter");
const q2=await until(()=>lastSeq(PA),v=>v>n1);await mcp("read",{});await until(()=>thinking(PA,q2),Boolean);
const PC=await page(A);await until(()=>thinking(PC,q2),Boolean); // the new page has its first update
check((await row(PC))==="",`…nor on a page opened now: "${await row(PC)}"`);
// Threads (vedu #4746): typing in a thread's reply box shows only in that thread; typing in the chat only in the chat.
const thr=(P)=>P.p.evaluate(()=>{const el=document.getElementById("thr-typing");return el&&!el.hidden?(el.querySelector(".ty-t")?.textContent||"").trim():""});
for(const P of [PA,PB])await P.p.evaluate(()=>{document.documentElement.dataset.replies="thread"});
const openThr=async(P)=>{await P.p.evaluate(s=>document.querySelector(`#e${s} button[data-reply]`).click(),q);await P.p.locator("dialog.thr-dlg[open]").waitFor()};
await openThr(PA);await openThr(PB);
await PA.p.click(".thr-dlg #composer-text");await PA.p.keyboard.type("in the thread");
{const v=await until(()=>thr(PB),v=>v===`${A} is typing`);check(v===`${A} is typing`,`typing in a thread shows in that thread: "${v}"`);}
check((await row(PB))==="",`…and not in the chat: "${await row(PB)}"`);
await PA.p.keyboard.press("Escape");await PA.p.locator("dialog.thr-dlg[open]").waitFor({state:"detached"});
await PA.p.click("#composer-text"); // back in the chat: its first keystroke says so at once (a new place, not the 3 s pace)
await PA.p.keyboard.type(" and the chat");
{const v=await until(()=>row(PB),v=>v===`${A} is typing`);check(v===`${A} is typing`,`typing in the chat shows in the chat: "${v}"`);}
check((await thr(PB))==="",`…and not in the open thread: "${await thr(PB)}"`);
check([...PA.errors,...PB.errors,...PC.errors].length===0,`no page errors ${[...PA.errors,...PB.errors,...PC.errors].join(" | ")}`);
await b.close();console.log(fails?`${fails} FAILED`:"all typing checks passed");
