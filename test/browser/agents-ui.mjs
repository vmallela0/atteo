// Board info → Agents: live agent sessions on the board, and the one-line join command.
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE=process.env.BASE||"http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run=Date.now().toString(36).slice(-4), A=`ag${run}`, B=`bg${run}`;
for (const u of [A,B]) await ops("users",{name:u,email:`${u}@example.com`,verified:"true"});
const tokA=(await ops("tokens",{user:A})).token, tokB=(await ops("tokens",{user:B})).token;
const board=(await ops("boards",{user:A,title:`Agents ${run}`})).board.id; await ops("members",{board,user:B});
const api=(t,m,p,b)=>fetch(BASE+p,{method:m,headers:{authorization:`Bearer ${t}`,"content-type":"application/json"},body:b?JSON.stringify(b):undefined}).then(r=>r.json());
for (const [t,c] of [[tokA,"Claude Code"],[tokA,"Codex"],[tokB,"Codex"]]){const s=(await api(t,"POST","/api/sessions",{suggest:c.split(" ")[0].toLowerCase(),client:c})).session;await api(t,"POST",`/api/sessions/${s.id}/boards`,{board});if(c==="Claude Code")await api(t,"POST",`/api/sessions/${s.id}`,{status:"reviewing the checkout PR"});}
const ck=(await ops("sessions",{user:A})).cookie;
let fails=0;const check=(ok,m)=>{console.log(`${ok?"✓":"✗"} ${m}`);if(!ok)fails++};
const b=await chromium.launch({executablePath: process.env.PW_CHROME || undefined});
for (const [w,h] of [[1280,800],[390,844]]) {
  const ctx=await b.newContext({viewport:{width:w,height:h}});const [k,...v]=ck.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
  const p=await ctx.newPage();const errors=[];p.on("pageerror",e=>errors.push(e.message));
  await p.goto(`${BASE}/b/${board}`);await p.waitForTimeout(600);
  if(w<960){await p.locator("#info-btn").click();await p.waitForTimeout(300)}
  const t=await p.locator("#agents").innerText();
  check(t.includes(`${A}/claude`)&&t.includes(`${A}/codex`)&&t.includes(`${B}/codex`),`${w}px: Agents lists every session on the board (${t.split("\n").slice(0,5).join(" | ")})`);
  check(t.includes("reviewing the checkout PR"),"…with what each one says it's doing");
  check((await p.locator("#ag-join").innerText())===`atteo join ${board}`,"…and the one line that brings another agent");
  check(await p.locator("#board-info .av-wrap.live").count()===0,"no separate live dots on Members (Agents is the one place)");
  await p.screenshot({path:`${SHOTS_DIR}/agents-${w}.png`});
  check(errors.length===0,`no page errors ${errors.join(" | ")}`);await ctx.close();
}
await b.close();console.log(fails?`${fails} FAILED`:"all agents checks passed");
