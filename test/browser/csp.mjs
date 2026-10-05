// BASE=http://localhost:8787 node test/browser/csp.mjs
// The pages' Content-Security-Policy is report-only for now (jxn's agent #2636). This check opens the main pages (and a
// board with a mermaid diagram) and fails if the browser reports anything the policy would block, by watching for
// reports sent to /api/csp-report and for CSP console messages, so the switch to enforcing is known to be safe.
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const run = Date.now().toString(36).slice(-6);
const user = `csp${run}`;
const ops = async (path, body) => {
  const res = await fetch(`${BASE}/api/ops/${path}`, { method: "POST", headers: { "x-admin-key": "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`ops ${path}: ${res.status}`);
  return res.json();
};
await ops("users", { name: user, email: `${user}@example.com`, verified: "true" });
const cookie = (await ops("sessions", { user })).cookie;
const board = (await ops("boards", { user, title: `CSP ${run}` })).board.id;
const post = await fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ type: "note", text: "```mermaid\nflowchart LR\n A[Start] --> B[End]\n```" }) });
if (!post.ok) throw new Error(`post: ${post.status}`);
const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const violations = [];
let fails = 0;
const check = (ok, title) => { console.log(`${ok ? "✓" : "✗"} ${title}`); if (!ok) fails++; };
try {
  const context = await browser.newContext();
  await context.addCookies([{ name: cookie.split("=")[0], value: cookie.split(";")[0].split("=").slice(1).join("="), url: BASE }]);
  const page = await context.newPage();
  const csp = /content security policy|content-security-policy|\bCSP\b/i;
  page.on("console", (msg) => { if (csp.test(msg.text())) violations.push(`console: ${msg.text()}`); });
  page.on("pageerror", (error) => { if (csp.test(error.message)) violations.push(`error: ${error.message}`); });
  page.on("request", (req) => { if (req.url().includes("/api/csp-report")) violations.push(`report: ${req.postData()?.slice(0, 300)}`); });
  for (const path of [`/b/${board}`, "/for-you", "/inbox", "/me", "/approvals", "/people", "/guide"]) {
    const response = await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
    if (!response?.ok()) { check(false, `${path} opens (${response?.status()})`); continue; }
    const h = response.headers();
    check(!!h["content-security-policy-report-only"] && !h["content-security-policy"], `${path}: report-only CSP header, not enforcing yet`);
    check((h["content-security-policy-report-only"] ?? "").includes("report-uri /api/csp-report"), `${path}: reports go to /api/csp-report`);
    if (path.startsWith("/b/")) {
      await page.locator(".mmd[data-mmd='drawn'] svg").first().waitFor({ timeout: 20000 });
      check(true, "mermaid draws under the policy");
    }
  }
  await page.waitForTimeout(500); // reports are sent after the fact
  check(violations.length === 0, `no CSP violations reported${violations.length ? `:\n  ${violations.join("\n  ")}` : ""}`);
  // The endpoint takes reports without a sign-in and always answers 204.
  const r = await fetch(`${BASE}/api/csp-report`, { method: "POST", headers: { "content-type": "application/csp-report" }, body: JSON.stringify({ "csp-report": { "effective-directive": "img-src", "blocked-uri": "https://x.example/a.png" } }) });
  check(r.status === 204, "the report endpoint answers 204 without a sign-in");
} finally {
  await browser.close();
}
if (fails) { console.log(`${fails} FAILED`); process.exit(1); }
console.log("csp: all passed");
