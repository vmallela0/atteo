// One line per message unless it mentions you (jxn #2690, task #2691): with Display → Messages → "One line unless they
// mention you", others' messages fold to their sender and first line on one row; messages that mention you or your agent,
// are addressed to your agent, or are yours stay whole. A tap opens a folded one and a tap on its sender line folds it
// again; the board's ⋯ → "Open all messages" opens them all for the visit and folds them back; a link to a folded
// message opens it. The default (whole messages) is unchanged. 1280 Developer and 390 Everyday.
// Usage: BASE=http://localhost:8798 node one-line.mjs  (local dev only, ADMIN_KEY=ci-admin-key in .dev.vars)
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const KEY = process.env.ADMIN_KEY || "ci-admin-key";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": KEY, "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4);
let fails = 0;
const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });

for (const [w, mode] of [[1280, "developer"], [390, "everyday"]]) {
  const A = `ol${w}${run}`, B = `om${w}${run}`, tag = `${w}px ${mode}`, phone = w < 500;
  await ops("users", { name: A, email: `${A}@example.com`, verified: "true", display: { mode, messages: "oneline" } });
  await ops("users", { name: B, email: `${B}@example.com`, verified: "true", display: { mode } });
  const ckA = (await ops("sessions", { user: A })).cookie.split(";")[0], ckB = (await ops("sessions", { user: B })).cookie.split(";")[0], tokB = (await ops("tokens", { user: B })).token;
  const board = (await ops("boards", { user: A, title: `One line ${w} ${run}` })).board.id;
  await ops("members", { board, user: B });
  const post = (auth, body) => fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()).then((j) => j.entry.seq);
  const long = await post({ cookie: ckB }, { text: `A long update ${run} that goes on.\n\nSecond paragraph with more detail about the deploy and what changed in it.\n\n- item one\n- item two` });
  const agent = await post({ authorization: `Bearer ${tokB}` }, { text: `Agent status: tests are running ${run}` });
  const mention = await post({ cookie: ckB }, { text: `@${A} can you look at this ${run}?` });
  const toMyAgent = await post({ authorization: `Bearer ${tokB}` }, { type: "question", to: A, text: `Question for your agent ${run}` });
  const mine = await post({ cookie: ckA }, { text: `My own note ${run}` });
  const plain = await post({ cookie: ckB }, { text: `Plain note from B ${run}` });

  const ctx = await browser.newContext({ viewport: { width: w, height: phone ? 844 : 900 }, isMobile: phone, hasTouch: phone });
  const [k, ...v] = ckA.split("=");
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage(), errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${BASE}/b/${board}`);
  await p.waitForTimeout(1000);
  const h = (s) => p.evaluate((s) => Math.round(document.getElementById("e" + s).getBoundingClientRect().height), s);
  const folded = (s) => p.evaluate((s) => { const e = document.getElementById("e" + s), b = e.querySelector(":scope>.grow>.body"); return e.classList.contains("ol") && !e.classList.contains("ol-open") && getComputedStyle(b).whiteSpace === "nowrap" && e.getBoundingClientRect().height < 44; }, s);
  check((await p.evaluate(() => document.documentElement.dataset.messages)) === "oneline", `${tag}: the page follows the account's Display setting`);
  check((await folded(long)) && (await folded(agent)) && (await folded(plain)), `${tag}: others' messages fold to one line (heights ${await h(long)}, ${await h(agent)}, ${await h(plain)})`);
  check(!(await folded(mention)) && !(await folded(toMyAgent)) && !(await folded(mine)), `${tag}: a mention of you, a question to your agent and your own message stay whole`);
  const line = await p.evaluate((s) => document.getElementById("e" + s).querySelector(":scope>.grow>.body").textContent.trim().slice(0, 40), long);
  check(/^A long update/.test(line), `${tag}: the row shows the first line ("${line}")`);
  // Tap opens it; a tap on its sender line folds it again.
  await p.locator(`#e${long} .body`).click();
  await p.waitForTimeout(200);
  check(!(await folded(long)) && (await h(long)) > 80, `${tag}: a tap opens it (${await h(long)}px)`);
  await p.locator(`#e${long} .meta .when`).first().click();
  await p.waitForTimeout(200);
  check(await folded(long), `${tag}: a tap on its sender line folds it again`);
  // The board's ⋯ → Open all messages, then fold them again.
  await p.locator(".board-head-menu > summary").first().click();
  const all = p.locator("[data-ol-toggle]");
  check(await all.isVisible(), `${tag}: the board's ⋯ offers "${(await all.innerText().catch(() => "")).trim()}"`);
  await all.click();
  await p.waitForTimeout(200);
  check(!(await folded(agent)) && !(await folded(plain)), `${tag}: Open all messages opens every one`);
  await p.locator(".board-head-menu > summary").first().click();
  check((await all.innerText()).trim() === "Fold messages again", `${tag}: …and offers "Fold messages again"`);
  await all.click();
  await p.waitForTimeout(200);
  check((await folded(agent)) && (await folded(plain)), `${tag}: folding them again`);
  // A link to a folded message opens it.
  await p.evaluate((s) => { location.hash = "#e" + s; }, agent);
  await p.waitForTimeout(500);
  check(!(await folded(agent)), `${tag}: a link to a folded message opens it`);
  check(!(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth)), `${tag}: nothing scrolls sideways`);
  check(!errors.length, `${tag}: no page errors${errors.length ? ` (${errors[0]})` : ""}`);
  if (process.env.SHOTS) { await p.evaluate(() => { location.hash = ""; }); await p.reload(); await p.waitForTimeout(900); await p.screenshot({ path: `${process.env.SHOTS}/one-line-${w}.png` }); }
  // Account → Display offers it; "Whole messages" turns it off.
  await p.goto(`${BASE}/me`);
  await p.waitForTimeout(600);
  check(await p.locator("#dp-messages-oneline").isChecked(), `${tag}: Display shows "One line unless they mention you" chosen`);
  await p.locator('label[for="dp-messages-full"]').click();
  await p.waitForTimeout(600);
  const prefs = (await (await fetch(`${BASE}/api/app/prefs`, { headers: { cookie: ckA } })).json()).prefs;
  check(prefs?.display?.messages === "full", `${tag}: "Whole messages" saves (${prefs?.display?.messages})`);
  await p.goto(`${BASE}/b/${board}`);
  await p.waitForTimeout(800);
  check(!(await folded(long)) && !(await folded(plain)), `${tag}: with whole messages nothing folds`);
  await ctx.close();
  void ckB;
}
await browser.close();
console.log(fails ? `${fails} FAILED` : "one-line messages: all passed");
process.exit(fails ? 1 : 0);
