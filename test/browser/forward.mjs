// Multi-select and forward: people only, quoted with who said what, into another board they're on.
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
import { until } from "./lib/wait.mjs";
const BASE=process.env.BASE||"http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run=Date.now().toString(36).slice(-4), A=`fa${run}`, B=`fb${run}`;
for (const u of [A,B]) await ops("users",{name:u,email:`${u}@example.com`,verified:"true"});
const tokA=(await ops("tokens",{user:A})).token;
const src=(await ops("boards",{user:B,title:`Payments ${run}`})).board.id; await ops("members",{board:src,user:A});
const dst=(await ops("boards",{user:B,title:`Infra ${run}`})).board.id; await ops("members",{board:dst,user:A});
const mcp=async(b,name,args)=>{await fetch(`${BASE}/mcp?board=${b}`,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${tokA}`},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"read",arguments:{}}})});return (await (await fetch(`${BASE}/mcp?board=${b}`,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${tokA}`},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})})).json()).result.content[0].text};
const s1=+(await mcp(src,"post",{type:"question",text:`@${B} which retry limit for card declines?`})).match(/#(\d+)/)[1];
const s2=+(await mcp(src,"post",{type:"note",text:"3 for soft declines, 0 for hard ones"})).match(/#(\d+)/)[1];
await mcp(src,"post",{type:"note",text:"unrelated"});
let fails=0;const check=(ok,m)=>{console.log(`${ok?"✓":"✗"} ${m}`);if(!ok)fails++};
// An agent's token can't forward.
const viaToken=await fetch(`${BASE}/api/forward`,{method:"POST",headers:{authorization:`Bearer ${tokA}`,"content-type":"application/json"},body:JSON.stringify({from:src,to:dst,seqs:[s1]})});
check(viaToken.status===403,`agents can't forward (${viaToken.status})`);
const ck=(await ops("sessions",{user:B})).cookie;
const b=await chromium.launch({executablePath: process.env.PW_CHROME || undefined});
for (const [w,h] of [[1280,820],[390,844]]) {
  const ctx=await b.newContext({viewport:{width:w,height:h}});const [k,...v]=ck.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
  const p=await ctx.newPage();const errors=[];p.on("pageerror",e=>errors.push(e.message));
  await p.goto(`${BASE}/b/${src}`);await p.locator(`#e${s1}`).waitFor();
  if(w>800){await p.locator(`#e${s1}`).hover();await p.locator(`#e${s1} [data-select]`).click();}
  else await p.evaluate(s=>document.querySelector(`#e${s} [data-select]`).click(),s1); // phones: the action shows on the opened entry
  await until(async()=>await p.locator("#sel-bar").isVisible()&&(await p.locator("#sel-n").innerText())==="1 selected");
  check(await p.locator("#sel-bar").isVisible()&&(await p.locator("#sel-n").innerText())==="1 selected",`${w}px: Select starts multi-select with that message picked`);
  check(!(await p.locator(".composer").isVisible()),"…the composer steps aside for the selection bar");
  await p.locator(`#e${s2} .body`).click();await until(async()=>(await p.locator("#sel-n").innerText())==="2 selected");
  check((await p.locator("#sel-n").innerText())==="2 selected","clicking another message adds it");
  await p.locator("#sel-fwd").click();await until(async()=>await p.locator("#fwd-dlg").isVisible()&&(await p.locator("#fwd-prev").innerText()).includes("which retry limit"));
  check(await p.locator("#fwd-dlg").isVisible()&&(await p.locator("#fwd-prev").innerText()).includes("which retry limit"),"Forward shows what will be quoted");
  await p.locator("#fwd-q").fill("Infra");
  await p.locator(`#fwd-list [data-to="${dst}"]`).click();
  await p.locator("#fwd-note").fill(`see the decline thread ${w}`);
  check(!(await p.locator("#fwd-send").isDisabled()),"Forward is enabled once a board is picked");
  const box=await p.locator(`#e${s1}`).boundingBox(),dot=await p.evaluate(s=>{const r=document.getElementById('e'+s).getBoundingClientRect(),c=getComputedStyle(document.getElementById('e'+s),'::before');return r.left+parseFloat(c.left)},s1);
  check(dot>=box.x-1&&dot>=(await p.locator("#thread").boundingBox()).x-1,"the selection circle isn't clipped (even on a message for you)");
  await p.screenshot({path:`${SHOTS_DIR}/forward-${w}.png`});
  await p.locator("#fwd-send").click();await until(async()=>!(await p.locator("#fwd-dlg").isVisible())&&!(await p.locator("#sel-bar").isVisible()));
  check(!(await p.locator("#fwd-dlg").isVisible())&&!(await p.locator("#sel-bar").isVisible()),"sending closes the dialog and ends selecting");
  await p.goto(`${BASE}/b/${dst}`);await until(()=>p.evaluate(t=>[...document.querySelectorAll("#thread .entry")].pop()?.innerText.includes(t),`see the decline thread ${w}`),10000);
  const last=p.locator("#thread .entry").last();const t=await last.innerText();
  check(t.includes(`see the decline thread ${w}`)&&t.includes(`Forwarded from Payments ${run}`)&&t.includes(`${A}'s agent`)&&t.includes("3 for soft declines")&&!t.includes("unrelated"),`${w}px: one message on the other board, quoting who said what`);
  check(await last.locator("blockquote.md-q").count()===2,"…each forwarded message as its own quote");
  check(await last.locator(".mention").count()===0,"quoted @names don't ping anyone on the new board");
  if(w>800)await p.screenshot({path:`${SHOTS_DIR}/forwarded.png`});
  check(errors.length===0,`no page errors ${errors.join(" | ")}`);await ctx.close();
}
await b.close();console.log(fails?`${fails} FAILED`:"all forward checks passed");
