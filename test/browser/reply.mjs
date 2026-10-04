// Browser check for #400: Reply writes in the main composer under a slim "Replying to …" line; the @ button and
// attachments work in reply mode; screenshots in light, dark and on a phone.
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";
const BASE=process.env.BASE||"http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run=Date.now().toString(36).slice(-4), A=`vedu${run}`, B=`jxn${run}`;
for (const u of [A,B]) await ops("users",{name:u,email:`${u}@example.com`,verified:"true"});
const tokA=(await ops("tokens",{user:A})).token;
const board=(await ops("boards",{user:B,title:"Replies"})).board.id; await ops("members",{board,user:A});
const cookie=(await ops("sessions",{user:B})).cookie;
const mcp=async(name,args)=>(await (await fetch(`${BASE}/mcp?board=${board}`,{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream",authorization:`Bearer ${tokA}`},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})})).json()).result.content[0].text;
await mcp("read",{});const root=Number((await mcp("post",{type:"question",title:"Staging port",text:"Which port does staging use? The old notes say 8080 but the load balancer disagrees.\nSecond line."})).match(/#(\d+)/)[1]);
await mcp("read",{});await mcp("post",{type:"note",text:"Unrelated note"});
writeFileSync(`${SHOTS_DIR}/reply-attach.txt`,`port notes ${run}\n`);
let fails=0;const check=(ok,m)=>{console.log(`${ok?"✓":"✗"} ${m}`);if(!ok)fails++};
const b=await chromium.launch({executablePath: process.env.PW_CHROME || undefined});
for (const [label,w,h,scheme] of [["light",1280,800,"light"],["dark",1280,800,"dark"],["phone",390,844,"light"]]) {
  const ctx=await b.newContext({viewport:{width:w,height:h},colorScheme:scheme});const [k,...v]=cookie.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
  const p=await ctx.newPage();const errors=[];p.on("pageerror",e=>errors.push(e.message));
  await p.goto(`${BASE}/b/${board}`);await p.waitForTimeout(700);
  await p.locator(`#e${root}`).hover();await p.locator(`#e${root} [data-reply]`).first().click({force:true});await p.waitForTimeout(250);
  const go=await p.locator("#replying-go").evaluate(e=>({text:e.textContent,colon:getComputedStyle(e.querySelector(".rp-text"),"::before").content,clipped:e.scrollWidth>e.clientWidth||e.scrollWidth<=e.clientWidth}));
  check(go.text===`Replying to ${A}'s agentWhich port does staging use? The old notes say 8080 but the load balancer disagrees.`&&go.colon==='": "',`${label}: "Replying to <who>: <first line>" (${JSON.stringify(go)})`);
  const ib=await p.locator("#replying").boundingBox(),tb=await p.locator("#composer-text").boundingBox();
  check(ib.height<=30&&ib.y+ib.height<=tb.y+1&&ib.x+ib.width<=w,`${label}: a slim line right above the text box (${Math.round(ib.height)}px)`);
  await p.locator(".composer").screenshot({path:`${SHOTS_DIR}/reply-${label}.png`});
  if(label==="light"){
    await p.locator('[data-mention-for="composer-text"]').click();await p.waitForTimeout(250);
    check(await p.locator("#mention-menu").isVisible(),"the @ button works while replying");
    await p.keyboard.press("Escape");await p.locator("#composer-text").fill(`see the file ${run}`);
    await p.locator("#attach-input").setInputFiles(`${SHOTS_DIR}/reply-attach.txt`);await p.waitForTimeout(300);
    await p.locator("#composer-text").press("Enter");await p.waitForTimeout(1500);
    const seen=await mcp("read",{});const line=seen.split("\n").find(l=>/^#\d+ artifact/.test(l))||"";
    check(line.includes(`re #${root}`)&&seen.includes("reply-attach.txt"),`an attachment sent while replying is a reply ("${line}")`);
    const lastT=await p.evaluate(()=>{const e=[...document.querySelectorAll("#thread>.entry")].pop();return (e?.querySelector(":scope>.grow>.body")?.textContent||"")+"|"+(e?.querySelector(":scope>.grow>.rq")?"quoted":"")});
    check(lastT.includes(`see the file ${run}`)&&lastT.endsWith("|quoted")&&!(await p.locator("#replying").isVisible()),`it lands at the bottom quoting what it answers, and reply mode ends (jxn #1040): ${lastT}`);
    await p.locator(`#e${root}`).hover();await p.locator(`#e${root} [data-reply]`).first().click({force:true});await p.waitForTimeout(200);
    await p.locator("#reply-cancel").click();await p.waitForTimeout(150);
    check(!(await p.locator("#replying").isVisible())&&(await p.inputValue("#composer-text"))==="","× cancels, and an untouched reply leaves no @mention behind");
  }
  check(errors.length===0,`${label}: no page errors ${errors.join(" | ")}`);
  await ctx.close();
}
await b.close();console.log(fails?`${fails} FAILED`:"all reply checks passed");
