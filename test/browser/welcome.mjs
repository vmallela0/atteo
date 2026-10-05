// Everyday first run (board #1272): "Bring your assistant" at /welcome, the home banner that points to it (until
// dismissed, per person), real tiles open steps with a working Copy, coming-soon tiles do nothing, Done flips to
// "Connected ✓" when a session appears, Account's "Your assistant" card, light/dark, 1280/390/320, no page errors.
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE=process.env.BASE||"http://localhost:8787";
const ops=async(p,b)=>(await fetch(`${BASE}/api/ops/${p}`,{method:"POST",headers:{"x-admin-key":"ci-admin-key","content-type":"application/json"},body:JSON.stringify(b)})).json();
const run=Date.now().toString(36).slice(-4),N=`ev${run}`,D=`ed${run}`;
for(const u of [N,D])await ops("users",{name:u,email:`${u}@example.com`,verified:"true"});
const ckN=(await ops("sessions",{user:N})).cookie,ckD=(await ops("sessions",{user:D})).cookie;
let fails=0;const check=(ok,m)=>{console.log(`${ok?"✓":"✗"} ${m}`);if(!ok)fails++};
const b=await chromium.launch({executablePath: process.env.PW_CHROME || undefined});
const errors=[];
const open=async(ck,w,h,scheme="light",mobile=false)=>{const ctx=await b.newContext({viewport:{width:w,height:h},colorScheme:scheme,...(mobile?{isMobile:true,hasTouch:true}:{})});
  await ctx.grantPermissions(["clipboard-read","clipboard-write"],{origin:BASE});
  const [k,...v]=ck.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
  const p=await ctx.newPage();p.on("pageerror",e=>errors.push(`${w}px ${e.message}`));return {ctx,p}};
const words=/\bMCP\b|OAuth|\btoken\b|\bagents?\b/i;
const noLink=(t)=>t.replace(/https?:\/\/\S+/g,"");
const sideways=(p)=>p.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1);

