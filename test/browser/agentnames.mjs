// Named agents on the web (vedu #1125/#1161): "Jarvis" with "vedu's agent" next to it on its posts, @Jarvis drawn as that
// agent's chip, offered by name in the @ menu, the hover card says whose it is, set in Account, renamed live.
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE=process.env.BASE||"http://localhost:8787";
const ops=async(p,b)=>(await fetch(`${BASE}/api/ops/${p}`,{method:"POST",headers:{"x-admin-key":"ci-admin-key","content-type":"application/json"},body:JSON.stringify(b)})).json();
const run=Date.now().toString(36).slice(-4),P=`jn${run}`,V=`vn${run}`,NAME=`Jarv${run}`;
for(const u of [P,V])await ops("users",{name:u,email:`${u}@example.com`,verified:"true"});
const board=(await ops("boards",{user:P,title:`Names ${run}`})).board.id;await ops("members",{board,user:V});
const ckP=(await ops("sessions",{user:P})).cookie,ckV=(await ops("sessions",{user:V})).cookie,tokV=(await ops("tokens",{user:V})).token;
const prof=(ck,b)=>fetch(`${BASE}/api/me/profile`,{method:"POST",headers:{"content-type":"application/json",cookie:ck},body:JSON.stringify(b)});
const r0=await prof(ckV,{agent_name:NAME});
const mcp=async(name,args)=>(await (await fetch(`${BASE}/mcp?board=${board}`,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${tokV}`},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})})).json()).result.content[0].text;
await mcp("read",{});const a1=+(await mcp("post",{type:"note",text:`Hello from the named agent ${run}`})).match(/#(\d+)/)[1];
const post=(ck,text)=>fetch(`${BASE}/api/boards/${board}/entries`,{method:"POST",headers:{"content-type":"application/json",cookie:ck},body:JSON.stringify({text})}).then(r=>r.json());
const m=await post(ckP,`@${NAME} can you check staging ${run}`);const ms=m.entry?.seq??m.seq;
let fails=0;const check=(ok,t)=>{console.log(`${ok?"✓":"✗"} ${t}`);if(!ok)fails++};
check(r0.ok,`setting the agent name works (${r0.status})`);
const bad=await prof(ckV,{agent_name:P});check(bad.status===400,`a name that looks like a member's is refused (${bad.status})`);
const b=await chromium.launch({executablePath: process.env.PW_CHROME || undefined});
for(const [w,scheme] of [[1280,"light"],[390,"dark"]]){
  const ctx=await b.newContext({viewport:{width:w,height:860},colorScheme:scheme,isMobile:w<500,hasTouch:w<500});const [k,...v]=ckP.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
  const p=await ctx.newPage();const errors=[];p.on("pageerror",e=>errors.push(e.message));await p.goto(`${BASE}/b/${board}`);await p.waitForTimeout(1100);
  const meta=await p.locator(`#e${a1}>.grow>.meta`).innerText();
  check(new RegExp(`^${NAME}`).test(meta.trim())&&new RegExp(`${V}'s agent`).test(meta),`${w}px: the agent's post reads "${NAME}" with "${V}'s agent" next to it (${meta.replace(/\s+/g," ").slice(0,80)})`);
  const chip=p.locator(`#e${ms} .mention.agent[data-user="${V}"]`);
  check(await chip.count()===1&&(await chip.innerText())===`@${NAME}`,`${w}px: "@${NAME}" in a message is that agent's chip`);
  if(w>500){await chip.hover();await p.waitForTimeout(900);const hc=await p.locator(".hcard").innerText().catch(()=>"");
    check(new RegExp(NAME).test(hc)&&new RegExp(`${V}.?s agent`).test(hc),`the hover card names it and says whose it is (${hc.replace(/\s+/g," ").slice(0,90)})`);
    await p.locator("#composer-text").click();await p.keyboard.type(`@${NAME.slice(0,3)}`);await p.waitForTimeout(400);
    const menu=await p.locator("#mention-menu").innerText();check(new RegExp(`${NAME}`).test(menu)&&new RegExp(`${V}'s agent`).test(menu),`the @ menu offers it by name, with whose it is (${menu.replace(/\s+/g," ").slice(0,90)})`);
    await p.keyboard.press("Enter");await p.waitForTimeout(200);check((await p.inputValue("#composer-text")).startsWith(`@${NAME}`),"picking it inserts @"+NAME);
    await p.fill("#composer-text","");
    // Live rename
    await prof(ckV,{agent_name:`Ada${run}`});await p.waitForTimeout(2500);
    check(new RegExp(`^Ada${run}`).test((await p.locator(`#e${a1}>.grow>.meta`).innerText()).trim()),"renaming it updates its posts without a reload");
    await prof(ckV,{agent_name:NAME});await p.waitForTimeout(1500)}
  await p.screenshot({path:`${SHOTS_DIR}/agentnames-${w}.png`});
  check(!errors.length,`${w}px: no page errors ${errors.join(" | ")}`);await ctx.close()}
// Account: the field
{const ctx=await b.newContext({viewport:{width:1100,height:900}});const [k,...v]=ckV.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);const p=await ctx.newPage();
  await p.goto(`${BASE}/me`);await p.waitForTimeout(800);check(await p.inputValue("#pf-agent").catch(()=>null)===NAME,"Account shows your agent's name");
  await p.fill("#pf-agent",`Max${run}`);await p.locator("#pf-form button.primary").click();await p.waitForTimeout(800);
  const me=await (await fetch(`${BASE}/api/people/${V}`,{headers:{cookie:ckV}})).json();check((me.person?.agent_name||me.agent_name)===`Max${run}`,`saving the form renames it (${me.person?.agent_name||me.agent_name})`);
  await p.fill("#pf-agent",P);await p.locator("#pf-form button.primary").click();await p.waitForTimeout(800);
  check(/./.test(await p.locator("#toast").innerText())&&!/Profile saved/.test(await p.locator("#toast").innerText()),`a look-alike name shows the server's error (${await p.locator("#toast").innerText()})`);
  await ctx.close()}
await b.close();console.log(fails?`${fails} FAILED`:"agent names: all passed");process.exit(fails?1:0);
