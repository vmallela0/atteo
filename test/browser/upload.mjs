import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE=process.env.BASE||"http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run=Date.now().toString(36).slice(-4), A=`vedu${run}`, B=`jxn${run}`;
for (const u of [A,B]) await ops("users",{name:u,email:`${u}@example.com`,verified:"true"});
const tokA=(await ops("tokens",{user:A})).token;
const board=(await ops("boards",{user:B,title:"Uploads"})).board.id; await ops("members",{board,user:A});
const cookie=(await ops("sessions",{user:B})).cookie;
const mcp=async(name,args)=>(await (await fetch(`${BASE}/mcp?board=${board}`,{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream",authorization:`Bearer ${tokA}`},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})})).json()).result.content[0].text;
let fails=0;const check=(ok,m)=>{console.log(`${ok?"✓":"✗"} ${m}`);if(!ok)fails++};
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const ctx=await b.newContext({viewport:{width:1280,height:900}});const [k,...v]=cookie.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
const p=await ctx.newPage();const errors=[];p.on("pageerror",e=>errors.push(e.message));
await p.goto(`${BASE}/b/${board}`);await p.waitForTimeout(500);
// make test images in the page: a small PNG and a big 4000x3000 noisy PNG
const mk=(w,h,noise)=>p.evaluate(async([w,h,noise])=>{const c=document.createElement('canvas');c.width=w;c.height=h;const g=c.getContext('2d');
  const grd=g.createLinearGradient(0,0,w,h);grd.addColorStop(0,'#4ea1ff');grd.addColorStop(1,'#16a34a');g.fillStyle=grd;g.fillRect(0,0,w,h);
  if(noise){const d=g.getImageData(0,0,w,h);for(let i=0;i<d.data.length;i+=4){d.data[i]=Math.random()*255}g.putImageData(d,0,0)}
  g.fillStyle='#fff';g.font=(h/6)+'px sans-serif';g.fillText('Agent Soup',w/10,h/2);
  const blob=await new Promise(r=>c.toBlob(r,'image/png'));return [...new Uint8Array(await blob.arrayBuffer())]},[w,h,noise]).then(a=>Buffer.from(a));
const small=await mk(600,400,false);
// 1) attach button: small image + a text file
await p.setInputFiles("#attach-input",[{name:"diagram.png",mimeType:"image/png",buffer:small},{name:"notes.md",mimeType:"text/markdown",buffer:Buffer.from("# Notes\n\nCheckout is fixed.\n")}]);
await p.waitForTimeout(400);
check(await p.locator("#attachments .att").count()===2,"attach: two previews (image thumbnail + file chip)");
await p.click("#composer-text");await p.keyboard.type("Here's the diagram and notes");await p.keyboard.press("Enter");
await p.waitForFunction(()=>[...document.querySelectorAll('#thread .entry:not(.pending)')].some(e=>e.textContent.includes("Here's the diagram")),null,{timeout:8000}); // several files are one message now (#738)await p.waitForTimeout(500);
check(await p.locator('#thread figure.img img, #thread .mg-tile img').count()===1,"the image shows inline in the chat");
check((await p.locator('#thread .entry').first().textContent()).includes("Here's the diagram and notes"),"the text went with the first file");
check(await p.locator('#thread [data-open-file="notes.md"]').count()>=1,"the text file is an ordinary file (Open in Files)");
check(!(await p.locator("#attachments").isVisible())&&(await p.inputValue("#composer-text"))==="","composer cleared");
// 2) paste a big photo → shrunk to ≤1600px WebP
const bigSize=await p.evaluate(async()=>{const w=4000,h=3000,c=document.createElement('canvas');c.width=w;c.height=h;const g=c.getContext('2d');
  const d=g.createImageData(w,h);for(let i=0;i<d.data.length;i++)d.data[i]=(i%4===3)?255:Math.random()*255;g.putImageData(d,0,0);
  const blob=await new Promise(r=>c.toBlob(r,'image/png'));const f=new File([blob],"photo.png",{type:"image/png"});const dt=new DataTransfer();dt.items.add(f);
  document.getElementById('composer-text').dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));return blob.size});
await p.waitForSelector("#attachments:not([hidden]) .att",{timeout:15000});
await p.click("#composer-text");await p.keyboard.press("Enter");
await p.waitForFunction(()=>document.querySelectorAll('#thread figure.img img, #thread .mg-tile img').length>=2,null,{timeout:15000});await p.waitForTimeout(500);
const files=await p.evaluate(async b=>(await (await fetch('/api/boards/'+b+'/files')).json()).docs,board);
const photo=files.find(f=>f.name==="photo.webp");
check(photo&&photo.mime==="image/webp"&&photo.size<1500000,`paste: big photo shrunk to WebP (${photo?.size} B, was ${bigSize})`);
const dims=await p.evaluate(()=>{const i=[...document.querySelectorAll('#thread figure.img img, #thread .mg-tile img')].pop();return [i.getAttribute('width'),i.getAttribute('height')]});
check(dims[0]==="1600"&&dims[1]==="1200",`…at 1600×1200 (${dims})`);
// 3) drop a binary file and a big text file (gzipped to fit)
const bin=Buffer.from([0,1,2,3,255,254,0,7,8,9,10,0,0,1]); const huge="line of text that compresses well\n".repeat(60000);
await p.evaluate(([bin,huge])=>{const dt=new DataTransfer();dt.items.add(new File([new Uint8Array(bin)],"blob.bin",{type:"application/octet-stream"}));dt.items.add(new File([huge],"big.log",{type:"text/plain"}));
  const t=document.querySelector('.conv');t.dispatchEvent(new DragEvent('dragover',{dataTransfer:dt,bubbles:true,cancelable:true}));t.dispatchEvent(new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true}))},[[...bin],huge]);
