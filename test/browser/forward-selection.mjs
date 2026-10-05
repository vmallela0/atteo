// Forward selected text to another board (vedu #1023): select words → Forward → pick a board → the excerpt
// lands as a quote box with who said it, the words and ↗ original. Whole-entry forwards stay unchanged.
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), A = `fsa${run}`, B = `fsb${run}`;
for (const u of [A, B]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true" });
const tokA = (await ops("tokens", { user: A })).token;
const src = (await ops("boards", { user: B, title: `Source ${run}` })).board.id;
await ops("members", { board: src, user: A });
const dst = (await ops("boards", { user: B, title: `Target ${run}` })).board.id;
await ops("members", { board: dst, user: A });
const mcp = async (b, name, args) => {
  await fetch(`${BASE}/mcp?board=${b}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tokA}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read", arguments: {} } }) });
  return (await (await fetch(`${BASE}/mcp?board=${b}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tokA}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json()).result.content[0].text;
};
const WORDS = "staging uses port 8443, per the load balancer config";
const s1 = +(await mcp(src, "post", { type: "note", text: `Heads up: ${WORDS}. The old notes saying 8080 are stale.` })).match(/#(\d+)/)[1];
const ck = (await ops("sessions", { user: A })).cookie;
let fails = 0;
const check = (ok, m) => { console.log(`${ok ? "✓" : "✗"} ${m}`); if (!ok) fails++; };
const RANGE = `window.qRange=(s,w)=>{const body=document.querySelector('#e'+s+'>.grow>.body'),ns=[],tw=document.createTreeWalker(body,NodeFilter.SHOW_TEXT);let n,all='';
  while((n=tw.nextNode())){ns.push([n,all.length]);all+=n.data}const i=all.indexOf(w);if(i<0)return null;
  const at=o=>{for(let k=ns.length-1;k>=0;k--)if(ns[k][1]<=o)return [ns[k][0],o-ns[k][1]]};const g=document.createRange();g.setStart(...at(i));g.setEnd(...at(i+w.length));return g}`;
const select = async (p, seq, words, mouse) => {
  await p.evaluate(async (s) => { for (let i = 0; i < 4; i++) { (document.getElementById("e" + s) || document.getElementById("g" + s)).scrollIntoView({ block: "center" }); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); } }, seq);
  await p.waitForTimeout(150);
  const r = await p.evaluate(([s, w]) => { const g = qRange(s, w); if (!g) return null; const rs = [...g.getClientRects()].filter((x) => x.width), a = rs[0], z = rs[rs.length - 1]; return { x0: a.left, y0: a.top + a.height / 2, x1: z.right, y1: z.top + z.height / 2 }; }, [seq, words]);
  if (!r) throw new Error(`"${words}" not in #${seq}`);
  if (mouse) { await p.mouse.move(r.x0 + 0.5, r.y0); await p.mouse.down(); await p.mouse.move((r.x0 + r.x1) / 2, r.y1, { steps: 4 }); await p.mouse.move(r.x1 - 0.5, r.y1, { steps: 4 }); await p.mouse.up(); }
  else await p.evaluate(([s, w]) => { getSelection().removeAllRanges(); getSelection().addRange(qRange(s, w)); }, [seq, words]);
  await p.waitForTimeout(300);
};
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
for (const [label, w, h, phone] of [["desktop", 1280, 820, false], ["phone", 390, 844, true]]) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, ...(phone ? { hasTouch: true, isMobile: true } : {}) });
  const [k, ...v] = ck.split(";")[0].split("=");
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage();
  await p.addInitScript(RANGE);
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${BASE}/b/${src}`);
  await p.locator(`#e${s1} .body`).waitFor({ timeout: 8000 }).catch(() => {});
  await select(p, s1, WORDS, !phone);
  check(await p.locator("#sel-float").isVisible() && await p.locator("#fwd-q-btn").isVisible(), `${label}: selecting text shows Forward`);
  if (phone) await p.locator("#fwd-q-btn").tap();
  else await p.locator("#fwd-q-btn").click();
  await p.locator("#fwd-dlg").waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  check(await p.locator("#fwd-dlg").isVisible(), `${label}: Forward opens the forward dialog`);
  check((await p.locator("#fwd-n").innerText()).toLowerCase().includes("excerpt"), `${label}: dialog title says excerpt`);
  check((await p.locator("#fwd-prev").innerText()).includes(WORDS), `${label}: preview shows the selected words`);
  await p.locator("#fwd-q").fill("Target");
  await p.waitForTimeout(150);
  await p.locator(`#fwd-list [data-to="${dst}"]`).click();
  await p.locator("#fwd-note").fill(`see this excerpt ${label}`);
  await p.screenshot({ path: `${SHOTS_DIR}/forward-selection-${label}.png` });
  await p.locator("#fwd-send").click();
  await p.locator("#fwd-dlg").waitFor({ state: "hidden", timeout: 8000 }).catch(() => {});
  await p.goto(`${BASE}/b/${dst}`);
  await p.locator("#thread .entry", { hasText: `see this excerpt ${label}` }).waitFor({ timeout: 8000 }).catch(() => {});
  const last = p.locator("#thread .entry").last();
  const t = await last.innerText();
  check(t.includes(`see this excerpt ${label}`) && t.includes(`Forwarded from Source ${run}`) && t.includes("excerpt"), `${label}: note and forward header on the target board`);
  const box = last.locator("blockquote.qt");
  check(await box.count() === 1, `${label}: the excerpt is a quote box`);
  check((await box.locator(".qt-t").innerText()) === WORDS, `${label}: …with the selected words`);
  check((await box.locator(".qt-who").innerText()) === `${A}'s agent`, `${label}: …and who said them`);
  check((await box.locator(".qt-go").innerText()).trim() === "↗ original", `${label}: …and ↗ original`);
  check(!t.includes("8080 are stale"), `${label}: the rest of the source message is not quoted`);
  check(errors.length === 0, `${label}: no page errors ${errors.join(" | ")}`);
  await ctx.close();
}
await b.close();
console.log(fails ? `${fails} FAILED` : "all forward-selection checks passed");
process.exit(fails ? 1 : 0);
