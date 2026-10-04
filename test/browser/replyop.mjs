// Replying deeper in a thread also mentions whoever started it (jxn #1195); never yourself, never twice.
import { chromium } from "playwright-core";
const BASE=process.env.BASE||"http://localhost:8787";
const ops=async(p,b)=>(await fetch(`${BASE}/api/ops/${p}`,{method:"POST",headers:{"x-admin-key":"ci-admin-key","content-type":"application/json"},body:JSON.stringify(b)})).json();
const run=Date.now().toString(36).slice(-4),A=`ra${run}`,B=`rb${run}`,C=`rc${run}`;
for(const u of [A,B,C])await ops("users",{name:u,email:`${u}@example.com`,verified:"true"});
const board=(await ops("boards",{user:A,title:`OP ${run}`})).board.id;for(const u of [B,C])await ops("members",{board,user:u});
const ck={};for(const u of [A,B,C])ck[u]=(await ops("sessions",{user:u})).cookie;
const post=(u,b)=>fetch(`${BASE}/api/boards/${board}/entries`,{method:"POST",headers:{"content-type":"application/json",cookie:ck[u]},body:JSON.stringify(b)}).then(r=>r.json()).then(j=>j.entry?.seq??j.seq);
const root=await post(A,{text:`Who owns staging ${run}?`});const rep=await post(B,{text:`I think C does ${run}`,reply_to:root});
let fails=0;const check=(ok,t)=>{console.log(`${ok?"✓":"✗"} ${t}`);if(!ok)fails++};
const b=await chromium.launch({executablePath: process.env.PW_CHROME || undefined});
const open=async u=>{const ctx=await b.newContext({viewport:{width:1200,height:800}});const [k,...v]=ck[u].split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);const p=await ctx.newPage();await p.goto(`${BASE}/b/${board}`);await p.waitForTimeout(900);return {ctx,p}};
{const {ctx,p}=await open(C);await p.locator(`#e${rep}`).hover();await p.locator(`#e${rep} [data-reply]`).click();await p.waitForTimeout(200);
  const v=await p.inputValue("#composer-text");check(v.startsWith(`@${B} @${A} `),`replying to a reply mentions its author and the thread's starter ("${v}")`);
  await p.locator("#reply-cancel").click();await p.locator(`#e${root}`).hover();await p.locator(`#e${root} [data-reply]`).click();await p.waitForTimeout(200);
  const w=await p.inputValue("#composer-text");check(w===`@${A} `,`replying to the first message mentions just its author ("${w}")`);await ctx.close()}
{const {ctx,p}=await open(A);await p.locator(`#e${rep}`).hover();await p.locator(`#e${rep} [data-reply]`).click();await p.waitForTimeout(200);
  const v=await p.inputValue("#composer-text");check(v===`@${B} `,`the thread's starter isn't mentioned to themselves ("${v}")`);await ctx.close()}
await b.close();console.log(fails?`${fails} FAILED`:"reply mentions: all passed");process.exit(fails?1:0);
