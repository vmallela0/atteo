import { after } from "./seed.mjs";
import { chromium } from "playwright-core";
const { board, A, cookieB } = await after();
const BASE=process.env.BASE||"http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const tokA = (await ops("tokens", { user: A })).token;
const mcp = async (name, args) => (await fetch(`${BASE}/mcp?board=${board}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tokA}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json();
await mcp("read",{}); await mcp("post",{type:"artifact",text:"Trace from checkout",artifact_name:"trace.log",artifact_content:"line one\nTypeError at charge (checkout.js:42)\n"});
await mcp("read",{}); await mcp("post",{type:"artifact",text:"Trace, second run",artifact_name:"trace.log",artifact_content:"second run\nTypeError again\n"});
let fails=0;const check=(ok,m)=>{console.log(`${ok?"✓":"✗"} ${m}`);if(!ok)fails++};
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
for (const [w,h] of [[1280,800],[390,844]]) {
const ctx = await b.newContext({ viewport: { width: w, height: h } });
const [k, ...v] = cookieB.split(";")[0].split("=");
await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
const p = await ctx.newPage(); const errors=[]; p.on("pageerror",e=>errors.push(e.message));
await p.goto(`${BASE}/b/${board}`); await p.waitForTimeout(600);
check((await p.locator("#board-tabs button").nth(2).textContent())==="Files", "third tab is Files");
// the first trace post opens v1, not the latest
const cards=p.locator('#thread [data-open-file="trace.log"]');
check(await cards.count()>=2, "each post of trace.log shows a file card");
const nCards=await cards.count(); await cards.nth(nCards-2).click(); await p.waitForTimeout(500); // the previous version (old ones past 50 are pruned)
check(await p.locator("#panel-docs").isVisible(), "Open on a post switches to Files");
const view=await p.locator("#doc-view").textContent();
check(view.includes("trace.log") && view.includes("older version"), `…showing that post's version (v1, marked older): ${view.replace(/\s+/g," ").slice(0,160)}`);
check(await p.evaluate(()=>location.hash)==="#files", "URL says #files");
const list=await p.locator("#doc-items").textContent();
const latest=await p.evaluate(async(b)=>((j)=>j.files||j.docs)(await (await fetch("/api/boards/"+b+"/files")).json()).find(f=>f.name==="trace.log").version, board);
check(list.includes("trace.log") && list.includes("v"+latest), `Files list shows trace.log at its latest version v${latest}`);
await p.keyboard.press("1"); await p.waitForTimeout(200);
check(await p.locator('#sum [data-open-file]').count()===0, "files aren't repeated in Board info (they live in the Files tab)");
await p.goto(`${BASE}/b/${board}`); await p.waitForTimeout(500); await p.locator("#board-tabs button").nth(2).click(); await p.waitForTimeout(800);
if (w>800) check((await p.locator("#doc-view").textContent()).includes("second run"), "opening Files shows the newest file");
await p.goto(`${BASE}/b/${board}#docs`); await p.waitForTimeout(500);
check(await p.locator("#panel-docs").isVisible(), "old #docs links still open the Files tab");
check(errors.length===0, `no page errors ${errors.join(" | ")}`);
await ctx.close();
}
await b.close(); console.log(fails?`${fails} FAILED`:"all files checks passed"); process.exit(fails?1:0);
