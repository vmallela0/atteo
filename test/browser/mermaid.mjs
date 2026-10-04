// Mermaid diagrams in messages (vedu #1246/#1247): a ```mermaid block draws as an SVG once it's on screen; pages without
// one load nothing; bad syntax, offline or a tampered library leave the code block; injected labels never run; phone + dark/light.
// Usage: BASE=http://localhost:8787 [BROWSER=webkit] node mermaid.mjs  (local dev only, needs ADMIN_KEY=ci-admin-key in .dev.vars)
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium, webkit } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const ADMIN = process.env.ADMIN_KEY || "ci-admin-key";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": ADMIN, "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), P = `mm${run}`;
await ops("users", { name: P, email: `${P}@example.com`, verified: "true" });
const ck = (await ops("sessions", { user: P })).cookie, tok = (await ops("tokens", { user: P })).token;
const newBoard = async (t) => (await ops("boards", { user: P, title: `${t} ${run}` })).board.id;
const mcp = async (board, name, args) => (await (await fetch(`${BASE}/mcp?board=${board}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json()).result.content[0].text;
const post = async (board, t) => { await mcp(board, "read", {}); const r = await mcp(board, "post", { type: "note", text: t }); return +r.match(/#(\d+)/)[1]; };
const M = (s) => "```mermaid\n" + s + "\n```";

const FLOW = M("flowchart TD\n  A[Agent posts text] --> B{Plain text?}\n  B -->|yes| C[Stored as is]\n  C --> D[Web draws it]");
const BAD = M("flowchart LR\n  A --> \n  this is ((( not mermaid ]]");
// Labels that parse and draw, carrying HTML: handlers, script, frames, a page-wide <style>, an off-site image.
const EVIL = M([
  "flowchart TD",
  '  A["<img src=http://tracker.invalid/a.png onerror=window.__pwned=1>pic"] --> B["<b onmouseover=window.__pwned=6>hover</b>"]',
  '  B --> C["<iframe src=javascript:window.__pwned=5></iframe>frame"]',
  '  C --> D["<a href=javascript:window.__pwned=3>tap</a>"]',
  '  D --> E["<script>window.__pwned=2</script>script"]',
  '  E --> F["<style>body{display:none!important}</style>styled"]',
].join("\n"));
// Config and interaction tricks: an init directive asking for loose mode, injected CSS and a looser sanitiser; click handlers; an image shape.
const EVIL2 = M([
  '%%{init: {"securityLevel":"loose","startOnLoad":true,"themeCSS":"body{display:none!important}","dompurifyConfig":{"ADD_TAGS":["script","img"],"ADD_ATTR":["onerror"]}}}%%',
  "flowchart TD",
  '  A["<img src=x onerror=window.__pwned=7>a"] --> B[b]',
  "  click A call pwn()",
  '  click B "javascript:window.__pwned=4"',
].join("\n"));
const EVIL3 = M('flowchart LR\n  P@{ img: "http://tracker.invalid/b.png", label: "pic", pos: "t", w: 60, h: 60 } --> Q[q]');
const WIDE = M("flowchart LR\n" + Array.from({ length: 14 }, (_, i) => `  N${i}[Step number ${i + 1}] --> N${i + 1}[Step number ${i + 2}]`).join("\n"));

let fails = 0;
const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
// BROWSER=webkit runs the same checks in WebKit (Safari's engine).
const browser = process.env.BROWSER === "webkit" ? await webkit.launch() : await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const isLib = (u) => /mermaid/i.test(u) && !u.startsWith(BASE);
async function open(board, { w = 1200, scheme = "light", route } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, colorScheme: scheme, isMobile: w < 500 });
  const [k, ...v] = ck.split(";")[0].split("=");
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  if (route) await ctx.route(/cdn\.jsdelivr\.net/, route);
  await ctx.addInitScript(() => { window.pwn = () => { window.__pwned = "call"; }; });
  const p = await ctx.newPage();
  const libReqs = [], errors = [], tracker = [];
  p.on("request", (r) => { if (isLib(r.url())) libReqs.push(r.url()); if (/tracker\.invalid/.test(r.url())) tracker.push(r.url()); });
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("dialog", (d) => { errors.push("dialog: " + d.message()); d.dismiss(); });
  await p.goto(`${BASE}/b/${board}`);
  return { ctx, p, libReqs, errors, tracker };
}
const drawn = (p, seq) => p.waitForSelector(`#e${seq} .mmd[data-mmd="drawn"] .mmd-d svg`, { timeout: 20000 }).then(() => true, () => false);
const settled = (p, seq) => p.waitForSelector(`#e${seq} .mmd[data-mmd="drawn"], #e${seq} .mmd[data-mmd="code"]`, { timeout: 20000 }).then(() => true, () => false);

// 1. A page with no diagrams (but a chart and a code block) never asks for the library.
{
  const b = await newBoard("Plain");
  await post(b, "No diagrams here.\n\n```js\nconsole.log(1)\n```");
  await post(b, '```chart\n{"type":"bar","x":["a","b"],"series":[{"name":"n","values":[1,2]}]}\n```');
  const { ctx, p, libReqs } = await open(b);
  await p.waitForTimeout(2500);
  check(libReqs.length === 0, `no diagram on the page: the library isn't requested (${libReqs.length} requests)`);
  await ctx.close();
}

// 2. Flowchart, bad syntax, injection and a wide diagram; desktop light and phone dark.
const B = await newBoard("Diagrams");
const sFlow = await post(B, "How a diagram travels\n\n" + FLOW);
const sBad = await post(B, BAD);
const sEvil = await post(B, EVIL);
const sEvil2 = await post(B, EVIL2);
const sEvil3 = await post(B, EVIL3);
const sWide = await post(B, WIDE);
const fills = {};
for (const [w, scheme] of [[1200, "light"], [390, "dark"]]) {
  const { ctx, p, libReqs, errors, tracker } = await open(B, { w, scheme });
  const tag = `${w}px ${scheme}`;
  for (const s of [sFlow, sWide, sEvil, sEvil2, sEvil3, sBad]) { await p.locator(`#e${s}`).scrollIntoViewIfNeeded(); await settled(p, s); }
  check(await drawn(p, sFlow), `${tag}: the flowchart draws as an SVG`);
  check(libReqs.length === 1 && libReqs[0].includes("@12.1.0/"), `${tag}: the pinned library loads once (${libReqs.join(", ")})`);
  const g = await p.evaluate(([f, bad, wide]) => {
    const fe = document.querySelector(`#e${f} .mmd`), be = document.querySelector(`#e${bad} .mmd`), we = document.querySelector(`#e${wide} .mmd-d`);
    const shape = fe?.querySelector(".mmd-d .node rect, .mmd-d .node path, .mmd-d .node polygon");
    const label = [...(fe?.querySelectorAll(".mmd-d .node") ?? [])].map((n) => n.textContent).join("|");
    const ws = we?.querySelector("svg");
    return {
      label,
      fill: shape ? getComputedStyle(shape).fill : "",
      bgSub: getComputedStyle(document.documentElement).getPropertyValue("--bg-subtle").trim(),
      codeHidden: !!fe?.querySelector("details.mmd-src:not([open]) .code-b"),
      badState: be?.dataset.mmd, badCode: be ? be.querySelector(".code-b").getBoundingClientRect().height > 0 && !be.querySelector(".mmd-d") : false,
      badText: be?.querySelector("code")?.textContent.includes("not mermaid"),
      wideScroll: we ? we.scrollWidth > we.clientWidth + 4 : false,
      wideNatural: ws ? ws.getBoundingClientRect().width >= ws.viewBox.baseVal.width * 0.75 - 1 : false,
      flowFits: (() => { const d = fe?.querySelector(".mmd-d"); return d ? d.scrollWidth <= d.clientWidth + 1 : false; })(),
      pageW: document.documentElement.scrollWidth,
    };
  }, [sFlow, sBad, sWide]);
  check(/Agent posts text/.test(g.label) && /Web draws it/.test(g.label), `${tag}: labels are in the drawing (${g.label})`);
  check(g.codeHidden, `${tag}: the source sits under a closed "Code" toggle`);
  check(g.badState === "code" && g.badCode && g.badText, `${tag}: bad syntax stays a code block (${g.badState})`);
  const hex = g.bgSub.replace("#", ""), rgb = `rgb(${parseInt(hex.slice(0, 2), 16)}, ${parseInt(hex.slice(2, 4), 16)}, ${parseInt(hex.slice(4, 6), 16)})`;
  fills[scheme] = g.fill;
  check(g.fill === rgb, `${tag}: nodes use the board's --bg-subtle (${g.fill} vs ${rgb})`);
  if (w > 500) check(g.flowFits, `${tag}: a small diagram fits the message without scrolling`);
  if (w < 500) check(g.wideScroll && g.wideNatural && g.pageW <= w, `${tag}: a wide diagram stays at least 3/4 size and scrolls sideways; the page doesn't (page ${g.pageW}px)`);
  // Injection: nothing ran, nothing dangerous made it into the page, the init directive didn't hide the page.
  for (const s of [sEvil, sEvil2]) for (const n of await p.locator(`#e${s} .mmd-d .node`).all()) { await n.hover({ force: true }).catch(() => {}); await n.click({ force: true }).catch(() => {}); }
  for (const a of await p.locator(`#e${sEvil} .mmd-d a`).all()) await a.click({ force: true }).catch(() => {});
  await p.waitForTimeout(500);
  const ev = await p.evaluate(([s1, s2, s3]) => {
    const st = (s) => document.querySelector(`#e${s} .mmd`)?.dataset.mmd;
    const all = [...document.querySelectorAll(".mmd-d *")];
    const lab = [...document.querySelectorAll(`#e${s1} .mmd-d .node`)].map((n) => n.textContent).join("|");
    return {
      states: [st(s1), st(s2), st(s3)], lab, pwned: window.__pwned ?? null,
      bad: all.filter((n) => /^(script|img|iframe|image|object|embed)$/i.test(n.localName)).length,
      styles: all.filter((n) => n.localName === "style" && n.parentNode.localName !== "svg").length,
      on: all.filter((n) => [...n.attributes].some((a) => /^on/i.test(a.name))).length,
      js: all.filter((n) => [...n.attributes].some((a) => /javascript:/i.test(a.value))).length,
      bodyShown: getComputedStyle(document.body).display !== "none",
    };
  }, [sEvil, sEvil2, sEvil3]);
  check(ev.states[0] === "drawn" && /pic/.test(ev.lab) && /styled/.test(ev.lab), `${tag}: a diagram with HTML in its labels draws, as text only (${ev.lab})`);
  check(ev.pwned === null && ev.bad === 0 && ev.styles === 0 && ev.on === 0 && ev.js === 0 && ev.bodyShown, `${tag}: injection in labels, init directives and click lines doesn't execute (${JSON.stringify(ev)})`);
  check(tracker.length === 0 && ev.states[2] === "code", `${tag}: no off-site image is fetched; an image shape stays as code (${tracker.join(", ") || "0 requests"})`);
  await p.locator(`#e${sFlow} .mmd`).screenshot({ path: `${SHOTS_DIR}/mermaid-flow-${w}-${scheme}.png` }).catch(() => {});
  await p.locator(`#e${sWide} .mmd`).screenshot({ path: `${SHOTS_DIR}/mermaid-wide-${w}-${scheme}.png` }).catch(() => {});
  // Switching light/dark under an open page redraws in the new tokens.
  if (w > 500) {
    await p.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    await p.waitForFunction((s) => { const r = document.querySelector(`#e${s} .mmd-d .node rect, #e${s} .mmd-d .node path, #e${s} .mmd-d .node polygon`); return r && getComputedStyle(r).fill === "rgb(17, 17, 17)"; }, sFlow, { timeout: 10000 }).then(() => check(true, `${tag}: Display → dark redraws the diagram in dark tokens`), () => check(false, `${tag}: Display → dark redraws the diagram in dark tokens`));
  }
  check(!errors.length, `${tag}: no page errors or dialogs ${errors.join(" | ")}`);
  await ctx.close();
}
check(fills.light && fills.dark && fills.light !== fills.dark, `light and dark draw differently (${fills.light} / ${fills.dark})`);

// 3. Lazy: a diagram far above the fold doesn't load the library until it's scrolled to; a diagram arriving live draws.
{
  const b = await newBoard("Lazy");
  const sTop = await post(b, FLOW);
  for (let i = 0; i < 14; i++) await post(b, `Filler ${i}\n\n` + Array.from({ length: 8 }, (_, k) => `Line ${k} of a long message that takes room.`).join("\n\n"));
  const { ctx, p, libReqs } = await open(b, { w: 390, scheme: "light" });
  await p.waitForTimeout(2500);
  const onScreen = await p.evaluate((s) => { const r = document.querySelector(`#e${s} .mmd`)?.getBoundingClientRect(); return r ? r.bottom > -300 && r.top < innerHeight + 300 : null; }, sTop);
  check(onScreen === false && libReqs.length === 0, `off screen: nothing loads yet (on screen ${onScreen}, ${libReqs.length} requests)`);
  await p.locator(`#e${sTop}`).scrollIntoViewIfNeeded();
  check(await drawn(p, sTop) && libReqs.length === 1, `scrolled to: the library loads and the diagram draws`);
  const sLive = await post(b, M("sequenceDiagram\n  Agent->>Board: post text\n  Board-->>Web: entry\n  Web->>Web: draw"));
  await p.waitForSelector(`#e${sLive}`, { timeout: 15000 }).catch(() => {});
  await p.locator(`#e${sLive}`).scrollIntoViewIfNeeded().catch(() => {});
  check(await drawn(p, sLive), `a diagram arriving live draws too (sequence diagram)`);
  await ctx.close();
}

// 4. Offline, and a library that fails its integrity hash: the code block stays, nothing breaks.
for (const [name, route] of [
  ["offline", (r) => r.abort("internetdisconnected")],
  ["tampered library (SRI)", (r) => r.fulfill({ status: 200, contentType: "application/javascript", headers: { "access-control-allow-origin": "*" }, body: "window.__pwned='sri';window.mermaid={initialize(){},render(){return {svg:'<svg><script>window.__pwned=1</script></svg>'}}}" })],
]) {
  const { ctx, p, libReqs, errors } = await open(B, { w: 390, scheme: "light", route });
  await p.locator(`#e${sFlow}`).scrollIntoViewIfNeeded();
  const ok = await settled(p, sFlow);
  const r = await p.evaluate((s) => { const el = document.querySelector(`#e${s} .mmd`); return { state: el?.dataset.mmd, code: !!el?.querySelector(":scope>.code-b code")?.textContent.includes("flowchart"), svg: !!el?.querySelector(".mmd-d"), pwned: window.__pwned ?? null }; }, sFlow);
  check(ok && r.state === "code" && r.code && !r.svg && r.pwned === null && libReqs.length >= 1, `${name}: the code block stays as today (${JSON.stringify(r)})`);
  check(!errors.length, `${name}: no page errors ${errors.join(" | ")}`);
  await ctx.close();
}

await browser.close();
console.log(fails ? `${fails} FAILED` : "mermaid: all passed");
process.exit(fails ? 1 : 0);
