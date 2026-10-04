// Browser check for #1023 (vedu #1022): select words in a message → Quote → a quote block in the composer → post →
// (quote.next: scrolls to a message before selecting in it (dom-cap placeholders); the test scrolls to the message until it settles, since rail-cap's content-visibility makes off-screen
// heights guesses that a single scrollIntoView aims at)
// a compact box with who said it, the words and "↗ original", which jumps back to the source. Desktop and phone.
// Agents read the same post as plain "> " lines ending "— who, #N".
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE=process.env.BASE||"http://localhost:8787";
const ops=async(p,b)=>(await fetch(`${BASE}/api/ops/${p}`,{method:"POST",headers:{"x-admin-key":"ci-admin-key","content-type":"application/json"},body:JSON.stringify(b)})).json();
const run=Date.now().toString(36).slice(-4),A=`vq${run}`,B=`jq${run}`;
for(const u of [A,B])await ops("users",{name:u,email:`${u}@example.com`,verified:"true"});
const tokA=(await ops("tokens",{user:A})).token;
const board=(await ops("boards",{user:B,title:`Quotes ${run}`})).board.id;await ops("members",{board,user:A});
const ckB=(await ops("sessions",{user:B})).cookie;
const mcp=async(name,args)=>(await (await fetch(`${BASE}/mcp?board=${board}`,{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream",authorization:`Bearer ${tokA}`},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})})).json()).result.content[0].text;
const api=(p,b)=>fetch(BASE+p,{method:"POST",headers:{"content-type":"application/json",cookie:ckB},body:JSON.stringify(b)}).then(r=>r.json());
await mcp("read",{});
const src=Number((await mcp("post",{type:"note",text:`Heads up @${B}'s agent: staging uses port 8443, per the load balancer config. The old notes saying 8080 are stale.`})).match(/#(\d+)/)[1]);
const other=Number((await mcp("post",{type:"note",text:"Second message, for a selection across two."})).match(/#(\d+)/)[1]);
for(let i=0;i<30;i++)await api(`/api/boards/${board}/entries`,{text:`filler ${i}: something else entirely`}); // pushes the source out of view
const WORDS=`Heads up @${B}'s agent: staging uses port 8443, per the load balancer config`; // with a mention, which mustn't ping again
let fails=0;const check=(ok,m)=>{console.log(`${ok?"✓":"✗"} ${m}`);if(!ok)fails++};
// Selects `words` inside message `seq`'s body (across a mention chip too): a real mouse drag on desktop, the selection
// API on a phone (as a long-press does).
const RANGE=`window.qRange=(s,w)=>{const body=document.querySelector('#e'+s+'>.grow>.body'),ns=[],tw=document.createTreeWalker(body,NodeFilter.SHOW_TEXT);let n,all='';
  while((n=tw.nextNode())){ns.push([n,all.length]);all+=n.data}const i=all.indexOf(w);if(i<0)return null;
  const at=o=>{for(let k=ns.length-1;k>=0;k--)if(ns[k][1]<=o)return [ns[k][0],o-ns[k][1]]};const g=document.createRange();g.setStart(...at(i));g.setEnd(...at(i+w.length));return g}`;
const select=async(p,seq,words,mouse)=>{await p.evaluate(async s=>{for(let i=0;i<4;i++){(document.getElementById('e'+s)||document.getElementById('g'+s)).scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))}},seq);await p.waitForTimeout(150);
  const r=await p.evaluate(([s,w])=>{const g=qRange(s,w);if(!g)return null;const rs=[...g.getClientRects()].filter(x=>x.width),a=rs[0],z=rs[rs.length-1];return {x0:a.left,y0:a.top+a.height/2,x1:z.right,y1:z.top+z.height/2}},[seq,words]);
  if(!r)throw new Error(`"${words}" not in #${seq}`);
  if(mouse){await p.mouse.move(r.x0+0.5,r.y0);await p.mouse.down();await p.mouse.move((r.x0+r.x1)/2,r.y1,{steps:4});await p.mouse.move(r.x1-0.5,r.y1,{steps:4});await p.mouse.up()}
  else await p.evaluate(([s,w])=>{getSelection().removeAllRanges();getSelection().addRange(qRange(s,w))},[seq,words]);
  await p.waitForTimeout(300)};
const inView=(p,sel)=>p.evaluate(s=>{const el=document.querySelector(s);if(!el)return false;const sc=document.getElementById('thread-scroll').getBoundingClientRect(),r=el.getBoundingClientRect();return r.top>=sc.top-1&&r.bottom<=sc.bottom+1},sel);
const b=await chromium.launch({executablePath: process.env.PW_CHROME || undefined});
for(const [label,w,h,phone] of [["desktop",1280,800,false],["phone",390,844,true]]){
  const ctx=await b.newContext({viewport:{width:w,height:h},...(phone?{hasTouch:true,isMobile:true}:{})});const [k,...v]=ckB.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
  const p=await ctx.newPage();await p.addInitScript(RANGE);const errors=[];p.on("pageerror",e=>errors.push(e.message));
  await p.goto(`${BASE}/b/${board}`);await p.waitForTimeout(800);
  check(await p.locator("#quote-btn").isHidden(),`${label}: no Quote button without a selection`);
  // A selection across two messages isn't a quote of one.
  await p.evaluate(async a=>{for(let i=0;i<4;i++){(document.getElementById('e'+a)||document.getElementById('g'+a)).scrollIntoView({block:'center'});await new Promise(r=>setTimeout(r,120))}},src); // dom-cap: far messages are placeholders until near
  await p.evaluate(([a,z])=>{const g=document.createRange();g.setStart(document.querySelector('#e'+a+'>.grow>.body'),0);g.setEnd(document.querySelector('#e'+z+'>.grow>.body'),1);getSelection().removeAllRanges();getSelection().addRange(g)},[src,other]);
  await p.waitForTimeout(300);check(await p.locator("#quote-btn").isHidden(),`${label}: a selection across two messages shows no Quote`);
  await p.evaluate(()=>getSelection().removeAllRanges());
  await select(p,src,WORDS,!phone);
  {const got=await p.evaluate(()=>getSelection().toString().trim());check(got===WORDS,`${label}: the words are selected (${JSON.stringify(got)})`)}
  const qb=p.locator("#quote-btn");check(await qb.isVisible(),`${label}: selecting text in a message shows Quote`);
  const bb=await qb.boundingBox(),selBox=await p.evaluate(()=>{const r=getSelection().getRangeAt(0).getBoundingClientRect();return {top:r.top,bottom:r.bottom}});
  check(bb&&bb.x>=0&&bb.x+bb.width<=w&&bb.y>=0&&bb.y+bb.height<=h,`${label}: Quote is on screen (${JSON.stringify(bb&&{x:Math.round(bb.x),y:Math.round(bb.y)})})`);
  check(phone?bb.y>=selBox.bottom:bb.y+bb.height<=selBox.top,`${label}: Quote sits ${phone?"below the selection (the phone's own menu goes above)":"just above the selection"}`);
  await p.screenshot({path:`${SHOTS_DIR}/quote-select-${label}.png`});
  if(phone)await qb.tap();else await qb.click();await p.waitForTimeout(250);
  const want=`> ${WORDS}\n> — ${A}'s agent, #${src}\n\n`;
  const val=await p.locator("#composer-text").inputValue();
  check(val===want,`${label}: Quote puts a quote block in the composer (${JSON.stringify(val)})`);
  check(await qb.isHidden()&&(await p.evaluate(()=>getSelection().isCollapsed)),`${label}: the selection and the button go away`);
  check(await p.evaluate(()=>document.activeElement?.id==="composer-text"&&document.activeElement.selectionStart===document.activeElement.value.length),`${label}: the caret waits below the quote`);
  check(await p.locator("#replying").isHidden(),`${label}: a quote isn't a reply (no second reply box)`);
  await p.locator("#composer-text").pressSequentially(`agreed, switching ${label}`);
  if(phone)await p.locator("form.composer .bar .btn.primary").tap();else await p.keyboard.press("Enter");
  await p.waitForTimeout(900);
  const last=p.locator("#thread>.entry").last(),seq=+(await last.getAttribute("data-seq"));
  const box=last.locator("blockquote.qt");
  check(await box.count()===1,`${label}: the post shows the quote as a box`);
  check((await box.locator(".qt-who").innerText())===`${A}'s agent`&&(await box.locator(".qt-t").innerText())===WORDS,`${label}: …with who said it and the quoted words`);
  check((await box.locator(".qt-go").innerText()).trim()==="↗ original",`${label}: …and ↗ original`);
  check((await last.locator(".body").innerText()).includes(`agreed, switching ${label}`),`${label}: your comment follows the box`);
  const qbb=await box.boundingBox();check(qbb.x>=0&&qbb.x+qbb.width<=w,`${label}: the box fits the screen (${Math.round(qbb.x)}..${Math.round(qbb.x+qbb.width)} of ${w})`);
  check(await last.locator(".mention").count()===0,`${label}: the quoted @name doesn't ping anyone again`);
  await box.screenshot({path:`${SHOTS_DIR}/quote-box-${label}.png`});
  check(!(await inView(p,`#e${src}`)),`${label}: the source is out of view before the jump`);
  if(phone)await box.locator(".qt-go").tap();else await box.locator(".qt-go").click();await p.waitForTimeout(900);
  check(await inView(p,`#e${src}`)&&await p.locator(`#e${src}`).evaluate(e=>e.classList.contains("hit")),`${label}: ↗ original jumps to the source and flashes it`);
  await p.screenshot({path:`${SHOTS_DIR}/quote-jump-${label}.png`});
  // Agents read the post as plain text: the quote lines and the source #.
  await mcp("read",{});const got=await mcp("get",{seq});
  check(got.includes(`> ${WORDS}`)&&got.includes(`> — ${A}'s agent, #${src}`),`${label}: an agent reads "> …" and "— who, #${src}"`);
  // A reload renders the same box (server-side).
  await p.reload();await p.waitForTimeout(700);
  check(await p.locator(`#e${seq} blockquote.qt .qt-go[href="#e${src}"]`).count()===1,`${label}: the box renders the same after a reload`);
  check(errors.length===0,`${label}: no page errors ${errors.join(" | ")}`);await ctx.close();
}
// Ref chip in a selection quotes #N, not the visible title (board #1820, #1443).
{const run2=Date.now().toString(36).slice(-4),C=`qc${run2}`;
for(const u of [C])await ops("users",{name:u,email:`${u}@example.com`,verified:"true"});
const tokC=(await ops("tokens",{user:C})).token;
const board2=(await ops("boards",{user:C,title:`Quote ref ${run2}`})).board.id;
const ckC=(await ops("sessions",{user:C})).cookie;
const mcp2=async(name,args)=>(await (await fetch(`${BASE}/mcp?board=${board2}`,{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream",authorization:`Bearer ${tokC}`},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})})).json()).result.content[0].text;
await mcp2("read",{});const tgt=+(await mcp2("post",{type:"decision",title:"Ship on Friday",text:"We ship on Friday."})).match(/#(\d+)/)[1];
const refSeq=+(await mcp2("post",{type:"note",text:`Following up on #${tgt}: all set.`})).match(/#(\d+)/)[1];
const chipTitle="↗ Ship on Friday";
const ctx=await b.newContext({viewport:{width:1280,height:800}});const [k,...v]=ckC.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
const p=await ctx.newPage();const errors=[];p.on("pageerror",e=>errors.push(e.message));
await p.goto(`${BASE}/b/${board2}`);await p.waitForTimeout(800);
check((await p.evaluate(()=>[...document.querySelectorAll('#thread .body a.ref')].map(a=>a.textContent)))[0]===chipTitle,`ref chip shows the title (${chipTitle})`);
await p.evaluate(s=>{const body=document.querySelector('#e'+s+'>.grow>.body'),r=document.createRange();r.selectNodeContents(body);getSelection().removeAllRanges();getSelection().addRange(r)},refSeq);
await p.waitForTimeout(300);
const qb=p.locator("#quote-btn");check(await qb.isVisible(),"selecting a message with a ref chip shows Quote");
await qb.click();await p.waitForTimeout(250);
await p.locator("#composer-text").pressSequentially("noted");await p.keyboard.press("Enter");await p.waitForTimeout(900);
const posted=+(await p.locator("#thread>.entry").last().getAttribute("data-seq"));
const got=await mcp2("get",{seq:posted});
check(got.includes(`#${tgt}`)&&!got.includes(chipTitle),`posted quote has #${tgt}, not the chip title (${JSON.stringify(got.slice(0,120))})`);
check(got.includes(`> Following up on #${tgt}: all set.`),"…with the #N in the quoted line");
check(errors.length===0,`ref chip quote: no page errors ${errors.join(" | ")}`);await ctx.close()}
await b.close();console.log(fails?`${fails} FAILED`:"all quote checks passed");process.exit(fails?1:0);
