// E2E Phase 1a on the web: pictures and files on an encrypted board are encrypted in the browser (a key per file, carried
// in the message's encrypted extras), the server stores only ciphertext, and the CLI decrypts them (and the other way
// round). Your own message can be edited for 15 minutes: the browser encrypts the new text and keeps the files.
import { chromium } from "playwright-core";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const BASE=process.env.BASE||"http://localhost:8787", WT=new URL("../../", import.meta.url).pathname, CLI=WT+"cli/dist/agent-soup.mjs";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run=Date.now().toString(36).slice(-4), A=`anf${run}`, B=`bof${run}`;
const dir=mkdtempSync(join(tmpdir(),"e2e-files-"));
const tok={},cred={};
for (const u of [A,B]) { await ops("users",{name:u,email:`${u}@example.com`,verified:"true"}); tok[u]=(await ops("tokens",{user:u})).token;
  cred[u]=join(dir,`${u}.json`); writeFileSync(cred[u],JSON.stringify({server:BASE,user:u,token:tok[u],expires_at:Date.now()+86400e3}),{mode:0o600}); }
const cli=(u,args,cwd=dir)=>new Promise(res=>{const p=spawn("node",[CLI,...args],{cwd,env:{...process.env,AGENT_BOARD_CREDENTIALS_FILE:cred[u],AGENT_BOARD_SERVER:BASE,XDG_CONFIG_HOME:join(dir,`cfg-${u}`)}});
  let out="",err="";p.stdout.on("data",d=>out+=d);p.stderr.on("data",d=>err+=d);p.stdin.end();p.on("close",code=>res({code,out,err}))});
