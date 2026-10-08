// Browser check for vedu #6508: board info → Integrations. ⋯ → Integrations opens it; Linear's status loads from
// /api/integrations/linear (stubbed here: no real Linear), Notion's from /api/integrations/notion (stubbed: not
// connected), Discord's from /api/integrations/discord (stubbed: not connected, then linked), Slack's from the page (the
// fake bridge), and Microsoft Teams is "Coming soon". Only an owner sees Connect; whoever linked it or an owner sees Disconnect; a
// server without Linear says so. 1280 and 390.
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE=process.env.BASE||"http://localhost:8787";
const ops=async(p,b)=>(await fetch(`${BASE}/api/ops/${p}`,{method:"POST",headers:{"x-admin-key":"ci-admin-key","content-type":"application/json"},body:JSON.stringify(b)})).json();
const run=Date.now().toString(36).slice(-4),A=`in${run}`,B=`in${run}x`;
for(const u of [A,B])await ops("users",{name:u,email:`${u}@example.com`,verified:"true"});
const board=(await ops("boards",{user:A,title:`Integrations ${run}`})).board.id;await ops("members",{board,user:B}); // B: can post
const cookie={[A]:(await ops("sessions",{user:A})).cookie,[B]:(await ops("sessions",{user:B})).cookie};
let fails=0;const check=(ok,m)=>{console.log(`${ok?"✓":"✗"} ${m}`);if(!ok)fails++};
const LINKED={linked:true,ready:true,org:{id:"o1",name:"Acme"},team:{id:"t1",key:"ENG",name:"Engineering"},project:{id:"p1",name:"Checkout"},blocked_label:false,created_by:A,created_at:1,issues:2};
const DISCORD_LINKED={linked:true,active:true,guild_id:"g9",channel_id:"c9",created_by:A,linked_by_name:"Ann",created_at:1};
const b=await chromium.launch({executablePath: process.env.PW_CHROME || undefined});
// state: what GET /api/integrations/linear answers ("off" = 503, as on a server without Linear's secrets)
const open=async(user,w,phone,state)=>{
  const ctx=await b.newContext({viewport:{width:w,height:820},...(phone?{hasTouch:true,isMobile:true}:{})});
  const [k,...v]=cookie[user].split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
  const p=await ctx.newPage();const errors=[];p.on("pageerror",e=>errors.push(e.message));const deletes=[],dDeletes=[];
  await p.route("**/api/integrations/linear?*",async r=>{
    if(r.request().method()==="DELETE"){deletes.push(r.request().url());state.v="none";return r.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true,linked:false})})}
    if(state.v==="off")return r.fulfill({status:503,contentType:"application/json",body:JSON.stringify({error:"Linear isn't set up yet"})});
    return r.fulfill({status:200,contentType:"application/json",body:JSON.stringify(state.v==="linked"?LINKED:{linked:false})})});
  await p.route("**/api/integrations/notion?*",r=>r.fulfill({status:200,contentType:"application/json",body:JSON.stringify({linked:false})}));
  // Discord (state.d): "none" or "linked" (by A)
  await p.route("**/api/integrations/discord?*",r=>{
    if(r.request().method()==="DELETE"){dDeletes.push(r.request().url());state.d="none";return r.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true,linked:false})})}
    return r.fulfill({status:200,contentType:"application/json",body:JSON.stringify(state.d==="linked"?DISCORD_LINKED:{linked:false})})});
  await p.goto(`${BASE}/b/${board}`);await p.locator("#composer-text").waitFor();
  return {ctx,p,errors,deletes,dDeletes};
};
const panel=async(p,want)=>{if(!(await p.locator(".actions .board-head-menu").evaluate(d=>d.open)))await p.locator(".actions .board-head-menu summary").click();await p.locator('.board-head-menu-items [data-int-open]').click();
  await p.locator("#acc-integrations").waitFor();await p.locator("#int-linear .int-st").filter({hasText:want}).waitFor({timeout:8000}).catch(()=>{})};
