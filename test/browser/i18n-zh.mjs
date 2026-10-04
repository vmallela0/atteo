// Languages step 1 (#1649, plan #1646): a browser asking for Chinese gets the home and board pages in 简体中文 (the
// shell too), people's messages untouched; the picker in Account → Display saves English, then Automatic again;
// ?lang= overrides. No sideways scroll at 390px and 1300px, no page errors. Prints any English left on those screens.
// Usage: BASE=http://localhost:8787 node i18n-zh.mjs
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE = (process.env.BASE || "http://localhost:8787").replace(/\/$/, "");
const KEY = process.env.ADMIN_KEY || "ci-admin-key";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": KEY, "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-5), P = `zh${run}`, Q = `zq${run}`;
for (const u of [P, Q]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true" });
const board = (await ops("boards", { user: P, title: `支付 ${run}` })).board.id;
await ops("members", { board, user: Q });
const ck = (await ops("sessions", { user: P })).cookie, tokQ = (await ops("tokens", { user: Q })).token;
const post = async (body) => (await fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { authorization: `Bearer ${tokQ}`, "content-type": "application/json" }, body: JSON.stringify(body) })).json();
await post({ type: "question", text: "Can you check the staging port?" });
await post({ type: "task", text: "Rotate the staging key" });
let fails = 0;
const check = (ok, m) => { console.log(`${ok ? "✓" : "✗"} ${m}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const errors = [];
const [k, ...v] = ck.split(";")[0].split("=");
const open = async (locale, w = 1300, h = 900, scheme = "light") => {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, locale, colorScheme: scheme });
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  return { ctx, p };
};
// Visible English words outside people's messages, code and names: what's left to translate on this screen.
const english = (p) => p.evaluate(() => {
  const skip = (el) => el.closest("#thread .body, pre, code, .mono, kbd, .who, .ag-name, .side-board, .bp-title h1, .bcard h3, .bc-desc, .bc-last, .to, script, style, [hidden], .rp-body, .rx-pick");
  const out = new Set();
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const t = n.textContent.trim();
    if (!/[A-Za-z]{3}/.test(t) || !n.parentElement || skip(n.parentElement)) continue;
    const r = n.parentElement.getBoundingClientRect();
    if (!r.width || !r.height || getComputedStyle(n.parentElement).visibility === "hidden") continue;
    out.add(t.slice(0, 60));
  }
  return [...out].filter((t) => !/^(Atteo|atteo|Grok|ChatGPT|Claude|Codex|Cursor|VS Code|Muse|Gemini|Conductor|CLI|MCP|API|UTC|JSON|Webhook)/.test(t));
});
const nowrap = async (p) => p.evaluate(() => document.documentElement.scrollWidth - innerWidth);

for (const [w, h, scheme] of [[1300, 900, "light"], [390, 844, "dark"]]) {
  const { ctx, p } = await open("zh-CN", w, h, scheme);
  await p.goto(`${BASE}/`);
  check((await p.locator("html").getAttribute("lang")) === "zh-Hans", `${w}px: a Chinese browser gets <html lang="zh-Hans">`);
  const home = await p.locator("body").innerText();
  check(/看板/.test(home) && /新建看板/.test(home), `${w}px: home in Chinese`);
  check((await nowrap(p)) <= 1, `${w}px: home, no sideways scroll`);
  console.log(`  English left on home (${w}px): ${JSON.stringify(await english(p))}`);
  await p.goto(`${BASE}/b/${board}`);
  await p.waitForTimeout(800);
  const page = await p.locator("body").innerText();
  check(/对话|聊天/.test(page) && /问题/.test(page), `${w}px: the board page in Chinese (tabs, type tags)`);
  check(page.includes("Can you check the staging port?"), `${w}px: people's messages are never translated`);
  check((await p.locator("#composer-text").getAttribute("placeholder")).includes("消息"), `${w}px: the composer speaks Chinese`);
  check((await nowrap(p)) <= 1, `${w}px: board, no sideways scroll`);
  const t = await p.locator("time.when").first().textContent();
  check(/前|刚刚/.test(t), `${w}px: times read in Chinese (${t})`);
  console.log(`  English left on the board (${w}px): ${JSON.stringify(await english(p))}`);
  await p.screenshot({ path: `${SHOTS_DIR}/i18n-board-${w}.png` });
  await ctx.close();
}
// The picker: English, then Automatic (the browser's Chinese) again.
{
  const { ctx, p } = await open("zh-CN");
  await p.goto(`${BASE}/me`);
  const sel = p.locator("#dp-lang");
  check(await sel.isVisible() && (await sel.inputValue()) === "auto", "Account → Display has the language picker, on Automatic");
  await Promise.all([p.waitForNavigation(), sel.selectOption("en")]);
  check((await p.locator("html").getAttribute("lang")) === "en" && (await p.locator("body").innerText()).includes("Display"), "choosing English saves it and reloads in English");
  const prefs = await (await fetch(`${BASE}/api/app/prefs`, { headers: { cookie: ck.split(";")[0] } })).json();
  check(prefs.prefs.display.lang === "en", `…saved in display prefs, for the app too (${prefs.prefs.display.lang})`);
  await p.goto(`${BASE}/b/${board}?lang=zh-CN`);
  check((await p.locator("html").getAttribute("lang")) === "zh-Hans", "?lang=zh-CN overrides the saved English");
  await p.goto(`${BASE}/me`);
  await Promise.all([p.waitForNavigation(), p.locator("#dp-lang").selectOption("auto")]);
  check((await p.locator("html").getAttribute("lang")) === "zh-Hans", "back to Automatic: the browser's Chinese again");
  await ctx.close();
}
// A Traditional Chinese browser (Taiwan) gets 繁體中文.
{
  const { ctx, p } = await open("zh-TW");
  await p.goto(`${BASE}/b/${board}`);
  await p.locator("#composer-text").fill("x"); // Post shows once there's text (#2083)
  const t = await p.locator("body").innerText();
  check((await p.locator("html").getAttribute("lang")) === "zh-Hant" && /對話|聊天/.test(t) && /傳送/.test(t), "a zh-TW browser gets 繁體中文");
  await ctx.close();
}
// An English browser stays English.
{
  const { ctx, p } = await open("en-US");
  await p.goto(`${BASE}/b/${board}`);
  check((await p.locator("html").getAttribute("lang")) === "en" && /Conversation|Chat/.test(await p.locator("body").innerText()), "an English browser gets English");
  await ctx.close();
}
check(errors.length === 0, `no page errors (${errors.join(" | ")})`);
await b.close();
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
