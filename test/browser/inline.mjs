// Replies post in the conversation like any message, with a bar quoting what they answer; the thread opens as an overlay (jxn #1040).
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE=process.env.BASE||"http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run=Date.now().toString(36).slice(-4), A=`il${run}`, B=`im${run}`;
for(const u of [A,B])await ops("users",{name:u,email:`${u}@example.com`,verified:"true"});
const tokB=(await ops("tokens",{user:B})).token;const board=(await ops("boards",{user:A,title:`Inline ${run}`})).board.id;await ops("members",{board,user:B});
const call=async(name,args)=>(await (await fetch(`${BASE}/mcp?board=${board}`,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${tokB}`},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})})).json()).result.content[0].text;
const post=async(t,r=0)=>{await call("read",{});return +(await call("post",{type:"note",text:t,reply_to:r})).match(/#(\d+)/)[1]};
const root=await post("Which region do we deploy to?");for(let i=1;i<=6;i++)await post(`chatter ${i}`);
const ck=(await ops("sessions",{user:A})).cookie;
let fails=0;const check=(ok,m)=>{console.log(`${ok?"✓":"✗"} ${m}`);if(!ok)fails++};
const b=await chromium.launch({executablePath: process.env.PW_CHROME || undefined});
let nRep=0;for(const [w,h] of [[1280,800],[390,800]]){
const ctx=await b.newContext({viewport:{width:w,height:h},hasTouch:w<500});const [k,...v]=ck.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
const p=await ctx.newPage();const errors=[];p.on("pageerror",e=>errors.push(e.message));await p.goto(`${BASE}/b/${board}`);await p.waitForTimeout(800);
const rep=await post(`us-east-1, ${w}px`,root);nRep++;await p.waitForTimeout(1500);
const g=await p.evaluate(([r,root])=>{const el=document.getElementById('e'+r);const last=[...document.querySelectorAll('#thread>.entry')].pop();const q=el?.querySelector(':scope>.grow>.rq');
  return {top:el?.parentElement?.id,last:last?.id,q:q?.innerText.replace(/\s+/g,' ').trim(),sum:document.querySelector('#e'+root+' .thr-sum')?.innerText.replace(/\s+/g,' ').trim()}},[rep,root]);
check(g.top==="thread"&&g.last===`e${rep}`,`${w}px: a reply lands at the bottom like any message (${g.top}, last ${g.last})`);
check(/Which region do we deploy to\?/.test(g.q||""),`${w}px: with a bar quoting what it answers: "${g.q}"`);
check(new RegExp(nRep+' repl').test(g.sum||""),`${w}px: the original shows "${nRep} repl…": "${g.sum}"`);
await p.locator(`#e${rep} .rq`).click();await p.waitForTimeout(400);
const o=await p.evaluate(()=>{const d=document.querySelector('.thr-dlg');return {open:d?.open,n:d?.querySelectorAll('.thr-list>.entry').length,ids:d?.querySelectorAll('.thr-list [id^="e"]').length}});
check(o.open&&o.n===nRep+1&&o.ids===0,`${w}px: the bar opens the thread overlay: the question and its reply (${JSON.stringify(o)})`);
await p.screenshot({path:`${SHOTS_DIR}/inline-${w}.png`});
// The reply box in the thread is the conversation's own composer (jxn #1094)
const c=await p.evaluate(()=>{const f=document.querySelector('form.composer'),d=document.querySelector('.thr-dlg');const r=f.getBoundingClientRect(),dr=d.getBoundingClientRect();
  return {inDlg:d.contains(f),one:document.querySelectorAll('form.composer').length,btns:['attach-btn','mic-btn'].filter(id=>{const x=document.getElementById(id);return x&&d.contains(x)}).length+(d.querySelector('[data-mention-for]')?1:0),
    inside:r.left>=dr.left-0.5&&r.right<=dr.right+0.5&&r.bottom<=dr.bottom+0.5,to:document.getElementById('reply-to').value,val:document.getElementById('composer-text').value}});
check(c.inDlg&&c.one===1&&c.btns>=2&&c.inside,`${w}px: the thread's reply box is the conversation's composer, with its attach / @ / mic buttons (${JSON.stringify(c)})`);
check(c.to===String(root)||c.to===String(rep),`${w}px: …replying in the thread: to the reply it was opened from, or its first message (${c.to})`); // #1351: a thread opened at a reply answers that reply
await p.fill('.thr-dlg #composer-text',`and the db ${w}?`);await p.locator('.thr-dlg form.composer button.primary').click();await p.waitForTimeout(1500);
const n2=await p.locator('.thr-dlg .thr-list>.entry').count(),lastMain=await p.evaluate(()=>[...document.querySelectorAll('#thread>.entry')].pop().querySelector('.body')?.textContent);
nRep++;check(n2===nRep+1&&/and the db/.test(lastMain||""),`${w}px: replying in the overlay adds to it and to the conversation (${n2}, "${lastMain}")`);
check(await p.inputValue('.thr-dlg #composer-text')===""&&[String(root),String(rep)].includes(await p.inputValue('#reply-to')),`${w}px: after sending, the box is empty and still replies to the thread`);
await p.fill('.thr-dlg #composer-text',`second in a row ${w}`);await p.keyboard.press(w<500?'Tab':'Enter');if(w<500)await p.locator('.thr-dlg form.composer button.primary').click();await p.waitForTimeout(1500);
nRep++;check(await p.locator('.thr-dlg .thr-list>.entry').count()===nRep+1,`${w}px: a second reply in a row lands in the thread too`);
await p.fill('.thr-dlg #composer-text',`unsent thread draft ${w}`);
await p.locator('[data-thr-close]').click();await p.waitForTimeout(200);
const back=await p.evaluate(()=>({home:!!document.querySelector('.conv form.composer'),to:document.getElementById('reply-to').value,val:document.getElementById('composer-text').value,rp:document.getElementById('replying').hidden}));
check(back.home&&back.to===""&&back.rp&&!/unsent thread draft/.test(back.val),`${w}px: closing puts the composer back under the conversation, out of reply mode (${JSON.stringify(back)})`);
await p.locator(`#e${rep} .rq`).click();await p.waitForTimeout(400);
check((await p.inputValue('.thr-dlg #composer-text')).includes(`unsent thread draft ${w}`),`${w}px: reopening the thread brings back its unsent draft`);
await p.fill('.thr-dlg #composer-text','');await p.keyboard.press('Escape');await p.waitForTimeout(200);
check(!(await p.evaluate(()=>document.querySelector('.thr-dlg').open)),`${w}px: ✕ closes it`);
check(!errors.length,`${w}px: no page errors ${errors.join(" | ")}`);await ctx.close()}
await b.close();console.log(fails?`${fails} FAILED`:"all inline-reply checks passed");process.exit(fails?1:0);
