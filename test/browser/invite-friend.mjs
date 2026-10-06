import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
// Invite a friend / Meet my agent (vedu #5192, docs/research/INVITE-FRIEND.md): the board's "Invite an agent" dialog
// puts a friend first (one field, one button), then your own assistant's join message, with the exact CLI command, MCP
// call, MCP URL and Claude Code line under For developers.
const BASE=process.env.BASE||"http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run=Date.now().toString(36).slice(-4), A=`inf${run}`;
await ops("users",{name:A,email:`${A}@example.com`,verified:"true"});
const board=(await ops("boards",{user:A,title:`Invite a friend ${run}`})).board.id;
const ck=(await ops("sessions",{user:A})).cookie;
let fails=0;const check=(ok,m)=>{console.log(`${ok?"✓":"✗"} ${m}`);if(!ok)fails++};
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
for (const [w,h] of [[1280,820],[390,800]]) {
  const ctx=await b.newContext({viewport:{width:w,height:h}});const [k,...v]=ck.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
  const p=await ctx.newPage();const errors=[];p.on("pageerror",e=>errors.push(e.message));
  await p.goto(`${BASE}/b/${board}`);
  await p.locator(".av-add").first().click();
  const d=p.locator("#invite-agent");await d.waitFor();
  const order=await d.locator(".ia-opt h3").allInnerTexts();
  check(order[0]==="Invite a friend"&&order[1]==="Your own assistant",`${w}px: a friend first, then your own assistant (${order.join(" · ")})`);
  check(await p.locator("#ia-friend input[name=email]").isVisible()&&await p.locator("#ia-friend button.primary").isVisible(),"one field and one button");
  check(!(await p.locator("#ia-mcp-url").isVisible()),"developer details start folded");
  await p.locator("#ia-friend input[name=email]").fill(`friend-${run}-${w}@example.com`);
  await p.locator("#ia-friend button.primary").click();
  const res=p.locator("#ia-friend [data-result]");await res.waitFor({state:"visible"});
  const said=await res.innerText();
  check(said.length>0&&!/error|not allowed/i.test(said),`inviting any email says so: "${said}"`);
  check((await p.locator("#ia-friend input[name=email]").inputValue())==="","…and clears the field");
  await p.locator("#ia-friend input[name=email]").fill(`nobody${run}`);await p.locator("#ia-friend button.primary").click();
  await p.waitForFunction(()=>/use their email/.test(document.querySelector("#ia-friend [data-result]")?.textContent||""),null,{timeout:5000}).then(()=>check(true,"a stranger's name asks for their email"),()=>check(false,"a stranger's name asks for their email"));
  check((await p.locator("#ia-join").innerText()).includes(`atteo join ${board}`),"your own assistant: the join message names the board");
  await p.locator("#invite-agent .ia-dev summary").click();
  check((await p.locator("#ia-cli").innerText())===`atteo join ${board}`,"For developers: the CLI command");
  check((await p.locator("#ia-mcp-call").innerText())===`join_board("${board}")`,"…the MCP call");
  check((await p.locator("#ia-mcp-url").innerText())===`${BASE}/mcp`,"…the MCP URL with this server's address");
  check((await p.locator("#ia-mcp-cc").innerText()).endsWith(`atteo ${BASE}/mcp`),"…and the Claude Code line");
  const ov=await p.evaluate(()=>{const e=document.getElementById("invite-agent");return e.scrollWidth>e.clientWidth+1});check(!ov,"nothing overflows sideways");
  await p.screenshot({path:`${SHOTS_DIR}/invite-friend-${w}.png`});
  check(errors.length===0,`no page errors ${errors.join(" | ")}`);
  await ctx.close();
}
await b.close();console.log(fails?`${fails} FAILED`:"all invite-friend checks passed");process.exit(fails?1:0);
