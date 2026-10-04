// Agent model (jxn #1191): an agent session's model shows next to its client on the web (Agents list, hover card,
// profile), and never reaches an agent (its own session JSON, board agents with a token, MCP tool output).
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE=process.env.BASE||"http://localhost:8787";
const KEY=process.env.ADMIN_KEY||"ci-admin-key";
const ops=async(p,b)=>(await fetch(`${BASE}/api/ops/${p}`,{method:"POST",headers:{"x-admin-key":KEY,"content-type":"application/json"},body:JSON.stringify(b)})).json();
const run=Date.now().toString(36).slice(-4),A=`ma${run}`,B=`mb${run}`,M=`Opus 5.5 high ${run}`;
for(const u of [A,B])await ops("users",{name:u,email:`${u}@example.com`,verified:"true",display:{mode:"developer"}});
const board=(await ops("boards",{user:A,title:`Model ${run}`})).board.id;await ops("members",{board,user:B});
const ckA=(await ops("sessions",{user:A})).cookie,tokA=(await ops("tokens",{user:A})).token,tokB=(await ops("tokens",{user:B})).token;
const api=(t,m,p,b)=>fetch(BASE+p,{method:m,headers:{authorization:`Bearer ${t}`,"content-type":"application/json"},body:b?JSON.stringify(b):undefined}).then(r=>r.text());
let fails=0;const check=(ok,t)=>{console.log(`${ok?"✓":"✗"} ${t}`);if(!ok)fails++};
// B's agent starts a session with its model (as the CLI does); a second one of A's has none.
const sB=JSON.parse(await api(tokB,"POST","/api/sessions",{suggest:"claude",client:"Claude Code",model:M})).session;await api(tokB,"POST",`/api/sessions/${sB.id}/boards`,{board});await api(tokB,"POST",`/api/sessions/${sB.id}`,{status:"reviewing the PR"});
const sA=JSON.parse(await api(tokA,"POST","/api/sessions",{suggest:"codex",client:"Codex"})).session;await api(tokA,"POST",`/api/sessions/${sA.id}/boards`,{board});
const mcp=async(name,args)=>JSON.stringify((await (await fetch(`${BASE}/mcp?board=${board}`,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${tokB}`,"x-atteo-session":sB.id},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})})).json()).result);
await mcp("post",{type:"note",text:`hello from B's agent ${run}`});
// Agent side first: nothing it is handed carries the model.
const agentSees=[JSON.stringify(sB),await api(tokB,"GET",`/api/sessions/${sB.id}`),await api(tokB,"GET","/api/sessions"),await api(tokA,"GET",`/api/boards/${board}/agents`),await api(tokA,"GET",`/api/agents/${B}`),await mcp("read",{since:0}),await mcp("agents",{action:"get",name:B}),await mcp("agents",{action:"find"})];
check(!agentSees.some(t=>t.includes(M)),`agents never get the model (${agentSees.length} agent-facing replies checked)`);
const b=await chromium.launch({executablePath: process.env.PW_CHROME || undefined});
for(const [w,mobile] of [[1280,false],[390,true]]){const ctx=await b.newContext({viewport:{width:w,height:844},isMobile:mobile,hasTouch:mobile});const [k,...v]=ckA.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
  const p=await ctx.newPage();const errors=[];p.on("pageerror",e=>errors.push(e.message));
  await p.goto(`${BASE}/b/${board}`);await p.waitForTimeout(800);
  if(w<960){await p.locator("#info-btn").click();await p.waitForTimeout(300)}
  const row=p.locator(`#agents .ag-row[data-k="${B}/claude"]`),other=p.locator(`#agents .ag-row[data-k="${A}/codex"]`);
  const chip=async()=>(await row.locator(".ag-main").innerText()).replace(/\s+/g," ").trim();
  // Fully on screen, not cut off by the line's ellipsis.
  const shown=async()=>p.evaluate(k=>{const m=document.querySelector(`#agents .ag-row[data-k="${k}"] .ag-model`),l=m&&m.closest('.truncate');if(!m)return false;const a=m.getBoundingClientRect(),c=l.getBoundingClientRect();return a.width>0&&a.right<=c.right+0.5},`${B}/claude`);
  check((await chip()).endsWith(`Claude Code ${M} · reviewing the PR`)&&await shown(),`${w}px: the Agents row shows the model under its client, before its status, uncut ("${await chip()}")`);
  check((await row.getAttribute("title")).includes(`(Claude Code, ${M})`),`${w}px: …and its tooltip says both`);
  check(await other.locator(".ag-model").count()===0&&(await other.innerText()).includes("Codex"),`${w}px: a session without a model shows just its client`);
  // The live refresh (client-side rendering) keeps it.
  await p.evaluate(()=>window.agentsRefresh());await p.waitForTimeout(300);
  check((await chip()).endsWith(`Claude Code ${M} · reviewing the PR`)&&await shown(),`${w}px: still there after the Agents list refreshes`);
  {const box=await row.locator(".ag-main").boundingBox(),vw=await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth);check(!!box&&vw,`${w}px: the row fits (no sideways page scroll)`)}
  await p.screenshot({path:`${SHOTS_DIR}/agent-model-agents-${w}.png`});
  if(w<960){await p.keyboard.press("Escape");await p.goto(`${BASE}/b/${board}`);await p.waitForTimeout(600)}
  // Hover card on B's agent's post.
  const who=p.locator(`#thread>.entry.by-agent:has-text("hello from B's agent ${run}") .who`).first();
  if(mobile)await who.tap();else await who.hover();
  await p.waitForSelector(".hcard:not([hidden]) .hc-live",{timeout:4000}).catch(()=>{});
  const hc=(await p.locator(".hcard .hc-live").innerText().catch(()=>"")).replace(/\s+/g," ");
  check(hc.includes(`· Claude Code · ${M}: reviewing the PR`),`${w}px: the agent's card shows client and model ("${hc}")`);
  await p.screenshot({path:`${SHOTS_DIR}/agent-model-card-${w}.png`});
  // Profile page.
  await p.goto(`${BASE}/u/${B}#agent`);await p.waitForTimeout(400);
  const prof=(await p.locator("#agent").innerText()).replace(/\s+/g," ");
  check(prof.includes(`· Claude Code · ${M}: reviewing the PR`),`${w}px: the profile's agent section shows it too`);
  check(errors.length===0,`${w}px: no page errors ${errors.join(" | ")}`);await ctx.close();
}
await b.close();console.log(fails?`${fails} FAILED`:"all agent-model checks passed");process.exit(fails?1:0);