// 1. A new person with no assistant: home shows the banner; it leads to /welcome.
async function newPerson(){const {ctx,p}=await open(ckN,1280,860);
  await p.goto(`${BASE}/`);await p.waitForTimeout(700);
  check(await p.locator("#ev-banner").isVisible(),"a new person with no sessions sees the 'Bring your assistant' banner on home");
  await p.screenshot({path:`${SHOTS_DIR}/welcome-home-banner-1280.png`});
  await p.locator('#ev-banner a[href="/welcome"]').click();await p.waitForURL(`${BASE}/welcome`);await p.waitForTimeout(500);
  check((await p.locator(".ev h1").innerText())==="Bring your assistant","…its button opens /welcome with the heading");
  const tiles=await p.locator("[data-ev-tile]").evaluateAll(els=>els.map(e=>e.dataset.evTile));
  check(JSON.stringify(tiles)===JSON.stringify(["grok","chatgpt","claude","muse","atteo"]),`tiles: Grok, ChatGPT, Claude, Muse, Atteo's assistant (${tiles})`);
  check(!words.test(noLink(await p.locator(".ev").innerText())),"the page's words are plain (no MCP, OAuth, token, agent)");
  {const t=p.locator('[data-ev-tile="atteo"]');
    check(/Coming soon/.test(await t.innerText())&&await t.locator("button,a").count()===0,"atteo: 'Coming soon' and no action")}
  check(await p.locator('[data-ev-tile="muse"] a[href="/connect/muse"]').count()===1,"muse: Connect goes to /connect/muse, its key page (#2291)");
  await p.screenshot({path:`${SHOTS_DIR}/welcome-1280-light.png`,fullPage:true});
  // 2. Each real tile opens its steps with a working Copy.
  for(const id of ["grok","chatgpt","claude"]){
    await p.locator(`[data-open="ev-${id}"]`).click();await p.waitForTimeout(300);
    const d=p.locator(`#ev-${id}`);
    check(await d.isVisible()&&await d.locator(".ev-steps>li").count()===3,`${id}: the sheet opens with 3 steps`);
    check(!words.test(noLink(await d.innerText())),`${id}: the steps are in plain words`);
    await p.evaluate(()=>navigator.clipboard.writeText("nothing yet"));
    await d.locator('[data-ev-copy="link"]').click();await p.waitForTimeout(250);
    const clip=await p.evaluate(()=>navigator.clipboard.readText());
    check(clip===`${BASE}/mcp`&&/Copied/.test(await d.locator('[data-ev-copy="link"]').innerText()),`${id}: Copy link puts ${clip} on the clipboard and says Copied`);
    const href=await d.locator("a.ev-open").getAttribute("href");check(/^https:\/\/(grok\.com|chatgpt\.com|claude\.ai)\//.test(href)&&await d.locator("a.ev-open").getAttribute("target")==="_blank",`${id}: opens ${href} in a new tab`);
    if(id==="grok"){await d.locator('[data-ev-copy="alt"]').click();await p.waitForTimeout(250);const m=await p.evaluate(()=>navigator.clipboard.readText());
      check(m.includes(`${BASE}/mcp`)&&/Routine/.test(m),"grok: the Grok Bot message copies too (link + mailbox Routine)")}
    if(id==="claude")await p.screenshot({path:`${SHOTS_DIR}/welcome-sheet-1280-light.png`});
    await d.locator("[data-close]").click();await p.waitForTimeout(200);
  }
  // 3. Connect: open Claude, press Done, an agent connects with the person's token → "Connected ✓".
  await p.locator('[data-open="ev-claude"]').click();await p.waitForTimeout(800);
  const d=p.locator("#ev-claude");await d.locator("[data-ev-done]").click();await p.waitForTimeout(500);
  check(/Checking/.test(await d.locator(".ev-status").innerText()),"Done starts checking for the assistant");
  const tok=(await ops("tokens",{user:N,label:"Claude"})).token;
  const s=await (await fetch(`${BASE}/api/sessions`,{method:"POST",headers:{authorization:`Bearer ${tok}`,"content-type":"application/json"},body:JSON.stringify({suggest:"claude",client:"Claude"})})).json();
  check(!!s.session?.id,"an agent session is created with the person's token");
  await p.waitForFunction(()=>/Connected ✓/.test(document.querySelector('#ev-claude .ev-status').textContent),null,{timeout:15000}).catch(()=>{});
  const st=await d.locator(".ev-status").innerText();
  check(/Connected ✓/.test(st)&&/Claude/.test(st)&&await d.locator("[data-ev-go]").isVisible()&&!(await d.locator("[data-ev-done]").isVisible()),`the sheet flips to "${st}" with Go to your chats`);
  await p.screenshot({path:`${SHOTS_DIR}/welcome-connected-1280-light.png`});
  // 4. Account shows the assistant card; /welcome shows who's connected; the banner is gone.
  await p.goto(`${BASE}/me`);await p.waitForTimeout(500);
  const card=await p.locator("#ev-acct").innerText();
  check(/Your assistant/.test(await p.locator(".content").innerText())&&/Claude/.test(card)&&/Change/.test(card)&&await p.locator("#ev-acct").getAttribute("href")==="/welcome",`Account → Your assistant: ${card.replace(/\s+/g," ")} → /welcome`);
  await p.locator("#ev-acct").screenshot({path:`${SHOTS_DIR}/welcome-account-card-1280.png`});
  await p.goto(`${BASE}/welcome`);await p.waitForTimeout(400);
  check(/Connected now: Claude/.test(await p.locator(".ev").innerText())&&/Connected/.test(await p.locator('[data-ev-tile="claude"]').innerText()),"/welcome now says Claude is connected");
  await p.evaluate(()=>{try{localStorage.clear()}catch(e){}});await p.goto(`${BASE}/`);await p.waitForTimeout(400);
  check(await p.locator("#ev-banner").count()===0,"once an assistant has connected, home has no banner (even with nothing dismissed)");
  await ctx.close()}

// 5. Dismissal sticks, per person; "for developers" opens today's Connect.
async function dismissal(){const {ctx,p}=await open(ckD,1280,860,"dark");
  await p.goto(`${BASE}/`);await p.waitForTimeout(600);
  check(await p.locator("#ev-banner").isVisible(),"another new person sees the banner");
  await p.screenshot({path:`${SHOTS_DIR}/welcome-home-banner-1280-dark.png`});
  await p.locator("#ev-banner [data-ev-dismiss]").click();await p.waitForTimeout(200);
  check(!(await p.locator("#ev-banner").isVisible()),"Not now hides it");
  await p.reload();await p.waitForTimeout(600);
  check(!(await p.locator("#ev-banner").isVisible()),"…and it stays hidden after a reload");
  const keys=await p.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith("atteo-welcome-dismissed:")));
  check(keys.length===1&&keys[0]===`atteo-welcome-dismissed:${D}`,`dismissal is stored per person (${keys})`);
  await p.goto(`${BASE}/me`);await p.waitForTimeout(400);
  check(/No assistant yet/.test(await p.locator("#ev-acct").innerText())&&await p.locator('#ev-acct a[href="/welcome"]').count()===1,"Account with no assistant offers Bring your assistant");
  await p.locator("#ev-acct").screenshot({path:`${SHOTS_DIR}/welcome-account-card-none-1280-dark.png`});
  await p.goto(`${BASE}/welcome`);await p.waitForTimeout(400);await p.screenshot({path:`${SHOTS_DIR}/welcome-1280-dark.png`,fullPage:true});
  await p.locator("[data-ev-dev]").click();await p.waitForURL(`${BASE}/#connect`);await p.waitForTimeout(600);
  check(await p.locator("#connect").evaluate(x=>x.open),"Something else? (for developers) opens today's Connect dialog");
  await ctx.close()}

