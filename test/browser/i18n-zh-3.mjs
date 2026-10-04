// Languages step 3 (#1724): the board's dialogs and bars in 简体中文 (Developer mode, so every control shows): Members &
// access, the task card, entry details, the soul editor, Recap, a new file, the emoji picker, the read-aloud bar,
// keyboard shortcuts and search. Fails if English is left outside names, messages, code and brands. Pages send
// Vary: Accept-Language. No page errors.
// Usage: BASE=http://localhost:8787 node i18n-zh-3.mjs
import { chromium } from "playwright-core";
const BASE = (process.env.BASE || "http://localhost:8787").replace(/\/$/, "");
const KEY = process.env.ADMIN_KEY || "ci-admin-key";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": KEY, "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-5), P = `zd${run}`, Q = `ze${run}`;
for (const u of [P, Q]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true" });
const board = (await ops("boards", { user: P, title: `对话框 ${run}` })).board.id;
await ops("members", { board, user: Q });
const ck = (await ops("sessions", { user: P })).cookie, tokQ = (await ops("tokens", { user: Q })).token;
const cookie = ck.split(";")[0];
await fetch(`${BASE}/api/app/prefs`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ display: { mode: "developer" } }) });
const post = async (body) => (await (await fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { authorization: `Bearer ${tokQ}`, "content-type": "application/json" }, body: JSON.stringify(body) })).json()).entry.seq;
const q = await post({ type: "question", text: "Which port does staging use?" });
const t = await post({ type: "task", text: "Rotate the staging key\n- [ ] make a new key\n- [ ] update the secret" });
let fails = 0;
const check = (ok, m) => { console.log(`${ok ? "✓" : "✗"} ${m}`); if (!ok) fails++; };
const r0 = await fetch(`${BASE}/b/${board}`, { headers: { cookie } });
check((r0.headers.get("vary") || "").includes("Accept-Language"), `pages send Vary: Accept-Language (${r0.headers.get("vary")})`);
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const ctx = await b.newContext({ viewport: { width: 1300, height: 900 }, locale: "zh-CN" });
const [k, ...v] = cookie.split("=");
await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
const p = await ctx.newPage();
const errors = [];
p.on("pageerror", (e) => errors.push(e.message));
const BRAND = /^(Atteo|atteo|Grok|ChatGPT|Claude|Codex|Cursor|VS Code|Muse|Gemini|Conductor|CLI|MCP|API|UTC|JSON|Webhook|OpenAI|Anthropic|PROTOCOL\.md|MEMORY\.md|SOUL|Markdown|GitHub|复制 JSON)\b/;
const leftIn = (sel) => p.evaluate(([sel, run, brand]) => {
  const root = document.querySelector(sel);
  if (!root) return ["(missing " + sel + ")"];
  const skip = (el) => el.closest("pre, code, .mono, kbd, script, style, [hidden], .who, .ag-name, .body, .td-title, textarea, input, .tk-t, .rp-body, .rp-quick, .ck-t, .one, .pal-hint, .t-name, .fold-peek, .rc-item, .rc-t, td.sum, td.mono, #sheet-kv dd, th");
  const out = new Set();
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const t = n.textContent.trim();
    if (!/[A-Za-z]{3}/.test(t) || !n.parentElement || skip(n.parentElement)) continue;
    const r = n.parentElement.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (t.includes(run) || new RegExp(brand).test(t) || /^b_[a-z0-9]+$/.test(t)) continue;
    out.add(t.slice(0, 60));
  }
  return [...out];
}, [sel, run, BRAND.source]);
const audit = async (name, sel) => { const left = await leftIn(sel); check(!left.length, `${name} in Chinese${left.length ? ` (English left: ${JSON.stringify(left)})` : ""}`); };

await p.goto(`${BASE}/b/${board}`);
await p.waitForTimeout(800);
check((await p.evaluate(() => document.documentElement.dataset.mode)) !== "everyday", "Developer mode (every control shows)");
await audit("the board page", "#app");
// Members & access
await p.locator('[data-open="invite"]').first().click();
await p.waitForTimeout(600);
await audit("Members & access", "#invite");
await p.keyboard.press("Escape");
// The task card dialog
await p.locator(`#e${t} [data-tk="open"]`).first().click().catch(() => {});
await p.waitForTimeout(600);
if (await p.locator("dialog[open]").count()) { await audit("the task dialog", "dialog[open]"); await p.keyboard.press("Escape"); } else check(false, "the task dialog opens");
// Entry details (J, then Enter)
await p.locator("body").click({ position: { x: 600, y: 300 } });
await p.keyboard.press("j");
await p.keyboard.press("Enter");
await p.waitForTimeout(500);
if (await p.locator("#sheet[open]").count()) { await audit("entry details", "#sheet"); await p.keyboard.press("Escape"); } else check(false, "entry details open");
// Soul editor
const soulBtn = p.locator("[data-soul-edit]");
if (await soulBtn.count()) { await soulBtn.first().click(); await p.waitForTimeout(300); await audit("the soul editor", "#soul-dlg"); await p.keyboard.press("Escape"); }
// Recap
const recap = p.locator("#recap-btn");
if (await recap.isVisible()) { await recap.click(); await p.waitForTimeout(800); await audit("Recap", "#recap-dlg"); await p.keyboard.press("Escape"); }
// Emoji picker
await p.locator(`#e${q}`).hover();
await p.locator(`#e${q} .acts [data-rx-add]`).click();
await p.waitForTimeout(300);
await audit("the emoji picker", ".rx-pick");
const tabs = await p.locator(".rx-pick .rp-tabs button").evaluateAll((bs) => bs.map((x) => x.getAttribute("aria-label")));
check(tabs.includes("笑脸与人物") && tabs.includes("常用"), `emoji categories in Chinese (${tabs.join(", ")})`);
await p.keyboard.press("Escape");
// Files: a new file
await p.locator('[aria-controls="panel-docs"]').click();
await p.waitForTimeout(300);
await p.locator("#doc-new").click().catch(() => {});
await p.waitForTimeout(300);
await audit("the Files panel", "#panel-docs");
// Log
await p.locator('[aria-controls="panel-log"]').click();
await p.waitForTimeout(300);
await audit("the Log", "#panel-log");
await p.locator('[aria-controls="panel-conv"]').click();
// Composer buttons' tooltips
const tips = await p.locator("#mic-btn, #aloud-btn, #po-btn").evaluateAll((bs) => bs.map((x) => x.getAttribute("title") || ""));
check(tips.every((x) => !/[A-Za-z]{4}/.test(x.replace(/send it|go ahead/g, ""))), `composer tooltips in Chinese (${tips.join(" | ")})`);
// Shortcuts and search
await p.keyboard.press("?");
await p.waitForTimeout(200);
await audit("keyboard shortcuts", "#shortcuts");
await p.keyboard.press("Escape");
await p.keyboard.press("Control+k");
await p.waitForTimeout(400);
await audit("search", "#palette");
await p.keyboard.press("Escape");
check(errors.length === 0, `no page errors (${errors.join(" | ")})`);
await b.close();
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
