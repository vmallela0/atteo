// Languages step 4 (#1786, French #1842): Español, Français, 日本語, 한국어, हिन्दी. A browser in each gets home, the board page and Account in
// that language (<html lang>, the shell and the page), people's messages untouched, nothing scrolling sideways at 390px
// or 1300px; the Account picker lists every language (14 since #2334) in their own words, and choosing one saves display.lang and
// reloads in it. No page errors.
// Usage: BASE=http://localhost:8787 node i18n-more.mjs
import { chromium } from "playwright-core";
import { stable } from "./lib/wait.mjs";
// Fast (opus-a #2937): each page is read once it's ready (fonts in, the board's script up, the width settled), not after
// fixed sleeps.
const ready = async (p, board) => { if (board) await p.waitForFunction(() => !!window.BOARD_CTX && document.getElementById("composer-text")); await p.evaluate(() => document.fonts.ready); await stable(() => p.evaluate(() => [document.documentElement.scrollWidth, document.body.scrollHeight]), 3000, 60); };
const BASE = (process.env.BASE || "http://localhost:8787").replace(/\/$/, "");
const KEY = process.env.ADMIN_KEY || "ci-admin-key";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": KEY, "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-5), P = `lm${run}`, Q = `ln${run}`;
for (const u of [P, Q]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true" });
const board = (await ops("boards", { user: P, title: `idiomas ${run}` })).board.id;
await ops("members", { board, user: Q });
const ck = (await ops("sessions", { user: P })).cookie, tokQ = (await ops("tokens", { user: Q })).token;
const cookie = ck.split(";")[0];
await fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { authorization: `Bearer ${tokQ}`, "content-type": "application/json" }, body: JSON.stringify({ type: "question", text: "Can you check the staging port?" }) });
let fails = 0;
const check = (ok, m) => { console.log(`${ok ? "✓" : "✗"} ${m}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const errors = [];
const [k, ...v] = cookie.split("=");
const open = async (locale, w) => {
  const ctx = await b.newContext({ viewport: { width: w, height: 860 }, locale });
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(`${locale} ${w}: ${e.message}`));
  return { ctx, p };
};
// What each language should show: words from its table on home ("New board"), the board ("Post") and Account ("Display").
const LANGS = [
  ["es-ES", "es", /Nuevo tablero/, /Publicar/, /Pantalla|Visualización/, /[a-z]/],
  ["fr-FR", "fr", /Nouveau tableau/, /Publier/, /Affichage/, /[éèàç]/],
  ["ja-JP", "ja", /新しいボード/, /投稿/, /表示/, /[぀-ヿ一-鿿]/],
  ["ko-KR", "ko", /새 보드/, /게시/, /화면|표시|디스플레이/, /[가-힯]/],
  ["hi-IN", "hi", /नया बोर्ड/, /पोस्ट करें/, /डिस्प्ले|प्रदर्शन/, /[ऀ-ॿ]/],
  ["pt-BR", "pt", /Novo quadro/, /Publicar/, /Exibição/, /[ãçõé]/],
  ["de-DE", "de", /Neues Board/, /Posten/, /Anzeige/, /[äöüß]/],
  ["ru-RU", "ru", /Новая доска/, /Опубликовать/, /Отображение/, /[а-яё]/],
  ["id-ID", "id", /Papan baru/, /Posting/, /Tampilan/, /[a-z]/],
  ["tr-TR", "tr", /Yeni pano/, /Paylaş/, /Görünüm/, /[çğışöü]/],
  ["bn-BD", "bn", /নতুন বোর্ড/, /পোস্ট করুন/, /ডিসপ্লে/, /[ঀ-৿]/],
  ["ar-EG", "ar", /لوحة جديدة/, /.+/, /العرض|عرض/, /[\u0600-\u06ff]/],
];
for (const [locale, lang, home, boardRe, account, script] of LANGS) {
  for (const w of [1300, 390]) {
    const { ctx, p } = await open(locale, w);
    for (const [path, re, name] of [["/", home, "home"], [`/b/${board}`, boardRe, "the board"], ["/me", account, "Account"]]) {
      await p.goto(BASE + path);
      await ready(p, path.startsWith("/b/"));
      if (path.startsWith("/b/")) await p.locator("#composer-text").fill("x"); // Post shows once there's text (#2083)
      const htmlLang = await p.locator("html").getAttribute("lang");
      const text = await p.locator("body").innerText();
      const over = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      check(htmlLang === lang && re.test(text) && script.test(text) && over <= 1, `${lang} ${w}px ${name}: <html lang="${htmlLang}">, in ${lang}, fits (${over}px)`);
      if (path.startsWith("/b/")) check(text.includes("Can you check the staging port?"), `${lang} ${w}px: people's messages are never translated`);
      if (path.startsWith("/b/")) check(!/Any agent joins|Connect an agent|Or write the first/.test(text), `${lang} ${w}px: the empty-board hint and Connect button in ${lang} too`);
    }
    await ctx.close();
  }
}
// The picker lists every language in its own words; choosing 日本語 saves it and reloads in Japanese, then Automatic.
{
  const { ctx, p } = await open("en-US", 1300);
  await p.goto(`${BASE}/me`);
  const names = await p.locator("#dp-lang option").evaluateAll((os) => os.map((o) => o.textContent));
  check(["English", "简体中文", "繁體中文", "Español", "Français", "日本語", "한국어", "हिन्दी", "Português", "Deutsch", "Русский", "Bahasa Indonesia", "Türkçe", "বাংলা", "العربية"].every((n) => names.includes(n)) && !names.some((n) => /set in the app/.test(n)), `the picker lists all eight (${names.join(", ")})`);
  await Promise.all([p.waitForNavigation(), p.locator("#dp-lang").selectOption("ja")]);
  check((await p.locator("html").getAttribute("lang")) === "ja" && /表示/.test(await p.locator("body").innerText()), "choosing 日本語 saves it and reloads in Japanese");
  const prefs = await (await fetch(`${BASE}/api/app/prefs`, { headers: { cookie } })).json();
  check(prefs.prefs.display.lang === "ja", `…saved in display prefs, for the app too (${prefs.prefs.display.lang})`);
  await p.goto(`${BASE}/b/${board}?lang=ko`);
  check((await p.locator("html").getAttribute("lang")) === "ko", "?lang=ko overrides the saved 日本語");
  await p.goto(`${BASE}/me`);
  await Promise.all([p.waitForNavigation(), p.locator("#dp-lang").selectOption("auto")]);
  check((await p.locator("html").getAttribute("lang")) === "en", "back to Automatic: the browser's English again");
  await ctx.close();
}
// Arabic reads right to left (#2335): the page says so, the phone menu comes in from the right, and an English message
// keeps its own direction.
{
  const { ctx, p } = await open("ar-EG", 390);
  await p.goto(`${BASE}/b/${board}`); await ready(p, true);
  const dir = await p.evaluate(() => document.documentElement.dir);
  const msg = await p.evaluate(() => { const b = [...document.querySelectorAll("#thread .entry .body")].find((x) => /staging port/.test(x.textContent)); if (!b) return null; const r = document.createRange(); r.selectNodeContents(b.querySelector("p") || b); return Math.round(r.getBoundingClientRect().left - b.getBoundingClientRect().left); });
  await p.locator("[data-nav]").click(); await stable(() => p.evaluate(() => document.getElementById("sidebar").getBoundingClientRect().left), 3000, 80);
  const sb = await p.evaluate(() => { const r = document.getElementById("sidebar").getBoundingClientRect(); return { right: Math.round(innerWidth - r.right), left: Math.round(r.left) }; });
  check(dir === "rtl" && sb.right === 0 && sb.left > 0, `ar: dir=rtl and the phone menu opens from the right (${dir}, ${JSON.stringify(sb)})`);
  check(msg !== null && msg < 4, `ar: an English message starts at its left edge (${msg})`);
  await ctx.close();
}
check(errors.length === 0, `no page errors (${errors.join(" | ")})`);
await b.close();
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