// 6. Phones: 390 light/dark and 320, no sideways scroll; the sheet is a bottom sheet that fits.
async function phones(){await Promise.all([[390,844,"light"],[390,844,"dark"],[320,640,"light"]].map(async([w,h,scheme])=>{
  const {ctx,p}=await open(ckD,w,h,scheme,true);
  await p.goto(`${BASE}/welcome`);await p.waitForTimeout(600);
  check(!(await sideways(p)),`${w}px ${scheme}: /welcome has no sideways scroll`);
  const tb=await p.locator('[data-ev-tile="chatgpt"] button').boundingBox();check(tb&&tb.x+tb.width<=w,`${w}px: the Connect buttons stay on screen`);
  await p.screenshot({path:`${SHOTS_DIR}/welcome-${w}-${scheme}.png`,fullPage:true});
  await p.locator('[data-open="ev-grok"]').tap();await p.waitForTimeout(400);
  const bb=await p.locator("#ev-grok").boundingBox();
  check(bb&&bb.x>=0&&bb.x+bb.width<=w+0.5&&Math.abs(bb.y+bb.height-h)<2,`${w}px: the steps open as a bottom sheet that fits (${JSON.stringify(bb)})`);
  const ov=await p.locator("#ev-grok").evaluate(x=>x.scrollWidth>x.clientWidth+1);check(!ov,`${w}px: nothing in the sheet overflows sideways`);
  await p.locator('#ev-grok [data-ev-copy="link"]').tap();await p.waitForTimeout(250);
  check((await p.evaluate(()=>navigator.clipboard.readText()))===`${BASE}/mcp`,`${w}px: Copy works by tap`);
  await p.screenshot({path:`${SHOTS_DIR}/welcome-sheet-${w}-${scheme}.png`});
  if(w===390){await p.goto(`${BASE}/me`);await p.waitForTimeout(400);check(!(await sideways(p)),`${w}px ${scheme}: Account has no sideways scroll`);await p.locator("#ev-acct").screenshot({path:`${SHOTS_DIR}/welcome-account-card-${w}-${scheme}.png`})}
  await ctx.close()}))}
// Home banner on a phone (a third new person, nothing dismissed)
async function banner(){const P=`eh${run}`;await ops("users",{name:P,email:`${P}@example.com`,verified:"true"});const ck=(await ops("sessions",{user:P})).cookie;
  for(const [w,h] of [[390,844],[320,640]]){const {ctx,p}=await open(ck,w,h,"light",true);await p.goto(`${BASE}/`);await p.waitForTimeout(600);
    check(await p.locator("#ev-banner").isVisible()&&!(await sideways(p)),`${w}px: the home banner shows without sideways scroll`);
    await p.locator("#ev-banner").screenshot({path:`${SHOTS_DIR}/welcome-home-banner-${w}.png`});await ctx.close()}}

// The new person (1–4) and the phone banner (another new person) run side by side with the second person's dismissal,
// then that person's phones (the three sizes together: they all copy the same link, the clipboard being the browser's).
await Promise.all([newPerson(),banner(),dismissal()]);
await phones();
check(!errors.length,`no page errors ${errors.join(" | ")}`);
await b.close();console.log(fails?`${fails} FAILED`:"welcome: all passed");process.exit(fails?1:0);
