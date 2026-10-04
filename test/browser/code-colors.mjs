// Code blocks get syntax colours on the page (jxn #2015, task #2018): keywords, strings, comments, numbers and calls in
// TypeScript, Python, SQL and diff blocks, each colour at least 4.5:1 on the code background in light and dark. The code
// itself is untouched: the same text, Copy copies it exactly, the server sends plain text, and code that looks like HTML
// stays text (no element is made from it). A block without a known language stays one colour. The tokenizer is served by
// the Worker and loaded only once a code block is on screen: a board without code never fetches it. 1280 light, 390 dark.
// Usage: BASE=http://localhost:8798 node code-colors.mjs  (local dev only, ADMIN_KEY=ci-admin-key in .dev.vars)
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const KEY = process.env.ADMIN_KEY || "ci-admin-key";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": KEY, "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), A = `cc${run}`;
await ops("users", { name: A, email: `${A}@example.com`, verified: "true", display: { mode: "developer" } });
const ck = (await ops("sessions", { user: A })).cookie.split(";")[0];
const board = (await ops("boards", { user: A, title: `Code colours ${run}` })).board.id;
const quiet = (await ops("boards", { user: A, title: `No code ${run}` })).board.id;
const post = (text) => fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { "content-type": "application/json", cookie: ck }, body: JSON.stringify({ text }) }).then((r) => r.json()).then((j) => j.entry?.seq ?? j.seq);
const TS = '// a debounced search\nexport function debounce(fn, ms = 250) {\n  let t;\n  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };\n}\nconst s = "done";';
const PY = '# count words\ndef top(text: str, n: int = 5):\n    return Counter(text.split()).most_common(n) if True else None';
const SQL = "SELECT author, COUNT(*) AS posts FROM entries WHERE ts > 1000 GROUP BY author;";
const DIFF = "@@ -1,2 +1,2 @@\n-const a = 1\n+const a = 2\n unchanged";
const HTML = '<img src="x" onerror="window.__pwned=1"><b class="y">bold</b>';
const PLAIN = "just some words = 1 // not coloured";
const seqs = {};
for (const [k, lang, code] of [["ts", "ts", TS], ["py", "python", PY], ["sql", "sql", SQL], ["diff", "diff", DIFF], ["html", "html", HTML], ["plain", "", PLAIN]]) seqs[k] = await post(`${k} block\n\n\`\`\`${lang}\n${code}\n\`\`\``);

