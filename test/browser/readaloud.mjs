// Read aloud uses Atteo's own voice (jxn #1612): POST /api/app/tts {board, seq} and play the audio; the device's
// (the read-aloud button speaks a blank to unlock audio; the fake ignores it) speechSynthesis only when the server says fallback (503/429) or the audio won't play. The route and audio are faked.
import { chromium } from "playwright-core";
const BASE=process.env.BASE||"http://localhost:8787";
const ops=async(p,b)=>(await fetch(`${BASE}/api/ops/${p}`,{method:"POST",headers:{"x-admin-key":"ci-admin-key","content-type":"application/json"},body:JSON.stringify(b)})).json();
const run=Date.now().toString(36).slice(-4),P=`ra${run}`,V=`rv${run}`;
for(const u of [P,V])await ops("users",{name:u,email:`${u}@example.com`,verified:"true"});
const tokV=(await ops("tokens",{user:V})).token;
const board=(await ops("boards",{user:P,title:`Read aloud ${run}`})).board.id;await ops("members",{board,user:V});
const ckP=(await ops("sessions",{user:P})).cookie;
const mcp=async(name,args)=>(await (await fetch(`${BASE}/mcp?board=${board}`,{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream",authorization:`Bearer ${tokV}`},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})})).json()).result?.content?.[0]?.text||"";
const agentPost=async(text)=>{await mcp("read",{});return +(await mcp("post",{type:"note",text})).match(/#(\d+)/)[1]};
await mcp("read",{});
let fails=0;const check=(ok,m)=>{console.log(`${ok?"✓":"✗"} ${m}`);if(!ok)fails++};
const FAKES=()=>{window.__spoken=[];window.__audio=[];
  window.SpeechSynthesisUtterance=class{constructor(t){this.text=t}};
  Object.defineProperty(window,"speechSynthesis",{value:{getVoices(){return [{name:"Basic",lang:"en-US",default:true}]},speak(u){if(String(u.text).trim())window.__spoken.push(u.text);setTimeout(()=>{u.onstart&&u.onstart();setTimeout(()=>u.onend&&u.onend(),50)},20)},cancel(){},resume(){},speaking:false,pending:false},configurable:true});
  window.Audio=class{constructor(src){this.src=src;window.__audio.push({src,played:false,paused:false});this.i=window.__audio.length-1}
    play(){if(window.__noPlay)return Promise.reject(new Error("NotAllowedError"));window.__audio[this.i].played=true;setTimeout(()=>this.onended&&this.onended(),150);return Promise.resolve()}
    pause(){window.__audio[this.i].paused=true}}};
const b=await chromium.launch({executablePath: process.env.PW_CHROME || undefined});
const errors=[];
async function open(route){const ctx=await b.newContext({viewport:{width:1100,height:800}});const [k,...v]=ckP.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
  await ctx.addInitScript(FAKES);const reqs=[];
  await ctx.route("**/api/app/tts",async r=>{reqs.push(r.request().postDataJSON());await route(r)});
  const p=await ctx.newPage();p.on("pageerror",e=>errors.push(e.message));await p.goto(`${BASE}/b/${board}`);await p.waitForTimeout(900);
  await p.click("#aloud-btn");return {ctx,p,reqs}}
async function readOne(p,text){const seq=await agentPost(`@${P} ${text}`);
  await p.locator("#voice-pill").waitFor({state:"visible",timeout:8000}).catch(()=>{});await p.click("#vp-go");await p.waitForTimeout(600);return seq}
const mp3=Buffer.from([0xff,0xfb,0x90,0x64,0,0,0,0]);

// 1. The server has a voice: it plays, the device voice stays quiet.
{const {ctx,p,reqs}=await open(r=>r.fulfill({status:200,contentType:"audio/mpeg",body:mp3}));
  const seq=await readOne(p,`deploy done ${run}`);
  check(reqs.length===1&&reqs[0].board===board&&reqs[0].seq===seq,`asks the server for that message (${JSON.stringify(reqs)})`);
  const au=await p.evaluate(()=>window.__audio);
  check(au.length===1&&au[0].played&&/^blob:/.test(au[0].src),`plays the server's audio (${JSON.stringify(au)})`);
  check((await p.evaluate(()=>window.__spoken)).length===0,"the device's robot voice isn't used");
  await p.waitForTimeout(500);check(await p.locator("#voice-pill").isHidden(),"the bar goes away when the audio ends");
  // stopping mid-read pauses the audio
  await p.evaluate(()=>{window.Audio.prototype.play=function(){window.__audio[this.i].played=true;return Promise.resolve()}});
  await readOne(p,`long one ${run}`);await p.click("#vp-go");await p.waitForTimeout(200);
  const au2=await p.evaluate(()=>window.__audio);check(au2.length===2&&au2[1].paused&&await p.locator("#voice-pill").isHidden(),`tapping the bar while it reads stops the audio (${JSON.stringify(au2[1])})`);
  await ctx.close()}
// 2. Not set up / over the allowance: the device voice reads it.
{const {ctx,p,reqs}=await open(r=>r.fulfill({status:503,contentType:"application/json",body:JSON.stringify({error:"Voice isn't set up yet",fallback:"device"})}));
  await readOne(p,`fallback ${run}`);
  const sp=await p.evaluate(()=>window.__spoken);
  check(reqs.length===1&&sp.length===1&&sp[0].includes(`fallback ${run}`)&&(await p.evaluate(()=>window.__audio)).length===0,`503 → the device voice reads it (${JSON.stringify(sp)})`);
  await ctx.close()}
// 3. The audio won't play (autoplay blocked): the device voice reads it instead of going silent.
{const {ctx,p}=await open(r=>r.fulfill({status:200,contentType:"audio/mpeg",body:mp3}));
  await p.evaluate(()=>{window.__noPlay=true});await readOne(p,`blocked ${run}`);
  const sp=await p.evaluate(()=>window.__spoken);check(sp.length===1&&sp[0].includes(`blocked ${run}`),`blocked audio → the device voice instead (${JSON.stringify(sp)})`);
  await ctx.close()}
check(errors.length===0,`no page errors ${errors.join(" | ")}`);
await b.close();
console.log(fails?`${fails} FAILED`:"read aloud (server voice): all passed");process.exit(fails?1:0);
