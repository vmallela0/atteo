import { SHOTS_DIR } from "./lib/shots.mjs";
import { after } from "./seed.mjs";
import { chromium } from "playwright-core";
const { board, A, cookieB } = await after();
const BASE=process.env.BASE||"http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const tokA = (await ops("tokens", { user: A })).token;
const mcp = async (name, args) => (await fetch(`${BASE}/mcp?board=${board}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tokA}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json();
let fails=0;const check=(ok,m)=>{console.log(`${ok?"✓":"✗"} ${m}`);if(!ok)fails++};
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined, ignoreDefaultArgs: ["--hide-scrollbars"] });
for (const [label,w,h,scheme] of [["desktop",1280,800,"light"],["mobile",390,844,"dark"]]) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, colorScheme: scheme });
  const [k, ...v] = cookieB.split(";")[0].split("=");
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage(); const errors=[]; p.on("pageerror",e=>errors.push(e.message));
  await p.goto(`${BASE}/b/${board}`); await p.waitForTimeout(700);
  const n = await p.locator("#thread>.entry").count(), t = await p.locator("#rail i").count();
  check(n>10 && (t===n || (n>60 && t<=60+await p.locator("#thread>.entry.for-you").count())), `${label}: one tick per message, at most ~60 on long boards (${t} ticks, ${n} messages)`);
  const on0 = await p.locator("#rail i.on").count();
  check(on0>0 && on0<n, `${label}: ticks in view are marked (${on0})`);
  const lastOn = await p.evaluate(()=>{const is=[...document.querySelectorAll("#rail i")];return is[is.length-1].classList.contains("on")});
  check(lastOn, `${label}: at the bottom, the last tick is in view`);
  check(await p.evaluate(()=>getComputedStyle(document.getElementById("thread-scroll")).scrollbarWidth)==="none", `${label}: the thread has no scrollbar of its own`);
  check(!(await p.locator("#new-pill").isVisible()), `${label}: no pill at the bottom`);
  // scroll up: ticks switch, pill says Jump to latest
  await p.evaluate(()=>{const s=document.getElementById("thread-scroll");s.dispatchEvent(new WheelEvent("wheel",{deltaY:-100}));s.scrollTop=0}); await p.waitForTimeout(150);
  const firstOn = await p.evaluate(()=>document.querySelector("#rail i").classList.contains("on"));
  check(firstOn, `${label}: at the top, the first tick is in view`);
  check(await p.locator("#new-pill").isVisible() && (await p.locator("#new-pill").textContent()).includes("Jump to latest"), `${label}: away from the bottom → "Jump to latest ↓"`);
  if (label==="desktop") {
    await p.screenshot({ path: `${SHOTS_DIR}/rail-${label}-top.png` });
    // hover a tick → preview
    const rb = await p.locator("#rail").boundingBox();
    const ty = await p.evaluate(()=>parseFloat(document.querySelectorAll("#rail i")[5].style.top));
    await p.mouse.move(rb.x+rb.width/2, rb.y+rb.height*ty/100);
    await p.waitForTimeout(150);
    const tipText = await p.locator("#rail-tip").textContent();
    check(await p.locator("#rail-tip").isVisible() && /agent|person|·/.test(tipText), `hover a tick previews it: "${tipText.slice(0,70)}"`);
    await p.screenshot({ path: `${SHOTS_DIR}/rail-${label}-hover.png` });
    // click → that message in view
    await p.mouse.down(); await p.mouse.up(); await p.waitForTimeout(300);
    const sixth = await p.evaluate(()=>{const el=document.querySelectorAll("#thread>.entry")[5].getBoundingClientRect(),s=document.getElementById("thread-scroll").getBoundingClientRect();return el.top>=s.top-2&&el.bottom<=s.bottom+2});
    check(sixth, "click a tick → that message is in view");
    // drag scrubs to the middle
    await p.mouse.move(rb.x+rb.width/2, rb.y+10); await p.mouse.down(); await p.mouse.move(rb.x+rb.width/2, rb.y+rb.height*0.5, {steps:5});
    const mid = await p.evaluate(()=>{const s=document.getElementById("thread-scroll");return (s.scrollTop+s.clientHeight/2)/s.scrollHeight});
    await p.mouse.up();
    check(Math.abs(mid-0.5)<0.1, `drag scrubs (centre at ${(mid*100).toFixed(0)}%)`);
  }
  // new message while away → "New messages ↓"
  await mcp("read",{}); await mcp("post",{type:"note",text:`rail check ${label} ${Date.now()}`});
  await p.waitForFunction(()=>document.getElementById("new-pill").textContent.includes("New messages"),null,{timeout:5000}).catch(()=>{});
  check((await p.locator("#new-pill").textContent()).includes("New messages"), `${label}: a new message while away → "New messages ↓"`);
  check(await p.locator("#rail i").count()===n+1, `${label}: the new message gets a tick`);
  await p.click("#new-pill"); await p.waitForTimeout(600);
  check(!(await p.locator("#new-pill").isVisible()), `${label}: pill takes you down and hides`);
  if (label==="mobile") await p.screenshot({ path: `${SHOTS_DIR}/rail-${label}.png` });
  check(errors.length===0, `${label}: no page errors ${errors.join(" | ")}`);
  await ctx.close();
}
await b.close(); console.log(fails?`${fails} FAILED`:"all rail checks passed"); process.exit(fails?1:0);
