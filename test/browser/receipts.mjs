// Browser check: agents' 👀/✅ on a person's message read as one quiet receipt line; everything else stays chips.
// It waits for each state instead of sleeping (opus-a #2824): reads are instant (no locator waits, which used to sit out
// 30s each on an expected-empty receipt) and `until` polls for what the step should produce.
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE=process.env.BASE||"http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run=Date.now().toString(36).slice(-4), P=`pat${run}`, V=`val${run}`, Q=`quin${run}`;
for (const u of [P,V,Q]) await ops("users",{name:u,email:`${u}@example.com`,verified:"true"});
const tokV=(await ops("tokens",{user:V})).token;
const board=(await ops("boards",{user:P,title:"Receipts"})).board.id; await ops("members",{board,user:V});await ops("members",{board,user:Q});
const cookie=(await ops("sessions",{user:P})).cookie,cookieQ=(await ops("sessions",{user:Q})).cookie; // P writes; Q, another person, watches (on your own messages the ring replaces 👀)
const api=(m,p,b,h={})=>fetch(BASE+p,{method:m,headers:{"content-type":"application/json",...h},body:b?JSON.stringify(b):undefined}).then(r=>r.json());
const sess=(await api("POST","/api/sessions",{suggest:"builder",client:"Claude Code"},{authorization:`Bearer ${tokV}`})).session;
await api("POST",`/api/sessions/${sess.id}/boards`,{board},{authorization:`Bearer ${tokV}`});
const mcp=async(name,args,h={})=>(await (await fetch(`${BASE}/mcp?board=${board}`,{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream",authorization:`Bearer ${tokV}`,...h},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})})).json()).result.content[0].text;
const r1=await fetch(`${BASE}/api/boards/${board}/entries`,{method:"POST",headers:{"content-type":"application/json",cookie},body:JSON.stringify({text:`@${V}'s agent can you check the deploy?`})}).then(r=>r.json());
const ask=r1.entry?.seq ?? r1.seq;
await mcp("read",{}); // V's agent picks it up: 👀 automatically
const agentSeq=Number((await mcp("post",{type:"note",title:"Deploy done",text:"Deployed 1e60fbf",reply_to:0})).match(/#(\d+)/)[1]);
await mcp("react",{seq:agentSeq,emoji:"✅"});
let fails=0;const check=(ok,m)=>{console.log(`${ok?"✓":"✗"} ${m}`);if(!ok)fails++};
/** Polls get() until ok(value) (or ms pass) and returns the last value: a step waits for its result, not a fixed time. */
const until=async(get,ok,ms=8000)=>{const t=Date.now();let v;for(;;){v=await get();if(ok(v)||Date.now()-t>ms)return v;await new Promise(r=>setTimeout(r,40))}};
const J=(x)=>JSON.stringify(x);
const b=await chromium.launch({executablePath: process.env.PW_CHROME || undefined});
const errors=[];
async function open(scheme,ck=cookieQ){const ctx=await b.newContext({viewport:{width:1280,height:800},colorScheme:scheme});const [k,...v]=ck.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
  const p=await ctx.newPage();p.on("pageerror",e=>errors.push(e.message));await p.goto(`${BASE}/b/${board}`);await p.waitForFunction(()=>!!window.BOARD_CTX&&document.querySelector('#thread .entry'));return p}
const p=await open("light");
const text=(pg,sel)=>pg.evaluate(s=>document.querySelector(s)?.innerText??"",sel); // instant: "" when it isn't there
const parts=(pg,s)=>pg.evaluate(s=>[...document.querySelectorAll(`[data-rx="${s}"] .rx-rcpt > span[title]`)].map(x=>x.innerText),s);
const rcpt=()=>text(p,`[data-rx="${ask}"] .rx-rcpt`);
const chips=(s)=>p.evaluate(s=>[...document.querySelectorAll('[data-rx="'+s+'"] .rx-chip')].map(c=>c.textContent+'|'+c.title),s);
{const v=await until(rcpt,v=>v===`🤔 ${V}'s agent is on it`);check(v===`🤔 ${V}'s agent is on it`,`the agent's 🤔 is a receipt: "${v}"`);}
check((await chips(ask)).length===0,`…and not a chip: ${await chips(ask)}`);
check(JSON.stringify(await chips(agentSeq))===JSON.stringify([`✅1|${V}'s agent`]),`an agent's ✅ on an agent's post stays a chip: ${await chips(agentSeq)}`);
// A named session reacts 👀 itself; then the agent answers: ✅ arrives live and replaces its 👀.
await mcp("react",{seq:ask,emoji:"👀"},{"x-agent-soup-session":sess.id});
{const v=await until(rcpt,v=>v==="");check(v==="",`a session toggling 👀 takes its agent's automatic receipt back (a8de249): "${v}"`);}
await mcp("react",{seq:ask,emoji:"👀"},{"x-agent-soup-session":sess.id});
{const v=await until(rcpt,v=>v===`👀 read by ${V}/builder`);check(v===`👀 read by ${V}/builder`,`…and again adds the session's own, live: "${v}"`);}
await mcp("post",{type:"note",text:"Checked: it's healthy.",reply_to:ask});
{const want=J([`✅ done by ${V}'s agent`]),v=J(await until(()=>parts(p,ask),v=>J(v)===want));check(v===want,`answering turns the session's own 👀 into ✅ too (0473773): ${v}`);}
// A fresh question: the automatic 👀 turns into ✅ when the agent answers, live
const rq=await fetch(`${BASE}/api/boards/${board}/entries`,{method:"POST",headers:{"content-type":"application/json",cookie},body:JSON.stringify({text:`@${V}'s agent and the logs?`})}).then(r=>r.json());
const askF=rq.entry?.seq??rq.seq;await mcp("read",{});await until(()=>text(p,`[data-rx="${askF}"] .rx-rcpt`),v=>v!=="");
await mcp("post",{type:"note",text:"Logs are clean.",reply_to:askF});
{const want=J([`✅ done by ${V}'s agent`]),v=J(await until(()=>parts(p,askF),v=>J(v)===want));check(v===want,`answering turns its 👀 into ✅ done, live: ${v}`);}
// People's 👀 and other emoji stay chips, next to the receipt line.
const entry=p.locator(`#e${ask}`);await entry.hover();await entry.locator(`.acts [data-qr="${ask}"][data-emo="👍"]`).click();await until(()=>chips(ask),v=>v.some(c=>c.startsWith("👍")));
await mcp("react",{seq:ask,emoji:":tada:"});
{const want=J([`👍1|you`,`🎉1|${V}'s agent`]),v=await until(()=>chips(ask),v=>J(v)===want);check(J(v)===want,`your own 👍 and an agent's 🎉 are chips: ${v}`);}
const parts2=await parts(p,ask);
check(parts2.length===1,`the receipt line stays: ${JSON.stringify(parts2)}`);
const g=await p.evaluate(s=>{const row=document.querySelector('[data-rx="'+s+'"]'),r=row.querySelector('.rx-rcpt').getBoundingClientRect(),c=row.querySelector('.rx-chip').getBoundingClientRect();return {below:r.top>=c.bottom-1,h:r.height,color:getComputedStyle(row.querySelector('.rx-rcpt')).color}},ask);
check(g.below&&g.h<=20,`the receipt sits on its own short line under the chips (${JSON.stringify(g)})`);
let box=await entry.boundingBox();await p.mouse.move(0,0);await p.waitForTimeout(150); // the hover actions fade out before the picture
await p.screenshot({path:`${SHOTS_DIR}/receipts-light.png`,clip:{x:box.x,y:box.y-10,width:box.width,height:box.height+20}});
const d=await open("dark");const de=d.locator(`#e${ask}`);box=await de.boundingBox();
await d.screenshot({path:`${SHOTS_DIR}/receipts-dark.png`,clip:{x:box.x,y:box.y-10,width:box.width,height:box.height+20}});
await d.waitForFunction(s=>!!document.querySelector('[data-rx="'+s+'"] .rx-rcpt'),ask,{timeout:8000}).catch(()=>{}); // the receipts come with the page's first update
const dc=await d.evaluate(s=>{const r=document.querySelector('[data-rx="'+s+'"] .rx-rcpt');return r?getComputedStyle(r).color:null},ask);
check(dc!==g.color,`dark mode uses the dark muted token (${g.color} → ${dc})`);
// Only receipts: a fresh person message with just the agent's 👀 shows the line and no ☺+ in the row.
const r2=await fetch(`${BASE}/api/boards/${board}/entries`,{method:"POST",headers:{"content-type":"application/json",cookie},body:JSON.stringify({text:`@${V}'s agent and the logs?`})}).then(r=>r.json());const ask2=r2.entry?.seq ?? r2.seq;
await mcp("read",{});
const t2=(await until(()=>text(p,`[data-rx="${ask2}"] .rx-rcpt`),v=>v===`🤔 ${V}'s agent is on it`))||"(none)",add2=await p.locator(`[data-rx="${ask2}"] .rx-add`).isVisible();
check(t2===`🤔 ${V}'s agent is on it`&&!add2,`a new message's receipt arrives live, with no ☺+ shown in the row ("${t2}", ☺+ ${add2?"shown":"hidden"}, #${ask2})`);
{await p.mouse.move(0,0);const bx=await p.locator(`#e${ask2}`).boundingBox();await p.screenshot({path:`${SHOTS_DIR}/receipts-only.png`,clip:{x:bx.x,y:bx.y-6,width:bx.width,height:bx.height+12}})}
// The author's own view: no 👀 "read by" and no second line; the ring is the one read status. ✅ "done by" stays.
const pa=await open("light",cookie);
const t3=await until(()=>text(pa,`[data-rx="${ask2}"] .rx-rcpt`),v=>v!==""),lines3=await pa.locator(`#e${ask2} .rcpt-line`).count(),ring3=await until(()=>pa.evaluate(s=>document.querySelector(`#e${s}>.rd`)?.getAttribute("aria-label")??null,ask2),v=>/^Seen by/.test(v||""));
check(t3===`🤔 ${V}'s agent is on it`&&lines3===0&&/^Seen by/.test(ring3||""),`on your own message: the ring for reads, 🤔 for "on it", no 👀 ("${t3}", ${lines3} lines, ring "${ring3}")`);
const parts4=await parts(pa,askF);
check(JSON.stringify(parts4)===JSON.stringify([`✅ done by ${V}'s agent`]),`…and ✅ done still shows there: ${JSON.stringify(parts4)}`);
// 🤔: an agent working on your message says so once; its "on it" pill, when it takes the message, replaces the 🤔 line.
const r5=await fetch(`${BASE}/api/boards/${board}/entries`,{method:"POST",headers:{"content-type":"application/json",cookie},body:JSON.stringify({text:`@${V}'s agent one more thing?`})}).then(r=>r.json());const ask5=r5.entry?.seq??r5.seq;
await mcp("read",{}); // the server adds its 🤔 when the agent picks it up
const t5=await until(()=>text(pa,`[data-rx="${ask5}"] .rx-rcpt .think`),v=>v===`🤔 ${V}'s agent is on it`);
check(t5===`🤔 ${V}'s agent is on it`,`🤔 reads as "on it" under your message: "${t5}"`);
const t5r=await pa.locator(`[data-rx="${ask5}"] .rx-rcpt .read`).count();
check(t5r===0,"…without a 👀 \"read by\" next to it");
await mcp("handle",{seq:ask5,action:"take"});
const pill=await until(()=>text(pa,`#e${ask5}>.grow>.meta>.hdl`),v=>/on it/.test(v)),thinkVis=await pa.locator(`[data-rx="${ask5}"] .rx-rcpt .think`).isVisible().catch(()=>false);
check(/on it/.test(pill)&&!thinkVis,`with the "on it" pill ("${pill.trim()}"), the 🤔 line hides: one marker`);
await mcp("post",{type:"note",text:"Done.",reply_to:ask5});await mcp("handle",{seq:ask5,action:"done"}).catch(()=>{});
const pill2=await until(()=>text(pa,`#e${ask5}>.grow>.meta>.hdl`),v=>/done/.test(v)),doneVis=await pa.locator(`[data-rx="${ask5}"] .rx-rcpt .done`).isVisible().catch(()=>false);
check(!/done/.test(pill2)||!doneVis,`a "done" pill and a ✅ line never both show ("${pill2.trim()}", ✅ line ${doneVis?"shown":"hidden"})`);
check(errors.length===0,`no page errors ${errors.join(" | ")}`);
await b.close();console.log(fails?`${fails} FAILED`:"all receipt checks passed");
