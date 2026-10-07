// Named agents on the web (vedu #1125/#1161): "Jarvis · vedu's agent" on its posts, @Jarvis drawn as that
// agent's chip, offered by name in the @ menu, the hover card says whose it is, set in Account, renamed live.
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
import { until } from "./lib/wait.mjs";
const BASE=process.env.BASE||"http://localhost:8787";
const ops=async(p,b)=>(await fetch(`${BASE}/api/ops/${p}`,{method:"POST",headers:{"x-admin-key":"ci-admin-key","content-type":"application/json"},body:JSON.stringify(b)})).json();
const run=Date.now().toString(36).slice(-4),P=`jn${run}`,V=`vn${run}`,NAME=`Jarv${run}`;
// P reads with one line per message (Display → Messages), set on the account the way a person sets it: the page applies
// it from /api/me/profile once per tab, so poking data-compact by hand raced that fetch and lost under load.
for(const u of [P,V])await ops("users",{name:u,email:`${u}@example.com`,verified:"true",...(u===P?{display:{compact:"others"}}:{})});
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
// Until the agent post's header starts with this name (a rename shows up live), up to 8 s.
const metaIs=(p,n)=>p.waitForFunction(([s,n])=>(document.querySelector(`#e${s}>.grow>.meta`)?.innerText||"").trim().startsWith(n),[a1,n],{timeout:8000}).catch(()=>{});
const b=await chromium.launch({executablePath: process.env.PW_CHROME || undefined});
for(const [w,scheme] of [[1280,"light"],[390,"dark"]]){
  const ctx=await b.newContext({viewport:{width:w,height:860},colorScheme:scheme,isMobile:w<500,hasTouch:w<500});const [k,...v]=ckP.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
  const p=await ctx.newPage();const errors=[];p.on("pageerror",e=>errors.push(e.message));await p.goto(`${BASE}/b/${board}`);await p.locator(`#e${ms} .mention.agent[data-user="${V}"]`).waitFor({timeout:8000}).catch(()=>{});
  const meta=await p.locator(`#e${a1}>.grow>.meta`).innerText(),own=await p.locator(`#e${a1}>.grow>.meta>.who`).getAttribute("title");
  check(new RegExp(`^${NAME}`).test(meta.trim())&&meta.includes(`${V}'s agent`)&&own===`${V}'s agent`,`${w}px: the agent's post shows its owner (${meta.replace(/\s+/g," ").slice(0,60)} | ${own})`);
  await p.waitForFunction(()=>document.documentElement.dataset.compact==="others",null,{timeout:8000}).catch(()=>{});
  // olMark runs on a timer/frame; the capture-phase opener only handles rows already marked .ol.
  await p.locator(`#e${a1}.ol`).waitFor({state:"attached",timeout:5000});
  check(!await p.locator(`#e${a1} .agent-info`).isVisible(),`${w}px: extra details are hidden in collapsed rows`);
  const opened=async()=>await p.locator(`#e${a1}.ol-open`).count()&&await p.locator(`#e${a1} .agent-info`).isVisible()&&await p.locator(`#e${a1} .agent-info`).innerText()===`${V}'s agent`&&await p.locator(`#e${a1} .who`).innerText()===`${NAME} · ${V}'s agent`;
  // Under load a click can land while olMark is re-marking the row. Retry only while the whole opened state below is absent.
  await until(async()=>await opened()||(await p.locator(`#e${a1} .body`).click(),false));
  check(await p.locator(`#e${a1} .agent-info`).isVisible()&&await p.locator(`#e${a1} .agent-info`).innerText()===`${V}'s agent`&&await p.locator(`#e${a1} .who`).innerText()===`${NAME} · ${V}'s agent`,`${w}px: opening keeps the agent name and owner`);
  const chip=p.locator(`#e${ms} .mention.agent[data-user="${V}"]`);
  check(await chip.count()===1&&(await chip.innerText())===`@${NAME} · ${V}'s agent`,`${w}px: "@${NAME}" in a message shows its owner`);
  if(w>500){await chip.hover();await p.locator(".hcard",{hasText:NAME}).waitFor({timeout:5000}).catch(()=>{});const hc=await p.locator(".hcard").innerText().catch(()=>"");
    check(new RegExp(NAME).test(hc)&&new RegExp(`${V}.?s agent`).test(hc),`the hover card names it and says whose it is (${hc.replace(/\s+/g," ").slice(0,90)})`);
    await p.locator("#composer-text").click();await p.keyboard.type(`@${NAME.slice(0,3)}`);await p.locator("#mention-menu",{hasText:NAME}).waitFor({timeout:5000}).catch(()=>{});
    const menu=await p.locator("#mention-menu").innerText();check(new RegExp(`${NAME}`).test(menu)&&new RegExp(`${V}'s agent`).test(menu),`the @ menu offers it by name, with whose it is (${menu.replace(/\s+/g," ").slice(0,90)})`);
    await p.keyboard.press("Enter");await p.waitForFunction(()=>document.getElementById("composer-text")?.value?.startsWith("@"),null,{timeout:5000}).catch(()=>{});check((await p.inputValue("#composer-text")).startsWith(`@${V}'s agent`),"picking it inserts the agent's canonical address");
    await p.fill("#composer-text","");
    // Live rename
    await prof(ckV,{agent_name:`Ada${run}`});await metaIs(p,`Ada${run}`);
    check(new RegExp(`^Ada${run}`).test((await p.locator(`#e${a1}>.grow>.meta`).innerText()).trim()),"renaming it updates its posts without a reload");
    check(await p.locator(`#e${a1} .agent-info`).innerText()===`${V}'s agent`,"live rename keeps expanded owner details");
    await prof(ckV,{agent_name:NAME});await metaIs(p,NAME)}
  await p.screenshot({path:`${SHOTS_DIR}/agentnames-${w}.png`});
  check(!errors.length,`${w}px: no page errors ${errors.join(" | ")}`);await ctx.close()}
