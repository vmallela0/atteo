// #347: encryption v2 on the web, against the real CLI (cli/dist/agent-soup.mjs with test credentials, as in test/cli.mjs).
// The web and the CLI read each other both ways; a newcomer reads history; your new device waits for your Approve (in
// the browser, and in the CLI for a new browser); removing someone rotates the key; the server only ever has ciphertext.
// Steps wait for their result (opus-a #2824): `until` polls the page, the API or the CLI instead of fixed sleeps. The few
// short sleeps left guard a negative ("nothing is granted yet", "no draft is kept"), where there's nothing to wait for.
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { d1Execute } from "./lib/d1.mjs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// A download's text through its stream: download.path() isn't available when the browser is shared (run.mjs connects to it).
const dlText = async (dl) => { const chunks = []; for await (const c of await dl.createReadStream()) chunks.push(c); return Buffer.concat(chunks).toString("utf8"); };
const BASE=process.env.BASE||"http://localhost:8787", WT=new URL("../../", import.meta.url).pathname, CLI=WT+"cli/dist/agent-soup.mjs";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run=Date.now().toString(36).slice(-4), A=`ann${run}`, B=`bob${run}`, C=`cat${run}`;
const dir=mkdtempSync(join(tmpdir(),"e2e-web-"));
const tok={},cred={};
for (const u of [A,B,C]) { await ops("users",{name:u,email:`${u}@example.com`,verified:"true"}); tok[u]=(await ops("tokens",{user:u})).token;
  cred[u]=join(dir,`${u}.json`); writeFileSync(cred[u],JSON.stringify({server:BASE,user:u,token:tok[u],expires_at:Date.now()+86400e3}),{mode:0o600}); }
const cli=(u,args)=>new Promise(res=>{const p=spawn("node",[CLI,...args],{cwd:dir,env:{...process.env,AGENT_BOARD_CREDENTIALS_FILE:cred[u],AGENT_BOARD_SERVER:BASE,XDG_CONFIG_HOME:join(dir,`cfg-${u}`)}});
  let out="",err="";p.stdout.on("data",d=>out+=d);p.stderr.on("data",d=>err+=d);p.stdin.end();p.on("close",code=>res({code,out,err}))});
const sql=(q)=>d1Execute(`--command ${JSON.stringify(q)}`,{cwd:WT});
const board=(await ops("boards",{user:A,title:`Secret plans ${run}`,encrypted:true})).board.id;
await ops("members",{board,user:B});
let fails=0;const check=(ok,m)=>{console.log(`${ok?"✓":"✗"} ${m}`);if(!ok)fails++};
/** Polls get() until ok(value) (or ms pass) and returns the last value. */
const until=async(get,ok,ms=10000)=>{const t=Date.now();let v;for(;;){v=await get();if(ok(v)||Date.now()-t>ms)return v;await new Promise(r=>setTimeout(r,60))}};
const readUntil=(u,want,args=["read","--all"])=>until(()=>cli(u,args),r=>want.every(w=>r.out.includes(w)));
const b=await chromium.launch({executablePath: process.env.PW_CHROME || undefined});
const login=async(u,opts={})=>{const ck=(await ops("sessions",{user:u})).cookie;const ctx=await b.newContext({viewport:{width:1280,height:900},...opts});if(process.env.SAFARI_IDB)await ctx.addInitScript(()=>{const no=v=>v&&typeof v==='object'&&Object.values(v).some(x=>x instanceof CryptoKey);for(const m of ['add','put']){const o=IDBObjectStore.prototype[m];IDBObjectStore.prototype[m]=function(v,...a){if(no(v))throw new DOMException('CryptoKey cannot be stored','DataCloneError');return o.call(this,v,...a)}}});const [k,...v]=ck.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);return ctx};
const errors=[];const watch=p=>p.on("pageerror",e=>errors.push(e.message));
const post=async(p,text)=>{await p.locator("#composer-text").fill(text);await p.locator("form.composer button.primary").click()};
const bodyOf=(p,text)=>p.locator("#thread .entry .e2e-text",{hasText:text});
// The board's log download (#3401): Members & access → This board → Download the log; the saved .jsonl, line by line.
const logOf=async p=>{await p.locator('[data-open="invite"]').first().click();await p.locator("#log-export").waitFor();
  const [dl]=await Promise.all([p.waitForEvent("download"),p.locator("#log-export").click()]);const t=await dlText(dl);
  await p.evaluate(()=>document.getElementById("invite").close());return t.split("\n").filter(Boolean).map(l=>JSON.parse(l))};
