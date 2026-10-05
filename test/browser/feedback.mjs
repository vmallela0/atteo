// Send feedback on the web (vedu #4125): a speech-bubble button in the account row, just before Report a bug, opens a
// small form for the Atteo team; Send posts to /api/feedback and either thanks you (it landed) or says why not (this
// server has no developers' board yet: "isn't set up"), keeping what you wrote. Cancel closes it. Light 1280, dark 390.
// The form is fetched from /feedback-form on the first click, so pages don't carry it. BASE, ADMIN_KEY, PW_CHROME.
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": process.env.ADMIN_KEY || "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), P = `fb${run}`;
await ops("users", { name: P, email: `${P}@example.com`, verified: "true", display: { mode: "developer" } });
const board = (await ops("boards", { user: P, title: `Feedback ${run}` })).board.id;
const ck = (await ops("sessions", { user: P })).cookie.split(";")[0];
let fails = 0;
const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
await Promise.all([[1280, 800, "light"], [390, 844, "dark"]].map(async ([w, h, scheme]) => {
  const tag = `${w}px ${scheme}`, phone = w < 500;
  const ctx = await b.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
  const [k, ...v] = ck.split("="); await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage(), errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${BASE}/b/${board}`);
  if (phone) await p.locator("[data-nav]").first().click();
  const btn = p.locator(".sidebar .me [data-feedback]");
  await btn.waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
  const row = await p.evaluate(() => {
    const me = document.querySelector(".sidebar .me"), f = me.querySelector("[data-feedback]"), bug = me.querySelector("[data-bug]");
    return { label: f?.getAttribute("aria-label"), svg: !!f && /url\(/.test(getComputedStyle(f, "::before").maskImage || getComputedStyle(f, "::before").webkitMaskImage) && getComputedStyle(f, "::before").width === "16px", before: !!(f && bug && f.getBoundingClientRect().right <= bug.getBoundingClientRect().left + 1), bugLast: me.lastElementChild === bug };
  });
  check(row.label === "Send feedback" && row.svg && row.before && row.bugLast, `${tag}: a feedback button in the account row, before Report a bug (${JSON.stringify(row)})`);
  const lazy = await p.evaluate(() => !document.getElementById("feedback"));
  check(lazy, `${tag}: the form isn't in the page until it's asked for (web-budget)`);
  await btn.click();
  await p.locator("#feedback[open]").waitFor({ timeout: 8000 }).catch(() => {});
  const d = await p.evaluate(() => {
    const dl = document.getElementById("feedback"), r = dl.getBoundingClientRect(), t = document.getElementById("fb-text").getBoundingClientRect();
    return { open: dl.open, focused: document.activeElement?.id, inset: Math.round(t.left - r.left), insetR: Math.round(r.right - t.right), title: document.getElementById("fb-title")?.textContent };
  });
  check(d.open && d.focused === "fb-text" && d.inset >= 16 && d.insetR >= 16 && d.title === "Send feedback", `${tag}: it opens a form, the text box focused inside the padding (${JSON.stringify(d)})`);
  const words = `Search could rank newer posts higher ${run} ${w}`;
  await p.locator("#fb-text").fill(words);
  const [res] = await Promise.all([p.waitForResponse((r) => r.url().endsWith("/api/feedback")), p.locator("#fb-send").click()]);
  if (res.status() === 201) {
    await p.locator("#feedback").waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
    const t = await p.evaluate(() => ({ open: document.getElementById("feedback").open, toast: document.getElementById("toast")?.textContent }));
    check(!t.open && /Atteo team/.test(t.toast || ""), `${tag}: sent: it closes and thanks you (${JSON.stringify(t)})`);
  } else {
    await p.locator("#fb-status:not([hidden])").waitFor({ timeout: 5000 }).catch(() => {});
    const t = await p.evaluate(() => ({ open: document.getElementById("feedback").open, status: document.getElementById("fb-status").textContent, kept: document.getElementById("fb-text").value }));
    check(t.open && /isn't set up|Try again|ten minutes/.test(t.status) && t.kept === words, `${tag}: not sent (${res.status()}): it says why and keeps the words (${JSON.stringify(t)})`);
    await p.locator("#feedback .ft [data-close]").click();
    check(!(await p.evaluate(() => document.getElementById("feedback").open)), `${tag}: Cancel closes it`);
  }
  check(!errors.length, `${tag}: no page errors ${errors.join(" | ")}`);
  await ctx.close();
}));
await b.close();
console.log(fails ? `${fails} FAILED` : "feedback: all passed");
process.exit(fails ? 1 : 0);