// Account: the field
{const ctx=await b.newContext({viewport:{width:1100,height:900}});const [k,...v]=ckV.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);const p=await ctx.newPage();
  await p.goto(`${BASE}/me`);await p.waitForFunction((n)=>document.getElementById("pf-agent")?.value===n,NAME,{timeout:8000}).catch(()=>{});check(await p.inputValue("#pf-agent").catch(()=>null)===NAME,"Account shows your agent's name");
  await p.fill("#pf-agent",`Max${run}`);await p.locator("#pf-form button.primary").click();await until(()=>p.evaluate(()=>/Profile saved/.test(document.getElementById("toast")?.textContent||"")));
  await until(async()=>{const j=await (await fetch(`${BASE}/api/people/${V}`,{headers:{cookie:ckV}})).json();return (j.person?.agent_name||j.agent_name)===`Max${run}`});
  const me=await (await fetch(`${BASE}/api/people/${V}`,{headers:{cookie:ckV}})).json();check((me.person?.agent_name||me.agent_name)===`Max${run}`,`saving the form renames it (${me.person?.agent_name||me.agent_name})`);
  await p.evaluate(()=>{document.getElementById("toast").textContent=""});await p.fill("#pf-agent",P);await p.locator("#pf-form button.primary").click();await until(()=>p.evaluate(()=>{const t=document.getElementById("toast")?.textContent||"";return /./.test(t)&&!/Profile saved/.test(t)}));
  check(/./.test(await p.locator("#toast").innerText())&&!/Profile saved/.test(await p.locator("#toast").innerText()),`a look-alike name shows the server's error (${await p.locator("#toast").innerText()})`);
  await ctx.close()}
await b.close();console.log(fails?`${fails} FAILED`:"agent names: all passed");process.exit(fails?1:0);
