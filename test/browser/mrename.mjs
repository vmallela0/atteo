// A renamed agent session shows under its new name in the @ menu without reloading the page (jxn #986).
import { chromium } from "playwright-core";
const BASE=process.env.BASE||"http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run=Date.now().toString(36).slice(-4), A=`mr${run}`, B=`ms${run}`;
for(const u of [A,B])await ops("users",{name:u,email:`${u}@example.com`,verified:"true"});
const tokB=(await ops("tokens",{user:B})).token;const board=(await ops("boards",{user:A,title:`Rename ${run}`})).board.id;await ops("members",{board,user:B});
const api=(m,p,b)=>fetch(BASE+p,{method:m,headers:{authorization:`Bearer ${tokB}`,"content-type":"application/json"},body:b?JSON.stringify(b):undefined}).then(r=>r.json());
const s=(await api("POST","/api/sessions",{suggest:"builder",client:"Claude Code"})).session;await api("POST",`/api/sessions/${s.id}/boards`,{board});
const ck=(await ops("sessions",{user:A})).cookie;
let fails=0;const check=(ok,m)=>{console.log(`${ok?"✓":"✗"} ${m}`);if(!ok)fails++};
const b=await chromium.launch({executablePath: process.env.PW_CHROME || undefined});
const ctx=await b.newContext({viewport:{width:1280,height:800}});const [k,...v]=ck.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
const p=await ctx.newPage();const errors=[];p.on("pageerror",e=>errors.push(e.message));await p.goto(`${BASE}/b/${board}`);await p.waitForSelector('#composer-text');
// Types "@B/" and reads the menu once it lists `expect` (or after 5 s, and the check says what it showed).
const opts=async(expect)=>{await p.fill('#composer-text','');await p.click('#composer-text');await p.keyboard.type(`@${B}/`);
  await p.locator('#mention-menu [role=option]',{hasText:expect}).first().waitFor({timeout:5000}).catch(()=>{});await p.waitForTimeout(100);return p.locator('#mention-menu [role=option]').allInnerTexts()};
let o=await opts(`${B}/${s.name}`);check(o.some(x=>x.includes(`${B}/${s.name}`)),`before: the session is in the @ menu as ${s.name}: ${JSON.stringify(o)}`);
await api("POST",`/api/sessions/${s.id}`,{name:`coord${run}`});
// The menu refreshes its list when it's older than 10 s: move the page's clock on 11 s instead of waiting for it.
await p.evaluate(()=>{const now=Date.now.bind(Date);Date.now=()=>now()+11000});
o=await opts(`${B}/coord${run}`);check(o.some(x=>x.includes(`${B}/coord${run}`))&&!o.some(x=>x.includes(`${B}/${s.name}`)),`after a rename, the menu shows the new name without a reload: ${JSON.stringify(o)}`);
check(!errors.length,`no page errors ${errors.join(" | ")}`);
await b.close();console.log(fails?`${fails} FAILED`:"all mention-rename checks passed");process.exit(fails?1:0);
