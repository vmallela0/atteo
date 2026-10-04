import { SHOTS_DIR } from "./lib/shots.mjs";
import { after } from "./seed.mjs";
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const { board, cookieB } = await after();
let fails=0;const check=(ok,m)=>{console.log(`${ok?"✓":"✗"} ${m}`);if(!ok)fails++};
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const ctx = await b.newContext({ viewport: { width: 1920, height: 1000 } });
const [k, ...v] = cookieB.split(";")[0].split("=");
await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
const p = await ctx.newPage(); const errors=[]; p.on("pageerror",e=>errors.push(e.message));
await p.goto(`${BASE}/b/${board}`); await p.waitForTimeout(600);
const top=()=>p.evaluate(()=>document.getElementById("thread-scroll").scrollTop);
const t0=await top(); const thr=await p.locator("#thread-scroll").boundingBox();
await p.mouse.move(thr.x-80, thr.y+300); await p.mouse.wheel(0,-600); await p.waitForTimeout(300);
const t1=await top(); check(t1<t0-300, `wheel over the empty left margin scrolls the chat (${t0} → ${t1})`);
const hd=await p.locator(".bp-head").boundingBox(); await p.mouse.move(hd.x+300, hd.y+15); await p.mouse.wheel(0,-300); await p.waitForTimeout(300);
const t2=await top(); check(t2<t1-150, `wheel over the board header too (${t1} → ${t2})`);
const side=await p.locator("#board-info").boundingBox(); await p.mouse.move(side.x+100, side.y+300); await p.mouse.wheel(0,-300); await p.waitForTimeout(300);
check(await top()===t2, "wheel over the sidebar leaves the chat alone");
const nav=await p.locator(".sidebar").boundingBox(); await p.mouse.move(nav.x+100, nav.y+400); await p.mouse.wheel(0,-300); await p.waitForTimeout(300);
check(await top()===t2, "wheel over the left nav leaves the chat alone");
// the agent card's close button
const card=p.locator("#board-info [data-agent-card]");
if (await card.count()) {
  const xb=await card.locator("[data-dismiss-agent]").boundingBox(), cb=await card.boundingBox();
  check(xb.width<=26 && xb.x>cb.x+cb.width-40, `✕ sits in the card's top-right corner (${Math.round(xb.x-cb.x)}px in, ${xb.width}px wide)`);
  await card.locator("[data-dismiss-agent]").click(); await p.waitForTimeout(200);
  check(await card.count()===0, "✕ closes the agent card");
  await p.reload(); await p.waitForTimeout(500);
  check(await p.locator("#board-info [data-agent-card]").count()===0, "…and it stays closed on this board");
  await p.evaluate(()=>localStorage.clear());
}
check(errors.length===0, `no page errors ${errors.join(" | ")}`);
await p.screenshot({ path: `${SHOTS_DIR}/wheel-1920.png` });
await b.close(); console.log(fails?`${fails} FAILED`:"all wheel/card checks passed");
