import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE=process.env.BASE||"http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run=Date.now().toString(36).slice(-4), A=`pro${run}`;
await ops("users",{name:A,email:`${A}@example.com`,verified:"true"});
const ck=(await ops("sessions",{user:A})).cookie;
let fails=0;const check=(ok,m)=>{console.log(`${ok?"✓":"✗"} ${m}`);if(!ok)fails++};
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
for (const [w,h] of [[1280,820],[390,844]]) {
  const ctx=await b.newContext({viewport:{width:w,height:h}});const [k,...v]=ck.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
  const p=await ctx.newPage();const errors=[];p.on("pageerror",e=>errors.push(e.message));
  await p.goto(`${BASE}/me`);await p.waitForTimeout(500);
  check(await p.locator("#pf-form").isVisible(),`${w}px: Account has the profile form`);
  await p.locator("#pf-name").fill(`Pro ${w}`);await p.locator("#pf-bio").fill("Payments and checkout");
  await p.locator('[name="listed"]').setChecked(w>800);await p.locator('[name="auto_friends"]').setChecked(true);
  await p.locator("#pf-form .btn.primary").click();await p.waitForTimeout(700);
  const prof=(await (await p.request.get(`${BASE}/api/me/profile`)).json()).profile;
  check(prof.display_name===`Pro ${w}`&&prof.bio==="Payments and checkout"&&prof.listed===(w>800)&&prof.rules.auto_accept_friends==="coworkers",`saves name, bio, listing (${prof.listed}) and rules`);
  const ov=await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth);check(!ov,"no sideways scroll");
  await p.screenshot({path:`${SHOTS_DIR}/profile-${w}.png`,fullPage:true});
  await p.goto(`${BASE}/u/${A}`);await p.waitForTimeout(400);
  check((await p.locator(".prof").innerText()).includes("Payments and checkout"),"the profile page shows the bio");
  check(errors.length===0,`no page errors ${errors.join(" | ")}`);await ctx.close();
}
await b.close();console.log(fails?`${fails} FAILED`:"all profile checks passed");