const board=(await ops("boards",{user:A,title:`Sealed files ${run}`,encrypted:true})).board.id;
await ops("members",{board,user:B});
let fails=0;const check=(ok,m)=>{console.log(`${ok?"✓":"✗"} ${m}`);if(!ok)fails++};
const until=async(get,ok,ms=10000)=>{const t=Date.now();let v;for(;;){v=await get();if(ok(v)||Date.now()-t>ms)return v;await new Promise(r=>setTimeout(r,60))}};
const sealed=async()=>(await fetch(`${BASE}/api/boards/${board}/sealed?after=0`,{headers:{authorization:`Bearer ${tok[A]}`}}).then(r=>r.json())).entries;
const blob=async id=>Buffer.from(await (await fetch(`${BASE}/api/boards/${board}/sealed-files/${id}`,{headers:{authorization:`Bearer ${tok[B]}`}})).arrayBuffer());
const b=await chromium.launch({executablePath: process.env.PW_CHROME || undefined});
const ck=(await ops("sessions",{user:A})).cookie;const ctx=await b.newContext({viewport:{width:1280,height:900},acceptDownloads:true});
{ const [k,...v]=ck.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]); }
const errors=[];const pa=await ctx.newPage();pa.on("pageerror",e=>errors.push(e.message));
await cli(B,["keys"]);await cli(B,["use",board]);
await pa.goto(`${BASE}/b/${board}`);await pa.waitForFunction(()=>!document.querySelector("form.composer").hidden,null,{timeout:10000}).catch(()=>{});
check(await pa.locator("#attach-btn").count()===1,"the attach button is there on an encrypted board");
// A picture (a real PNG: the composer reads its size) and a text file, posted with a line of text.
const png=Buffer.from(await pa.evaluate(()=>{const c=document.createElement("canvas");c.width=c.height=2;const g=c.getContext("2d");g.fillStyle="#c33";g.fillRect(0,0,2,2);return c.toDataURL("image/png").split(",")[1]}),"base64");
const notes=`secret notes ${run}\n`.repeat(5000); // ~90 KB: two chunks
await pa.locator("#attach-input").setInputFiles([{name:"dot.png",mimeType:"image/png",buffer:png},{name:"notes.txt",mimeType:"text/plain",buffer:Buffer.from(notes)}]);
await until(()=>pa.locator("#attachments .att").count(),n=>n===2);
await pa.locator("#composer-text").fill(`files from the web ${run}`);await pa.locator("form.composer button.primary").click();
await pa.locator("#thread .entry .e2e-text",{hasText:`files from the web ${run}`}).waitFor({timeout:10000}).catch(()=>{});
const last=(await sealed()).at(-1),env=JSON.parse(last.payload);
check(env.v===2&&env.x&&typeof env.x.ct==="string"&&last.files?.length===2,`stored as one envelope with encrypted extras and 2 files (${last.files?.length})`);
const raw=(await Promise.all(last.files.map(blob))).sort((x,y)=>y.length-x.length)[0];
check(!raw.includes(Buffer.from("secret notes"))&&raw.length===notes.length+2*16,`the server has only ciphertext (${raw.length} bytes for ${notes.length}: two chunks, a tag each)`);
check(await pa.locator("#attachments .att").count()===0,"…and the composer's attachments are cleared");
const img=pa.locator(`#e${last.seq} .mg-tile img`);
const w=await until(()=>img.evaluate(i=>i.complete?i.naturalWidth:0).catch(()=>0),n=>n>0);
check(w===2&&/^blob:/.test(await img.getAttribute("src")),`the picture shows, decrypted in the page (naturalWidth ${w})`);
await pa.locator(`#e${last.seq} .mg-tile`).click();
check(await until(()=>pa.locator("#lightbox[open]").count(),n=>n===1)===1&&/^blob:/.test(await pa.locator("#lightbox-img").getAttribute("src")),"…and opens in the lightbox");
await pa.keyboard.press("Escape");
const [dl]=await Promise.all([pa.waitForEvent("download"),pa.locator(`#e${last.seq} [data-sf-dl]`).click()]);
const got=[];for await (const c of await dl.createReadStream())got.push(c);
check(dl.suggestedFilename()==="notes.txt"&&Buffer.concat(got).toString()===notes,`Download decrypts the file in the browser (${dl.suggestedFilename()})`);
// The CLI reads what the web wrote, files and all.
let r=await until(()=>cli(B,["read","--all"]),x=>x.out.includes("notes.txt"));
check(r.out.includes(`files from the web ${run}`)&&r.out.includes("📎 dot.png")&&r.out.includes("📎 notes.txt"),"the CLI lists the web's files");
r=await cli(B,["download",String(last.seq)]);
check(r.code===0&&readFileSync(join(dir,"notes.txt"),"utf8")===notes&&readFileSync(join(dir,"dot.png")).equals(png),`…and atteo download decrypts them byte for byte (${r.code})`);
// And the other way: a file the CLI shares shows up as a chip the browser decrypts.
writeFileSync(join(dir,"plan.md"),`# plan ${run}\n`);
r=await cli(B,["share",join(dir,"plan.md"),"--note",`the plan ${run}`]);
const chip=pa.locator("#thread .entry [data-sf-dl]").last();
await until(()=>pa.locator("#thread .entry .e2e-text",{hasText:`the plan ${run}`}).count(),n=>n===1);
const [dl2]=await Promise.all([pa.waitForEvent("download"),chip.click()]);
const got2=[];for await (const c of await dl2.createReadStream())got2.push(c);
check(r.code===0&&Buffer.concat(got2).toString()===`# plan ${run}\n`,"a file the CLI shared opens in the browser");
// An approval request from an encrypted board (#5542): what's asked goes to the board; the details and command only to
// the deciding person's own devices. Bob's browser (approved by his CLI first) is one of them; Ann's isn't.
const ctxB=await b.newContext({viewport:{width:1280,height:900}});
{ const ckB=(await ops("sessions",{user:B})).cookie;const [k,...v]=ckB.split(";")[0].split("=");await ctxB.addCookies([{name:k,value:v.join("="),url:BASE}]); }
const pb=await ctxB.newPage();pb.on("pageerror",e=>errors.push(e.message));await pb.goto(`${BASE}/b/${board}`);
await until(()=>pb.locator("#e2e-msg").innerText().catch(()=>""),t=>/waiting for the board's key/.test(t));
r=await until(()=>cli(B,["read"]),x=>/keys approve \S+/.test(x.err));await cli(B,["keys","approve",(r.err.match(/keys approve (\S+)/)||[])[1]]);
r=await cli(B,["approvals","ask",`ship the plan ${run}`,"--details",`deploy plan ${run} to staging`,"--command","make deploy"]);
check(r.code===0&&/ap_/.test(r.out),`Bob's agent asks for approval on the encrypted board (${r.code})`);
const apTitle=pa.locator("#thread .entry .e2e-text",{hasText:`ship the plan ${run}`});
await until(()=>apTitle.count(),n=>n===1);
await pa.evaluate(()=>e2eSync());await pa.waitForTimeout(300); // a negative: Ann's page must not show the details
check(await apTitle.count()===1&&!(await pa.locator("#thread").innerText()).includes(`deploy plan ${run}`)&&await pa.locator(".e2e-apd").count()===0,"…members read what's asked, never the details or command");
await pb.evaluate(()=>e2eSync());
const apd=pb.locator(".apc .e2e-apd");await apd.first().waitFor({timeout:8000}).catch(()=>{});
check((await apd.innerText().catch(()=>"")).includes(`deploy plan ${run} to staging`)&&(await apd.innerText().catch(()=>"")).includes("$ make deploy"),"…Bob's own browser opens the details and command on his card");
// A message naming a file by a path, not an id (#5542), crafted with a board key: never fetched, never shown.
{ const { createCipheriv, createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } = await import("node:crypto");
  const k=generateKeyPairSync("x25519"),pub=Buffer.from(k.publicKey.export({format:"jwk"}).x,"base64url").toString("base64");
  const kid=(await (await fetch(`${BASE}/api/me/keys`,{method:"POST",headers:{authorization:`Bearer ${tok[B]}`,"content-type":"application/json"},body:JSON.stringify({public_key:pub,label:"test device"})})).json()).id;
  await cli(B,["read"]);await cli(B,["keys","approve",kid]);await cli(B,["read"]);
  const st=await (await fetch(`${BASE}/api/boards/${board}/epochs`,{headers:{authorization:`Bearer ${tok[B]}`}})).json(),g=st.mine.find(x=>x.kid===kid&&x.epoch===st.current);
  const un=(key,iv,d)=>{const raw=Buffer.from(d,"base64"),c=createDecipheriv("aes-256-gcm",key,Buffer.from(iv,"base64"));c.setAuthTag(raw.subarray(raw.length-16));return Buffer.concat([c.update(raw.subarray(0,raw.length-16)),c.final()])};
  const shared=diffieHellman({privateKey:k.privateKey,publicKey:createPublicKey({key:{kty:"OKP",crv:"X25519",x:Buffer.from(g.epk,"base64").toString("base64url")},format:"jwk"})});
  const bk=un(Buffer.from(hkdfSync("sha256",shared,Buffer.concat([Buffer.from(g.epk,"base64"),Buffer.from(pub,"base64")]),"agent-soup board key v2",32)),g.iv,g.wrapped);
  const enc=t=>{const iv=randomBytes(12),c=createCipheriv("aes-256-gcm",bk,iv);return {iv:iv.toString("base64"),ct:Buffer.concat([c.update(t),c.final(),c.getAuthTag()]).toString("base64")}};
  const bad="sf_real?/../../../../evil";
  const x=enc(JSON.stringify({xv:1,files:[{id:bad,name:"evil.png",mime:"image/png",size:3,key:randomBytes(32).toString("base64"),chunk:65536}]}));
  const reqs=[];pa.on("request",q=>{if(/evil/.test(q.url()))reqs.push(q.url())});
  const pr=await fetch(`${BASE}/api/boards/${board}/sealed`,{method:"POST",headers:{authorization:`Bearer ${tok[B]}`,"content-type":"application/json"},body:JSON.stringify({payload:JSON.stringify({v:2,epoch:st.current,...enc(`crafted ${run}`),x})})});
  await until(()=>pa.locator("#thread .entry .e2e-text",{hasText:`crafted ${run}`}).count(),n=>n===1);await pa.waitForTimeout(300); // a negative: no fetch
  const row=pa.locator("#thread .entry",{has:pa.locator(".e2e-text",{hasText:`crafted ${run}`})});
  check(pr.status===201&&await row.locator("[data-sf-img],[data-sf-dl]").count()===0&&!reqs.length,`a file id that isn't sf_… is dropped: not shown, not fetched (${reqs.length} requests)`);
  r=await cli(B,["read"]);check(!r.out.includes("evil.png"),"…and the CLI doesn't list it"); }
// Edit: own message, new text encrypted again, the files kept.
await pa.locator(`#e${last.seq} [data-edit]`).click();
await pa.locator(`#e${last.seq} [data-edit-box]`).fill(`files from the web, edited ${run}`);
await Promise.all([pa.waitForNavigation(),pa.locator(`#e${last.seq} [data-edit-box] ~ button`).first().click()]);
await pa.locator("#thread .entry .e2e-text",{hasText:`edited ${run}`}).waitFor({timeout:10000}).catch(()=>{});
check(await pa.locator(`#e${last.seq} .e2e-text`,{hasText:`edited ${run}`}).count()===1&&await pa.locator(`#e${last.seq} [data-sf-dl]`).count()===1,"Edit re-encrypts the message in the browser and keeps its files");
const after=(await sealed()).find(e=>e.seq===last.seq);
check(after.edited_at>0&&!after.payload.includes("edited")&&after.files.length===2,"…the server has the new envelope only (edited_at set, still 2 files)");
r=await until(()=>cli(B,["read","--all"]),x=>x.out.includes(`edited ${run}`));
check(r.out.includes(`files from the web, edited ${run}`)&&r.out.includes("edited"),"the CLI reads the edit");
check(await pa.locator(`#e${(await sealed()).at(-1).seq} [data-edit]`).count()===0,"…and there's no Edit on someone else's message");
// A handoff (docs/SPEC.md §16): Bob's CLI seals the branch and commits; Ann's page opens them under the message and
// keeps the clear line (state, check counts); board info's gate queue shows the branch the page opened.
{ const repo=mkdtempSync(join(tmpdir(),"e2e-ho-")),genv={...process.env,GIT_AUTHOR_NAME:"t",GIT_AUTHOR_EMAIL:"t@example.com",GIT_COMMITTER_NAME:"t",GIT_COMMITTER_EMAIL:"t@example.com"};
  const g=(...a)=>execFileSync("git",a,{cwd:repo,env:genv,stdio:"pipe"}).toString().trim();
  g("init","-q","-b","main");writeFileSync(join(repo,"a.txt"),"1\n");g("add",".");g("commit","-qm","m");g("update-ref","refs/remotes/origin/main",g("rev-parse","HEAD"));
  g("checkout","-qb",`gate/web-${run}`);writeFileSync(join(repo,"a.txt"),"2\n");g("commit","-qam","f");const head=g("rev-parse","HEAD");
  r=await cli(B,["post","handoff","--checks","vitest 9, e2e 2/3","--board",board],repo);
  const h=Number((r.out.match(/Posted #(\d+)/)||[])[1]);
  check(r.code===0&&h>0,`Bob's CLI hands off on the encrypted board (${r.code} ${r.err.slice(0,160)})`);
  await pa.evaluate(()=>e2eSync());
  const ho=pa.locator(`#e${h} .e2e-ho`);await ho.waitFor({timeout:10000}).catch(()=>{});
  check((await ho.innerText().catch(()=>"")).includes(`ready to gate: gate/web-${run} @${head.slice(0,7)}`),"the page opens the handoff's branch and commit");
  check((await pa.locator(`#e${h} .handoff:not(.e2e-ho)`).innerText().catch(()=>"")).includes("e2e 2 (1 failed)"),"…and keeps the clear line (check counts)");
  await pa.locator('[data-open="invite"]').first().click();await pa.locator("#acc-gate:not([hidden])").waitFor({timeout:8000}).catch(()=>{});
  await until(()=>pa.locator("#acc-handoffs .acc-row").first().innerText().catch(()=>""),t=>t.includes(`gate/web-${run}`),5000);
  check((await pa.locator("#acc-handoffs .acc-row").first().innerText().catch(()=>"")).includes(`🔒 gate/web-${run}`),"board info's gate queue shows the branch this page opened");
  await pa.keyboard.press("Escape"); }
check(errors.length===0,`no page errors ${errors.join(" | ")}`);
await b.close();console.log(fails?`${fails} FAILED`:"all encrypted file and edit checks passed");
if (fails) process.exitCode = 1;
