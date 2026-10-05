// emoji-sync branch version of emojipick.mjs: swap it in for emojipick.mjs when emoji-sync merges (the row is server-backed, so wiping this browser no longer wipes your most-used, and more atteo.rx.* keys exist).
// The reaction emoji picker (vedu: "let me pick what emojis i will use, similar to slack"): search, frequently used, your own
// row of up to 8 whose first 3 are the one-click buttons on every message (live ones too, and after a reload), reset, Esc,
// a bottom sheet on phones, dark and light, no page errors.
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
import { until, trackBoardSocket, boardLive } from "./lib/wait.mjs";
const BASE=process.env.BASE||"http://localhost:8787";
const ops=async(p,b)=>(await fetch(`${BASE}/api/ops/${p}`,{method:"POST",headers:{"x-admin-key":"ci-admin-key","content-type":"application/json"},body:JSON.stringify(b)})).json();
const run=Date.now().toString(36).slice(-4),P=`ep${run}`,V=`ev${run}`;
for(const u of [P,V])await ops("users",{name:u,email:`${u}@example.com`,verified:"true"});
const board=(await ops("boards",{user:P,title:`Emoji ${run}`})).board.id;await ops("members",{board,user:V});
const ck=(await ops("sessions",{user:P})).cookie,tokV=(await ops("tokens",{user:V})).token;
const mcp=async(name,args)=>(await (await fetch(`${BASE}/mcp?board=${board}`,{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream",authorization:`Bearer ${tokV}`},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})})).json()).result.content[0].text;
const post=async(text)=>{await mcp("read",{});return +(await mcp("post",{type:"note",text})).match(/#(\d+)/)[1]};
const n1=await post(`Shipped the new picker ${run}`);
let fails=0;const check=(ok,m)=>{console.log(`${ok?"✓":"✗"} ${m}`);if(!ok)fails++};
const b=await chromium.launch({executablePath: process.env.PW_CHROME || undefined});
const [k,...v]=ck.split(";")[0].split("=");const cookie={name:k,value:v.join("="),url:BASE};
const errors=[];
const ctx=await b.newContext({viewport:{width:1400,height:900},colorScheme:"light"});await ctx.addCookies([cookie]);
const p=await ctx.newPage();p.on("pageerror",e=>errors.push(e.message));await trackBoardSocket(p);await p.goto(`${BASE}/b/${board}`);
const bar=(seq,q=p)=>q.locator(`#e${seq} .acts .rx-q`).evaluateAll(bs=>bs.map(b=>b.dataset.emo+(b.textContent===b.dataset.emo?"":"!")).join(""));
await boardLive(p);await until(async()=>await bar(n1)==="👍✅🤔");
const chips=(seq,q=p)=>q.locator(`[data-rx="${seq}"] .rx-chip`).evaluateAll(cs=>cs.map(c=>c.querySelector('.e').textContent+c.querySelector('.c').textContent+(c.classList.contains('on')?'*':'')));
const pk=p.locator(".rx-pick");
const results=()=>p.locator(".rx-pick .rp-body [data-ep]").evaluateAll(bs=>bs.map(b=>b.dataset.ep));
check(await bar(n1)==="👍✅🤔","the hover bar starts with the default 👍 ✅ 🤔");
// Open from the hover bar: a popover by the button, inside the viewport, search focused.
await p.locator(`#e${n1}`).hover();await p.locator(`#e${n1} .acts [data-rx-add]`).click();await p.waitForTimeout(200);
const g=await pk.evaluate(el=>{const r=el.getBoundingClientRect(),a=document.querySelector(`#e${el.dataset.seq} .acts [data-rx-add]`).getBoundingClientRect();
  return {sheet:el.classList.contains('sheet'),l:r.left,t:r.top,r:r.right,b:r.bottom,w:innerWidth,h:innerHeight,near:Math.abs(r.bottom-a.top)<20||Math.abs(r.top-a.bottom)<20,focus:document.activeElement===el.querySelector('.rp-search input'),
    n:el.querySelectorAll('.rp-body [data-ep]').length,secs:[...el.querySelectorAll('.rp-h')].map(h=>h.textContent),quick:[...el.querySelectorAll('.rp-quick [data-pick]')].map(b=>b.dataset.pick).join('')}});
check(await pk.isVisible()&&!g.sheet&&g.l>=8&&g.t>=8&&g.r<=g.w-8&&g.b<=g.h-8&&g.near,`☺+ opens a popover anchored to the button, inside the viewport (${JSON.stringify({l:g.l,t:g.t,r:g.r,b:g.b,near:g.near})})`);
check(g.focus,"the search box has focus");
check(g.secs[0]==="Frequently used"&&g.secs.includes("Smileys & people")&&g.secs.includes("Gestures")&&g.secs.includes("Hearts & symbols")&&g.secs.includes("Objects & work")&&g.secs.includes("Nature & food")&&g.n>=250,`Frequently used first, then the categories, ${g.n} emoji (${g.secs.join(" / ")})`);
check(g.quick==="👍✅🤔🎉❤️🔥😂🙏",`the quick row falls back to the defaults (${g.quick})`);
await p.screenshot({path:`${SHOTS_DIR}/emojipick-desktop-light.png`});
// Search
for(const [q,want,first] of [["fire","🔥",true],["ship","🚀",false],["eyes","👀",true],[":tada:","🎉",true],["thumbsup","👍",true]]){
  await p.locator(".rx-pick .rp-search input").fill(q);await p.waitForTimeout(60);const r=await results();
  check(first?r[0]===want:r.includes(want),`search "${q}" finds ${want}${first?" first":""} (${r.slice(0,6).join("")})`)}
await p.locator(".rx-pick .rp-search input").fill("zzqqxx");await p.waitForTimeout(60);
check(/No emoji match/.test(await p.locator(".rx-pick .rp-body").innerText()),"no match says so");
// Typing goes to search; Enter picks the top hit
await p.locator(".rx-pick .rp-search input").fill("");await p.locator(".rx-pick .rp-foot").click();await p.keyboard.type("rocket");await p.waitForTimeout(80);
check(await p.locator(".rx-pick .rp-search input").inputValue()==="rocket"&&(await results())[0]==="🚀"&&await p.locator('.rx-pick .rp-e.kb').getAttribute('data-ep')==="🚀",`typing "rocket" goes to search and highlights 🚀`);
await p.keyboard.press("Enter");await until(async()=>await pk.isHidden()&&JSON.stringify(await chips(n1))===`["🚀1*"]`);
check(await pk.isHidden()&&JSON.stringify(await chips(n1))==='["🚀1*"]',`Enter picks 🚀: the picker closes and the chip shows on the message (${await chips(n1)})`);
// Frequently used next time; the most-used fill your row, so 🚀 leads the row and the one-click buttons.
await p.locator(`[data-rx="${n1}"] .rx-add`).click();await p.waitForTimeout(200);
const fr=await p.locator(".rx-pick .rp-sec").first().locator("[data-ep]").evaluateAll(bs=>bs.map(b=>b.dataset.ep));
const q1=await p.locator(".rx-pick .rp-quick [data-pick]").evaluateAll(bs=>bs.map(b=>b.dataset.pick).join(""));
check(fr[0]==="🚀",`Frequently used shows 🚀 first next time (${fr.join("")})`);
check(q1.startsWith("🚀")&&q1.length>0,`…and it leads the quick row (${q1})`);
check(await p.locator('.rx-pick .rp-quick [data-pick="🚀"]').evaluate(b=>b.classList.contains('on')),"…marked as already yours on this message");
// Arrows move, Esc closes
await p.keyboard.press("ArrowDown");const k1=await p.locator('.rx-pick .rp-e.kb').getAttribute('data-ep');await p.keyboard.press("ArrowRight");const k2=await p.locator('.rx-pick .rp-e.kb').getAttribute('data-ep');
await p.keyboard.press("ArrowDown");const k3=await p.locator('.rx-pick .rp-e.kb').getAttribute('data-ep');
check(await pk.isVisible()&&k1&&k2&&k3&&k1!==k2&&k2!==k3,`arrow keys move the highlight (${k1} → ${k2} → ${k3})`);
await p.keyboard.press("Escape");await p.waitForTimeout(100);check(await pk.isHidden(),"Esc closes the picker");
check(await bar(n1)==="🚀👍✅",`the one-click buttons follow your row: most-used first (${await bar(n1)})`);
// Customize your row: 🚀 🎉 👀, reorder, done
await p.locator(`[data-rx="${n1}"] .rx-add`).click();await p.waitForTimeout(150);await p.locator(".rx-pick [data-rp-cz]").click();await p.waitForTimeout(100);
check(await p.locator(".rx-pick .rp-cz").isVisible()&&await p.locator(".rx-pick .rp-quick [data-pick]").count()===0,"Customize turns the row into slots you edit");
for(const e of ["🚀","🎉","👀"])await p.locator(`.rx-pick .rp-body [data-ep="${e}"]`).first().click();await p.waitForTimeout(100);
const slots=()=>p.locator(".rx-pick .rp-slot").evaluateAll(bs=>bs.map(b=>b.textContent+(b.classList.contains('pin')?'':'~')).join(""));
check((await slots()).startsWith("🚀🎉👀")&&!(await slots()).slice(0,6).includes("~"),`tapping 🚀 🎉 👀 makes them your first three (${await slots()})`);
check(await pk.isVisible()&&JSON.stringify(await chips(n1))==='["🚀1*"]',"customizing doesn't react to the message");
await p.locator('.rx-pick .rp-slot[data-slot="2"]').click();await p.locator('.rx-pick [data-rp-mv="-1"]').click();await p.waitForTimeout(60);const s1=await slots();
await p.locator('.rx-pick [data-rp-mv="1"]').click();await p.waitForTimeout(60);const s2=await slots();
check(s1.startsWith("🚀👀🎉")&&s2.startsWith("🚀🎉👀"),`◀ ▶ reorder a slot (${s1.slice(0,6)} → ${s2.slice(0,6)})`);
await p.screenshot({path:`${SHOTS_DIR}/emojipick-customize-light.png`});
await p.locator(".rx-pick [data-rp-done]").click();await p.waitForTimeout(80);
check(!(await p.locator(".rx-pick .rp-cz").isVisible())&&(await p.locator(".rx-pick .rp-quick [data-pick]").evaluateAll(bs=>bs.map(b=>b.dataset.pick).join(""))).startsWith("🚀🎉👀"),"Done goes back to picking, with your row on top");
await p.keyboard.press("Escape");
check(await bar(n1)==="🚀🎉👀",`the hover bar's one-click buttons are now 🚀 🎉 👀 (${await bar(n1)})`);
// A message that arrives after load gets them too, and they react
const n2=await post(`Live one ${run}`);await until(async()=>await bar(n2)==="🚀🎉👀");
check(await bar(n2)==="🚀🎉👀",`…also on a message that arrives live (${await bar(n2)})`);
await p.locator(`#e${n2}`).hover();await p.locator(`#e${n2} .acts .rx-q[data-emo="🎉"]`).click();await until(async()=>JSON.stringify(await chips(n2))===`["🎉1*"]`);
check(JSON.stringify(await chips(n2))==='["🎉1*"]',`clicking the 🎉 one-click button reacts with 🎉 (${await chips(n2)})`);
// Survives a reload
await p.reload();await until(async()=>await bar(n1)==="🚀🎉👀"&&await bar(n2)==="🚀🎉👀");
check(await bar(n1)==="🚀🎉👀"&&await bar(n2)==="🚀🎉👀",`after a reload the hover bars still show 🚀 🎉 👀 (${await bar(n1)} ${await bar(n2)})`);
// Dark desktop
await p.emulateMedia({colorScheme:"dark"});await p.locator(`[data-rx="${n1}"] .rx-add`).click();await p.waitForTimeout(200);
const dk=await pk.evaluate(el=>[getComputedStyle(el).backgroundColor,getComputedStyle(document.body).backgroundColor]);
check(dk[0]===dk[1]&&dk[0]!=="rgb(255, 255, 255)",`dark mode: the picker uses the page's dark background (${dk[0]})`);
await p.screenshot({path:`${SHOTS_DIR}/emojipick-desktop-dark.png`});
// Reset: your picks go; the row is your most-used again (and the defaults once you have none)
await p.locator(".rx-pick [data-rp-cz]").click();await p.locator(".rx-pick [data-rp-reset]").click();await p.waitForTimeout(80);
const afterReset=await slots();check(await p.locator(".rx-pick .rp-slot.pin").count()===0,`Reset clears your picks (${afterReset})`);
await p.keyboard.press("Escape");await p.waitForTimeout(800); // the row is saved to your prefs (after a short pause)
const rowNow=await p.evaluate(()=>quickRow().slice(0,3).join(""));
check(await bar(n1)===rowNow&&rowNow!=="🚀🎉👀",`…and the one-click buttons go back to your most-used (${await bar(n1)})`);
await p.evaluate(()=>{for(const k of Object.keys(localStorage))if(k.startsWith('atteo.rx.'))localStorage.removeItem(k)});await p.reload();
// This browser's copy gone: your most-used still come from the server (recent_reactions, every device; emoji-sync.mjs covers the rest).
const rec=(await (await p.request.get(`${BASE}/api/app/prefs`)).json()).prefs.recent_reactions;
await until(async()=>await bar(n1)===[...new Set([...rec,"👍","✅","🤔"])].slice(0,3).join(""));
check(await bar(n1)===[...new Set([...rec,"👍","✅","🤔"])].slice(0,3).join(""),`with no picks and this browser's history gone, your most-used on every device lead (${await bar(n1)}; recent ${rec.join("")})`);
const keys=await p.evaluate(()=>{quickSet(['🚀']);freqAdd('🔥');return Object.keys(localStorage).filter(k=>k.startsWith('atteo.rx.'))});
check(keys.length>=2&&keys.every(k=>k.endsWith('.'+P)),`stored per person (${keys.join(", ")})`);
await p.evaluate(()=>{for(const k of Object.keys(localStorage))if(k.startsWith('atteo.rx.'))localStorage.removeItem(k)});
await ctx.close();
// Phones: a bottom sheet, no sideways scroll; light and dark
for(const [w,scheme] of [[390,"dark"],[390,"light"],[320,"light"]]){
  const c=await b.newContext({viewport:{width:w,height:800},isMobile:true,hasTouch:true,colorScheme:scheme});await c.addCookies([cookie]);const q=await c.newPage();q.on("pageerror",e=>errors.push(e.message));
  await q.goto(`${BASE}/b/${board}`);await until(async()=>(await bar(n1,q)).length>=3);
  await q.locator(`#e${n1} .more-acts`).tap();await q.waitForTimeout(150);await q.locator(`#e${n1} .acts [data-rx-add]`).tap();await q.waitForTimeout(300);
  const s=await q.locator(".rx-pick").evaluate(el=>{const r=el.getBoundingClientRect(),qr=el.querySelector('.rp-quick').getBoundingClientRect();return {sheet:el.classList.contains('sheet'),l:r.left,r:r.right,b:r.bottom,t:r.top,h:innerHeight,w:innerWidth,
    sw:document.documentElement.scrollWidth,psw:el.scrollWidth,pcw:el.clientWidth,bsw:el.querySelector('.rp-body').scrollWidth,bcw:el.querySelector('.rp-body').clientWidth,qr:qr.right,scrim:!document.querySelector('.rp-scrim').hidden,bg:getComputedStyle(el).backgroundColor}});
  check(s.sheet&&s.l===0&&Math.round(s.r)===w&&Math.abs(s.b-s.h)<2&&s.t>s.h*0.2&&s.scrim,`${w}px ${scheme}: a bottom sheet across the width (${JSON.stringify({l:s.l,r:s.r,t:s.t,b:s.b})})`);
  check(s.sw<=w&&s.psw<=s.pcw&&s.bsw<=s.bcw&&s.qr<=w,`${w}px ${scheme}: no sideways scroll (page ${s.sw}, sheet ${s.psw}/${s.pcw}, grid ${s.bsw}/${s.bcw})`);
  check(scheme==="dark"?s.bg!=="rgb(250, 250, 247)":s.bg==="rgb(250, 250, 247)",`${w}px ${scheme}: themed (${s.bg})`);
  if(w===390&&scheme==="dark")await q.screenshot({path:`${SHOTS_DIR}/emojipick-phone-dark.png`});
  if(w===390&&scheme==="light")await q.screenshot({path:`${SHOTS_DIR}/emojipick-phone-light.png`});
  if(w===390){const [word,em]=scheme==="dark"?["fire","🔥"]:["eyes","👀"];await q.locator(".rx-pick .rp-search input").tap();await q.keyboard.type(word);await q.waitForTimeout(100);await q.locator(`.rx-pick .rp-body [data-ep="${em}"]`).tap();await until(async()=>await q.locator(".rx-pick").isHidden()&&(await chips(n1,q)).some(x=>x.startsWith(em+"1")));
    const ch=await chips(n1,q);check(await q.locator(".rx-pick").isHidden()&&ch.some(x=>x.startsWith(em+"1")),`${w}px ${scheme}: search "${word}" + tap ${em} reacts and closes the sheet (${ch})`);
    await q.locator(`[data-rx="${n1}"] .rx-add`).tap();await q.waitForTimeout(200);
    await q.locator(".rp-scrim").tap({position:{x:20,y:20}});await q.waitForTimeout(150);check(await q.locator(".rx-pick").isHidden(),`${w}px ${scheme}: tapping outside closes the sheet`)}
  else{await q.keyboard.press("Escape");}
  await c.close()}
check(!errors.length,`no page errors ${errors.join(" | ")}`);
await b.close();console.log(fails?`${fails} FAILED`:"emoji picker: all passed");process.exit(fails?1:0);
