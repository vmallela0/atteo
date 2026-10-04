// Voice prototype (jxn #1069): the mic button dictates into the composer ("send it" posts), and "read replies aloud"
// blips on a message for you, then reads it on tap or on "go ahead". Speech APIs are faked so this runs headless.
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
let fails=0;const check=(ok,m)=>{console.log(`${ok?"✓":"✗"} ${m}`);if(!ok)fails++};
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
  await ctx.addInitScript(FAKES);const p=await ctx.newPage();p.on("pageerror",e=>errors.push(e.message));await p.goto(`${BASE}/b/${board}`);await p.waitForTimeout(900);return {ctx,p}};
const {ctx,p}=await open(1100,false);
check(await p.locator("#mic-btn").isVisible()&&await p.locator("#aloud-btn").isVisible(),"the composer has a mic button and a read-aloud button");
// Typing steps the mic aside (jxn's agent #1785, like the app); an empty box brings it back.
await p.fill("#composer-text","typed words");await p.waitForTimeout(100);const micGone=!(await p.locator("#mic-btn").isVisible());
await p.fill("#composer-text","");await p.waitForTimeout(100);
check(micGone&&await p.locator("#mic-btn").isVisible(),"typing steps the mic aside; an empty box brings it back");
// Dictation: words land after what's already there (text the page put there, like a reply's @mention); stopping keeps them
await p.evaluate(()=>{document.getElementById("composer-text").value="note:"});
await p.evaluate(()=>{window.__say=[["remember the",false],["remember the milk",true]]});
await p.click("#mic-btn");check(await p.getAttribute("#mic-btn","aria-pressed")==="true","the mic button shows it's listening");
await p.waitForTimeout(600);check(await p.inputValue("#composer-text")==="note: remember the milk",`what you say goes in after what you typed (${JSON.stringify(await p.inputValue("#composer-text"))})`);
await p.click("#mic-btn");await p.waitForTimeout(200);
check(await p.getAttribute("#mic-btn","aria-pressed")==="false"&&await p.inputValue("#composer-text")==="note: remember the milk","tapping it again stops, and the words stay in the box");
// "send it" posts
await p.fill("#composer-text","");
await p.evaluate(r=>{window.__say=[["ship the fix",false],[`ship the fix ${r} send it`,true]]},run);
await p.click("#mic-btn");await p.waitForTimeout(2000);
const posted=await p.locator(`#thread>.entry .body:has-text("ship the fix ${run}")`).count();
const leaked=await p.locator(`#thread>.entry .body:has-text("send it")`).count();
check(posted===1&&leaked===0&&await p.inputValue("#composer-text")==="","saying “send it” at the end posts the message (without the words “send it”)");
// Read aloud: off by default; on, a message for you blips and shows the bar
check(await p.getAttribute("#aloud-btn","aria-pressed")==="false","read-aloud starts off");
await p.click("#aloud-btn");check(await p.getAttribute("#aloud-btn","aria-pressed")==="true","the read-aloud button turns on");
const b0=await p.evaluate(()=>window.__blips);
await agentPost(`@${P} the deploy is done ${run}`);
await p.locator("#voice-pill").waitFor({state:"visible",timeout:8000}).catch(()=>{});
check(await p.locator("#voice-pill").isVisible()&&/For you from/.test(await p.locator("#vp-go").innerText()),`a message that mentions you shows the bar (${await p.locator("#vp-go").innerText().catch(()=>"")})`);
check(await p.evaluate(()=>window.__blips)>b0,"…and blips");
await p.click("#vp-go");await p.waitForTimeout(450);
const sp=await p.evaluate(()=>window.__spoken);check(sp.length===1&&sp[0].includes(`the deploy is done ${run}`)&&sp[0].startsWith(`${V}'s agent. `),`tapping the bar reads it out, who said it first (${JSON.stringify(sp)})`);
check(/Aria Online \(Natural\)/.test(await p.evaluate(()=>window.__voice)||''),`it reads with the best voice the device has (${await p.evaluate(()=>window.__voice)})`);
await p.waitForTimeout(700);check(await p.locator("#voice-pill").isHidden(),"the bar goes away when it's done");
// "go ahead"
await p.evaluate(()=>{window.__say=[["go ahead",true]]});
await agentPost(`@${P} tests are green ${run}`);
await p.waitForFunction(()=>window.__spoken.length>=2,null,{timeout:8000}).catch(()=>{});
check((await p.evaluate(()=>window.__spoken))[1]?.includes(`tests are green ${run}`),"after the blip, saying “go ahead” reads it");
// Not for you: no blip, no bar
await p.waitForTimeout(600);const b1=await p.evaluate(()=>window.__blips);
await agentPost(`a note for the whole board ${run}`);
await p.locator(`#thread>.entry .body:has-text("a note for the whole board ${run}")`).waitFor({timeout:8000}).catch(()=>{});await p.waitForTimeout(400);
check(await p.evaluate(()=>window.__blips)===b1&&await p.locator("#voice-pill").isHidden(),"a message that isn't for you stays quiet");
// A reply to your message is for you
const mine=await api("POST",`/api/boards/${board}/entries`,{text:`which port ${run}?`},{cookie:ckP});const ms=mine.entry?.seq??mine.seq;
await p.locator(`#e${ms}`).waitFor({timeout:8000}).catch(()=>{});
await mcp("read",{});await mcp("post",{type:"note",text:`8443 ${run}`,reply_to:ms});
await p.locator("#voice-pill").waitFor({state:"visible",timeout:8000}).catch(()=>{});
check(await p.locator("#voice-pill").isVisible(),"a reply to your message is for you too");
await p.click("#vp-x");check(await p.locator("#voice-pill").isHidden(),"✕ dismisses the bar");
// A browser that never starts speaking: retried once, then the bar clears and says so (jxn #1101)
await p.evaluate(()=>{window.__mute=true;window.__tries=0});
await agentPost(`@${P} silent one ${run}`);await p.locator("#voice-pill").waitFor({state:"visible",timeout:8000}).catch(()=>{});
await p.click("#vp-go");await p.waitForTimeout(800);check(/Reading/.test(await p.locator("#vp-go").innerText()),"while it tries, the bar says it's reading");
await p.waitForTimeout(3500);
check(await p.locator("#voice-pill").isHidden()&&/didn't play/.test(await p.locator("#toast").innerText())&&await p.evaluate(()=>window.__tries)===2,`if speech never starts, it tries twice, then clears the bar and says so (tries ${await p.evaluate(()=>window.__tries)})`);
await p.evaluate(()=>{window.__mute=false});
// Remembered across reloads
await p.reload();await p.waitForTimeout(700);check(await p.getAttribute("#aloud-btn","aria-pressed")==="true","read-aloud stays on after a reload");
await p.click("#aloud-btn");await p.reload();await p.waitForTimeout(700);check(await p.getAttribute("#aloud-btn","aria-pressed")==="false","…and off once turned off");
await ctx.close();
// Phones: both buttons fit in the composer bar
for(const w of [320,390]){const {ctx,p}=await open(w,true);
  const g=await p.evaluate(()=>{const bar=document.querySelector(".composer .bar"),r=bar.getBoundingClientRect(),bs=[...bar.querySelectorAll(":scope>button,:scope>.seg,:scope>span:not(.grow)")].filter(x=>x.offsetParent).map(x=>x.getBoundingClientRect());
    return {sw:bar.scrollWidth,cw:bar.clientWidth,out:bs.filter(x=>x.right>r.right+0.5||x.left<r.left-0.5).length,doc:document.documentElement.scrollWidth}});
  check(g.sw<=g.cw&&g.out===0&&g.doc<=w,`${w}px: mic and read-aloud fit in the composer bar (${JSON.stringify(g)})`);
  await p.screenshot({path:`${SHOTS_DIR}/voice-${w}.png`});await ctx.close()}
// No speech support: the buttons stay hidden
{const ctx=await b.newContext({viewport:{width:900,height:700}});const [k,...v]=ckP.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
  await ctx.addInitScript(()=>{delete window.webkitSpeechRecognition;delete window.SpeechRecognition;Object.defineProperty(window,"speechSynthesis",{value:undefined,configurable:true})});
  const p=await ctx.newPage();p.on("pageerror",e=>errors.push(e.message));await p.goto(`${BASE}/b/${board}`);await p.waitForTimeout(700);
  check(await p.locator("#mic-btn").isHidden()&&await p.locator("#aloud-btn").isHidden(),"a browser without speech support doesn't show the buttons");await ctx.close()}
check(errors.length===0,`no page errors ${errors.join(" | ")}`);
await b.close();console.log(fails?`${fails} FAILED`:"voice: all passed");process.exit(fails?1:0);
