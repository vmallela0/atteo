// SVG files preview like HTML ones (jxn #4265), in the same sandboxed /preview-frame, but only ever as an <img> of a
// data: URL: a hostile SVG's <script>, onload, <foreignObject> and external hrefs neither run nor fetch (a listener on
// this machine counts any request; the page counts any message), and a plain SVG draws.
// Usage: BASE=http://localhost:8787 node svg-preview.mjs  (local dev only, ADMIN_KEY=ci-admin-key in .dev.vars)
import { createServer } from "node:http";
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const KEY = process.env.ADMIN_KEY || "ci-admin-key";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": KEY, "content-type": "application/json" }, body: JSON.stringify(b) })).json();

const hits = [];
const srv = createServer((q, r) => { hits.push(q.url); r.writeHead(200, { "access-control-allow-origin": "*", "content-type": "image/svg+xml" }); r.end("<svg xmlns='http://www.w3.org/2000/svg'/>"); });
await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
const OUT = `http://127.0.0.1:${srv.address().port}`;

const run = Date.now().toString(36).slice(-4), P = `sp${run}`, V = `sv${run}`;
for (const u of [P, V]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true", display: { mode: "developer" } });
const board = (await ops("boards", { user: P, title: `SVG ${run}` })).board.id;
await ops("members", { board, user: V });
const ck = (await ops("sessions", { user: P })).cookie, tokV = (await ops("tokens", { user: V })).token;
const mcp = async (name, args) => (await (await fetch(`${BASE}/mcp?board=${board}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tokV}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json()).result.content[0].text;

const ran = (k) => `fetch('${OUT}/${k}').catch(()=>{});try{top.postMessage('ran:${k}','*')}catch(e){}`;
const files = {
  hostile: `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="200" height="100" onload="${ran("onload")}">
<script>${ran("script")}new Image().src='${OUT}/script-img'</script>
<style>@import url(${OUT}/css);</style>
<image href="${OUT}/image" width="20" height="20"/><image xlink:href="${OUT}/ximage" width="20" height="20"/>
<use href="${OUT}/use.svg#x"/>
<rect width="200" height="100" fill="#c00" onclick="${ran("click")}"/>
<foreignObject width="200" height="100"><div xmlns="http://www.w3.org/1999/xhtml"><iframe src="${OUT}/fo-frame"></iframe><img src="${OUT}/fo-img" onerror="${ran("fo-onerror")}"/></div></foreignObject>
<a href="${OUT}/link"><text x="10" y="50">x</text></a>
</svg>`,
  plain: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60"><circle cx="60" cy="30" r="25" fill="#0a0"/></svg>`,
};
await mcp("read", {});
for (const [k, svg] of Object.entries(files)) await mcp("post", { type: "artifact", text: `svg ${k}`, artifact_name: `${k}-${run}.svg`, artifact_content: svg });

let fails = 0;
const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const ctx = await b.newContext({ viewport: { width: 1200, height: 820 } });
const [ckName, ...ckVal] = ck.split(";")[0].split("=");
await ctx.addCookies([{ name: ckName, value: ckVal.join("="), url: BASE }]);
const errors = [];
await Promise.all(Object.keys(files).map(async (k) => {
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${BASE}/b/${board}`);
  await p.evaluate(() => { window.__ran = []; addEventListener("message", (e) => { if (typeof e.data === "string" && e.data.startsWith("ran:")) window.__ran.push(e.data) }) });
  const btn = p.locator(`#thread [data-preview-file="${k}-${run}.svg"]`);
  if (!(await btn.waitFor({ timeout: 10000 }).then(() => true, () => false))) { check(false, `${k}: has Preview`); return p.close(); }
  await btn.click();
  const img = p.frameLocator("#pv-frame").locator("#pv-svg");
  await img.waitFor({ timeout: 10000 }).catch(() => {});
  await img.evaluate((i) => i.decode()).catch(() => {});
  const r = await img.evaluate((i) => ({ w: i.naturalWidth, h: i.naturalHeight, box: i.getBoundingClientRect().width, svgs: document.querySelectorAll("svg,foreignObject,iframe").length + [...document.scripts].filter((x) => x.text.includes("ran:")).length })).catch(() => null);
  check(r && r.w > 0 && r.h > 0 && r.box > 0 && r.svgs === 0, `${k}: draws as a picture, never as a document (${JSON.stringify(r)})`);
  if (k === "hostile") {
    await img.click().catch(() => {});
    await p.waitForTimeout(800); // time for anything that could run or load to show up
    check(!hits.length, `hostile: nothing reaches the network (${hits.join(", ") || "no requests"})`);
    const got = await p.evaluate(() => window.__ran);
    check(!got.length, `hostile: no script, handler or foreignObject runs (${got.join(", ") || "none"})`);
  }
  await p.locator(".pv-dlg").screenshot({ path: `${process.env.SHOTS_DIR || "/tmp"}/svg-preview-${k}.png` }).catch(() => {});
  await p.close();
}));
check(!errors.length, `no page errors ${errors.join(" | ")}`);
await b.close();
srv.close();
console.log(fails ? `${fails} FAILED` : "svg preview: all passed");
process.exit(fails ? 1 : 0);
