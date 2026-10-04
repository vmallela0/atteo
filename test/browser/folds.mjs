import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE=process.env.BASE||"http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run=Date.now().toString(36).slice(-4), A=`fo${run}`, B=`fb${run}`;
for (const u of [A,B]) await ops("users",{name:u,email:`${u}@example.com`,verified:"true"});
const tok=(await ops("tokens",{user:A})).token;
const board=(await ops("boards",{user:A,title:`Folds ${run}`})).board.id;await ops("members",{board,user:B});
const call=async(name,args)=>(await (await fetch(`${BASE}/mcp?board=${board}`,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${tok}`},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})})).json()).result.content[0].text;
await call("read",{});
for(let i=0;i<4;i++){await call("post",{type:"decision",title:`Decision ${i}`,text:`decided ${i}`});await call("task",{action:"create",title:`Task ${i}`})}
const ck=(await ops("sessions",{user:A})).cookie;
let fails=0;const check=(ok,m)=>{console.log(`${ok?"✓":"✗"} ${m}`);if(!ok)fails++};
const b=await chromium.launch({executablePath: process.env.PW_CHROME || undefined});
const ctx=await b.newContext({viewport:{width:1280,height:900},deviceScaleFactor:2});const [k,...v]=ck.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
const p=await ctx.newPage();const errors=[];p.on("pageerror",e=>errors.push(e.message));
await p.goto(`${BASE}/b/${board}`);await p.waitForTimeout(900);
await p.locator("#board-info").screenshot({path:`${SHOTS_DIR}/folds-open.png`});
const dec=p.locator('#board-info .fold[data-fold="decisions"]');
check(await dec.locator(".fold-h").getAttribute("aria-expanded")==="true"&&await dec.locator(".fold-b").isVisible(),"sections start open");
await dec.locator(".fold-h").click();await p.waitForTimeout(200);
check(await dec.locator(".fold-h").getAttribute("aria-expanded")==="false"&&!(await dec.locator(".fold-b").isVisible()),"clicking the heading folds it");
check((await dec.locator(".fold-peek").innerText())==="Decision 3","folded, it peeks at the newest item");
await p.locator('#board-info .fold[data-fold="members"] .fold-h').click();
await p.locator('#board-info .fold[data-fold="agents"] .fold-h').click();await p.waitForTimeout(200);
await p.locator("#board-info").screenshot({path:`${SHOTS_DIR}/folds-folded.png`});
await p.reload();await p.waitForTimeout(900);
check(await dec.evaluate(e=>e.classList.contains("folded"))&&await p.locator('#board-info .fold[data-fold="members"]').evaluate(e=>e.classList.contains("folded")),"remembered after a reload");
// a live update re-renders the summary: folds stay
await call("post",{type:"decision",title:"Decision live",text:"decided live"});await p.waitForTimeout(2500);
check(await dec.evaluate(e=>e.classList.contains("folded"))&&(await dec.locator(".fold-peek").innerText())==="Decision live","stays folded through live updates, and the peek follows the newest");
// keyboard
await dec.locator(".fold-h").focus();await p.keyboard.press("Enter");await p.waitForTimeout(200);
check(await dec.locator(".fold-b").isVisible(),"Enter on the heading opens it again");
// Manage still works from the folded Members heading area
check(await p.locator('#board-info .fold[data-fold="members"] [data-open="invite"]').isVisible(),"Members' Manage link stays on the heading");
check(errors.length===0,`no page errors ${errors.join(" | ")}`);
await b.close();console.log(fails?`${fails} FAILED`:"all fold checks passed");
