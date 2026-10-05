// A message highlight (the mention tint, a new message's flash, the jump tint) shows room on both sides at every width (jxn #2003):
// on the left it reaches past the avatar and isn't clipped by the thread's scroller (8px on phones, 12px wider up); on the right it
// stops short of the scroll rail instead of running under it. Developer and Everyday, 1280 and 390px, light and dark; no sideways scroll.
// hl-bleed.mjs only measured the entry's box, which the scroller clipped, so it passed while the tint sat flush with the avatar.
// Usage: BASE=http://localhost:8798 node highlight-phone.mjs  (local dev only, ADMIN_KEY=ci-admin-key in .dev.vars)
import { chromium } from "playwright-core";
import { until, stable } from "./lib/wait.mjs";
const BASE = process.env.BASE || "http://localhost:8787";
const KEY = process.env.ADMIN_KEY || "ci-admin-key";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": KEY, "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4);
let fails = 0;
const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });

// Where the highlight really shows: the entry's box cut by every ancestor that clips it, and the rail beside it.
const measure = (seq) => {
  const e = document.getElementById("e" + seq), r = e.getBoundingClientRect(), av = e.querySelector(".av").getBoundingClientRect();
  let left = r.left, right = r.right;
  for (let a = e.parentElement; a && a !== document.documentElement; a = a.parentElement) {
    if (getComputedStyle(a).overflowX === "visible") continue;
    const c = a.getBoundingClientRect(), cs = getComputedStyle(a);
    left = Math.max(left, c.left + parseFloat(cs.borderLeftWidth)); right = Math.min(right, c.right - parseFloat(cs.borderRightWidth));
  }
  const rail = document.querySelector(".thread-wrap .rail"), rl = rail && rail.getBoundingClientRect();
  return { cls: e.className, left: Math.round(left), right: Math.round(right), av: Math.round(av.left), rail: rl && rl.width ? Math.round(rl.left) : null,
    bg: getComputedStyle(e).backgroundColor, sideways: document.documentElement.scrollWidth > innerWidth };
};
const room = (tag, what, m, phone) => {
  const want = phone ? 7 : 11;
  check(m.av - m.left >= want, `${tag}: ${what} shows ${m.av - m.left}px left of the avatar (want ≥ ${want})`);
  check(m.rail == null || m.right <= m.rail - 1, `${tag}: ${what} ends at ${m.right}, clear of the rail at ${m.rail}`);
};

for (const mode of ["developer", "everyday"]) {
  const P = `hp${mode[0]}${run}`, V = `hq${mode[0]}${run}`;
  for (const u of [P, V]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true", display: { mode } });
  const board = (await ops("boards", { user: P, title: `Highlight ${mode} ${run}` })).board.id;
  await ops("members", { board, user: V });
  const ckP = (await ops("sessions", { user: P })).cookie, ckV = (await ops("sessions", { user: V })).cookie;
  const post = (ck, text) => fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { "content-type": "application/json", cookie: ck.split(";")[0] }, body: JSON.stringify({ text }) }).then((r) => r.json()).then((j) => j.entry?.seq ?? j.seq);
  const target = await post(ckV, `The agreed plan for the highlight ${run}`);
  for (let i = 0; i < 14; i++) await post(ckV, `older message ${i} with enough words to wrap onto a second line on a phone`);
  const ment = await post(ckV, `@${P} a mention whose tint needs room on both sides ${run}`);
  for (let i = 0; i < 2; i++) await post(ckV, `after ${i}`);
  const link = await post(ckV, `see #${target}`);

  for (const [w, scheme] of [[1280, "light"], [390, "light"], [390, "dark"]]) {
    const phone = w < 500, tag = `${mode} ${w}px ${scheme}`;
    const ctx = await browser.newContext({ viewport: { width: w, height: phone ? 844 : 820 }, colorScheme: scheme, isMobile: phone, hasTouch: phone });
    const [k, ...v] = ckP.split(";")[0].split("=");
    await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
    const p = await ctx.newPage(), errors = [];
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(`${BASE}/b/${board}`);
    await p.locator(`#e${ment}`).waitFor(); await p.evaluate(() => document.fonts.ready);
    await p.evaluate((s) => document.getElementById("e" + s).scrollIntoView({ block: "center" }), ment);
    await stable(() => p.evaluate(measure, ment));
    const m = await p.evaluate(measure, ment);
    check(/for-you/.test(m.cls), `${tag}: the mention is tinted`);
    room(tag, "the mention tint", m, phone);
    check(!m.sideways, `${tag}: nothing scrolls sideways`);
    const n = await post(ckV, `fresh ${w} ${scheme} ${run}`);
    await p.locator(`#e${n}`).waitFor({ timeout: 8000 });
    await until(() => p.evaluate((s) => /flash-in/.test(document.getElementById("e" + s).className), n), 2000);
    const f = await p.evaluate(measure, n);
    check(/flash-in/.test(f.cls), `${tag}: a new message flashes`);
    room(tag, "the new message's flash", f, phone);
    const chip = p.locator(`#e${link} a.ref[data-ref="${target}"]`);
    await chip.first().waitFor({ timeout: 5000 }).catch(() => {});
    if (await chip.count()) {
      await chip.first().click();
      await until(() => p.evaluate((s) => /\bhit\b/.test(document.getElementById("e" + s).className), target)); await stable(() => p.evaluate(measure, target));
      const h = await p.evaluate(measure, target);
      check(/\bhit\b/.test(h.cls), `${tag}: a #ref jump tints its message`);
      room(tag, "the jump tint", h, phone);
    } else check(false, `${tag}: the #${target} ref shows as a chip`);
    if (process.env.SHOTS && phone && scheme === "light" && mode === "developer") await p.screenshot({ path: `${process.env.SHOTS}/highlight-phone-${w}.png` }).catch(() => {});
    check(!errors.length, `${tag}: no page errors${errors.length ? ` (${errors[0]})` : ""}`);
    await ctx.close();
  }
}
await browser.close();
console.log(fails ? `${fails} FAILED` : "highlight room on phones: all passed");
process.exit(fails ? 1 : 0);
