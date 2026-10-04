// Languages step 2 (#1701): For you, Inbox, Approvals, People, Account and the welcome page in 简体中文 and 繁體中文.
// Each renders in the browser's Chinese, its scripts run without errors, nothing scrolls sideways at 390px, and the
// English left is only names, messages and code. Prints what's left per page.
// Usage: BASE=http://localhost:8787 node i18n-zh-2.mjs
import { chromium } from "playwright-core";
const BASE = (process.env.BASE || "http://localhost:8787").replace(/\/$/, "");
const KEY = process.env.ADMIN_KEY || "ci-admin-key";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": KEY, "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-5), P = `zp${run}`, Q = `zr${run}`;
for (const u of [P, Q]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true" });
const board = (await ops("boards", { user: P, title: `测试 ${run}` })).board.id;
await ops("members", { board, user: Q });
const ck = (await ops("sessions", { user: P })).cookie, tokQ = (await ops("tokens", { user: Q })).token;
await fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { authorization: `Bearer ${tokQ}`, "content-type": "application/json" }, body: JSON.stringify({ type: "question", text: `@${P} can you check this?` }) });
let fails = 0;
const check = (ok, m) => { console.log(`${ok ? "✓" : "✗"} ${m}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const errors = [];
const [k, ...v] = ck.split(";")[0].split("=");
const english = (p) => p.evaluate((run) => {
  const skip = (el) => el.closest("pre, code, .mono, kbd, script, style, [hidden], .side-board, .who, .bcard h3, .truncate.small.muted, .small.muted.truncate, .inbox-item .small b, .ev-name, .ev-link, .tt, .fy-hi h1");
  const out = new Set();
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const t = n.textContent.trim();
    if (!/[A-Za-z]{3}/.test(t) || !n.parentElement || skip(n.parentElement)) continue;
    const r = n.parentElement.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    out.add(t.slice(0, 50));
  }
  return [...out].filter((t) => !/^(Atteo|atteo|Grok|ChatGPT|Claude|Codex|Cursor|VS Code|Muse|Gemini|Conductor|CLI|MCP|API|UTC|JSON|Webhook|OpenAI|Anthropic|Stripe|Free|Pro)\b/.test(t) && !t.includes(run));
}, run);
for (const [locale, lang, sample] of [["zh-CN", "zh-Hans", "收件箱"], ["zh-TW", "zh-Hant", "收件匣|收件箱"]]) {
  for (const w of [1300, 390]) {
    const ctx = await b.newContext({ viewport: { width: w, height: 860 }, locale });
    await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
    const p = await ctx.newPage();
    p.on("pageerror", (e) => errors.push(`${lang} ${w}: ${e.message}`));
    for (const path of ["/for-you", "/inbox", "/approvals", "/people", "/me", "/welcome"]) {
      await p.goto(BASE + path);
      await p.waitForTimeout(300);
      const okLang = (await p.locator("html").getAttribute("lang")) === lang;
      const over = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      const left = await english(p);
      check(okLang && over <= 1 && /[一-鿿]/.test(await p.locator("main, .content").first().innerText()), `${lang} ${w}px ${path}: in Chinese, fits (${over}px)`);
      if (w === 1300) console.log(`  English left on ${path}: ${JSON.stringify(left)}`);
    }
    const sidebar = await p.locator(".sidebar").innerText().catch(() => "");
    check(new RegExp(sample).test(sidebar), `${lang} ${w}px: the sidebar too`);
    await ctx.close();
  }
}
check(errors.length === 0, `no page errors (${errors.join(" | ")})`);
await b.close();
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
