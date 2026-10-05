import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE=process.env.BASE||"http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run=Date.now().toString(36).slice(-4), A=`con${run}`;
await ops("users",{name:A,email:`${A}@example.com`,verified:"true"});
const board=(await ops("boards",{user:A,title:`Connect ${run}`})).board.id;
const ck=(await ops("sessions",{user:A})).cookie;
let fails=0;const check=(ok,m)=>{console.log(`${ok?"✓":"✗"} ${m}`);if(!ok)fails++};
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
for (const [w,h] of [[1280,820],[390,800]]) {
  const ctx=await b.newContext({viewport:{width:w,height:h}});const [k,...v]=ck.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
  const p=await ctx.newPage();const errors=[];p.on("pageerror",e=>errors.push(e.message));
  await p.goto(`${BASE}/b/${board}`);await p.waitForTimeout(500);
  await p.locator('[data-open="connect"]').first().click();await p.waitForTimeout(300);
  check(await p.locator("[data-ctab]").count()===4&&(await p.locator('[data-ctab][aria-selected="true"]').innerText())==="One click",`${w}px: four tabs, opening on One click`);
  // jxn #4124/#4151: the tiles A–Z with Any other agent last, each with its logo drawn (a mask, in the text colour).
  const tiles=await p.locator("#connect .cn-tile").evaluateAll(ts=>ts.map(t=>{const l=t.querySelector(".cn-logo"),cs=l&&getComputedStyle(l);return[t.querySelector("b").textContent,!!cs&&cs.maskImage.startsWith("url(")&&l.offsetWidth===20]}));
  const names=tiles.map(t=>t[0]),az=names.slice(0,-1).toSorted((a,c)=>a.localeCompare(c,"en",{sensitivity:"base"}));
  check(names.length===12&&names.at(-1)==="Any other agent"&&names.slice(0,-1).join()===az.join()&&tiles.every(t=>t[1]),`One click: A–Z, Any other agent last, a logo on each (${names.join(", ")})`);
  await p.locator('[data-ctab="cli"]').click();
  check(await p.locator("#cli-install").isVisible()&&(await p.locator("#cli-install").innerText()).includes("install.sh"),"CLI: one line installs and signs in");
  check((await p.locator("#cli-join").innerText())===`atteo join ${board}`,"…then any agent joins this board with one command");
  await p.locator('[data-ctab="url"]').click();
  check((await p.locator("#mcp-oauth").innerText())===`${BASE}/mcp`,"the MCP URL tab has the URL to paste");
  const cc=await p.locator("#mcp-oauth-cc").innerText();if(!cc.includes(`--transport http --scope user atteo ${BASE}/mcp`))console.log("CC:",cc);check(cc.includes(`--transport http --scope user atteo ${BASE}/mcp`),"…with the Claude Code one-liner");
  const ov=await p.evaluate(()=>{const d=document.getElementById('connect');return d.scrollWidth>d.clientWidth+1});check(!ov,"nothing overflows sideways");
  await p.screenshot({path:`${SHOTS_DIR}/connect-${w}.png`});
  await p.locator('[data-ctab="token"]').click();await p.locator("#connect-form .btn").click();await p.waitForTimeout(700);
  check((await p.locator("#mcp-header").innerText()).startsWith("Authorization: Bearer "),"Token & API generates a token with URL and header");
  check((await p.locator("#http-reply").textContent()).includes(`${BASE}/api/boards/`),"the curl example uses this server");
  if(w>800)await p.screenshot({path:`${SHOTS_DIR}/connect-token.png`});
  check(errors.length===0,`no page errors ${errors.join(" | ")}`);
}
// ChatGPT's tile (vedu #4065): a desktop opens the web's Connectors page in a new tab; an iPhone opens the app's
// settings in the same tab (a universal link the OS hands to the installed app; without it, the web). chatgpt.com is
// stubbed: nothing leaves the machine.
for (const phone of [false, true]) {
  const ctx=await b.newContext({viewport:phone?{width:390,height:800}:{width:1280,height:820},...(phone?{isMobile:true,hasTouch:true,userAgent:"Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1"}:{})});
  await ctx.route("https://chatgpt.com/**",r=>r.fulfill({contentType:"text/html",body:"<p>chatgpt stub</p>"}));
  await ctx.grantPermissions(["clipboard-read","clipboard-write"],{origin:BASE});
  const [k,...v]=ck.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
  const p=await ctx.newPage();await p.goto(`${BASE}/b/${board}`);await p.waitForTimeout(500);
  await p.locator('[data-open="connect"]').first().click();await p.waitForTimeout(300);
  const tile=p.locator('[data-cn-open^="https://chatgpt.com"]');
  if(phone){await tile.click();await p.waitForURL(/chatgpt\.com/,{timeout:5000}).catch(()=>{});
    check(p.url()==="https://chatgpt.com/#settings",`iPhone: the ChatGPT tile opens the app's settings in the same tab (${p.url()})`)}
  else{const [pop]=await Promise.all([ctx.waitForEvent("page",{timeout:5000}).catch(()=>null),tile.click()]);
    check(pop?.url()==="https://chatgpt.com/#settings/Connectors"&&p.url().startsWith(BASE),`desktop: the ChatGPT tile opens the web's Connectors page in a new tab (${pop?.url()})`)}
  await ctx.close();
}
// jxn #4151: the Boards page's Add your agent is one button that opens this dialog, not a second grid.
{const ctx=await b.newContext({viewport:{width:1280,height:820}});const [k,...v]=ck.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
  const p=await ctx.newPage();await p.goto(`${BASE}/`);await p.locator(".add-agent").click();
  check(await p.locator("#connect[open]").isVisible().catch(()=>false)&&await p.locator(".cn-grid").count()===1,"Boards: Add your agent opens the Connect dialog, the only tile grid on the page");
  await ctx.close()}
await b.close();console.log(fails?`${fails} FAILED`:"all connect checks passed");
