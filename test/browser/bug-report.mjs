// Report a bug on the web (jxn #4043, #4051, #4053): a warning-triangle button at the end of the account row opens
// the dialog; the screenshot of the page is taken (the app's color-mix() colours used to make html2canvas throw, and the
// fallback broke too, so every report said "couldn't be captured"); the dialog reads as a form: a text box in the
// normal font inside the dialog's padding, the screenshot with Remove, then Cancel and Send. Light 1280 and dark 390.
// BASE, ADMIN_KEY, PW_CHROME.
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": process.env.ADMIN_KEY || "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), P = `br${run}`;
await ops("users", { name: P, email: `${P}@example.com`, verified: "true", display: { mode: "developer" } });
const board = (await ops("boards", { user: P, title: `Bugs ${run}` })).board.id;
const ck = (await ops("sessions", { user: P })).cookie.split(";")[0];
for (let i = 0; i < 12; i++) await fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { "content-type": "application/json", cookie: ck }, body: JSON.stringify({ text: `note ${i} with \`code\` and **bold** ${run}` }) });
let fails = 0; const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
await Promise.all([[1280, 800, "light"], [390, 844, "dark"]].map(async ([w, h, scheme]) => {
  const tag = `${w}px ${scheme}`, phone = w < 500;
  const ctx = await b.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
  const [k, ...v] = ck.split("="); await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage(), errors = []; p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${BASE}/b/${board}`);
  if (phone) await p.locator("[data-nav]").first().click();
  const btn = p.locator(".sidebar .me [data-bug]");
  await btn.waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
  const row = await p.evaluate(() => { const me = document.querySelector(".sidebar .me"), a = me.querySelector(".side-link").getBoundingClientRect(), b = me.querySelector("[data-bug]").getBoundingClientRect(), cs = getComputedStyle(me.querySelector("[data-bug]"));
    return { same: Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2) < 4 && b.left > a.left, right: me.getBoundingClientRect().right - b.right, w: Math.round(b.width), border: cs.borderTopWidth !== "0px", svg: !!me.querySelector("[data-bug] svg path"), label: me.querySelector("[data-bug]").getAttribute("aria-label"), text: me.querySelector("[data-bug]").textContent.trim() }; });
  check(row.same && row.right < 12 && row.w >= 24 && row.border && row.svg && row.label === "Report a bug" && !row.text, `${tag}: a triangle button at the end of the account row (${JSON.stringify(row)})`);
  await btn.click();
  await p.locator("#bug-send:not([disabled])").waitFor({ timeout: 30000 }).catch(() => {});
  const d = await p.evaluate(() => { const dl = document.getElementById("bug").getBoundingClientRect(), ta = document.getElementById("bug-text"), t = ta.getBoundingClientRect(), img = document.getElementById("bug-shot");
    return { open: document.getElementById("bug").open, shot: !document.getElementById("bug-shot-box").hidden && (img.getAttribute("src") || "").startsWith("data:image/png") && img.naturalWidth > 100, none: !document.getElementById("bug-shotless").hidden,
      font: getComputedStyle(ta).fontFamily, inset: Math.round(t.left - dl.left), insetR: Math.round(dl.right - t.right), cancel: !!document.querySelector('#bug .ft [data-close]'), doc: document.documentElement.scrollWidth <= innerWidth }; });
  check(d.open && d.shot && !d.none, `${tag}: the screenshot is taken and shown (${JSON.stringify({ shot: d.shot, none: d.none })})`);
  check(!/mono|courier/i.test(d.font) && d.inset >= 16 && d.insetR >= 16 && d.cancel && d.doc, `${tag}: the text box is in the normal font inside the dialog's padding, with Cancel and Send (${JSON.stringify(d)})`);
  await p.locator("#bug-remove").click();
  const rm = await p.evaluate(() => ({ box: !document.getElementById("bug-shot-box").hidden, none: !document.getElementById("bug-shotless").hidden }));
  check(!rm.box && rm.none, `${tag}: Remove takes the screenshot off and says so`);
  await p.locator("#bug .ft [data-close]").click();
  check(!(await p.evaluate(() => document.getElementById("bug").open)), `${tag}: Cancel closes it`);
  check(!errors.length, `${tag}: no page errors ${errors.join(" | ")}`);
  await ctx.close();
}));
await b.close(); console.log(fails ? `${fails} FAILED` : "bug report: all passed"); process.exit(fails ? 1 : 0);
