// The board's MEMORY on the web (vedu #1091): the side-panel section, Remember on a message, adding and striking memory,
// live updates when an agent remembers something. No SOUL any more (vedu #5266): no section, no editor, and /soul is 410.
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE=process.env.BASE||"http://localhost:8787";
const ops=async(p,b)=>(await fetch(`${BASE}/api/ops/${p}`,{method:"POST",headers:{"x-admin-key":"ci-admin-key","content-type":"application/json"},body:JSON.stringify(b)})).json();
const run=Date.now().toString(36).slice(-4),P=`jm${run}`,V=`vm${run}`;
for(const u of [P,V])await ops("users",{name:u,email:`${u}@example.com`,verified:"true"});
const board=(await ops("boards",{user:P,title:`Memory ${run}`})).board.id;await ops("members",{board,user:V});
const ck=(await ops("sessions",{user:P})).cookie,tokV=(await ops("tokens",{user:V})).token;
const mcp=async(name,args)=>(await (await fetch(`${BASE}/mcp?board=${board}`,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${tokV}`},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})})).json()).result.content[0].text;
await mcp("read",{});const note=+(await mcp("post",{type:"note",text:`Staging deploys from the release branch ${run}\nmore detail here`})).match(/#(\d+)/)[1];
await mcp("remember",{text:`Prod DB is read-only on Fridays ${run}`});
let fails=0;const check=(ok,m)=>{console.log(`${ok?"✓":"✗"} ${m}`);if(!ok)fails++};
const b=await chromium.launch({executablePath: process.env.PW_CHROME || undefined});
const ctx=await b.newContext({viewport:{width:1400,height:900}});const [k,...v]=ck.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
const p=await ctx.newPage();const errors=[];p.on("pageerror",e=>errors.push(e.message));await p.goto(`${BASE}/b/${board}`);await p.waitForFunction(()=>/Prod DB/.test(document.getElementById("mem-side")?.textContent||""),null,{timeout:8000}).catch(()=>{});
// Until the page shows what the step should have done (or 8 s; the check then says what it saw).
const until=(fn,arg)=>p.waitForFunction(fn,arg,{timeout:8000,polling:50}).then(()=>p.waitForTimeout(100),()=>{});
if(!(await p.locator("#mem-side").isVisible()))await p.locator("#info-btn").click().catch(()=>{});await until(()=>!!document.getElementById("mem-side")?.offsetParent);
const mem=()=>p.locator("#mem-side").innerText();
check(new RegExp(`Prod DB is read-only on Fridays ${run}`).test(await mem())&&new RegExp(`${V}('s agent|/)`).test(await mem()),`Memory lists what the agent remembered, and who (${(await mem()).replace(/\s+/g," ").slice(0,140)})`);
check(!(await p.locator("#soul-side, #soul-dlg, [data-soul-edit]").count())&&!/\bSoul\b/.test(await p.locator("#board-info").innerText()),"no Soul section or editor (vedu #5266)");
// Remember a message
await p.locator(`#e${note}`).hover();await p.locator(`#e${note} [data-remember]`).click();await until((t)=>/Remembered/.test(document.getElementById("toast").textContent)&&(document.getElementById("mem-side")?.textContent||"").includes(t),`Staging deploys from the release branch ${run}`);
check(/Remembered/.test(await p.locator("#toast").innerText())&&new RegExp(`Staging deploys from the release branch ${run}`).test(await mem())&&new RegExp(`#${note}`).test(await mem()),"Remember on a message adds its first line to memory, linked to the message");
await p.locator(`#e${note}`).hover();await p.locator(`#e${note} [data-remember]`).click();await until(()=>/Already remembered/.test(document.getElementById("toast").textContent));
check(/Already remembered/.test(await p.locator("#toast").innerText()),"remembering it again says it's already there");
// Add by hand
await p.fill("#mem-in",`Design reviews are on Tuesdays ${run}`);await p.locator("#mem-add button").click();await until((t)=>(document.getElementById("mem-side")?.textContent||"").includes(t)&&document.getElementById("mem-in").value==="",`Design reviews are on Tuesdays ${run}`);
check(new RegExp(`Design reviews are on Tuesdays ${run}`).test(await mem())&&await p.inputValue("#mem-in")==="","you can add a fact by hand");
// Strike
const n0=await p.locator(".mem-it").count();await p.locator(".mem-it",{hasText:`Prod DB is read-only on Fridays ${run}`}).locator("[data-mem-strike]").click();await until((n)=>document.querySelectorAll(".mem-it").length===n,n0-1);
check(await p.locator(".mem-it").count()===n0-1&&!new RegExp(`Prod DB is read-only on Fridays ${run}`).test(await mem()),"✕ strikes an item");
// Live: the agent remembers something while the page is open
await mcp("remember",{text:`Use pnpm, not npm ${run}`});await until((t)=>(document.getElementById("mem-side")?.textContent||"").includes(t),`Use pnpm, not npm ${run}`);
check(new RegExp(`Use pnpm, not npm ${run}`).test(await mem()),"when an agent remembers something, it shows up without a reload");
await p.screenshot({path:`${SHOTS_DIR}/memory-panel-1400.png`});
// The old SOUL endpoint is gone, for people and agents alike, and says where to go instead
for(const [who,h] of [["a person",{cookie:ck}],["an agent",{authorization:`Bearer ${tokV}`}]]){
  const r=await fetch(`${BASE}/api/boards/${board}/soul`,{method:"PUT",headers:{"content-type":"application/json",...h},body:JSON.stringify({text:"rules"})});const j=await r.json().catch(()=>({}));
  check(r.status===410&&/atteo remember/.test(j.error||""),`PUT /soul from ${who}: 410 pointing at memory (${r.status})`)}
check(!errors.length,`no page errors ${errors.join(" | ")}`);await ctx.close();
// Phone
{const c=await b.newContext({viewport:{width:390,height:800},isMobile:true,hasTouch:true});await c.addCookies([{name:k,value:v.join("="),url:BASE}]);const q=await c.newPage();await q.goto(`${BASE}/b/${board}`);await q.locator("#info-btn").waitFor({timeout:8000}).catch(()=>{});
  await q.locator("#info-btn").tap().catch(()=>{});await q.waitForFunction(()=>!!document.getElementById("mem-side")?.offsetParent,null,{timeout:5000}).catch(()=>{});await q.waitForTimeout(300);
  const g=await q.evaluate(()=>({mem:!!document.getElementById('mem-side')?.offsetParent,sw:document.documentElement.scrollWidth}));
  check(g.mem&&g.sw<=390,`390px: the info sheet shows Memory without sideways scroll (${JSON.stringify(g)})`);
  await q.screenshot({path:`${SHOTS_DIR}/memory-panel-390.png`});await c.close()}
await b.close();console.log(fails?`${fails} FAILED`:"memory panel: all passed");process.exit(fails?1:0);
