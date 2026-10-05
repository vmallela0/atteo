// BASE=http://localhost:8787 node test/browser/csp.mjs
// The pages' Content-Security-Policy is report-only until CSP_ENFORCE (src/ui.ts) flips (jxn's agent #2636, #2722); this
// check expects whichever header that switch says, so the flip needs no change here. It opens the main pages (and a
// board with a mermaid diagram), an HTML preview, a voice call, and /_ops (DEV_FAKE_ADMIN localhost session; CI has no ADMIN_EMAIL), and fails if the browser reports anything the policy
// would block, by watching for reports sent to /api/csp-report and for CSP console messages, so the switch to enforcing
// is known to be safe. The preview runs from /preview-frame with its own enforced CSP (opus-b #2678): it must never see
// the page's nonce, and its scripts must not reach the network.
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
import { adminCookie, adminSession } from "./lib/admin.mjs";
const ENFORCE = /^export const CSP_ENFORCE = true;/m.test(readFileSync(new URL("../../src/ui.ts", import.meta.url), "utf8"));
const HEADER = ENFORCE ? "content-security-policy" : "content-security-policy-report-only", OTHER = ENFORCE ? "content-security-policy-report-only" : "content-security-policy";
const BASE = process.env.BASE || "http://localhost:8787";
const run = Date.now().toString(36).slice(-6);
const user = `csp${run}`;
const ops = async (path, body) => {
  const res = await fetch(`${BASE}/api/ops/${path}`, { method: "POST", headers: { "x-admin-key": "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`ops ${path}: ${res.status}`);
  return res.json();
};
await ops("users", { name: user, email: `${user}@example.com`, verified: "true", display: { mode: "developer" } });
const cookie = (await ops("sessions", { user })).cookie;
const token = (await ops("tokens", { user })).token;
const board = (await ops("boards", { user, title: `CSP ${run}` })).board.id;
const post = await fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ type: "note", text: "```mermaid\nflowchart LR\n A[Start] --> B[End]\n```" }) });
if (!post.ok) throw new Error(`post: ${post.status}`);
// An HTML file whose script tries to reach this server and reports what happened into #o.
const mcp = async (name, args) => (await (await fetch(`${BASE}/mcp?board=${board}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json()).result?.content?.[0]?.text;
const FILE = `csp-${run}.html`;
await mcp("read", {});
await mcp("post", { type: "artifact", text: "preview me", artifact_name: FILE, artifact_content: `<!doctype html><html><body><pre id="o">waiting</pre><script>
const o=document.getElementById('o');o.textContent='ran';
fetch(${JSON.stringify(BASE + "/health")}).then(()=>{o.textContent='fetched'}).catch(()=>{o.textContent='blocked'});
</script></body></html>` });

const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
const violations = [];
let fails = 0;
const check = (ok, title) => { console.log(`${ok ? "✓" : "✗"} ${title}`); if (!ok) fails++; };
// A stand-in for the voice provider's socket, as voice-chat.mjs does: the call runs its real page code without xAI.
const FAKE_WS = `(()=>{const Real=window.WebSocket;
  window.WebSocket=function(url,protocols){if(!String(url).startsWith('wss://api.x.ai'))return new Real(url,protocols);
    const ws={url,protocols,readyState:0,send(){},close(){if(this.readyState===3)return;this.readyState=3;setTimeout(()=>this.onclose&&this.onclose({}),0)}};
    setTimeout(()=>{ws.readyState=1;ws.onopen&&ws.onopen({})},50);return ws};
  Object.assign(window.WebSocket,{CONNECTING:0,OPEN:1,CLOSING:2,CLOSED:3});})()`;
try {
  const context = await browser.newContext({ permissions: ["microphone"] });
  await context.addCookies([{ name: cookie.split("=")[0], value: cookie.split(";")[0].split("=").slice(1).join("="), url: BASE }]);
  const page = await context.newPage();
  await page.addInitScript(FAKE_WS);
  await page.route("**/api/app/voice/**", (route) => route.continue({ headers: { ...route.request().headers(), "x-dev-fake-voice": "1" } }));
  const csp = /content security policy|content-security-policy|\bCSP\b/i;
  // The pages' policy is report-only, so each of their violations says so (and is also sent to /api/csp-report, caught
  // below). An enforced block can only be the preview frame's own CSP stopping its file, which is the point (checked
  // below), not a page violation.
  page.on("console", (msg) => { if (csp.test(msg.text()) && /report-only/i.test(msg.text())) violations.push(`console: ${msg.text()}`); });
  // Enforced or not, the page's own document hears each violation of its policy (the preview frame's are its own).
  await page.exposeBinding("__cspViolation", (_src, v) => violations.push(`violation: ${v}`));
  await page.addInitScript(() => { if (window === window.top) document.addEventListener("securitypolicyviolation", (e) => window.__cspViolation(`${e.disposition} ${e.effectiveDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber} ${location.pathname}`)); });
  page.on("pageerror", (error) => { if (csp.test(error.message)) violations.push(`error: ${error.message}`); });
  page.on("request", (req) => { if (req.url().includes("/api/csp-report")) violations.push(`report: ${req.postData()?.slice(0, 300)}`); });
  let pageNonce = "";
  for (const path of [`/b/${board}`, "/for-you", "/inbox", "/me", "/approvals", "/people", "/guide"]) {
    const response = await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
    if (!response?.ok()) { check(false, `${path} opens (${response?.status()})`); continue; }
    const h = response.headers();
    const policy = h[HEADER] ?? "";
    check(!!policy && !h[OTHER], `${path}: ${ENFORCE ? "enforced" : "report-only"} CSP header, as CSP_ENFORCE says`);
    check(policy.includes("report-uri /api/csp-report"), `${path}: reports go to /api/csp-report`);
    check(/connect-src 'self' wss:\/\/api\.x\.ai(;|$)/.test(policy), `${path}: sockets only to this host and the voice provider`);
    if (path.startsWith("/b/")) {
      pageNonce = policy.match(/'nonce-([a-f0-9]+)'/)?.[1] ?? "";
      await page.locator(".mmd[data-mmd='drawn'] svg").first().waitFor({ timeout: 20000 });
      check(true, "mermaid draws under the policy");

      // The HTML preview: its own route and enforced CSP, no page nonce, no network.
      const frameResp = page.waitForResponse((r) => r.url().includes("/preview-frame"), { timeout: 10000 });
      await page.locator(`[data-preview-file="${FILE}"]`).first().click();
      const fr = await frameResp;
      const fh = fr.headers();
      check(!!fh["content-security-policy"] && /connect-src 'none'/.test(fh["content-security-policy"]) && /sandbox allow-scripts/.test(fh["content-security-policy"]), "the preview frame has its own enforced CSP (sandbox, no network)");
      const out = page.frameLocator("#pv-frame").locator("#o");
      await out.waitFor({ timeout: 10000 });
      let o = "";
      for (let i = 0; i < 20 && !/fetched|blocked/.test(o); i++) { o = await out.innerText(); await page.waitForTimeout(150); }
      check(o === "blocked", `a preview script can't fetch (${o})`);
      const frameHtml = await page.frameLocator("#pv-frame").locator("html").evaluate((e) => e.outerHTML);
      const frameBody = await fr.text();
      check(!!pageNonce && !frameHtml.includes(pageNonce) && !frameBody.includes(pageNonce) && !/nonce/.test(frameBody), "the page's nonce never reaches the preview");
      await page.locator(".pv-dlg [data-pv-close]").click();

      // A voice call (fake provider and socket): the page's audio and socket code under the policy.
      const talk = page.locator("[data-talk]").first();
      if (await talk.count()) {
        await talk.click();
        await page.waitForTimeout(2500);
        check(true, "a voice call runs under the policy");
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);
      } else check(false, "the board has a voice call button");
    }
  }
  await page.waitForTimeout(500); // reports are sent after the fact
  check(violations.length === 0, `no CSP violations reported${violations.length ? `:\n  ${violations.join("\n  ")}` : ""}`);
  // /_ops is operator-only (CI has no ADMIN_EMAIL): a localhost ops session, same checks as the signed-in pages.
  const admin = await adminSession(BASE);
  const opsCtx = await browser.newContext();
  try {
    await opsCtx.addCookies([adminCookie(admin, BASE)]);
    const opsPage = await opsCtx.newPage();
    const opsViol = [];
    opsPage.on("console", (msg) => { if (csp.test(msg.text()) && /report-only/i.test(msg.text())) opsViol.push(`console: ${msg.text()}`); });
    await opsPage.exposeBinding("__cspViolation", (_src, v) => opsViol.push(`violation: ${v}`));
    await opsPage.addInitScript(() => { if (window === window.top) document.addEventListener("securitypolicyviolation", (e) => window.__cspViolation(`${e.disposition} ${e.effectiveDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber} ${location.pathname}`)); });
    const opsResp = await opsPage.goto(`${BASE}/_ops`, { waitUntil: "networkidle" });
    const opsH = opsResp?.headers() ?? {};
    const opsPolicy = opsH[HEADER] ?? "";
    check(!!opsResp?.ok() && (await opsPage.locator("h1").first().innerText()) === "Ops", `/_ops opens for a localhost admin session (${opsResp?.status()})`);
    check(!!opsPolicy && !opsH[OTHER], `/_ops: ${ENFORCE ? "enforced" : "report-only"} CSP header, as CSP_ENFORCE says`);
    check(opsPolicy.includes("report-uri /api/csp-report"), "/_ops: reports go to /api/csp-report");
    for (const [i, tab] of ["Overview", "Access", "Events"].entries()) {
      await opsPage.locator("#ops-tabs button").nth(i).click();
      await opsPage.waitForTimeout(400);
      const selected = await opsPage.locator("#ops-tabs button[aria-selected='true']").innerText();
      check(selected === tab, `/_ops ${tab} tab runs`);
    }
    await opsPage.waitForTimeout(300);
    check(opsViol.length === 0, `/_ops: no CSP violations${opsViol.length ? `:\n  ${opsViol.join("\n  ")}` : ""}`);
  } finally {
    await opsCtx.close();
  }
  // The endpoint takes reports without a sign-in and always answers 204.
  const r = await fetch(`${BASE}/api/csp-report`, { method: "POST", headers: { "content-type": "application/csp-report" }, body: JSON.stringify({ "csp-report": { "effective-directive": "img-src", "blocked-uri": "https://x.example/a.png" } }) });
  check(r.status === 204, "the report endpoint answers 204 without a sign-in");
} finally {
  await browser.close();
}
if (fails) { console.log(`${fails} FAILED`); process.exit(1); }
console.log("csp: all passed");
