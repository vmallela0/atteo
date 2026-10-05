// One line per message unless it mentions you (jxn #2690, task #2691): with Display → Messages → "One line unless they
// mention you", others' messages fold to their sender and first line on one row; messages that mention you or your agent,
// are addressed to your agent, or are yours stay whole. A tap opens a folded one and a tap on its sender line folds it
// again; the board's ⋯ → "Open all messages" opens them all for the visit and folds them back; a link to a folded
// message opens it. Replies to you, decisions and @agents stay whole too (the list agreed with the app, #2695). The
// default (whole messages) is unchanged. 1280 Developer and 390 Everyday.
// Usage: BASE=http://localhost:8798 node one-line.mjs  (local dev only, ADMIN_KEY=ci-admin-key in .dev.vars)
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { until } from "./lib/wait.mjs";
const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
const BASE = process.env.BASE || "http://localhost:8787";
const KEY = process.env.ADMIN_KEY || "ci-admin-key";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": KEY, "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4);
// The two widths run side by side, each with its own users and board; each one's lines print together.
let fails = 0;
const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });

await Promise.all([[1280, "developer"], [390, "everyday"]].map(async ([w, mode]) => {
  const out = [], check = (ok, t) => { out.push(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
  const A = `ol${w}${run}`, B = `om${w}${run}`, C = `on${w}${run}`, tag = `${w}px ${mode}`, phone = w < 500;
  await ops("users", { name: A, email: `${A}@example.com`, verified: "true", display: { mode, compact: "others" } });
  for (const u of [B, C]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true", display: { mode } });
  const ckA = (await ops("sessions", { user: A })).cookie.split(";")[0], ckB = (await ops("sessions", { user: B })).cookie.split(";")[0], tokB = (await ops("tokens", { user: B })).token;
  const board = (await ops("boards", { user: A, title: `One line ${w} ${run}` })).board.id;
  for (const u of [B, C]) await ops("members", { board, user: u });
  const post = (auth, body) => fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()).then((j) => j.entry.seq);
  const tokA = (await ops("tokens", { user: A })).token;
  const myAgents = await post({ authorization: `Bearer ${tokA}` }, { text: `My agent's update ${run}` }); // first: an agent posts only once it has read what's new
  const long = await post({ cookie: ckB }, { text: `A long update ${run} that goes on.\n\nSecond paragraph with more detail about the deploy and what changed in it.\n\n- item one\n- item two` });
  const agent = await post({ authorization: `Bearer ${tokB}` }, { text: `Agent status: tests are running ${run}` });
  const mention = await post({ cookie: ckB }, { text: `@${A} can you look at this ${run}?` });
  const toMyAgent = await post({ authorization: `Bearer ${tokB}` }, { type: "question", to: A, text: `Question for your agent ${run}` });
  const mine = await post({ cookie: ckA }, { text: `My own note ${run}` });
  const plain = await post({ cookie: ckB }, { text: `Plain note from B ${run}` });
  const replyToMe = await post({ cookie: ckB }, { text: `Replying to your note ${run}`, reply_to: mine });
  const decision = await post({ cookie: ckB }, { type: "decision", text: `We ship on Friday ${run}` });
  const allAgents = await post({ cookie: ckB }, { text: `@agents status please ${run}` });
  const otherMention = await post({ cookie: ckB }, { text: `Ready to go @${C}'s agent display-layout lands ${run}` }); // jxn #4481
  const peopleOnly = await post({ cookie: ckB }, { text: `Between us people ${run}`, people_only: true, to: [A, C] });
  const replyToOther = await post({ cookie: ckB }, { text: `A reply to someone else's note ${run}, long enough to fold.\n\nWith a second paragraph.`, reply_to: long }); // jxn #4454
  const replyToMyAgent = await post({ cookie: ckB }, { text: `A reply to your agent's update ${run}`, reply_to: myAgents });
  const askMyAgent = await post({ cookie: ckB }, { type: "question", text: `A question on your agent's update ${run}`, reply_to: myAgents });

  const ctx = await browser.newContext({ viewport: { width: w, height: phone ? 844 : 900 }, isMobile: phone, hasTouch: phone });
  const [k, ...v] = ckA.split("=");
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage(), errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${BASE}/b/${board}`);
  const h = (s) => p.evaluate((s) => Math.round(document.getElementById("e" + s).getBoundingClientRect().height), s);
  const folded = (s) => p.evaluate((s) => { const e = document.getElementById("e" + s), b = e.querySelector(":scope>.grow>.body"); return e.classList.contains("ol") && !e.classList.contains("ol-open") && getComputedStyle(b).whiteSpace === "nowrap" && e.getBoundingClientRect().height < 44; }, s);
  await until(() => folded(plain), 5000); // the page marks the rows once its script is up
  check((await p.evaluate(() => document.documentElement.dataset.compact)) === "others", `${tag}: the page follows the account's Display setting`);
  check((await folded(long)) && (await folded(agent)) && (await folded(plain)), `${tag}: others' messages fold to one line (heights ${await h(long)}, ${await h(agent)}, ${await h(plain)})`);
  check(!(await folded(mention)) && !(await folded(toMyAgent)) && !(await folded(mine)), `${tag}: a mention of you, a question to your agent and your own message stay whole`);
  check(!(await folded(replyToMe)) && !(await folded(decision)) && !(await folded(allAgents)), `${tag}: a reply to you, a decision and an @agents message stay whole`);
  check(!(await folded(peopleOnly)), `${tag}: a People only message to you and someone else stays whole`);
  check((await folded(replyToOther)) && (await folded(replyToMyAgent)), `${tag}: replies fold like any other, a reply to your agent's message too (jxn #4454)`);
  // A mention's dot gets its own space in a folded row, after the name, not over its last letter (jxn #4481).
  const dot = await p.evaluate((s) => { const m = document.querySelector(`#e${s} .body .mention`); if (!m) return null; const t = [...m.childNodes].filter((n) => n.nodeType === 3).pop(), r = document.createRange(); r.setStart(t, t.length - 1); r.setEnd(t, t.length); return { pos: getComputedStyle(m, "::after").position, gap: m.getBoundingClientRect().right - r.getBoundingClientRect().right }; }, otherMention);
  check((await folded(otherMention)) && dot && dot.pos !== "absolute" && dot.gap >= 6, `${tag}: a mention's dot sits clear of its name in a folded row (${JSON.stringify(dot)})`);
  check(!(await folded(askMyAgent)), `${tag}: a question in your agent's thread stays whole`);
  // The keyboard: a folded row takes focus; Enter opens it, Space folds it again.
  await p.focus(`#e${plain}`);
  check((await p.evaluate(() => document.activeElement?.id)) === `e${plain}`, `${tag}: a folded row takes focus`);
  await p.keyboard.press("Enter");
  await until(async () => !(await folded(plain)), 3000);
  check(!(await folded(plain)), `${tag}: Enter opens it`);
  await p.keyboard.press(" ");
  await until(() => folded(plain), 3000);
  check(await folded(plain), `${tag}: Space folds it again`);
  // axe over the folded rows: no serious or critical issues. (The whole messages are the page as before.)
  await p.evaluate(AXE); // not addScriptTag: an inline <script> without the nonce is refused once CSP_ENFORCE is on
  const bad = await p.evaluate(async () => (await axe.run({ include: [...document.querySelectorAll("#thread>.entry.ol:not(.ol-open)")].map((e) => ["#" + e.id]) }, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } })).violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id + ": " + v.nodes.slice(0, 2).map((n) => n.html.slice(0, 60) + (n.any?.[0]?.data?.fgColor ? ` ${n.any[0].data.fgColor} on ${n.any[0].data.bgColor} ${n.any[0].data.contrastRatio}:1 ${n.any[0].data.fontSize}` : "") + " in " + n.target.join(" ")).join(" | ")));
  check(!bad.length, `${tag}: axe finds nothing serious in the folded rows${bad.length ? ` (${bad.join("; ")})` : ""}`);
  const line = await p.evaluate((s) => document.getElementById("e" + s).querySelector(":scope>.grow>.body").textContent.trim().slice(0, 40), long);
  check(/^A long update/.test(line), `${tag}: the row shows the first line ("${line}")`);
  const liveReply = await post({ cookie: ckB }, { text: `A reply that arrives live ${run}`, reply_to: agent });
  await until(() => folded(liveReply), 5000);
  check(await folded(liveReply), `${tag}: a reply that arrives while you look folds too`);
  // Tap opens it; a tap on its sender line folds it again.
  await p.locator(`#e${long} .body`).click();
  await until(async () => !(await folded(long)) && (await h(long)) > 80, 3000);
  check(!(await folded(long)) && (await h(long)) > 80, `${tag}: a tap opens it (${await h(long)}px)`);
  await p.locator(`#e${long} .meta .when`).first().click();
  await until(() => folded(long), 3000);
  check(await folded(long), `${tag}: a tap on its sender line folds it again`);
  // The board's ⋯ → Open all messages, then fold them again.
  await p.locator(".board-head-menu > summary").first().click();
  const all = p.locator("[data-ol-toggle]");
  check(await all.isVisible(), `${tag}: the board's ⋯ offers "${(await all.innerText().catch(() => "")).trim()}"`);
  await all.click();
  await until(async () => !(await folded(agent)) && !(await folded(plain)), 3000);
  check(!(await folded(agent)) && !(await folded(plain)) && !(await folded(replyToOther)), `${tag}: Open all messages opens every one, replies too`);
  await p.locator(".board-head-menu > summary").first().click();
  check((await all.innerText()).trim() === "Fold messages again", `${tag}: …and offers "Fold messages again"`);
  await all.click();
  await until(async () => (await folded(agent)) && (await folded(plain)), 3000);
  check((await folded(agent)) && (await folded(plain)), `${tag}: folding them again`);
  // A link to a folded message opens it.
  await p.evaluate((s) => { location.hash = "#e" + s; }, agent);
  await until(async () => !(await folded(agent)), 3000);
  check(!(await folded(agent)), `${tag}: a link to a folded message opens it`);
  check(!(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth)), `${tag}: nothing scrolls sideways`);
  check(!errors.length, `${tag}: no page errors${errors.length ? ` (${errors[0]})` : ""}`);
  if (process.env.SHOTS) { await p.evaluate(() => { location.hash = ""; }); await p.reload(); await p.waitForTimeout(900); await p.screenshot({ path: `${process.env.SHOTS}/one-line-${w}.png` }); }
  // Account → Display offers it; "Whole messages" turns it off.
  await p.goto(`${BASE}/me`);
  await p.locator("#dp-compact-others").waitFor({ state: "attached", timeout: 8000 }).catch(() => {});
  check(await p.locator("#dp-compact-others").isChecked(), `${tag}: Display shows "One line unless they mention you" chosen`);
  await p.locator('label[for="dp-compact-off"]').click();
  const prefsNow = async () => (await (await fetch(`${BASE}/api/app/prefs`, { headers: { cookie: ckA } })).json()).prefs;
  await until(async () => (await prefsNow())?.display?.compact === "off", 5000);
  const prefs = await prefsNow();
  check(prefs?.display?.compact === "off", `${tag}: "Whole messages" saves (${prefs?.display?.compact})`);
  await p.goto(`${BASE}/b/${board}`);
  await p.evaluate(() => new Promise((r) => setTimeout(r, 0))); // after the page's own marking pass
  check(!(await folded(long)) && !(await folded(plain)), `${tag}: with whole messages nothing folds`);
  await ctx.close();
  void ckB;
  console.log(out.join("\n"));
}));
await browser.close();
console.log(fails ? `${fails} FAILED` : "one-line messages: all passed");
process.exit(fails ? 1 : 0);
