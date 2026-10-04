// The board's SOUL and MEMORY on the web (vedu #1090/#1091): side-panel sections, the SOUL editor, Remember on a
// message, adding and striking memory, live updates when an agent remembers something.
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE=process.env.BASE||"http://localhost:8787";
const ops=async(p,b)=>(await fetch(`${BASE}/api/ops/${p}`,{method:"POST",headers:{"x-admin-key":"ci-admin-key","content-type":"application/json"},body:JSON.stringify(b)})).json();
const run=Date.now().toString(36).slice(-4),P=`js${run}`,V=`vs${run}`;
for(const u of [P,V])await ops("users",{name:u,email:`${u}@example.com`,verified:"true"});
const board=(await ops("boards",{user:P,title:`Soul ${run}`})).board.id;await ops("members",{board,user:V});
const ck=(await ops("sessions",{user:P})).cookie,tokV=(await ops("tokens",{user:V})).token;
const mcp=async(name,args)=>(await (await fetch(`${BASE}/mcp?board=${board}`,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${tokV}`},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})})).json()).result.content[0].text;
await mcp("read",{});const note=+(await mcp("post",{type:"note",text:`Staging deploys from the release branch ${run}\nmore detail here`})).match(/#(\d+)/)[1];
await mcp("remember",{text:`Prod DB is read-only on Fridays ${run}`});
let fails=0;const check=(ok,m)=>{console.log(`${ok?"✓":"✗"} ${m}`);if(!ok)fails++};
const b=await chromium.launch({executablePath: process.env.PW_CHROME || undefined});
const ctx=await b.newContext({viewport:{width:1400,height:900}});const [k,...v]=ck.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
const p=await ctx.newPage();const errors=[];p.on("pageerror",e=>errors.push(e.message));await p.goto(`${BASE}/b/${board}`);await p.waitForTimeout(1200);
const aside=async()=>{if(!(await p.locator("#soul-side").isVisible()))await p.locator("#info-btn").click().catch(()=>{});await p.waitForTimeout(300)};
await aside();
check(await p.locator("#soul-side").isVisible()&&/No soul yet/.test(await p.locator("#soul-side").innerText()),"the side panel has a Soul section, empty to start, with a way to write it");
const mem=()=>p.locator("#mem-side").innerText();
check(new RegExp(`Prod DB is read-only on Fridays ${run}`).test(await mem())&&new RegExp(`${V}('s agent|/)`).test(await mem()),`Memory lists what the agent remembered, and who (${(await mem()).replace(/\s+/g," ").slice(0,140)})`);
// Write the SOUL
await p.locator("[data-soul-edit]").click();await p.locator("#soul-text").fill(`# Atteo ${run}\nWe ship small, test locally, and never deploy on Fridays.`);await p.locator("#soul-save").click();await p.waitForTimeout(900);
const st=await p.locator("#soul-side").innerText();
check(!(await p.locator("#soul-dlg").evaluate(d=>d.open))&&/never deploy on Fridays/.test(st)&&/v1/.test(st)&&new RegExp(P).test(st),`saving the editor updates the Soul section, v1 by you (${st.replace(/\s+/g," ").slice(0,120)})`);
const api=await (await fetch(`${BASE}/api/boards/${board}/soul`,{headers:{cookie:ck}})).json();check(/never deploy on Fridays/.test(api.soul?.text||""),"…and the server has it");
// Remember a message
await p.locator(`#e${note}`).hover();await p.locator(`#e${note} [data-remember]`).click();await p.waitForTimeout(900);
check(/Remembered/.test(await p.locator("#toast").innerText())&&new RegExp(`Staging deploys from the release branch ${run}`).test(await mem())&&new RegExp(`#${note}`).test(await mem()),"Remember on a message adds its first line to memory, linked to the message");
await p.locator(`#e${note}`).hover();await p.locator(`#e${note} [data-remember]`).click();await p.waitForTimeout(700);
check(/Already remembered/.test(await p.locator("#toast").innerText()),"remembering it again says it's already there");
// Add by hand
await p.fill("#mem-in",`Design reviews are on Tuesdays ${run}`);await p.locator("#mem-add button").click();await p.waitForTimeout(900);
check(new RegExp(`Design reviews are on Tuesdays ${run}`).test(await mem())&&await p.inputValue("#mem-in")==="","you can add a fact by hand");
// Strike
const n0=await p.locator(".mem-it").count();await p.locator(".mem-it",{hasText:`Prod DB is read-only on Fridays ${run}`}).locator("[data-mem-strike]").click();await p.waitForTimeout(900);
check(await p.locator(".mem-it").count()===n0-1&&!new RegExp(`Prod DB is read-only on Fridays ${run}`).test(await mem()),"✕ strikes an item");
// Live: the agent remembers something while the page is open
await mcp("remember",{text:`Use pnpm, not npm ${run}`});await p.waitForTimeout(2500);
check(new RegExp(`Use pnpm, not npm ${run}`).test(await mem()),"when an agent remembers something, it shows up without a reload");
await p.screenshot({path:`${SHOTS_DIR}/soulmem-1400.png`});
// Agents can't write the SOUL
const ag=await fetch(`${BASE}/api/boards/${board}/soul`,{method:"PUT",headers:{"content-type":"application/json",authorization:`Bearer ${tokV}`},body:JSON.stringify({text:"agents rule"})});
check(ag.status===403,`an agent can't change the SOUL (${ag.status})`);
check(!errors.length,`no page errors ${errors.join(" | ")}`);await ctx.close();
// Phone
{const c=await b.newContext({viewport:{width:390,height:800},isMobile:true,hasTouch:true});await c.addCookies([{name:k,value:v.join("="),url:BASE}]);const q=await c.newPage();await q.goto(`${BASE}/b/${board}`);await q.waitForTimeout(1200);
  await q.locator("#info-btn").tap().catch(()=>{});await q.waitForTimeout(500);
  const g=await q.evaluate(()=>({soul:!!document.getElementById('soul-side')?.offsetParent,mem:!!document.getElementById('mem-side')?.offsetParent,sw:document.documentElement.scrollWidth}));
  check(g.soul&&g.mem&&g.sw<=390,`390px: the info sheet shows Soul and Memory without sideways scroll (${JSON.stringify(g)})`);
  await q.screenshot({path:`${SHOTS_DIR}/soulmem-390.png`});await c.close()}
await b.close();console.log(fails?`${fails} FAILED`:"soul + memory: all passed");process.exit(fails?1:0);
