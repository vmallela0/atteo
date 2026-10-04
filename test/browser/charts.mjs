// Charts in messages (vedu #1246/#1247): bar, line, area and pie draw as SVGs in the board's colours, light and dark, phone and desktop.
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE=process.env.BASE||"http://localhost:8787";
const ops=async(p,b)=>(await fetch(`${BASE}/api/ops/${p}`,{method:"POST",headers:{"x-admin-key":"ci-admin-key","content-type":"application/json"},body:JSON.stringify(b)})).json();
const run=Date.now().toString(36).slice(-4),P=`ch${run}`;await ops("users",{name:P,email:`${P}@example.com`,verified:"true"});
const board=(await ops("boards",{user:P,title:`Charts ${run}`})).board.id;const ck=(await ops("sessions",{user:P})).cookie;const tok=(await ops("tokens",{user:P})).token;
const mcp=async(name,args)=>(await (await fetch(`${BASE}/mcp?board=${board}`,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${tok}`},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})})).json()).result.content[0].text;
const post=async t=>{await mcp("read",{});return +(await mcp("post",{type:"note",text:t})).match(/#(\d+)/)[1]};
const c=j=>"```chart\n"+JSON.stringify(j)+"\n```";
const s1=await post("Signups this week\n\n"+c({type:"bar",title:"Signups",x:["Mon","Tue","Wed","Thu","Fri"],series:[{name:"web",values:[12,19,7,22,15]},{name:"app",values:[4,6,9,11,8]}]}));
const s2=await post(c({type:"line",title:"p95 latency",unit:"ms",x:["9:00","10:00","11:00","12:00","13:00","14:00"],series:[{name:"p95",values:[180,142,120,95,88,91]},{name:"p50",values:[60,52,48,40,38,39]}]}));
const s3=await post(c({type:"area",title:"Active boards",x:["W1","W2","W3","W4"],series:[{name:"boards",values:[3,8,14,21]}]}));
const s4=await post(c({type:"pie",title:"Where agents run",x:["Claude Code","Codex","Grok","Cursor"],series:[{name:"agents",values:[12,5,3,2]}]}));
const s5=await post("```chart\nthis is not json\n```");
let fails=0;const check=(ok,t)=>{console.log(`${ok?"✓":"✗"} ${t}`);if(!ok)fails++};
const b=await chromium.launch({executablePath: process.env.PW_CHROME || undefined});
for(const [w,scheme] of [[1200,"light"],[390,"dark"]]){const ctx=await b.newContext({viewport:{width:w,height:900},colorScheme:scheme,isMobile:w<500});const [k,...v]=ck.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
  const p=await ctx.newPage();const errors=[];p.on("pageerror",e=>errors.push(e.message));await p.goto(`${BASE}/b/${board}`);await p.waitForTimeout(1000);
  const g=await p.evaluate(([a,b2,c3,d,e])=>{const q=(s,sel)=>[...document.querySelectorAll('#e'+s+' '+sel)].filter(x=>(x.closest('svg')||x).getBoundingClientRect().width>0).length;const fill=[...document.querySelectorAll('#e'+a+' rect.ch-s0')].find(x=>x.getBoundingClientRect().width>0);
    return {bars:q(a,'rect[class^="ch-s"]'),lines:q(b2,'polyline'),area:q(c3,'polygon'),pie:q(d,'path[class^="ch-s"]'),bad:q(e,'pre code'),fill:fill?getComputedStyle(fill).fill:'',sw:document.documentElement.scrollWidth,
      fits:[...document.querySelectorAll('.ch')].every(f=>f.getBoundingClientRect().right<=document.getElementById('thread').getBoundingClientRect().right+1)}},[s1,s2,s3,s4,s5]);
  check(g.bars===10&&g.lines===2&&g.area===1&&g.pie===4&&g.bad===1,`${w}px ${scheme}: bar, line, area and pie draw; a broken one shows as text (${JSON.stringify(g)})`);
  check(/rgb/.test(g.fill)&&g.sw<=w&&g.fits,`${w}px ${scheme}: in the board's colours, inside the conversation, no sideways scroll`);
  await p.locator(`#e${s1} .ch-data summary`).click();check(await p.locator(`#e${s1} .ch-data table`).isVisible(),`${w}px: "Data" shows the numbers as a table`);
  for(const [s,n] of [[s1,"bar"],[s2,"line"],[s4,"pie"]])await p.locator(`#e${s} .ch`).screenshot({path:`${SHOTS_DIR}/chart-${n}-${w}.png`});
  check(!errors.length,`${w}px: no page errors ${errors.join(" | ")}`);await ctx.close()}
await b.close();console.log(fails?`${fails} FAILED`:"charts: all passed");process.exit(fails?1:0);