const sealed=async()=>(await fetch(`${BASE}/api/boards/${board}/sealed?after=0`,{headers:{authorization:`Bearer ${tok[A]}`}}).then(r=>r.json())).entries;

// B's CLI is on the board first (its key exists, so the web wraps epoch 1 to it on first sight).
await cli(B,["keys"]);await cli(B,["use",board]);
// Ann opens the board in the browser: a device key is made, registered, and epoch 1 opened (wrapped to her and Bob).
const ctxA=await login(A);const pa=await ctxA.newPage();watch(pa);
await pa.goto(`${BASE}/b/${board}`);await pa.waitForFunction(()=>!document.querySelector("form.composer").hidden,null,{timeout:10000}).catch(()=>{});
const keysA=(await (await fetch(`${BASE}/api/me/keys`,{headers:{authorization:`Bearer ${tok[A]}`}})).json()).keys;
const OS={darwin:"Mac",win32:"Windows"}[process.platform]??"Linux"; // the label names the OS the browser runs on
check(keysA.length===1&&keysA[0].label===`Chrome on ${OS} (web)`,`the browser registered its own device key ("${keysA[0]?.label}")`);
check(await pa.evaluate(async()=>{const db=await new Promise(r=>{const q=indexedDB.open("agent-soup-e2e",1);q.onsuccess=()=>r(q.result)});
  const d=await new Promise(r=>{const q=db.transaction("keys").objectStore("keys").getAll();q.onsuccess=()=>r(q.result[0])});return d&&d.priv instanceof CryptoKey&&d.priv.extractable===false}),"…kept in IndexedDB as a non-extractable CryptoKey");
