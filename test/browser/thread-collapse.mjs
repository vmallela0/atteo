// Replies only in their threads (vedu #2360, task #2363): a Display setting keeps replies off the chat. Each message with
// replies shows "N replies", which opens the thread; a reply arriving live doesn't appear in the chat (the count grows);
// a link to a reply, and Reply on a message, open its thread; the rail has no ticks for hidden replies. Account →
// Display offers it and switching back shows replies again. 1280 (Developer) and 390px (Everyday), and the default
// (replies in the chat) is unchanged.
// Usage: BASE=http://localhost:8798 node thread-collapse.mjs  (local dev only, ADMIN_KEY=ci-admin-key in .dev.vars)
import { chromium } from "playwright-core";
import { until } from "./lib/wait.mjs";
const BASE = process.env.BASE || "http://localhost:8787";
const KEY = process.env.ADMIN_KEY || "ci-admin-key";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": KEY, "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4);
// The two widths and the default run side by side, each with its own users and board; each one's lines print together.
let fails = 0;
const part = () => { const out = []; return { out, check: (ok, t) => { out.push(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; } }; };
const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });

const runs = [[1280, "developer"], [390, "everyday"]].map(([w, mode]) => async () => {
  const { out, check } = part();
  const A = `tc${w}${run}`, B = `td${w}${run}`, tag = `${w}px ${mode}`, phone = w < 500;
  await ops("users", { name: A, email: `${A}@example.com`, verified: "true", display: { mode, replies: "thread" } });
  await ops("users", { name: B, email: `${B}@example.com`, verified: "true", display: { mode } });
  const ckA = (await ops("sessions", { user: A })).cookie.split(";")[0], ckB = (await ops("sessions", { user: B })).cookie.split(";")[0];
  const board = (await ops("boards", { user: A, title: `Threads ${w} ${run}` })).board.id;
  await ops("members", { board, user: B });
  const post = (ck, body) => fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { cookie: ck, "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()).then((j) => j.entry.seq);
  const root = await post(ckA, { text: `Which port should staging use? ${run}` });
  const r1 = await post(ckB, { text: `8985, like prod ${run}`, reply_to: root });
  const r2 = await post(ckA, { text: `ok, switching ${run}`, reply_to: root });
  const other = await post(ckB, { text: `Separate topic: the logo ${run}` });

  const ctx = await browser.newContext({ viewport: { width: w, height: phone ? 844 : 820 }, isMobile: phone, hasTouch: phone });
  const [k, ...v] = ckA.split("=");
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage(), errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${BASE}/b/${board}`);
  await p.locator(`#e${root} .thr-sum`).waitFor({ timeout: 8000 }).catch(() => {});
  // The account's Display setting arrives after load (the shell fetches /api/me/profile): wait for it to apply.
  await until(() => p.evaluate(() => document.documentElement.dataset.replies === "thread"), 5000);
  const vis = (s) => p.locator(`#e${s}`).isVisible();
  check((await p.evaluate(() => document.documentElement.dataset.replies)) === "thread", `${tag}: the page follows the account's Display setting`);
  check((await vis(root)) && (await vis(other)) && !(await vis(r1)) && !(await vis(r2)), `${tag}: top-level messages show; replies don't`);
  const sum = p.locator(`#e${root} .thr-sum`);
  check(/2 repl/.test(await sum.innerText().catch(() => "")), `${tag}: the message says "2 replies" (${(await sum.innerText().catch(() => "")).replace(/\n/g, " ")})`);
  const ticks = await p.locator(".rail i").count();
  check(ticks === 2, `${tag}: the rail has a tick per visible message only (${ticks})`);
  // Live: a new reply grows the count but stays off the chat.
  const r3 = await post(ckB, { text: `done ${run}`, reply_to: r1 });
  await p.waitForFunction((s) => !!document.getElementById("e" + s), r3, { timeout: 8000 }).catch(() => {});
  await until(async () => /3 repl/.test(await sum.innerText()), 5000);
  check(!(await vis(r3)) && /3 repl/.test(await sum.innerText().catch(() => "")), `${tag}: a reply arriving live stays in the thread; the count says 3`);
  // "N replies" opens the thread with the replies in it.
  await sum.click();
  await until(async () => (await p.locator("dialog.thr-dlg[open] .thr-list").innerText()).includes(`done ${run}`), 5000);
  const dlg = p.locator("dialog.thr-dlg[open]");
  const inThread = await dlg.locator(".thr-list").innerText().catch(() => "");
  check((await dlg.count()) === 1 && inThread.includes(`8985, like prod ${run}`) && inThread.includes(`done ${run}`), `${tag}: "3 replies" opens the thread with them`);
  const closed = () => until(async () => !(await p.locator("dialog.thr-dlg[open]").count()), 3000);
  await p.keyboard.press("Escape");
  await closed();
  // A link to a reply opens its thread at it: on this page (the hash changes) and opening the page with it.
  const opened = async () => (await p.locator("dialog.thr-dlg[open]").count()) === 1 && (await p.locator("dialog.thr-dlg[open] .thr-list").innerText()).includes(`ok, switching ${run}`);
  await p.evaluate((s) => { location.hash = "#e" + s; }, r2);
  await until(opened, 5000);
  check(await opened(), `${tag}: following a link to a reply on the page opens its thread`);
  await p.keyboard.press("Escape");
  await p.goto("about:blank");
  await p.goto(`${BASE}/b/${board}#e${r2}`);
  await until(opened, 8000);
  check(await opened(), `${tag}: opening the board at a reply opens its thread`);
  await p.keyboard.press("Escape");
  await closed();
  // Reply on a message answers in its thread (desktop: the hover action).
  if (!phone) {
    await p.locator(`#e${other}`).hover();
    const rb = p.locator(`#e${other} button[data-reply]`).first();
    if (await rb.count()) {
      await rb.click();
      await until(async () => (await p.locator("dialog.thr-dlg[open]").count()) === 1, 5000);
      check((await p.locator("dialog.thr-dlg[open]").count()) === 1, `${tag}: Reply opens the message's thread to answer there`);
      await p.keyboard.press("Escape");
    } else check(false, `${tag}: the message has a Reply action`);
  }
  check(!errors.length, `${tag}: no page errors${errors.length ? ` (${errors[0]})` : ""}`);
  // Account → Display: it's offered, and "In the chat" brings replies back.
  await p.goto(`${BASE}/me`);
  await p.locator("#dp-replies-thread").waitFor({ state: "attached", timeout: 8000 }).catch(() => {});
  check(await p.locator("#dp-replies-thread").isChecked(), `${tag}: Display shows "Only in their threads" chosen`);
  await p.locator('label[for="dp-replies-chat"]').click();
  const prefsNow = async () => (await (await fetch(`${BASE}/api/app/prefs`, { headers: { cookie: ckA } })).json()).prefs;
  await until(async () => (await prefsNow())?.display?.replies === "chat", 5000);
  const prefs = await prefsNow();
  check(prefs?.display?.replies === "chat", `${tag}: choosing "In the chat" saves it (${prefs?.display?.replies})`);
  await p.goto(`${BASE}/b/${board}`);
  await p.locator(`#e${r3}`).waitFor({ timeout: 8000 }).catch(() => {});
  check((await vis(r1)) && (await vis(r3)), `${tag}: back in the chat, replies show again`);
  await ctx.close();
  console.log(out.join("\n"));
});

// Someone who never chose it: replies in the chat, as before.
runs.push(async () => {
  const { out, check } = part();
  const C = `te${run}`;
  await ops("users", { name: C, email: `${C}@example.com`, verified: "true", display: { mode: "developer" } });
  const ck = (await ops("sessions", { user: C })).cookie.split(";")[0];
  const board = (await ops("boards", { user: C, title: `Default ${run}` })).board.id;
  const post = (body) => fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { cookie: ck, "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()).then((j) => j.entry.seq);
  const root = await post({ text: `root ${run}` }), rep = await post({ text: `reply ${run}`, reply_to: root });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const [k, ...v] = ck.split("=");
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage();
  await p.goto(`${BASE}/b/${board}`);
  await p.locator(`#e${rep}`).waitFor({ timeout: 8000 }).catch(() => {});
  check(await p.locator(`#e${rep}`).isVisible(), "default: replies show in the chat as before");
  await ctx.close();
  console.log(out.join("\n"));
});
await Promise.all(runs.map((r) => r()));
await browser.close();
console.log(fails ? `${fails} FAILED` : "replies only in threads: all passed");
process.exit(fails ? 1 : 0);
