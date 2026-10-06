// Everyday mode (#1272): plain words over the same board; Developer mode (a switch, or auto with a coding agent) is today's page.
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE=process.env.BASE||"http://localhost:8787";
const ops=async(p,b)=>(await fetch(`${BASE}/api/ops/${p}`,{method:"POST",headers:{"x-admin-key":"ci-admin-key","content-type":"application/json"},body:JSON.stringify(b)})).json();
const run=Date.now().toString(36).slice(-4),P=`ev${run}`,S=`es${run}`;
await ops("users",{name:P,email:`${P}@example.com`,verified:"true",display:{mode:"auto"}});await ops("users",{name:S,email:`${S}@example.com`,verified:"true",display:{mode:"auto"}});
const board=(await ops("boards",{user:P,title:`Corner Studio ${run}`})).board.id;await ops("members",{board,user:S});
const ck=(await ops("sessions",{user:P})).cookie,tokS=(await ops("tokens",{user:S})).token;
const mcp=async(name,args)=>(await (await fetch(`${BASE}/mcp?board=${board}`,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${tokS}`},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})})).json()).result.content[0].text;
await mcp("read",{});const chg=+(await mcp("post",{type:"change",title:"Holiday hours are ready",text:"Holiday hours added to home + contact.",card:{branch:"holiday-hours",base:"main",repo:"x/y",ci:"passing",commits:[{sha:"a41c9e2",title:"Add closure"}],files:[{path:"site/hours.json",added:6,removed:1}]}})).match(/#(\d+)/)[1];
await mcp("read",{});await mcp("task",{action:"create",title:`Put the holiday hours on the site ${run}`});
let fails=0;const check=(ok,t)=>{console.log(`${ok?"✓":"✗"} ${t}`);if(!ok)fails++};
const b=await chromium.launch({executablePath: process.env.PW_CHROME || undefined});
const open=async(w,scheme)=>{const ctx=await b.newContext({viewport:{width:w,height:860},colorScheme:scheme,isMobile:w<500,hasTouch:w<500});const [k,...v]=ck.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
  const p=await ctx.newPage();const errors=[];p.on("pageerror",e=>errors.push(e.message));await p.goto(`${BASE}/b/${board}`);await p.waitForTimeout(1300);return {ctx,p,errors}};
for(const [w,scheme] of [[1200,"light"],[390,"dark"]]){const {ctx,p,errors}=await open(w,scheme);
  const g=await p.evaluate(s=>{const vis=el=>!!el&&getComputedStyle(el).display!=='none'&&el.getBoundingClientRect().width>0;const e=document.getElementById('e'+s);
    return {mode:document.documentElement.dataset.mode,tab0:document.querySelector('#board-tabs [role=tab]')?.textContent.trim(),tab3:document.querySelectorAll('#board-tabs [role=tab]')[3]?.textContent.trim().replace(/\s+/g,' '),
      log:vis(document.querySelector('[aria-controls="panel-log"]')),who:e?.querySelector('.who')?.textContent,seq:[...(e?.querySelectorAll('.seq,.gut-n')||[])].some(vis),chg:vis(e?.querySelector('.chg')),res:e?.querySelector('.ev-res')?.textContent,
      ph:document.getElementById('composer-text')?.placeholder,side:[...document.querySelectorAll('.side-link[href="/chats"] span')].map(x=>x.textContent)[0]}},chg);
  check(g.mode==="everyday",`${w}px: a person with no coding agent gets Everyday (${g.mode})`);
  check(g.tab0==="Chat"&&/^To-dos/.test(g.tab3)&&!g.log,`${w}px: tabs read Chat · To-dos · Files, no Log (${g.tab0} / ${g.tab3})`);
  check(g.who===`${S[0].toUpperCase()+S.slice(1)}'s assistant`&&!g.seq,`${w}px: the agent reads "${g.who}", no #number`);
  check(!g.chg&&/✓\s*Holiday hours are ready/.test(g.res||""),`${w}px: the change card is a plain result card (${(g.res||"").trim()})`);
  check(g.ph==="Message the group…",`${w}px: the box says "Message the group…"`);
  if(w>500)check(g.side==="Chats",`the sidebar says Chats (${g.side})`);
  await p.screenshot({path:`${SHOTS_DIR}/everyday-${w}.png`});check(!errors.length,`${w}px: no page errors ${errors.join(" | ")}`);await ctx.close()}
// Developer mode: the switch in Account brings today's page back
{const {ctx,p,errors}=await open(1100,"light");await p.goto(`${BASE}/me`);await p.waitForTimeout(900);
  check(!(await p.locator("#dev-mode").isChecked()),"Account shows Developer mode off");
  await p.locator("label.dev-mode").click();await p.waitForTimeout(700);
  const pr=await (await fetch(`${BASE}/api/app/prefs`,{headers:{cookie:ck}})).json();check(pr.prefs?.developer===true&&pr.prefs?.display?.mode==="developer","turning it on saves Developer mode");
  await p.goto(`${BASE}/b/${board}`);await p.waitForTimeout(1200);
  const g=await p.evaluate(s=>({mode:document.documentElement.dataset.mode,tab0:document.querySelector('#board-tabs [role=tab]')?.textContent.trim(),chg:!!document.querySelector('#e'+s+' .chg')?.getBoundingClientRect().width,seq:!!document.querySelector('#e'+s+' .gut-n')?.getBoundingClientRect().width}),chg);
  check(!g.mode&&g.tab0==="Conversation"&&g.chg&&g.seq,`Developer mode is today's page: Conversation, change card, #numbers in the gutter (${JSON.stringify(g)})`);
  check(!errors.length,`no page errors ${errors.join(" | ")}`);await ctx.close()}
// Auto: someone who connected Claude Code is in Developer mode without choosing
{const D=`ed${run}`;await ops("users",{name:D,email:`${D}@example.com`,verified:"true",display:{mode:"auto"}});const t=(await ops("tokens",{user:D})).token;
  await fetch(`${BASE}/api/sessions`,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${t}`},body:JSON.stringify({suggest:"claude",client:"Claude Code"})});
  const cd=(await ops("sessions",{user:D})).cookie;const pr=await (await fetch(`${BASE}/api/app/prefs`,{headers:{cookie:cd}})).json();
  check(pr.prefs?.developer===true&&pr.prefs?.display?.mode==="auto",`connecting Claude Code turns Developer mode on by itself (${JSON.stringify({d:pr.prefs?.developer,m:pr.prefs?.display?.mode})})`)}
await b.close();console.log(fails?`${fails} FAILED`:"everyday: all passed");process.exit(fails?1:0);
