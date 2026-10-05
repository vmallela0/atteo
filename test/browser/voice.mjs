// Voice prototype (jxn #1069): the mic button dictates into the composer ("send it" posts). Since #2083 it sits where
// Post is (Post once there's text), and reading messages for you aloud lives in Talk to Atteo (call-nap.mjs). Speech is faked.
// The desktop part, the two phone widths and the no-speech browser run side by side; their lines print in this order.
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE=process.env.BASE||"http://localhost:8787";
const ops=async(p,b)=>(await fetch(`${BASE}/api/ops/${p}`,{method:"POST",headers:{"x-admin-key":process.env.ADMIN_KEY||"ci-admin-key","content-type":"application/json"},body:JSON.stringify(b)})).json();
const run=Date.now().toString(36).slice(-4),P=`jv${run}`,V=`vv${run}`;
for(const u of [P,V])await ops("users",{name:u,email:`${u}@example.com`,verified:"true"});
const tokV=(await ops("tokens",{user:V})).token;
const board=(await ops("boards",{user:P,title:`Voice ${run}`})).board.id;await ops("members",{board,user:V});
const ckP=(await ops("sessions",{user:P})).cookie;
const api=(m,p,b,h={})=>fetch(BASE+p,{method:m,headers:{"content-type":"application/json",...h},body:b?JSON.stringify(b):undefined}).then(r=>r.json());
const s=(await api("POST","/api/sessions",{suggest:"builder",client:"Claude Code"},{authorization:`Bearer ${tokV}`})).session;await api("POST",`/api/sessions/${s.id}/boards`,{board},{authorization:`Bearer ${tokV}`});
const mcp=async(name,args)=>(await (await fetch(`${BASE}/mcp?board=${board}`,{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream",authorization:`Bearer ${tokV}`,"x-agent-soup-session":s.id},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})})).json()).result.content[0].text;
const agentPost=async(text)=>{await mcp("read",{});return mcp("post",{type:"note",text})};
await mcp("read",{});
let fails=0;const parts=[];
const part=(fn)=>{const lines=[];const check=(ok,m)=>{lines.push(`${ok?"✓":"✗"} ${m}`);if(!ok)fails++};parts.push(fn(check).then(()=>lines,(e)=>{fails++;return [...lines,`✗ ${e.stack||e}`]}))};
const FAKES=()=>{window.__spoken=[];window.__recs=0;window.__blips=0;
  class FSR{start(){window.__recs++;const say=window.__say||[];window.__say=null;const fin=[];let t=0;
      say.forEach(([tr,isF])=>{t+=150;setTimeout(()=>{const cur=Object.assign([{transcript:tr}],{isFinal:isF});const results=fin.concat([cur]);const ri=fin.length;if(isF)fin.push(cur);this.onresult&&this.onresult({resultIndex:ri,results})},t)})}
    stop(){setTimeout(()=>this.onend&&this.onend(),20)}abort(){this.stop()}}
  window.webkitSpeechRecognition=FSR;window.SpeechRecognition=FSR;window.SpeechSynthesisUtterance=class{constructor(t){this.text=t}};
  Object.defineProperty(window,"speechSynthesis",{value:{getVoices(){return [{name:"Basic",lang:"en-US",default:true},{name:"Microsoft Aria Online (Natural) - English (United States)",lang:"en-US"},{name:"Natural Fr",lang:"fr-FR"}]},speak(u){window.__voice=u.voice&&u.voice.name;if(window.__mute){window.__tries=(window.__tries||0)+1;return}if(u.text.trim())window.__spoken.push(u.text);setTimeout(()=>u.onend&&u.onend(),250)},cancel(){}},configurable:true});
  navigator.permissions.query=async()=>({state:"granted"});
  const AC=window.AudioContext;window.AudioContext=class extends AC{createOscillator(){window.__blips++;return super.createOscillator()}}};
const b=await chromium.launch({executablePath: process.env.PW_CHROME || undefined});
const errors=[];
const open=async(w,mobile)=>{const ctx=await b.newContext({viewport:{width:w,height:800},hasTouch:mobile,isMobile:mobile});const [k,...v]=ckP.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
  await ctx.addInitScript(FAKES);const p=await ctx.newPage();p.on("pageerror",e=>errors.push(e.message));await p.goto(`${BASE}/b/${board}`);await p.locator("#mic-btn").waitFor({state:"visible",timeout:8000}).catch(()=>{});return {ctx,p}};
part(async(check)=>{const {ctx,p}=await open(1100,false);
check(await p.locator("#mic-btn").isVisible()&&!(await p.locator(".composer .post-btn").isVisible())&&await p.locator("#aloud-btn").count()===0,"an empty composer has the mic where Post goes, and no read-aloud button");
// Typing steps the mic aside (jxn's agent #1785, like the app); an empty box brings it back.
await p.fill("#composer-text","typed words");await p.locator("#mic-btn").waitFor({state:"hidden",timeout:3000}).catch(()=>{});const micGone=!(await p.locator("#mic-btn").isVisible());
await p.fill("#composer-text","");await p.locator("#mic-btn").waitFor({state:"visible",timeout:3000}).catch(()=>{});
check(micGone&&await p.locator("#mic-btn").isVisible(),"typing steps the mic aside; an empty box brings it back");
// Dictation: words land after what's already there (text the page put there, like a reply's @mention); stopping keeps them
await p.evaluate(()=>{document.getElementById("composer-text").value="note:"});
await p.evaluate(()=>{window.__say=[["remember the",false],["remember the milk",true]]});
await p.click("#mic-btn");check(await p.getAttribute("#mic-btn","aria-pressed")==="true","the mic button shows it's listening");
await p.waitForFunction(()=>document.getElementById("composer-text").value==="note: remember the milk",null,{timeout:4000}).catch(()=>{});check(await p.inputValue("#composer-text")==="note: remember the milk",`what you say goes in after what you typed (${JSON.stringify(await p.inputValue("#composer-text"))})`);
await p.click("#mic-btn");await p.waitForFunction(()=>document.getElementById("mic-btn").getAttribute("aria-pressed")==="false",null,{timeout:3000}).catch(()=>{});
check(await p.getAttribute("#mic-btn","aria-pressed")==="false"&&await p.inputValue("#composer-text")==="note: remember the milk","tapping it again stops, and the words stay in the box");
// "send it" posts
await p.fill("#composer-text","");
await p.evaluate(r=>{window.__say=[["ship the fix",false],[`ship the fix ${r} send it`,true]]},run);
await p.click("#mic-btn");
await p.locator(`#thread>.entry .body:has-text("ship the fix ${run}")`).first().waitFor({timeout:8000}).catch(()=>{});
await p.waitForFunction(()=>document.getElementById("composer-text").value==="",null,{timeout:3000}).catch(()=>{});
const posted=await p.locator(`#thread>.entry .body:has-text("ship the fix ${run}")`).count();
const leaked=await p.locator(`#thread>.entry .body:has-text("send it")`).count();
check(posted===1&&leaked===0&&await p.inputValue("#composer-text")==="","saying “send it” at the end posts the message (without the words “send it”)");
await ctx.close()});
// Phones: the composer bar fits, mic included
for(const w of [320,390])part(async(check)=>{const {ctx,p}=await open(w,true);
  const g=await p.evaluate(()=>{const bar=document.querySelector(".composer .bar"),r=bar.getBoundingClientRect(),bs=[...bar.querySelectorAll(":scope>button,:scope>.seg,:scope>span:not(.grow)")].filter(x=>x.offsetParent).map(x=>x.getBoundingClientRect());
    return {sw:bar.scrollWidth,cw:bar.clientWidth,out:bs.filter(x=>x.right>r.right+0.5||x.left<r.left-0.5).length,doc:document.documentElement.scrollWidth}});
  check(g.sw<=g.cw&&g.out===0&&g.doc<=w,`${w}px: the bar and its mic fit (${JSON.stringify(g)})`);
  await p.screenshot({path:`${SHOTS_DIR}/voice-${w}.png`});await ctx.close()});
// No speech support: no mic, and Post is there from the start
part(async(check)=>{const ctx=await b.newContext({viewport:{width:900,height:700}});const [k,...v]=ckP.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
  await ctx.addInitScript(()=>{delete window.webkitSpeechRecognition;delete window.SpeechRecognition;Object.defineProperty(window,"speechSynthesis",{value:undefined,configurable:true})});
  const p=await ctx.newPage();p.on("pageerror",e=>errors.push(e.message));await p.goto(`${BASE}/b/${board}`);await p.locator(".composer .post-btn").waitFor({state:"visible",timeout:8000}).catch(()=>{});
  check(await p.locator("#mic-btn").isHidden()&&await p.locator(".composer .post-btn").isVisible(),"a browser without speech support shows Post, no mic");await ctx.close()});
for(const lines of await Promise.all(parts))for(const l of lines)console.log(l);
const check=(ok,m)=>{console.log(`${ok?"✓":"✗"} ${m}`);if(!ok)fails++};
check(errors.length===0,`no page errors ${errors.join(" | ")}`);
await b.close();console.log(fails?`${fails} FAILED`:"voice: all passed");process.exit(fails?1:0);
