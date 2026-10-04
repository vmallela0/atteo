// #346: a task's card in the chat shows it as it is now: checklist as real checkboxes (tick from the web, or watch an
// agent tick live), n/m with a bar, its sub-tasks with their state; read-only viewers can't tick; the Tasks tab marks sub-tasks.
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE=process.env.BASE||"http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run=Date.now().toString(36).slice(-4), A=`vedu${run}`, B=`jxn${run}`, C=`viewer${run}`;
for (const u of [A,B,C]) await ops("users",{name:u,email:`${u}@example.com`,verified:"true"});
const tokA=(await ops("tokens",{user:A})).token, tokB=(await ops("tokens",{user:B})).token;
const board=(await ops("boards",{user:B,title:"Live checklists"})).board.id; await ops("members",{board,user:A}); await ops("members",{board,user:C});
await fetch(`${BASE}/api/boards/${board}/members/${C}`,{method:"POST",headers:{authorization:`Bearer ${tokB}`,"content-type":"application/json"},body:JSON.stringify({role:"viewer"})});
const mcp=async(name,args)=>(await (await fetch(`${BASE}/mcp?board=${board}`,{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream",authorization:`Bearer ${tokA}`},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})})).json()).result.content[0].text;
let fails=0;const check=(ok,m)=>{console.log(`${ok?"✓":"✗"} ${m}`);if(!ok)fails++};
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const login=async(u,opts={})=>{const ck=(await ops("sessions",{user:u})).cookie;const ctx=await b.newContext({viewport:{width:1280,height:900},...opts});const [k,...v]=ck.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);return ctx};
const ctx=await login(B);const p=await ctx.newPage();const errors=[];p.on("pageerror",e=>errors.push(e.message));
await p.goto(`${BASE}/b/${board}`);await p.waitForTimeout(500);
await mcp("read",{});
const body="Plan:\n\n- [ ] Reproduce the double charge\n- [ ] Write a failing test\n- [ ] Update the docs\n\n```\n- [ ] not a box (code)\n```";
const seq=Number((await mcp("task",{action:"create",title:"Fix the checkout double charge",body,assignee:B})).match(/#(\d+)/)[1]);
const sub1=Number((await mcp("task",{action:"create",title:"Update the docs",parent:seq})).match(/#(\d+)/)[1]);
const sub2=Number((await mcp("task",{action:"create",title:"Ask payments about refunds",parent:seq})).match(/#(\d+)/)[1]);
const card=p.locator(`#e${seq}`), boxes=card.locator(":scope > .grow > .body li.ck > input");
await p.waitForFunction(s=>document.querySelectorAll(`#e${s} .tk-subs li`).length===2,seq,{timeout:8000}).catch(()=>{});
check(await boxes.count()===3,`the checklist shows as 3 real checkboxes (code block lines aren't boxes) (${await boxes.count()})`);
check(await boxes.evaluateAll(xs=>xs.every(x=>!x.disabled&&!x.checked)),"…enabled for a contributor, none ticked");
const prog=()=>card.locator(".tk-prog").innerText().catch(()=>"");
check((await prog())==="0/3","n/m shows 0/3 with a bar");
const subs=await card.locator(".tk-subs").innerText().catch(()=>"");
check(subs.includes("Update the docs")&&subs.includes("Ask payments about refunds")&&/To do/.test(subs)&&!/#\d/.test(subs),`its sub-tasks are listed by title with their state, no numbers (${subs.replace(/\n/g," | ")})`);
check(await card.locator(`.tk-subs a[href="#e${sub1}"]`).innerText()==="Update the docs","…each title links to its message (vedu #675)");
// Tick from the web
await boxes.nth(0).check();await p.waitForTimeout(900);
let got=await mcp("task",{action:"get",seq});
check(/- \[x\] Reproduce the double charge/.test(got)&&/v2/.test(got),"ticking a box on the web saves a versioned edit (v2, [x] in the body)");
check((await prog())==="1/3"&&await card.locator(".body li.ck.done").count()===1,"…the card shows 1/3 and strikes the line through");
const hist=await mcp("task",{action:"history",seq});
check(/ticked: Reproduce the double charge/.test(hist),"…and the history says what was ticked");
await p.screenshot({path:`${SHOTS_DIR}/check-web-tick.png`,clip:await card.boundingBox()});
// Tick from an agent (MCP edit) → live, no reload
await mcp("task",{action:"edit",seq,old_str:"- [ ] Write a failing test",new_str:"- [x] Write a failing test",summary:"test written"});
await p.waitForFunction(s=>document.querySelectorAll(`#e${s} .body li.ck.done`).length===2,seq,{timeout:6000}).catch(()=>{});
check(await boxes.nth(1).isChecked()&&(await prog())==="2/3","an agent ticks a line via MCP → the box ticks live (2/3)");
// A sub-task finished by the agent → its state on the card, and the parent's matching line ticks itself
await mcp("task",{action:"update",seq:sub1,status:"done"});
await p.waitForFunction(s=>document.querySelectorAll(`#e${s} .body li.ck.done`).length===3,seq,{timeout:6000}).catch(()=>{});
check((await prog())==="3/3"&&await boxes.nth(2).isChecked(),"sub-task done → the parent's \"Update the docs\" line ticks live (3/3)");
check(/Done/.test(await card.locator(`.tk-subs li:has(a[href="#e${sub1}"])`).innerText()),"…and the sub-task shows Done on the parent's card");
// Untick from the web
await boxes.nth(0).uncheck();await p.waitForTimeout(900);
got=await mcp("task",{action:"get",seq});
check(/- \[ \] Reproduce the double charge/.test(got)&&(await prog())==="2/3","unticking on the web saves too (2/3)");
// A duplicate line falls back to a whole-body versioned edit
await mcp("task",{action:"edit",seq,old_str:"- [ ] Reproduce the double charge",new_str:"- [ ] Reproduce the double charge\n- [ ] Ping vedu\n- [ ] Ping vedu",summary:"dupes"});
await p.waitForFunction(s=>document.querySelectorAll(`#e${s} .body li.ck`).length===5,seq,{timeout:6000}).catch(()=>{});
await boxes.nth(1).check();await p.waitForTimeout(900);got=await mcp("task",{action:"get",seq});
check(/- \[x\] Ping vedu\n- \[ \] Ping vedu/.test(got),"a line that appears twice: ticking the first copy ticks only that one (whole-body edit against its version)");
await boxes.nth(1).uncheck();await p.waitForTimeout(900);
await boxes.nth(2).check();await p.waitForTimeout(900);got=await mcp("task",{action:"get",seq});
check(/- \[ \] Ping vedu\n- \[x\] Ping vedu/.test(got),"…and ticking the second copy ticks that exact line (whole-body edit against its version)");
await card.scrollIntoViewIfNeeded();
await p.screenshot({path:`${SHOTS_DIR}/check-card-light.png`,clip:await card.boundingBox()});
// Tasks tab: sub-tasks say whose they are; the parent counts them; the checklist count is right
await p.locator("#board-tabs button").nth(3).click();await p.waitForTimeout(700);
const kp=await p.locator(`.kcard[data-seq="${seq}"]`).innerText(), k1=await p.locator(`.kcard[data-seq="${sub1}"]`).innerText();
check(/☑ 3\/5/.test(kp)&&/1\/2 sub-tasks/.test(kp),`Tasks tab: the parent shows ☑ 3/5 and 1/2 sub-tasks (${kp.replace(/\n/g," | ")})`);
check(/↳ Fix the checkout double charge/.test(k1)&&!/#\d/.test(k1),`…a sub-task shows ↳ its parent's title, no number (${k1.replace(/\n/g," | ")})`);
{const vis=await p.evaluate(()=>[...document.querySelectorAll('#kanban .kcard')].map(c=>c.innerText).filter(t=>/#\d/.test(t)));check(vis.length===0,`no visible numbers on task cards (vedu #675): ${JSON.stringify(vis)}`)}
await p.locator("#kanban").screenshot({path:`${SHOTS_DIR}/check-kanban.png`});
check(errors.length===0,`no page errors ${errors.join(" | ")}`);
// Dark mode screenshot
{ const c2=await login(B,{colorScheme:"dark"});const q=await c2.newPage();await q.goto(`${BASE}/b/${board}#e${seq}`);await q.waitForTimeout(1200);
  await q.locator(`#e${seq}`).scrollIntoViewIfNeeded();await q.screenshot({path:`${SHOTS_DIR}/check-card-dark.png`,clip:await q.locator(`#e${seq}`).boundingBox()});await c2.close(); }
// Viewer: sees the boxes, can't tick
{ const c3=await login(C);const q=await c3.newPage();await q.goto(`${BASE}/b/${board}`);await q.waitForTimeout(1200);
  const vb=q.locator(`#e${seq} > .grow > .body li.ck > input`);
  check(await vb.count()===5&&await vb.evaluateAll(xs=>xs.every(x=>x.disabled)),"a read-only viewer sees the boxes but they're disabled");
  const r=await q.evaluate(async([b,s])=>(await fetch(`/api/boards/${b}/tasks/${s}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"edit",old_str:"- [ ] Ping vedu",new_str:"- [x] Ping vedu"})})).status,[board,seq]);
  check(r===403,`…and the server refuses a viewer's edit (${r})`);await c3.close(); }
// Plain messages with a checklist render boxes too, never tickable
await mcp("post",{type:"note",text:"Shopping:\n- [x] milk\n- [ ] eggs"});await p.locator("#board-tabs button").nth(0).click();await p.waitForTimeout(1500);
const note=p.locator("#thread > .entry").last().locator(".body li.ck > input");
check(await note.count()===2&&await note.evaluateAll(xs=>xs.every(x=>x.disabled)),"a checklist in a plain message shows boxes, read-only");
await b.close();console.log(fails?`${fails} FAILED`:"all live checklist checks passed");
