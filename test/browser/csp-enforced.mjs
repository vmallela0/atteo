// BASE=http://localhost:8787 node test/browser/csp-enforced.mjs
// What breaks when CSP_ENFORCE flips (#2722): this check turns the report-only header into an enforcing one in the
// browser and walks the flows that a page-wide policy can break without any report on the pages themselves:
// - OAuth consent: browsers apply form-action to the redirect after the POST, so Allow and Don't allow must still reach
//   the client's redirect_uri (an http one here; claude.ai and cursor:// get the same treatment);
// - HTML previews: scripts, inline handlers (onclick=) and a frame-busting file all behave as in report-only, and
//   nothing reaches the network;
// - the lazy bug-report script inherits the page nonce and the dialog opens;
// - the main pages and a board with code colours and a mermaid diagram load with no violation;
// - /_ops (admin-only) Overview, Access and Events, via a localhost ops session (DEV_FAKE_ADMIN=1, lib/admin.mjs; CI has no ADMIN_EMAIL).
import { createServer } from "node:http";
import { chromium } from "playwright-core";
import { adminCookie, adminSession } from "./lib/admin.mjs";
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => {
  const r = await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": process.env.ADMIN_KEY || "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) });
  if (!r.ok) throw new Error(`ops ${p}: ${r.status}`);
  return r.json();
};
const hits = [];
const srv = createServer((q, r) => { hits.push(q.url); r.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" }); r.end("ok"); });
await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
const OUT = `http://127.0.0.1:${srv.address().port}`;
const run = Date.now().toString(36).slice(-5), P = `ce${run}`, V = `cv${run}`;
for (const u of [P, V]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true", display: { mode: "developer" } });
const board = (await ops("boards", { user: P, title: `CSP enforced ${run}` })).board.id;
await ops("members", { board, user: V });
const ck = (await ops("sessions", { user: P })).cookie, tokV = (await ops("tokens", { user: V })).token;
const mcp = async (name, args) => (await fetch(`${BASE}/mcp?board=${board}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tokV}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json();
await mcp("read", {});
await mcp("post", { type: "note", text: "code:\n```js\nconst a = 1; // hi\n```\n```mermaid\nflowchart LR\n A --> B\n```" });
const files = {
  onclick: `<!doctype html><style>#o{color:rgb(12,34,56)}</style><button id="b" onclick="document.getElementById('o').textContent='clicked'">go</button><pre id="o" style="padding:7px">idle</pre>`,
  script: `<!doctype html><style>#o{color:rgb(12,34,56)}</style><pre id="o" style="padding:7px">idle</pre><script>document.getElementById('o').textContent='ran';fetch('${OUT}/preview').catch(()=>{});new Image().src='${OUT}/preview-img'</script>`,
};
for (const [k, html] of Object.entries(files)) await mcp("post", { type: "artifact", text: `case ${k}`, artifact_name: `ce-${k}-${run}.html`, artifact_content: html });
// An OAuth client whose redirect_uri is the listener above.
const cb = `${OUT}/cb`;
const reg = await (await fetch(`${BASE}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: `Probe ${run}`, redirect_uris: [cb] }) })).json();
const verifier = "v".repeat(50), challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
const authorize = (state) => `${BASE}/oauth/authorize?response_type=code&client_id=${reg.client_id}&redirect_uri=${encodeURIComponent(cb)}&code_challenge=${challenge}&code_challenge_method=S256&state=${state}`;

let fails = 0;
const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
let enforced = 0;
const enforce = async (route) => {
  const r = await route.fetch({ maxRedirects: 0 }).catch(() => null);
  if (!r) return route.abort().catch(() => {});
  const h = r.headers();
  if (h["content-security-policy-report-only"]) { h["content-security-policy"] = h["content-security-policy-report-only"]; delete h["content-security-policy-report-only"]; enforced++; }
  else if (/'nonce-/.test(h["content-security-policy"] ?? "")) enforced++; // CSP_ENFORCE is already on
  await route.fulfill({ response: r, headers: h }).catch(() => {});
};
const ctx = await b.newContext({ viewport: { width: 1200, height: 820 } });
await ctx.addCookies([{ name: ck.split("=")[0], value: ck.split(";")[0].split("=").slice(1).join("="), url: BASE }]);
await ctx.route(`${BASE}/**`, enforce);
// A page of its own for each part, so they run side by side; each collects its own violations.
const open = async () => {
  const p = await ctx.newPage(), viol = [];
  p.on("console", (m) => { if (/content security policy/i.test(m.text())) viol.push(m.text().slice(0, 200)); });
  p.on("pageerror", (e) => viol.push(`pageerror: ${e.message.slice(0, 160)}`));
  return { p, viol };
};
const pages = async () => {
  await Promise.all(["/", "/chats", `/b/${board}`, "/inbox", "/approvals", "/people", "/me", "/guide", "/docs", "/terms", "/privacy", "/welcome", "/for-you", "/ask", "/device"].map(async (path) => {
    const { p, viol } = await open();
    await p.goto(`${BASE}${path}`); await p.waitForTimeout(800);
    check(!viol.length, `${path}: no violations with the policy enforced ${viol.join(" | ")}`);
    await p.close();
  }));
  check(enforced > 0, `the pages' policy really was enforced (${enforced} responses)`);
};
const drawing = async () => {
  const { p } = await open();
  await p.goto(`${BASE}/b/${board}`);
  const drawn = await p.locator("#thread .mmd[data-mmd='drawn'] svg").first().waitFor({ timeout: 20000 }).then(() => true, () => false);
  check(await p.locator("#thread pre code span").count() > 0 && drawn, "code colours and the mermaid diagram render");
  await p.close();
};
const preview = async (k) => {
  const { p, viol } = await open();
  await p.goto(`${BASE}/b/${board}`);
  await p.locator(`#thread [data-preview-file="ce-${k}-${run}.html"]`).click();
  const f = p.frameLocator("#pv-frame");
  if (k === "onclick") await f.locator("#b").click({ timeout: 10000 }).catch(() => {});
  const want = k === "onclick" ? "clicked" : "ran";
  await f.locator("#o", { hasText: want }).waitFor({ timeout: 10000 }).catch(() => {});
  await p.waitForTimeout(300); // a violation report, if any, comes just after
  const o = await f.locator("#o").innerText().catch(() => "?");
  const styled = await f.locator("#o").evaluate(el => {
    const s = getComputedStyle(el); return s.color === "rgb(12, 34, 56)" && s.paddingTop === "7px";
  }).catch(() => false);
  // The preview's own policy blocking its fetch and image is expected; only the page's policy (the nonce one) counts here.
  const page = viol.filter((v) => /'nonce-|form-action 'self'/.test(v));
  check(o === want && styled && !page.length, `preview ${k}: script/handler and styles work with the page's policy enforced (${o}, styled=${styled}) ${page.join(" | ")}`);
  await p.close();
};
const bugReport = async () => {
  const { p, viol } = await open();
  const response = await p.goto(`${BASE}/for-you`);
  const nonce = (await response.allHeaders())["content-security-policy"]?.match(/'nonce-([^']+)'/)?.[1] ?? "";
  const bugJs = p.waitForResponse((r) => new URL(r.url()).pathname === "/bug.js");
  await p.locator("[data-bug]").click();
  await bugJs;
  await p.locator("#bug[open]").waitFor();
  await p.locator("#bug-send:not([disabled])").waitFor({ timeout: 20000 });
  const dynamicNonces = await p.locator("script#bug-js").evaluateAll((xs) => xs.map((x) => x.nonce));
  check(!!nonce && dynamicNonces.length === 1 && dynamicNonces.every((n) => n === nonce) && !viol.length, `the bug-report script inherits the nonce and the dialog opens ${viol.join(" | ")}`);
  await p.close();
};
const opsConsole = async () => {
  const admin = await adminSession(BASE);
  const aCtx = await b.newContext({ viewport: { width: 1200, height: 820 } });
  await aCtx.addCookies([adminCookie(admin, BASE)]);
  await aCtx.route(`${BASE}/**`, enforce);
  const p = await aCtx.newPage(), viol = [];
  p.on("console", (m) => { if (/content security policy/i.test(m.text())) viol.push(m.text().slice(0, 200)); });
  p.on("pageerror", (e) => viol.push(`pageerror: ${e.message.slice(0, 160)}`));
  try {
    const response = await p.goto(`${BASE}/_ops`);
    const title = await p.locator("h1").first().innerText().catch(() => "");
    check(!!response?.ok() && title === "Ops", `/_ops opens for a localhost admin session (${response?.status()} ${title})`);
    for (const [i, tab] of ["Overview", "Access", "Events"].entries()) {
      await p.locator("#ops-tabs button").nth(i).click();
      await p.waitForTimeout(400);
      const selected = await p.locator("#ops-tabs button[aria-selected='true']").innerText();
      const scriptsOk = await p.evaluate(() => {
        const scripts = [...document.querySelectorAll("script")];
        return scripts.length > 0 && scripts.every((s) => !!s.nonce);
      });
      check(selected === tab && scriptsOk && !viol.length, `/_ops ${tab}: nonce on every script, no violations ${viol.join(" | ")}`);
    }
  } finally {
    await p.close();
    await aCtx.unrouteAll({ behavior: "ignoreErrors" });
    await aCtx.close();
  }
};
const consent = async (allow) => {
  const { p, viol } = await open();
  const label = allow ? "Allow" : "Don't allow", state = `s${allow ? 1 : 0}${run}`;
  await p.goto(authorize(state));
  await p.locator(`form[action="/oauth/authorize"] button[name="allow"][value="${allow ? 1 : 0}"]`).click();
  const deadline = Date.now() + 10000;
  let got;
  while (!(got = hits.find((h) => h.startsWith("/cb") && h.includes(`state=${state}`))) && Date.now() < deadline) await p.waitForTimeout(50);
  await p.waitForTimeout(200);
  const ok = allow ? got && got.includes("code=") : got && got.includes("error=access_denied");
  check(!!ok && !viol.length, `OAuth consent, ${label}: the redirect reaches the client (${(got || "nothing").slice(0, 60)}) ${viol.join(" | ")}`);
  await p.close();
};
try {
  await Promise.all([pages(), drawing(), ...Object.keys(files).map(preview), bugReport(), opsConsole(), consent(true), consent(false)]);
  check(!hits.some((h) => h.startsWith("/preview")), `a preview still can't reach the network (${hits.join(", ") || "nothing arrived"})`);
} finally {
  await ctx.unrouteAll({ behavior: "ignoreErrors" });
  await b.close();
  srv.close();
}
console.log(fails ? `${fails} FAILED` : "csp enforced: all passed");
process.exit(fails ? 1 : 0);
