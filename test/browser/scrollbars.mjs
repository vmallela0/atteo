import { SHOTS_DIR } from "./lib/shots.mjs";
import { after } from "./seed.mjs";
import { chromium } from "playwright-core";
const { board, cookieB } = await after();
const BASE=process.env.BASE||"http://localhost:8787", shot=process.argv[2];
let fails=0;const check=(ok,m)=>{console.log(`${ok?"✓":"✗"} ${m}`);if(!ok)fails++};
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined, ignoreDefaultArgs: ["--hide-scrollbars"] });
const scan = (p) => p.evaluate(() => {
  const name = (el) => el.id ? "#" + el.id : el.tagName.toLowerCase() + (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).join(".") : "");
  const scrolls = (el, ax) => { const cs = getComputedStyle(el); const o = ax === "y" ? cs.overflowY : cs.overflowX; return (o === "auto" || o === "scroll") && (ax === "y" ? el.scrollHeight > el.clientHeight + 1 : el.scrollWidth > el.clientWidth + 1) && el.offsetParent !== null; };
  const ys = [...document.querySelectorAll("*")].filter((el) => scrolls(el, "y"));
  const nested = ys.filter((el) => ys.some((o) => o !== el && o.contains(el))).map(name);
  const xs = [...document.querySelectorAll("*")].filter((el) => scrolls(el, "x") && !el.matches("pre, pre *, .list.scroll-x")).map(name); // code blocks and the log table may scroll sideways
  const page = document.documentElement.scrollHeight > innerHeight + 1 || document.documentElement.scrollWidth > innerWidth + 1;
  return { ys: ys.map(name), nested, page, xs };
});
for (const [label,w,h,scheme] of [["desktop",1280,800,"light"],["mobile",390,844,"dark"]]) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, colorScheme: scheme });
  const [k, ...v] = cookieB.split(";")[0].split("=");
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage();
  await p.goto(`${BASE}/b/${board}`); await p.waitForTimeout(600);
  // grow the composer past its max height
  await p.click("#composer-text"); await p.keyboard.type("line\n".repeat(1).trim()); for (let i=0;i<25;i++){await p.keyboard.press("Shift+Enter");await p.keyboard.type("more "+i)}
  const views = { conversation: async()=>{}, log: async()=>{await p.locator("body").click({position:{x:2,y:2}}).catch(()=>{});await p.evaluate(()=>document.activeElement.blur());await p.keyboard.press("2")},
    files: async()=>{await p.keyboard.press("3");await p.waitForTimeout(300);await p.click('[data-doc="BACKLOG.md"]');await p.waitForTimeout(300)},
    editing: async()=>{await p.click("#doc-edit");await p.waitForTimeout(200)} };
  if (label==="mobile") views.info = async()=>{await p.click("#doc-cancel");await p.evaluate(()=>document.activeElement.blur());await p.keyboard.press("1");await p.click("#info-btn");await p.waitForTimeout(200)};
  for (const [view,go] of Object.entries(views)) {
    await go(); await p.waitForTimeout(150);
    const r = await scan(p);
    console.log(`  ${label}/${view}: scrolling panes = ${r.ys.join(", ")}`);
    check(!r.page, `${label}/${view}: no page-level scrollbar`);
    check(r.xs.length===0, `${label}/${view}: no stray horizontal scrollbars${r.xs.length?": "+r.xs.join(", "):""}`);
    check(r.nested.length===0, `${label}/${view}: no nested scrollbars${r.nested.length?": "+r.nested.join(", "):""}`);
    if (shot) await p.screenshot({ path: `${SHOTS_DIR}/${shot}-scroll-${label}-${view}.png` });
  }
  const tw = await p.evaluate(()=>{const cs=getComputedStyle(document.getElementById("thread-scroll"));return cs.scrollbarWidth+" "+cs.scrollbarColor});
  console.log(`  thread scrollbar style: ${tw}`);
  await ctx.close();
}
await b.close(); console.log(fails?`${fails} FAILED`:"all scrollbar checks passed"); process.exit(fails?1:0);