await p.waitForFunction(()=>document.querySelectorAll('#attachments .att').length===2,null,{timeout:15000});
const names=await p.locator("#attachments .att-name").allTextContents();
check(names.includes("blob.bin")&&names.includes("big.log.gz"),`drop: both files queued; the 2 MB log was gzipped (${names})`);
await p.click("#composer-text");await p.keyboard.press("Enter");
await p.waitForFunction(()=>document.querySelectorAll('#thread a[download]').length>=2,null,{timeout:15000});
check(await p.locator('#thread a[download="blob.bin"]').count()===1,"binary file offers a Download");
// served files: inert, downloads for non-images
const head=async(name)=>{const r=await fetch(`${BASE}/api/boards/${board}/image?name=${name}`,{headers:{cookie}});return [r.status,r.headers.get("content-type"),r.headers.get("content-disposition"),r.headers.get("content-security-policy")]};
const hi=await head("diagram.png"), hb=await head("blob.bin");
check(hi[0]===200&&hi[1]==="image/png"&&hi[2]==="inline"&&/sandbox/.test(hi[3]),`image served inline and sandboxed (${hi})`);
check(hb[1]==="application/octet-stream"&&/^attachment/.test(hb[2]),`other files only as downloads (${hb})`);
const so=await fetch(`${BASE}/api/boards/${board}/image?name=diagram.png`,{redirect:"manual"});check((so.status===303||so.status===401)&&!/image/.test(so.headers.get("content-type")||""),`signed-out visitors are sent to sign in, not given the file (${so.status})`);
// lightbox and Files tab
await p.locator('#thread figure.img .img-open, #thread .mg-tile').first().click();await p.waitForTimeout(300);
check(await p.locator('#lightbox').isVisible(),"click an image → full size");await p.locator('#lightbox').click();
await p.locator('#thread figure.img [data-open-file], #thread .mcap [data-open-file]').first().click();await p.waitForTimeout(500);
check(await p.locator('#doc-view .doc-img img').isVisible()&&!(await p.locator('#doc-edit').count()),"Open in Files shows the picture, no Edit");
// agents see a description of the image
const got=await mcp("read",{});
check(/diagram\.png/.test(got)&&/file: photo\.webp/.test(got),"agents see the image posts as files");
check(errors.length===0,`no page errors ${errors.join(" | ")}`);
await p.locator('#board-tabs button').first().click();await p.waitForTimeout(400);
await p.screenshot({path:`${SHOTS_DIR}/uploads.png`});
await b.close();console.log(fails?`${fails} FAILED`:"all upload checks passed");
