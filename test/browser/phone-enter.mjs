// Phones: Return in the composer adds a line (Post sends); on a desktop Enter still posts.
import { chromium, devices } from "playwright-core";
const BASE=process.env.BASE||"http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run=Date.now().toString(36).slice(-4), A=`pe${run}`;
await ops("users",{name:A,email:`${A}@example.com`,verified:"true"});
const board=(await ops("boards",{user:A,title:`Enter ${run}`})).board.id;const ck=(await ops("sessions",{user:A})).cookie;
let fails=0;const check=(ok,m)=>{console.log(`${ok?"✓":"✗"} ${m}`);if(!ok)fails++};
const b=await chromium.launch({executablePath: process.env.PW_CHROME || undefined});
const count=p=>p.locator('#thread>.entry:not(.pending)').count();
for(const [label,opts] of [["phone",{...devices["iPhone 13"]}],["desktop",{viewport:{width:1280,height:800}}]]){
  const ctx=await b.newContext(opts);const [k,...v]=ck.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
  const p=await ctx.newPage();await p.goto(`${BASE}/b/${board}`);await p.waitForSelector('#composer-text');const n0=await count(p);
  await p.locator('#composer-text').click();await p.keyboard.type("line one");await p.keyboard.press("Enter");await p.keyboard.type("line two");await p.waitForTimeout(600);
  if(label==="phone"){
    check((await p.inputValue('#composer-text'))==="line one\nline two"&&await count(p)===n0,"phone: Return adds a line, nothing posted");
    await p.locator('.composer button.primary, .composer [type=submit]').first().tap();await p.waitForTimeout(1200);
    check(await count(p)===n0+1,"phone: Post sends both lines as one message");
  } else check(await count(p)===n0+1,"desktop: Enter still posts");
  await ctx.close();
}
await b.close();console.log(fails?`${fails} FAILED`:"all phone-enter checks passed");process.exit(fails?1:0);