const raw = await (await fetch(`${BASE}/b/${board}`, { headers: { cookie: ck } })).text();
let fails = 0;
const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
check(!/class="sx-/.test(raw) && raw.includes("<code>// a debounced search"), "the server sends the code as plain text (colours are added on the page)");

const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
{
  await fetch(`${BASE}/api/boards/${quiet}/entries`, { method: "POST", headers: { "content-type": "application/json", cookie: ck }, body: JSON.stringify({ text: "no code here, just `inline` words" }) });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const [k, ...v] = ck.split("=");
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage(), asked = [];
  p.on("request", (r) => { if (r.url().includes("/code-colors.js")) asked.push(r.url()); });
  await p.goto(`${BASE}/b/${quiet}`);
  await p.waitForTimeout(800);
  check(!asked.length, "a board without code blocks never loads the tokenizer");
  await ctx.close();
}
const js = await fetch(`${BASE}/code-colors.js?v=x`);
check(js.ok && /javascript/.test(js.headers.get("content-type")) && /immutable/.test(js.headers.get("cache-control") || "") && js.headers.get("x-content-type-options") === "nosniff", "the Worker serves the tokenizer as JavaScript, cached for good when versioned");
for (const [w, scheme] of [[1280, "light"], [390, "dark"]]) {
  const tag = `${w}px ${scheme}`, phone = w < 500;
  const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, colorScheme: scheme, isMobile: phone, hasTouch: phone });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  const [k, ...v] = ck.split("=");
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage(), errors = [], asked = [];
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("request", (r) => { if (r.url().includes("/code-colors.js")) asked.push(r.url()); });
  await p.goto(`${BASE}/b/${board}`);
  await p.waitForTimeout(800);
  const info = async (key) => {
    await p.evaluate((s) => document.getElementById("e" + s).scrollIntoView({ block: "center" }), seqs[key]);
    await p.waitForTimeout(250);
    return p.evaluate((s) => {
      const c = document.querySelector(`#e${s} .code-b code`);
      // WCAG contrast of each coloured span against the block's background.
      const rgb = (x) => x.match(/[\d.]+/g).slice(0, 3).map(Number);
      const lum = ([r, g, b]) => { const f = (u) => { u /= 255; return u <= 0.03928 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const ratio = (a, b) => { const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
      const pre = c.closest("pre"), bg0 = getComputedStyle(pre).backgroundColor;
      const spans = [...c.querySelectorAll("span")].map((sp) => { const bg = getComputedStyle(sp).backgroundColor; return { cls: sp.className, text: sp.textContent, color: getComputedStyle(sp).color, r: ratio(getComputedStyle(sp).color, bg === "rgba(0, 0, 0, 0)" ? bg0 : bg) }; });
      return { hl: c.dataset.hl, text: c.textContent, kids: [...c.querySelectorAll("*")].map((n) => n.localName), spans, plainColor: getComputedStyle(c).color };
    }, seqs[key]);
  };
  const ts = await info("ts");
  const want = (s, cls, text) => s.spans.some((x) => x.cls === cls && x.text.trim() === text);
  check(ts.hl === "on" && want(ts, "sx-c", "// a debounced search") && want(ts, "sx-k", "export") && want(ts, "sx-k", "function") && want(ts, "sx-n", "250") && want(ts, "sx-f", "setTimeout") && want(ts, "sx-s", '"done"'), `${tag}: TypeScript gets comment, keyword, number, call and string colours`);
  check(ts.text === TS, `${tag}: the TypeScript text is unchanged`);
  check(new Set(ts.spans.map((x) => x.color)).size >= 5, `${tag}: at least 5 distinct colours in the TypeScript block (${new Set(ts.spans.map((x) => x.color)).size})`);
  const reach = await p.evaluate((s) => { const pre = document.querySelector(`#e${s} .code-b pre`); return { scrolls: pre.scrollWidth > pre.clientWidth + 1, tab: pre.tabIndex }; }, seqs.ts);
  check(!reach.scrolls || reach.tab === 0, `${tag}: a code block that scrolls sideways can be reached from the keyboard (scrolls ${reach.scrolls}, tabindex ${reach.tab})`);
  const py = await info("py"), sql = await info("sql"), diff = await info("diff");
  check(want(py, "sx-k", "def") && want(py, "sx-c", "# count words") && want(py, "sx-n", "None"), `${tag}: Python is coloured`);
  check(want(sql, "sx-k", "SELECT") && want(sql, "sx-f", "COUNT") && want(sql, "sx-n", "1000"), `${tag}: SQL is coloured`);
  check(want(diff, "sx-d", "-const a = 1") && want(diff, "sx-i", "+const a = 2") && want(diff, "sx-m", "@@ -1,2 +1,2 @@"), `${tag}: diff lines are coloured`);
  const low = [ts, py, sql, diff].flatMap((s) => s.spans).filter((x) => x.r < 4.5);
  check(!low.length, `${tag}: every colour has at least 4.5:1 contrast${low.length ? ` (${low.slice(0, 3).map((x) => `${x.cls} ${x.color} ${x.r.toFixed(2)}`).join(", ")})` : ""}`);
  const html = await info("html");
  check(html.text === HTML && html.kids.every((n) => n === "span") && want(html, "sx-g", "<img") && !(await p.evaluate(() => window.__pwned)), `${tag}: code that looks like HTML stays text (only spans made, nothing runs)`);
  const plain = await info("plain");
  check(plain.text === PLAIN && !plain.spans.length, `${tag}: a block without a language stays one colour`);
  // Copy copies the code exactly, colours or not.
  await p.evaluate((s) => document.getElementById("e" + s).scrollIntoView({ block: "center" }), seqs.ts);
  await p.locator(`#e${seqs.ts} [data-copy-code]`).click();
  await p.waitForTimeout(200);
  check((await p.evaluate(() => navigator.clipboard.readText().catch(() => ""))) === TS, `${tag}: Copy copies the code exactly`);
  // A message that arrives live gets coloured too.
  const n = await post("live\n\n```js\nconst live = true\n```");
  await p.locator(`#e${n} .code-b code[data-hl="on"]`).waitFor({ timeout: 8000 }).catch(() => {});
  check(await p.evaluate((s) => !!document.querySelector(`#e${s} .code-b code .sx-k`), n), `${tag}: a block that arrives live is coloured`);
  check(asked.length === 1 && /\/code-colors\.js\?v=\w+$/.test(asked[0]), `${tag}: the tokenizer loads once, from our own server (${asked.length}: ${asked[0] || "none"})`);
  if (process.env.SHOTS) await p.screenshot({ path: `${process.env.SHOTS}/code-colors-${w}.png` }).catch(() => {});
  check(!errors.length, `${tag}: no page errors${errors.length ? ` (${errors[0]})` : ""}`);
  await ctx.close();
}
await browser.close();
console.log(fails ? `${fails} FAILED` : "code colours: all passed");
process.exit(fails ? 1 : 0);