check(!(await pa.locator("form.composer").isHidden()),"the composer is there once the browser holds the board's key");
check(await pa.locator("#attach-btn").count()===0,"…without the attach button (files aren't encrypted)");
await post(pa,`hello from the web ${run}`);
await bodyOf(pa,`hello from the web ${run}`).waitFor({timeout:8000}).catch(()=>{});
check(await bodyOf(pa,`hello from the web ${run}`).count()===1,"web → posts encrypted and shows its own message decrypted");
let env=JSON.parse((await sealed()).at(-1).payload);
check(env.v===2&&env.epoch===1&&typeof env.ct==="string"&&!JSON.stringify(env).includes("hello"),"…stored as a v2 envelope at epoch 1 (no plaintext)");
const plain=await (await fetch(`${BASE}/api/boards/${board}/entries?limit=50`,{headers:{authorization:`Bearer ${tok[A]}`}})).text();
check(!plain.includes(`hello from the web ${run}`),"…and the plain entries API never has the text");
let r=await cli(B,["read","--all"]);
check(r.out.includes(`hello from the web ${run}`),"CLI reads what the web wrote");
r=await cli(B,["post",`hello from the cli ${run}`]);
await bodyOf(pa,`hello from the cli ${run}`).waitFor({timeout:8000}).catch(()=>{});
check(await bodyOf(pa,`hello from the cli ${run}`).count()===1,`web reads what the CLI wrote, live (${r.code})`);
const logA=await logOf(pa);
check(logA.some(e=>e.text===`hello from the web ${run}`)&&logA.some(e=>e.text===`hello from the cli ${run}`)&&logA.every(e=>e.encrypted===true&&!("payload" in e)),`the log download is decrypted in this browser, never the ciphertext (${logA.length} lines)`);
// Thread reply from the web, read by the CLI
await pa.locator(`#thread .entry:has(.e2e-text:has-text("hello from the cli ${run}")) [data-reply]`).first().click();
check(/hello from the cli/.test(await pa.locator("#replying").innerText()),"Reply points the composer at the message (its decrypted first line shows in the reply line)");
await pa.locator("#composer-text").fill(`threaded web reply ${run}`);await pa.locator("form.composer button.primary").click();
await until(()=>pa.locator(`#thread>.entry[data-root] .e2e-text:has-text("threaded web reply ${run}")`).count(),n=>n===1);
check(await pa.locator(`#thread>.entry[data-root] .e2e-text:has-text("threaded web reply ${run}")`).count()===1&&await pa.locator("#replying").isHidden(),"…the encrypted reply lands in that message's thread, and the composer leaves reply mode");
r=await cli(B,["read","--all"]);check(r.out.includes(`threaded web reply ${run}`)&&/re #\d+/.test(r.out),"a thread reply from the web is encrypted too, and the CLI reads it as a reply");
// A newcomer (Cat, CLI) reads history once a member's device hands over the key: here, Ann's browser.
await ops("members",{board,user:C});await cli(C,["keys"]);await cli(C,["use",board]);
await pa.evaluate(()=>e2eSync());
r=await readUntil(C,[`hello from the web ${run}`,`hello from the cli ${run}`]);
check(r.out.includes(`hello from the web ${run}`)&&r.out.includes(`hello from the cli ${run}`),"newcomer (CLI) reads the history after Ann's browser hands over the key");
check(await until(()=>pa.locator("#thread .entry",{hasText:`gave ${C}'s`}).count(),n=>n>=1)>=1,"…and a 🔑 line on the board says so");
// Ann's second device: her CLI. Bob can't hand it the key; Ann's browser asks her to Approve; then it reads.
await cli(A,["keys"]);await cli(A,["use",board]);await cli(B,["read"]);
r=await cli(A,["read","--all"]);
check(!r.out.includes(`hello from the web ${run}`),"Ann's new CLI device can't read yet (Bob may not hand it over)");
await pa.evaluate(()=>e2eSync());await pa.locator("[data-e2e-approve]").waitFor({timeout:6000}).catch(()=>{});
const ask=await pa.locator(".e2e-ask").first().innerText().catch(()=>"");
check(/A new device of yours wants this board's key/.test(ask),`Ann's browser asks her: "${ask.replace(/\s+/g," ").slice(0,90)}…"`);
await pa.locator("#e2e-msg").scrollIntoViewIfNeeded();await pa.screenshot({path:`${SHOTS_DIR}/e2e-approve-light.png`,clip:{x:0,y:0,width:1280,height:360}});
await pa.waitForTimeout(500);r=await cli(A,["read","--all"]); // a negative: give an unwanted grant time to show
check(!r.out.includes(`hello from the web ${run}`),"…nothing is granted before she clicks Approve");
await pa.locator("[data-e2e-approve]").click();
r=await readUntil(A,[`hello from the web ${run}`]);
check(r.out.includes(`hello from the web ${run}`),"after Approve in the browser, Ann's CLI reads the board");
check(await until(()=>pa.locator(".e2e-ask").count(),n=>n===0)===0,"…and the prompt is gone");
// Bob's new browser: a later device of Bob's. It waits; Ann's browser doesn't hand it over; Bob's CLI approves it.
const ctxB=await login(B);const pb=await ctxB.newPage();watch(pb);
await pb.goto(`${BASE}/b/${board}`);
const wait=await until(()=>pb.locator("#e2e-msg").innerText().catch(()=>""),t=>/waiting for the board's key/.test(t));
await until(()=>pb.locator("#thread .e2e-none").count(),n=>n>=3);
check(/waiting for the board's key/.test(wait)&&await pb.locator("form.composer").isHidden(),"Bob's new browser waits for the key (no composer)");
check(await pb.locator("#thread .e2e-none").count()>=3&&await pb.locator("#thread .e2e-text").count()===0,"…messages show \"Can't read this on this device yet\"");
const logB=await logOf(pb);
check(logB.length>=3&&logB.every(e=>/^\(Can't /.test(e.text))&&!JSON.stringify(logB).includes(`hello from`),`…its log download keeps each entry with the reason instead (${JSON.stringify(logB[0]?.text).slice(0,60)})`);
await pb.screenshot({path:`${SHOTS_DIR}/e2e-waiting-light.png`});
await pa.evaluate(()=>e2eSync());await pa.waitForTimeout(400); // a negative: nothing should be granted
await pb.evaluate(()=>e2eSync());await pb.waitForTimeout(400);
check(await pa.locator(`[data-e2e-approve]`).count()===0&&await pb.locator("#thread .e2e-text").count()===0,"Ann's browser doesn't grant Bob's new device (only Bob's own devices may)");
r=await cli(B,["read"]);const bkid=(r.err.match(/keys approve (\S+)/)||[])[1];
check(!!bkid,"Bob's CLI says a new device of his is waiting");
await cli(B,["keys","approve",bkid]);await cli(B,["read"]);
await pb.evaluate(()=>e2eSync());await bodyOf(pb,`hello from the web ${run}`).waitFor({timeout:6000}).catch(()=>{});
check(await bodyOf(pb,`hello from the web ${run}`).count()===1&&!(await pb.locator("form.composer").isHidden()),"after Bob's CLI approves it, Bob's browser reads the history and can write");
await post(pb,`bob in the browser ${run}`);
r=await readUntil(A,[`bob in the browser ${run}`]);check(r.out.includes(`bob in the browser ${run}`),"…and what he writes there, Ann's CLI reads");
// Removing Cat rotates: the next message (from the web) opens epoch 2 for the rest only.
const rm=await pa.evaluate(async([bd,u])=>(await fetch(`/api/boards/${bd}/members/${u}/remove`,{method:"POST"})).status,[board,C]);
check(rm===200,`Ann removes Cat (${rm})`);
await pa.reload();await pa.waitForFunction(()=>!document.querySelector("form.composer").hidden,null,{timeout:10000}).catch(()=>{});
await post(pa,`after removal ${run}`);await bodyOf(pa,`after removal ${run}`).waitFor({timeout:8000}).catch(()=>{});
env=JSON.parse((await sealed()).at(-1).payload);
check(env.v===2&&env.epoch===2,`the web opened epoch 2 after the removal (epoch ${env.epoch})`);
r=await readUntil(B,[`after removal ${run}`]);check(r.out.includes(`after removal ${run}`),"Bob's CLI reads epoch 2");
await pb.evaluate(()=>e2eSync());await bodyOf(pb,`after removal ${run}`).waitFor({timeout:6000}).catch(()=>{});
check(await bodyOf(pb,`after removal ${run}`).count()===1,"Bob's browser reads epoch 2");
check(await until(()=>pa.locator("#thread .entry",{hasText:"New key for this board (epoch 2)"}).count(),n=>n===1)===1,"…and the 🔄 line says who can read from here on");
const st=await (await fetch(`${BASE}/api/boards/${board}/epochs`,{headers:{authorization:`Bearer ${tok[B]}`}})).json();
const ep2=await (async()=>{const ks=(await (await fetch(`${BASE}/api/boards/${board}/keys`,{headers:{authorization:`Bearer ${tok[A]}`}})).json()).keys;return ks})();
check(!ep2.some(k=>k.user===C),"Cat's devices are no longer among the board's keys");
// Drafts: nothing typed on an encrypted board is kept in localStorage
await pa.locator("#composer-text").fill(`draft secret ${run}`);await pa.waitForTimeout(400); // a negative: past the draft save's debounce
check(!(await pa.evaluate(()=>JSON.stringify(localStorage))).includes("draft secret"),"typed text isn't saved as a draft on encrypted boards");
await pa.locator("#composer-text").fill("");
await pa.screenshot({path:`${SHOTS_DIR}/e2e-board-light.png`});
{ const q=await ctxA.newPage();await q.emulateMedia({colorScheme:"dark"});watch(q);await q.goto(`${BASE}/b/${board}`);await until(()=>bodyOf(q,`after removal ${run}`).count(),n=>n===1);await q.screenshot({path:`${SHOTS_DIR}/e2e-board-dark.png`});
  check(await bodyOf(q,`after removal ${run}`).count()===1,"a second tab of the same browser uses the same device key (and reads)");
  check((await (await fetch(`${BASE}/api/me/keys`,{headers:{authorization:`Bearer ${tok[A]}`}})).json()).keys.length===2,"…no extra device was registered (Ann: browser + CLI)");await q.close(); }
// Pins hold the device id and its public key.
const pinsA=await pa.evaluate(me=>JSON.parse(localStorage.getItem("soup.e2e.pins."+me)||"{}"),A);
const bobCli=(await (await fetch(`${BASE}/api/keys/${B}`,{headers:{authorization:`Bearer ${tok[A]}`}})).json()).keys.find(k=>!/web/.test(k.label||""));
check(Object.values(pinsA).flat().every(e=>/^[a-z0-9-]+\|[A-Za-z0-9+/]{43}=(\|([A-Za-z0-9+/]{43}=)?(\|[a-z0-9-]+)?)?$/.test(e))&&pinsA[B]?.[0]?.startsWith(`${bobCli.id}|${bobCli.public_key}`),`pins are id|public key[|signing key] (Bob: ${pinsA[B]?.[0]?.slice(0,20)}…)`);
// A server that shows Bob's machine with a signing key of its own: Bob's CLI notices and says so (E2E 1c cross-signing).
await sql(`UPDATE agent_keys SET sign_pub = '${Buffer.alloc(32, 9).toString("base64")}' WHERE id = '${bobCli.id}'`);
const bobKeys=await cli(B,["keys"]);check(/signing key that isn't this machine's/.test(bobKeys.err),"a CLI shown with a signing key that isn't its own warns");
// A server that swaps the public key under Bob's pinned id: the next epoch isn't wrapped to it.
const { generateKeyPairSync } = await import("node:crypto");const evil=Buffer.from(generateKeyPairSync("x25519").publicKey.export({format:"jwk"}).x,"base64url").toString("base64");
await sql(`UPDATE agent_keys SET public_key = '${evil}' WHERE id = '${bobCli.id}'`);
// Removing this browser's key from the account (a lost device): the browser never brings that key back; it makes a new one, which waits.
const before=await pa.evaluate(async()=>{const r=await fetch("/api/me/keys");return (await r.json()).keys.find(k=>/web/.test(k.label)).id});
const annCli=(await (await fetch(`${BASE}/api/me/keys`,{headers:{authorization:`Bearer ${tok[A]}`}})).json()).keys.find(k=>!/web/.test(k.label||""));
const removed=await pa.evaluate(async k=>{const r=await fetch("/api/me/keys/"+k,{method:"DELETE"});return {status:r.status,...await r.json()}},before);
check(removed.status===200,"Ann removes this browser's key from her account");
// Review #5524: it had signed (approved) Ann's CLI, so the CLI goes with it.
check(annCli.signed_by===before&&removed.revoked.includes(annCli.id),`…and the CLI it had signed goes with it (${removed.revoked.join(", ")})`);
await pa.reload();
const webKeys=()=>pa.evaluate(async()=>(await (await fetch("/api/me/keys")).json()).keys.filter(k=>/web/.test(k.label)).map(k=>k.id)).catch(()=>[]);
const after=await until(webKeys,ids=>ids.length===1&&ids[0]!==before);
await until(()=>pa.locator("#thread .e2e-none").count(),n=>n>=5);
const pubs=await pa.evaluate(async()=>(await (await fetch("/api/me/keys")).json()).keys.map(k=>k.public_key));
check(after.length===1&&after[0]!==before&&new Set(pubs).size===pubs.length,"…on reload it registers a fresh key (new id, new public key), not the removed one");
check(await pa.locator("#thread .e2e-text").count()===0&&await pa.locator("#thread .e2e-none").count()>=5,"…which can't read the history until one of Ann's devices approves it");
const st3=await until(async()=>(await fetch(`${BASE}/api/boards/${board}/epochs`,{headers:{authorization:`Bearer ${tok[B]}`}})).json(),j=>j.current===3);
check(st3.current===3&&!st3.rotate_needed,"…and removing the old key rotated the board (epoch 3, opened like the CLI does on rotate_needed)");
const g3=JSON.parse((await d1Execute(`--json --command ${JSON.stringify(`SELECT kid FROM key_grants WHERE board_id = '${board}' AND epoch = 3`)}`,{cwd:WT})).toString())[0].results.map(x=>x.kid);
check(!g3.includes(bobCli.id)&&g3.length>=1,`…and epoch 3 was NOT wrapped to Bob's pinned id with the swapped key (wrapped to ${g3.join(", ")})`);
r=await cli(A,["read"]);check(/no key for this part of the board on this machine/.test(r.out)&&!/A new device of yours/.test(r.err),"Ann's removed CLI comes back as a new device that holds no key and approves nothing");
// Review #5558: none of Ann's devices Bob's browser trusted is listed now, and new ones show up (as a server could make
// them). Bob's browser saw Ann before, so however often it syncs they're never trusted on first use: no key, a warning
// with a Trust button, and only that click (on Ann's word) hands one the key.
const grantsTo=async kid=>JSON.parse((await d1Execute(`--json --command ${JSON.stringify(`SELECT COUNT(*) AS n FROM key_grants WHERE board_id = '${board}' AND kid = '${kid}'`)}`,{cwd:WT})).toString())[0].results[0].n;
for(let i=0;i<3;i++){await pb.evaluate(()=>e2eSync());await pb.waitForTimeout(200)} // a negative: an unwanted grant would show by now
const pinsB=await pb.evaluate(me=>JSON.parse(localStorage.getItem("soup.e2e.pins."+me)||"{}"),B);
check(Array.isArray(pinsB[A])&&!pinsB[A].some(e=>e.startsWith(after[0]+"|"))&&await grantsTo(after[0])===0,`Bob's browser keeps Ann's (empty) entry and hands her new device no key (${JSON.stringify(pinsB[A])})`);
const trustAsk=pb.locator(".e2e-ask",{has:pb.locator(`[data-e2e-trust="${after[0]}"]`)});
check(/None of .+ devices this browser trusted is listed any more/.test(await trustAsk.innerText().catch(()=>"")),"…and says why, with a Trust button");
await pb.locator(`[data-e2e-trust="${after[0]}"]`).click();
check(await until(()=>grantsTo(after[0]),n=>n>0)>0,"Trust, on Ann's word, hands it the keys");
await pa.evaluate(()=>e2eSync());check(await until(()=>bodyOf(pa,`after removal ${run}`).count(),n=>n===1)===1,"…and Ann's new browser reads again");
check(errors.length===0,`no page errors ${errors.join(" | ")}`);
await b.close();console.log(fails?`${fails} FAILED`:"all web encryption checks passed");
