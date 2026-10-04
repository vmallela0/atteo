// The HTML preview's no-network rule holds for any file, not just tidy ones (vedu's agent #2039). The CSP meta has to be
// the document's first node: one that lands in <body> (content before <head>, a <header>, "<head>" inside a comment) is
// ignored by the browser, so the page could call out. Each file here tries fetch, an image and a stylesheet against a
// listener on this machine; nothing may arrive. WebRTC, which CSP doesn't cover, is gone from the page, the page can't
// make a frame to get a fresh one, and the page renders in standards mode.
// Usage: BASE=http://localhost:8787 node preview-sandbox.mjs  (local dev only, ADMIN_KEY=ci-admin-key in .dev.vars)
import { createServer } from "node:http";
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const KEY = process.env.ADMIN_KEY || "ci-admin-key";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": KEY, "content-type": "application/json" }, body: JSON.stringify(b) })).json();

// Anything the previews manage to send lands here.
const hits = [];
const srv = createServer((q, r) => { hits.push(q.url); r.writeHead(200, { "access-control-allow-origin": "*", "content-type": "text/plain" }); r.end("x"); });
await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
const OUT = `http://127.0.0.1:${srv.address().port}`;

const run = Date.now().toString(36).slice(-4), P = `pc${run}`, V = `pv${run}`;
for (const u of [P, V]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true", display: { mode: "developer" } });
const board = (await ops("boards", { user: P, title: `Preview CSP ${run}` })).board.id;
await ops("members", { board, user: V });
const ck = (await ops("sessions", { user: P })).cookie, tokV = (await ops("tokens", { user: V })).token;
const mcp = async (name, args) => (await (await fetch(`${BASE}/mcp?board=${board}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tokV}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json()).result.content[0].text;

// The probe each file runs: three ways out, the WebRTC check, and the mode, written into #o.
const probe = (k) => `<pre id="o">probe ${k}</pre><script>
const o=[];try{fetch('${OUT}/f-${k}',{mode:'no-cors'}).catch(()=>{})}catch(e){}
try{new Image().src='${OUT}/i-${k}'}catch(e){}
try{const l=document.createElement('link');l.rel='stylesheet';l.href='${OUT}/s-${k}';document.head.appendChild(l)}catch(e){}
o.push('rtc:'+(typeof RTCPeerConnection==='undefined'&&typeof webkitRTCPeerConnection==='undefined'?'gone':'there'));
o.push('mode:'+document.compatMode);const show=()=>document.getElementById('o').textContent=o.join(' ');show();
// A frame made by the page would be a fresh window with its own RTCPeerConnection: it reports back if it lives.
addEventListener('message',e=>{if(typeof e.data==='string'&&e.data.startsWith('child:')){o.push(e.data);show()}});
const f=document.createElement('iframe');f.srcdoc='<script>parent.postMessage("child:"+typeof RTCPeerConnection,"*")<\\/script>';document.body.appendChild(f)</script>
<iframe srcdoc="<script>parent.postMessage('child:'+typeof RTCPeerConnection,'*')</script>"></iframe>`;
const files = {
  tidy: `<!doctype html><html><head><title>t</title></head><body>${probe("tidy")}</body></html>`,
  nohead: `<p>No head at all</p>${probe("nohead")}`,
  before: `<p>Before the head</p><head><title>t</title></head><body>${probe("before")}</body>`,
  header: `<header>A header, no head</header>${probe("header")}`,
  comment: `<!-- <head> -->${probe("comment")}`,
  lowerdoc: `\n  <!DOCTYPE html>\n<body><header>x</header>${probe("lowerdoc")}</body>`,
  bom: `﻿<!doctype html><body>${probe("bom")}</body>`,
  nbsp: ` <!doctype html><body>${probe("nbsp")}</body>`,
  abrupt: `<!--> <!doctype html>${probe("abrupt")}<!-- --> <!doctype html>`,
};
await mcp("read", {});
for (const [k, html] of Object.entries(files)) await mcp("post", { type: "artifact", text: `case ${k}`, artifact_name: `pc-${k}-${run}.html`, artifact_content: html });

let fails = 0;
const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const ctx = await b.newContext({ viewport: { width: 1200, height: 820 } });
const [ckName, ...ckVal] = ck.split(";")[0].split("=");
await ctx.addCookies([{ name: ckName, value: ckVal.join("="), url: BASE }]);
const p = await ctx.newPage();
const errors = [];
p.on("pageerror", (e) => errors.push(e.message));
await p.goto(`${BASE}/b/${board}`);
await p.waitForTimeout(1000);
for (const k of Object.keys(files)) {
  const btn = p.locator(`#thread [data-preview-file="pc-${k}-${run}.html"]`);
  if (!(await btn.count())) { check(false, `${k}: has Preview`); continue; }
  await btn.click();
  await p.waitForTimeout(1200);
  const o = await p.frameLocator("#pv-frame").locator("#o").innerText().catch(() => "(no #o)");
  const mine = hits.filter((h) => h.endsWith(`-${k}`));
  check(!mine.length, `${k}: nothing reaches the network (${mine.join(", ") || "no requests"})`);
  check(/(^| )rtc:gone/.test(o) && !/child:/.test(o), `${k}: no WebRTC in the page, and no frame of its own to get it from (${o})`);
  if (k === "tidy" || k === "lowerdoc") check(/mode:CSS1Compat/.test(o), `${k}: the file's doctype still counts (${o})`);
  await p.locator(".pv-dlg [data-pv-close]").click();
  await p.waitForTimeout(200);
}
check(!errors.length, `no page errors ${errors.join(" | ")}`);
await b.close();
srv.close();
console.log(fails ? `${fails} FAILED` : "preview sandbox: all passed");
process.exit(fails ? 1 : 0);
