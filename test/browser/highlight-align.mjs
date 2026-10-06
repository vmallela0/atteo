// Tinted messages line up (jxn #4680): the message you linked to (#eN, which stays the page's :target after a reload),
// the one you jumped to, the keyboard's pick (j/k) and a message for you all bleed the same way past the avatar, so
// none sits as a card set in from the others, at 1280 and on a phone, in compact (one-line) view. BASE, PW_CHROME.
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": process.env.ADMIN_KEY || "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), A = `ha${run}`, B = `hb${run}`;
await ops("users", { name: A, email: `${A}@example.com`, verified: "true", display: { mode: "developer", compact: "others" } });
await ops("users", { name: B, email: `${B}@example.com`, verified: "true", display: { mode: "developer" } });
const board = (await ops("boards", { user: A, title: `Align ${run}` })).board.id; await ops("members", { board, user: B });
const ck = {}; for (const u of [A, B]) ck[u] = (await ops("sessions", { user: u })).cookie.split(";")[0];
const post = async (u, text) => (await (await fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { "content-type": "application/json", cookie: ck[u] }, body: JSON.stringify({ text }) })).json()).entry.seq;
const linked = await post(B, `The message a link points at, ${run}, long enough to fold onto one line.\n\nSecond paragraph.`);
const other = await post(B, `Another folded row ${run}.`);
const forYou = await post(B, `@${A} this one is for you ${run}`);
let fails = 0;
const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
await Promise.all([[1280, 800, false], [390, 844, true]].map(async ([w, h, phone]) => {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, isMobile: phone, hasTouch: phone });
  await ctx.addCookies([{ name: ck[A].split("=")[0], value: ck[A].split("=").slice(1).join("="), url: BASE }]);
  const p = await ctx.newPage();
  await p.goto(`${BASE}/b/${board}#e${linked}`);
  await p.locator(`#e${forYou}`).waitFor();
  await p.waitForFunction((s) => document.getElementById("e" + s).matches(":target"), linked);
  const box = (s) => p.evaluate((s) => { const r = document.getElementById("e" + s).getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)]; }, s);
  const [t, y] = [await box(linked), await box(forYou)];
  check(t[0] === y[0] && t[1] === y[1], `${w}px: the linked message's tint lines up with a message for you (${t} vs ${y})`);
  await p.evaluate(() => location.hash = ""); // j/k picks a message: its tint lines up too
  await p.locator("#composer-text").evaluate((x) => x.blur()); await p.keyboard.press("k");
  const sel = await p.evaluate(() => { const e = document.querySelector("#thread>.entry.sel"); if (!e) return null; const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right), getComputedStyle(e).boxShadow]; });
  check(!sel || (sel[0] === y[0] && sel[1] === y[1] && sel[2] === "none"), `${w}px: the keyboard's pick lines up the same way (${sel})`);
  await ctx.close();
}));
await b.close();
console.log(fails ? `${fails} FAILED` : "highlight align: all passed");
process.exit(fails ? 1 : 0);
