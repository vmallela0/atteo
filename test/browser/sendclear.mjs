// While a message sends, its "sending…" copy is in the conversation and the box looks empty, not both (jxn #1222);
// a failed send brings it back. And a page that's been open across a deploy offers a reload (jxn #1221).
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE=process.env.BASE||"http://localhost:8787";
const ops=async(p,b)=>(await fetch(`${BASE}/api/ops/${p}`,{method:"POST",headers:{"x-admin-key":"ci-admin-key","content-type":"application/json"},body:JSON.stringify(b)})).json();
const run=Date.now().toString(36).slice(-4),P=`sc${run}`;await ops("users",{name:P,email:`${P}@example.com`,verified:"true"});
const board=(await ops("boards",{user:P,title:`Send ${run}`})).board.id;const ck=(await ops("sessions",{user:P})).cookie;
const PNG=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==","base64");
let fails=0;const check=(ok,t)=>{console.log(`${ok?"✓":"✗"} ${t}`);if(!ok)fails++};
const b=await chromium.launch({executablePath: process.env.PW_CHROME || undefined});
const ctx=await b.newContext({viewport:{width:1200,height:800}});const [k,...v]=ck.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
let ver="v1";await ctx.route(`${BASE}/health`,r=>r.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true,version:ver})}));
let hold=null;await ctx.route(`${BASE}/api/boards/${board}/upload`,async r=>{if(hold)await hold;if(globalThis.failUpload){r.fulfill({status:500,contentType:"application/json",body:'{"error":"boom"}'});return}r.continue()});
const p=await ctx.newPage();const errors=[];p.on("pageerror",e=>errors.push(e.message));await p.goto(`${BASE}/b/${board}`);await p.waitForTimeout(900);
const looks=()=>p.evaluate(()=>{const f=document.querySelector('form.composer');return {sending:f.classList.contains('sending'),field:document.getElementById('composer-text').value===''?'empty':'text',focus:document.activeElement?.id||'',att:getComputedStyle(document.getElementById('attachments')).display,pend:document.querySelectorAll('#thread .entry.pending:not(.failed)').length}});
// A post with a picture
let release;hold=new Promise(r=>release=r);
await p.locator("#attach-input").setInputFiles({name:"pic.png",mimeType:"image/png",buffer:PNG});await p.waitForTimeout(400);
await p.fill("#composer-text",`with a picture ${run}`);await p.locator("form.composer button.primary").click();await p.waitForTimeout(400);
let g=await looks();check(g.sending&&g.field==="empty"&&g.att==="none"&&g.pend===1,`while it sends, the "sending…" copy shows and the box looks empty (${JSON.stringify(g)})`);
release();hold=null;await p.waitForTimeout(1500);g=await looks();
check(!g.sending&&g.pend===0&&await p.inputValue("#composer-text")===""&&await p.locator(`#thread>.entry .body:has-text("with a picture ${run}")`).count()===1,`once sent, it's in the conversation once and the box is empty (${JSON.stringify(g)})`);
// A failed send comes back
globalThis.failUpload=true;await p.locator("#attach-input").setInputFiles({name:"pic2.png",mimeType:"image/png",buffer:PNG});await p.waitForTimeout(300);
await p.fill("#composer-text",`will fail ${run}`);await p.locator("form.composer button.primary").click();await p.waitForTimeout(1200);g=await looks();
check(!g.sending&&await p.inputValue("#composer-text")===`will fail ${run}`&&await p.locator("#attachments .att").count()===1,`a failed send leaves the text and picture in the box, visible (${JSON.stringify(g)})`);
globalThis.failUpload=false;await p.locator("#attachments .att button, #attachments [data-rm], #attachments .x").first().click().catch(()=>{});await p.fill("#composer-text","");
// A plain text post
let rel2;const h2=new Promise(r=>rel2=r);await ctx.route(`${BASE}/api/boards/${board}/entries`,async r=>{if(r.request().method()==="POST")await h2;r.continue()});
await p.fill("#composer-text",`plain text ${run}`);await p.keyboard.press("Enter");await p.waitForTimeout(400);g=await looks();
check(g.sending&&g.field==="empty"&&g.focus==="composer-text"&&g.pend===1,`a text message too: sending copy shown, the box is empty and keeps focus (${JSON.stringify(g)})`);
await p.keyboard.type("next one");check(await p.inputValue("#composer-text")==="next one","you can type the next message while it sends");
rel2();await p.waitForTimeout(1500);check(await p.inputValue("#composer-text")==="next one","…and it stays when the first one lands");await p.fill("#composer-text","");g=await looks();check(!g.sending&&await p.locator(`#thread>.entry .body:has-text("plain text ${run}")`).count()===1,"…and it lands once");
// A deploy while the page is open
check(await p.locator("#upd-bar").count()===0,"no update bar while the version is the same");
ver="v2";await p.evaluate(()=>{Object.defineProperty(document,'hidden',{value:false,configurable:true});document.dispatchEvent(new Event('visibilitychange'))});await p.waitForTimeout(600);
check(await p.locator("#upd-bar").isVisible()&&/updated/.test(await p.locator("#upd-bar").innerText()),"after a deploy, coming back to the tab shows \"Atteo was updated · Reload\"");
await p.screenshot({path:`${SHOTS_DIR}/updbar.png`});
await Promise.all([p.waitForNavigation(),p.locator("#upd-bar button").click()]);check(true,"Reload reloads the page");
check(!errors.length,`no page errors ${errors.join(" | ")}`);
await b.close();console.log(fails?`${fails} FAILED`:"send + update: all passed");process.exit(fails?1:0);
