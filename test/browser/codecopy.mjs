// Code blocks in messages: a header with the language and Copy, which copies exactly the code (jxn #1255).
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE=process.env.BASE||"http://localhost:8787";
const ops=async(p,b)=>(await fetch(`${BASE}/api/ops/${p}`,{method:"POST",headers:{"x-admin-key":"ci-admin-key","content-type":"application/json"},body:JSON.stringify(b)})).json();
const run=Date.now().toString(36).slice(-4),P=`cc${run}`;await ops("users",{name:P,email:`${P}@example.com`,verified:"true"});
const board=(await ops("boards",{user:P,title:`Code ${run}`})).board.id;const ck=(await ops("sessions",{user:P})).cookie;
const code=`const a = "<b>${run}</b>";\nconsole.log(a);`;
const r=await (await fetch(`${BASE}/api/boards/${board}/entries`,{method:"POST",headers:{"content-type":"application/json",cookie:ck},body:JSON.stringify({text:"Try this:\n\n```js\n"+code+"\n```"})})).json();const seq=r.entry?.seq??r.seq;
let fails=0;const check=(ok,t)=>{console.log(`${ok?"✓":"✗"} ${t}`);if(!ok)fails++};
const b=await chromium.launch({executablePath: process.env.PW_CHROME || undefined});
for(const [w,mobile] of [[1100,false],[390,true]]){const ctx=await b.newContext({viewport:{width:w,height:800},isMobile:mobile,hasTouch:mobile,permissions:["clipboard-read","clipboard-write"]});const [k,...v]=ck.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
  const p=await ctx.newPage();const errors=[];p.on("pageerror",e=>errors.push(e.message));await p.goto(`${BASE}/b/${board}`);await p.waitForTimeout(900);
  check(await p.locator(`#e${seq} .code-h .mono`).innerText()==="js",`${w}px: the block shows its language`);
  await p.locator(`#e${seq} [data-copy-code]`)[mobile?"tap":"click"]();await p.waitForTimeout(300);
  const clip=await p.evaluate(()=>navigator.clipboard.readText());
  check(clip===code,`${w}px: Copy copies exactly the code (${JSON.stringify(clip).slice(0,60)})`);
  check(/Copied/.test(await p.locator(`#e${seq} [data-copy-code]`).innerText()),`${w}px: it says Copied`);
  check(await p.evaluate(()=>document.documentElement.scrollWidth)<=w,`${w}px: no sideways scroll`);
  await p.locator(`#e${seq} .code-b`).screenshot({path:`${SHOTS_DIR}/code-${w}.png`});
  check(!errors.length,`${w}px: no page errors ${errors.join(" | ")}`);await ctx.close()}
await b.close();console.log(fails?`${fails} FAILED`:"code blocks: all passed");process.exit(fails?1:0);