// For the screenshots: the ⋯ menu closed, the dialog's fade done.
const settle=async(p)=>{await p.locator(".actions .board-head-menu").evaluate(d=>d.open=false);await p.waitForTimeout(450)};
const fits=async(p,w)=>{for(const r of await p.locator("#acc-integrations .int-row").all()){const x=await r.boundingBox();if(!x||x.x<0||x.x+x.width>w+0.5)return false}return true};
for(const [label,w,phone] of [["desktop",1280,false],["phone",390,true]]){
  // The owner, Linear not connected yet: Connect Linear, Connect Slack, Connect Notion, Connect Discord, one coming soon.
  const st={v:"none",d:"none"};const {ctx,p,errors,deletes,dDeletes}=await open(A,w,phone,st);
  await panel(p,"Not connected");
  check(await p.locator("#acc-integrations").isVisible(),`${label}: ⋯ → Integrations opens board info at Integrations`);
  check((await p.locator("#int-linear .int-st").innerText()).includes("Not connected"),`${label}: Linear says not connected`);
  check((await p.locator("#int-linear a").getAttribute("href"))===`/api/integrations/linear/start?board=${board}`,`${label}: the owner gets Connect Linear → /start`);
  check((await p.locator("#int-slack .int-st").innerText()).includes("Not connected"),`${label}: Slack says not connected`);
  check((await p.locator("#int-slack a").getAttribute("href"))===`/slack/connect?board=${board}`,`${label}: the owner gets Connect Slack`);
  const soon=p.locator("#acc-integrations [data-soon]");
  check(await soon.count()===1&&(await soon.allInnerTexts()).every(t=>t.includes("Microsoft Teams")&&t.includes("Coming soon")),`${label}: Teams is greyed "Coming soon"`);
  await p.locator("#int-discord .int-st").filter({hasText:"Not connected"}).waitFor({timeout:8000}).catch(()=>{});
  check((await p.locator("#int-discord a").getAttribute("href"))===`/api/integrations/discord/start?board=${board}`,`${label}: the owner gets Connect Discord → /start`);
  await p.locator("#int-notion .int-st").filter({hasText:"Not connected"}).waitFor({timeout:8000}).catch(()=>{});
  check((await p.locator("#int-notion a").getAttribute("href"))===`/api/integrations/notion/start?board=${board}`,`${label}: the owner gets Connect Notion → /start`);
  check(await soon.locator("a,button").count()===0,`${label}: …with nothing to click`);
  check(await fits(p,w),`${label}: every row fits ${w}px`);
  await settle(p);
  const box=await p.locator("#acc-integrations h3").boundingBox();
  check(!!box&&box.y>=0&&box.y<820,`${label}: board info scrolls to Integrations (again after the members list loads above it)`);
  await p.screenshot({path:`${SHOTS_DIR}/integrations-${label}.png`});
  // Linked: team · project, by whom, and Disconnect (with a confirm) back to not connected.
  st.v="linked";await p.locator("#invite [data-close]").first().click();await panel(p,"Engineering");
  const s=await p.locator("#int-linear .int-st").innerText();
  check(s.includes("Engineering · Checkout")&&s.includes(`connected by ${A}`),`${label}: linked shows team · project and who connected it`);
  await settle(p);await p.screenshot({path:`${SHOTS_DIR}/integrations-${label}-linked.png`});
  p.once("dialog",d=>d.accept());await p.locator("[data-linear-disconnect]").click();
  // Discord linked: who connected it (no Discord ids), and Disconnect (with a confirm) back to not connected.
  st.d="linked";await p.locator("#invite [data-close]").first().click();await panel(p,"Not connected");
  await p.locator("#int-discord .int-st").filter({hasText:`connected by ${A}`}).waitFor({timeout:8000}).catch(()=>{});
  const ds=await p.locator("#int-discord .int-st").innerText();
  check(ds.includes(`connected by ${A}`)&&!/g9|c9/.test(ds),`${label}: Discord linked shows who connected it, no ids`);
  p.once("dialog",d=>d.accept());await p.locator("[data-discord-disconnect]").click();
  await p.locator("#int-discord .int-st").filter({hasText:"Not connected"}).waitFor({timeout:8000});
  check(dDeletes.length===1&&dDeletes[0].includes(`board=${board}`),`${label}: Discord's Disconnect asks, then DELETEs this board's link`);
  await p.locator("#int-linear .int-st").filter({hasText:"Not connected"}).waitFor({timeout:8000});
  check(deletes.length===1&&deletes[0].includes(`board=${board}`),`${label}: Disconnect asks, then DELETEs this board's link`);
  // A server without Linear set up: says so, and offers nothing.
  st.v="off";await p.locator("#invite [data-close]").first().click();await panel(p,"Not set up");
  check((await p.locator("#int-linear .int-st").innerText()).includes("Not set up on this server yet"),`${label}: 503 → not set up on this server yet`);
  check(await p.locator("#int-linear a, #int-linear button").count()===0,`${label}: …with no Connect`);
  check(errors.length===0,`${label}: no page errors ${errors.join(" | ")}`);
  await ctx.close();
  // Someone who can post (not an owner): the status, nothing to connect or disconnect.
  const st2={v:"linked",d:"linked"};const o2=await open(B,w,phone,st2);await panel(o2.p,"Engineering");
  await o2.p.locator("#int-discord .int-st").filter({hasText:`connected by ${A}`}).waitFor({timeout:8000}).catch(()=>{});
  check((await o2.p.locator("#int-discord .int-st").innerText()).includes(`connected by ${A}`)&&await o2.p.locator("#int-discord a, #int-discord button").count()===0,`${label}: a contributor sees Discord's status, no Disconnect`);
  check((await o2.p.locator("#int-linear .int-st").innerText()).includes("Engineering"),`${label}: a contributor sees Linear's status`);
  check(await o2.p.locator("#int-linear a, #int-linear button, #int-slack a").count()===0,`${label}: …but no Connect or Disconnect (owners connect; the linker or an owner disconnects)`);
  st2.v="none";st2.d="none";await o2.p.locator("#invite [data-close]").first().click();await panel(o2.p,"Not connected");
  check(await o2.p.locator("#int-linear a").count()===0,`${label}: …and no Connect Linear when it isn't connected`);
  check(await o2.p.locator("#int-notion a, #int-notion button").count()===0,`${label}: …nor Connect Notion`);
  await o2.p.locator("#int-discord .int-st").filter({hasText:"Not connected"}).waitFor({timeout:8000}).catch(()=>{});
  check(await o2.p.locator("#int-discord a, #int-discord button").count()===0,`${label}: …nor Connect Discord`);
  check(o2.errors.length===0,`${label}: contributor: no page errors ${o2.errors.join(" | ")}`);
  await o2.ctx.close();
}
// atteo disconnect's link: /b/<id>#integrations opens board info at Integrations.
{const st={v:"none",d:"none"};const {ctx,p}=await open(A,1280,false,st);await p.goto("about:blank");await p.goto(`${BASE}/b/${board}#integrations`);
  check(await p.locator("#acc-integrations").waitFor({timeout:8000}).then(()=>true,()=>false),"#integrations opens the panel");await ctx.close()}
await b.close();console.log(fails?`${fails} FAILED`:"all integrations checks passed");process.exit(fails?1:0);
