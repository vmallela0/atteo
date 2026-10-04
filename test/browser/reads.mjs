import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE=process.env.BASE||"http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run=Date.now().toString(36).slice(-4), A=`vedu${run}`, B=`jxn${run}`;
for (const u of [A,B]) await ops("users",{name:u,email:`${u}@example.com`,verified:"true"});
const tokA=(await ops("tokens",{user:A})).token, tokB=(await ops("tokens",{user:B})).token;
const board=(await ops("boards",{user:B,title:"Read receipts"})).board.id; await ops("members",{board,user:A});
const cookie=async u=>(await ops("sessions",{user:u})).cookie;
const mcp=async(tok,name,args)=>(await (await fetch(`${BASE}/mcp?board=${board}`,{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream",authorization:`Bearer ${tok}`},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})})).json());
// both agents have been on the board
await mcp(tokA,"read",{}); await mcp(tokB,"read",{});
let fails=0;const check=(ok,m)=>{console.log(`${ok?"✓":"✗"} ${m}`);if(!ok)fails++};
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const page=async(u)=>{const ctx=await b.newContext({viewport:{width:1280,height:800}});const c=await cookie(u);const [k,...v]=c.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);const p=await ctx.newPage();const errors=[];p.on("pageerror",e=>errors.push(e.message));await p.goto(`${BASE}/b/${board}`);await p.waitForTimeout(700);return {p,ctx,errors}};
const J=await page(B);
await J.p.click("#composer-text"); await J.p.keyboard.type(`@${A.slice(0,4)}`); await J.p.waitForSelector("#mention-menu:not([hidden])"); await J.p.keyboard.press("Enter");
await J.p.keyboard.type("and @"+A.slice(0,4)); await J.p.waitForSelector("#mention-menu:not([hidden])"); await J.p.keyboard.press("ArrowDown"); await J.p.keyboard.press("Enter");
await J.p.keyboard.type("can you check the trace?"); await J.p.keyboard.press("Enter");
await J.p.waitForSelector("#thread .rd"); await J.p.waitForTimeout(500);
const state=()=>J.p.evaluate(()=>{const r=document.querySelector("#thread .rd");return {label:r?.getAttribute("aria-label"),all:r?.classList.contains("all"),pop:r?.querySelector(".rd-pop")?.textContent,dots:[...document.querySelectorAll("#thread .entry:last-child .mention")].map(m=>(m.classList.contains("agent")?"agent":"person")+":"+m.classList.contains("seen"))}});
let s=await state(); console.log("  after posting:", JSON.stringify(s));
check(s.label==="Not seen yet" && !s.all, "ring on my latest message: nobody has seen it yet (vedu, vedu's agent, your agent)");
check(JSON.stringify(s.dots)==='["person:false","agent:false"]', "both mention dots empty");
await J.p.screenshot({ path: `${SHOTS_DIR}/reads-0.png`, clip: await J.p.locator("#thread .entry").last().boundingBox() });
// vedu's agent reads the board
await mcp(tokA,"read",{}); await J.p.waitForTimeout(800); s=await state(); console.log("  after vedu's agent reads:", JSON.stringify(s));
check(s.label==="Seen by 1", "vedu's agent read it → Seen by 1, live");
check(JSON.stringify(s.dots)==='["person:false","agent:true"]', "the agent mention's dot fills");
// vedu opens the board
const V=await page(A); await J.p.waitForTimeout(1500); s=await state(); console.log("  after vedu opens it:", JSON.stringify(s));
check(s.label==="Seen by 2" && !s.all && JSON.stringify(s.dots)==='["person:true","agent:true"]', "vedu saw it on the web → 2 of 3, both mention dots full");
// my own agent reads
await mcp(tokB,"read",{}); await J.p.waitForTimeout(800); s=await state();
check(s.all, "your agent read it too → seen by everyone");
await J.p.locator("#thread .rd").hover(); await J.p.waitForTimeout(200);
check(await J.p.locator("#thread .rd .rd-pop").isVisible(), "hover lists who has seen it");
const box=await J.p.locator("#thread .entry").last().boundingBox();
await J.p.screenshot({ path: `${SHOTS_DIR}/reads-all.png`, clip: { x: box.x, y: box.y-90, width: box.width, height: box.height+90 } });
check(J.errors.length===0 && V.errors.length===0, `no page errors ${[...J.errors,...V.errors].join(" | ")}`);
await b.close(); console.log(fails?`${fails} FAILED`:"all read-receipt checks passed");
