// BASE=http://localhost:8703 node test/browser/csp.mjs
// Uses local ops fixtures; ADMIN_KEY is intentionally unset, matching scripts/ship.sh.
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8703";
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
try {
  const context = await browser.newContext();
  await context.addCookies([{ name: cookie.split("=")[0], value: cookie.split(";")[0].split("=").slice(1).join("="), url: BASE }]);
  const page = await context.newPage();
  page.on("console", (msg) => { if (/content security policy|content-security-policy|\bCSP\b/i.test(msg.text())) violations.push(msg.text()); });
  page.on("pageerror", (error) => { if (/content security policy|content-security-policy|\bCSP\b/i.test(error.message)) violations.push(error.message); });
  for (const path of [`/b/${board}`, "/for-you", "/me"]) {
    const response = await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
    if (!response?.ok()) throw new Error(`${path}: ${response?.status()}`);
    if (!response.headers()["content-security-policy"]) throw new Error(`${path}: missing CSP`);
    if (path.startsWith("/b/")) {
      await page.locator(".mmd[data-mmd='drawn'] svg").first().waitFor({ timeout: 20000 });
    }
  }
  if (violations.length) throw new Error(`CSP violations:\n${violations.join("\n")}`);
  console.log("CSP: board, For you, Account, and Mermaid passed");
} finally { await browser.close(); }
