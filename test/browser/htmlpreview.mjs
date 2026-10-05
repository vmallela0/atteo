// HTML files preview live in a sandbox (jxn #1309): Preview next to Open; the page runs but can't touch the viewer's account.
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE=process.env.BASE||"http://localhost:8787";
const ops=async(p,b)=>(await fetch(`${BASE}/api/ops/${p}`,{method:"POST",headers:{"x-admin-key":"ci-admin-key","content-type":"application/json"},body:JSON.stringify(b)})).json();
const run=Date.now().toString(36).slice(-4),P=`hp${run}`,V=`hv${run}`;for(const u of [P,V])await ops("users",{name:u,email:`${u}@example.com`,verified:"true",display:{mode:"developer"}});
const board=(await ops("boards",{user:P,title:`Prev ${run}`})).board.id;await ops("members",{board,user:V});
const ck=(await ops("sessions",{user:P})).cookie,tokV=(await ops("tokens",{user:V})).token;
const mcp=async(name,args)=>(await (await fetch(`${BASE}/mcp?board=${board}`,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${tokV}`},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})})).json()).result.content[0].text;
const page=`<!doctype html><html><head><title>t</title></head><body><button id="b" onclick="this.textContent='clicked'">Tap me ${run}</button><pre id="o"></pre><script>
const out=[];try{parent.document.title;out.push('parent:LEAK')}catch(e){out.push('parent:blocked')}
try{document.cookie;out.push('cookie:LEAK')}catch(e){out.push('cookie:blocked')}
try{localStorage.length;out.push('storage:LEAK')}catch(e){out.push('storage:blocked')}
fetch('/api/me').then(()=>{document.getElementById('o').textContent+=' fetch:LEAK'}).catch(()=>{document.getElementById('o').textContent+=' fetch:blocked'});
try{top.location='https://example.com';out.push('nav:tried')}catch(e){out.push('nav:blocked')}
document.getElementById('o').textContent=out.join(' ');</script></body></html>`;
await mcp("read",{});await mcp("post",{type:"artifact",text:"A mockup",artifact_name:`mock-${run}.html`,artifact_content:page});
let fails=0;const check=(ok,t)=>{console.log(`${ok?"✓":"✗"} ${t}`);if(!ok)fails++};
const b=await chromium.launch({executablePath: process.env.PW_CHROME || undefined});
// Both sizes side by side (they only read).
await Promise.all([[1200,false],[390,true]].map(async([w,mobile])=>{const ctx=await b.newContext({viewport:{width:w,height:820},isMobile:mobile,hasTouch:mobile});const [k,...v]=ck.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
  const p=await ctx.newPage();const errors=[];p.on("pageerror",e=>errors.push(e.message));await p.goto(`${BASE}/b/${board}`);await p.locator(`#thread [data-preview-file="mock-${run}.html"]`).waitFor({timeout:8000}).catch(()=>{});
  const btn=p.locator(`#thread [data-preview-file="mock-${run}.html"]`);check(await btn.count()===1,`${w}px: the HTML file has Preview next to Open`);
  await btn[mobile?"tap":"click"]();await p.frameLocator("#pv-frame").locator("#o",{hasText:"fetch:"}).waitFor({timeout:8000}).catch(()=>{}); // the probe's last line (its fetch settles)
  check(await p.locator(".pv-dlg").evaluate(d=>d.open),`${w}px: Preview opens the overlay`);
  const fr=p.frameLocator("#pv-frame");await fr.locator("#b").click();await p.waitForTimeout(300);
  check((await fr.locator("#b").innerText())==="clicked",`${w}px: the page is interactive (a button works)`);
  const o=await fr.locator("#o").innerText();
  check(/parent:blocked/.test(o)&&/cookie:blocked/.test(o)&&/storage:blocked/.test(o)&&/fetch:blocked/.test(o)&&!/LEAK/.test(o),`${w}px: it can't reach the page, cookies, storage or the API (${o})`);
  check(p.url().startsWith(BASE),`${w}px: it can't navigate the page away (${p.url()})`);
  check(await p.locator(".pv-dlg iframe").getAttribute("sandbox")==="allow-scripts",`${w}px: sandboxed with scripts only`);
  await p.screenshot({path:`${SHOTS_DIR}/htmlpreview-${w}.png`});
  if(!mobile){await p.locator('[data-pv-w="390"]').click(); // Full / Phone (jxn #4322): pressed state and the frame's width follow
    check((await p.locator("[data-pv-w]").evaluateAll(bs=>bs.map(x=>x.getAttribute("aria-pressed")).join()))==="false,true"&&(await p.locator("#pv-frame").evaluate(f=>f.style.width))==="390px","Phone narrows the frame and is the pressed option")}
  await p.locator(".pv-hd b").click();await p.keyboard.press("Escape");await p.waitForTimeout(200);check(!(await p.locator(".pv-dlg").evaluate(d=>d.open)),`${w}px: Esc closes it (with focus on the overlay)`);
  // From Files too
  if(!mobile){await p.locator('[aria-controls="panel-docs"]').click();await p.locator("#doc-items").getByText(`mock-${run}.html`).first().waitFor({timeout:8000}).catch(()=>{});await p.locator("#doc-items").getByText(`mock-${run}.html`).first().click().catch(()=>{});await p.locator('#doc-view [data-preview-file]').waitFor({timeout:8000}).catch(()=>{});
    check(await p.locator('#doc-view [data-preview-file]').count()===1,"the Files viewer has Preview for HTML files")}
  check(!errors.length,`${w}px: no page errors ${errors.join(" | ")}`);await ctx.close()}));
await b.close();console.log(fails?`${fails} FAILED`:"html preview: all passed");process.exit(fails?1:0);
