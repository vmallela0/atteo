// Just mine on the web (#1825, server #1748/#1808; each tap starts at People only, #1866): the composer's lock offers People only or Just mine. Just mine says
// what it means, posts with own:true, shows 🔒 just mine on the message and turns the lock off after sending. Your own agent
// gets it (its mailbox and its read); another member never sees it, in their browser, the API or their agent's read.
// Each tap of the lock starts at People only, and the button names the choice that's on. People only still needs an @person. The choice works with arrow keys and is in Chinese for a Chinese browser. 1200px
// and 390px (touch), no page errors.
// Usage: BASE=http://localhost:8787 node just-mine.mjs
import { chromium } from "playwright-core";
const BASE = (process.env.BASE || "http://localhost:8787").replace(/\/$/, "");
const KEY = process.env.ADMIN_KEY || "ci-admin-key";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": KEY, "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-5), A = `ja${run}`, B = `jb${run}`;
for (const u of [A, B]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true", display: { mode: "developer" } });
const board = (await ops("boards", { user: A, title: `Lane ${run}` })).board.id;
await ops("members", { board, user: B });
const ckA = (await ops("sessions", { user: A })).cookie.split(";")[0], ckB = (await ops("sessions", { user: B })).cookie.split(";")[0];
const tokA = (await ops("tokens", { user: A })).token, tokB = (await ops("tokens", { user: B })).token;
const mcp = async (tok, name, args) => (await (await fetch(`${BASE}/mcp?board=${board}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json()).result.content[0].text;
const entries = async (headers) => JSON.stringify(await (await fetch(`${BASE}/api/boards/${board}/entries?after=0&limit=200`, { headers })).json());
const mailbox = async (tok) => (await (await fetch(`${BASE}/api/mailbox?peek=1&limit=100`, { headers: { authorization: `Bearer ${tok}` } })).json()).mail || [];
await mcp(tokA, "read", {});
await mcp(tokB, "read", {});
let fails = 0;
const check = (ok, m) => { console.log(`${ok ? "✓" : "✗"} ${m}`); if (!ok) fails++; };
const until = async (f, ms = 5000) => { const t = Date.now(); for (;;) { const v = await f(); if (v || Date.now() - t > ms) return v; await new Promise((r) => setTimeout(r, 200)); } };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const errors = [];
const open = async (cookie, w, mobile, locale = "en-US") => {
  const ctx = await b.newContext({ viewport: { width: w, height: 820 }, isMobile: mobile, hasTouch: mobile, locale });
  const [k, ...v] = cookie.split("=");
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(`${w}: ${e.message}`));
  await p.goto(`${BASE}/b/${board}`);
  await p.waitForTimeout(900);
  return { ctx, p };
};
const secrets = [];
for (const [w, mobile] of [[1200, false], [390, true]]) {
  const { ctx, p } = await open(ckA, w, mobile);
  const tap = (sel) => p.locator(sel)[mobile ? "tap" : "click"]();
  await tap("#po-btn");
  check(await p.getAttribute("#po-btn", "aria-pressed") === "true" && await p.locator("#po-note").isVisible() && await p.getAttribute('[data-po="people"]', "aria-checked") === "true", `${w}px: the lock turns on as People only, with Just mine beside it`);
  check((await p.locator("#po-lbl").innerText()) === "People only" && /People only/.test(await p.getAttribute("#po-btn", "aria-label")), `${w}px: the button says People only (${await p.getAttribute("#po-btn", "aria-label")})`);
  await tap('[data-po="own"]');
  check((await p.locator("#po-lbl").innerText()) === "Just mine" && await p.locator("#po-btn.own").count() === 1, `${w}px: …and Just mine, in another colour, once that's picked`);
  // Post, or the mic that stands in for it while the box is empty (#2083).
  const fit = await p.evaluate(() => { const r = [...document.querySelectorAll("form.composer .post-btn, form.composer #mic-btn")].find((e) => e.offsetParent).getBoundingClientRect(), l = document.getElementById("po-btn").getBoundingClientRect(); return r.right <= innerWidth && Math.abs(r.top - l.top) < 12; });
  check(fit, `${w}px: the labelled lock and Post still fit on one row`);
  const why = await p.locator("#po-note").innerText(), ph = await p.getAttribute("#composer-text", "placeholder");
  check(await p.getAttribute('[data-po="own"]', "aria-checked") === "true" && /only you and your agents/i.test(why) && /only you and your agents/i.test(ph), `${w}px: Just mine says who sees it ("${why.replace(/\s+/g, " ")}"; "${ph}")`);
  const over = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check(over <= 1, `${w}px: the choice fits (${over}px sideways)`);
  const text = `secret plan ${w} ${run}`;
  secrets.push(text);
  await p.fill("#composer-text", text);
  await p.locator("form.composer button.primary").click();
  const e = p.locator(`#thread .entry:has-text("${text}")`);
  check(await until(async () => (await e.count()) === 1 && "ok"), `${w}px: it posts with no @ needed`);
  let toastSeen = "";
  const badge = await until(async () => { const t = await p.locator("#toast").innerText().catch(() => ""); if (/Just mine/.test(t)) toastSeen = t; return (await e.locator(".badge.po.own").count()) === 1 && /just mine/.test(await e.locator(".badge.po.own").innerText()) && "ok"; });
  check(badge, `${w}px: the message shows 🔒 just mine`);
  check(toastSeen || await until(async () => /Just mine/.test(await p.locator("#toast").innerText()) && "ok", 2000), `${w}px: the server's notice shows ("${toastSeen}")`);
  check(await until(async () => (await p.getAttribute("#po-btn", "aria-pressed")) === "false" && "ok", 2000) && await p.locator("#po-note").isHidden() && (await p.inputValue("#own-in")) === "", `${w}px: the lock turns off after sending`);
  check((await p.locator("#po-lbl").innerText()) === "" && /^Private$/.test(await p.getAttribute("#po-btn", "aria-label")), `${w}px: the button's label goes with it`);
  // The next tap starts at People only again, the stricter choice; it still asks for an @person.
  await tap("#po-btn");
  check(await p.getAttribute('[data-po="people"]', "aria-checked") === "true" && (await p.inputValue("#po-in")) === "true" && (await p.inputValue("#own-in")) === "", `${w}px: after a Just mine post, the next tap starts at People only`);
  await p.fill("#composer-text", `nobody named ${run}`);
  await p.locator("form.composer button.primary").click();
  await p.waitForTimeout(500);
  check(/@ the people/.test(await p.locator("#toast").innerText()) && (await p.locator(`#thread .body:has-text("nobody named ${run}")`).count()) === 0, `${w}px: People only still needs an @person`);
  await p.fill("#composer-text", "");
  await tap("#po-btn");
  check(await p.locator("#po-note").isHidden() && (await p.inputValue("#po-in")) === "" && (await p.inputValue("#own-in")) === "", `${w}px: the lock turns off`);
  await ctx.close();
}
// Keyboard: arrow keys move between the two choices.
{
  const { ctx, p } = await open(ckA, 1200, false);
  await p.click("#po-btn");
  await p.focus('[data-po="people"]');
  await p.keyboard.press("ArrowRight");
  check(await p.getAttribute('[data-po="own"]', "aria-checked") === "true" && await p.evaluate(() => document.activeElement?.dataset.po) === "own", "→ picks Just mine (and moves focus)");
  await p.keyboard.press("ArrowLeft");
  check(await p.getAttribute('[data-po="people"]', "aria-checked") === "true", "← back to People only");
  await ctx.close();
}
// Who gets it.
const seqs = (JSON.parse(await entries({ cookie: ckA })).entries || []).filter((x) => secrets.some((s) => x.text?.includes(s))).map((x) => x.seq);
check(seqs.length === 2, `both are on the board for me (${seqs.join(", ")})`);
const mail = await mailbox(tokA);
check(seqs.every((s) => mail.some((m) => m.board === board && m.seq === s)), `my agent's mailbox has them (${mail.filter((m) => m.board === board).map((m) => m.seq).join(", ")})`);
const readA = await mcp(tokA, "read", {});
check(secrets.every((s) => readA.includes(s)), "my agent's read shows them");
const readB = await mcp(tokB, "read", {});
check(!secrets.some((s) => readB.includes(s)), `${B}'s agent never sees them`);
check(!(await mailbox(tokB)).some((m) => seqs.includes(m.seq) && m.board === board), `…nor its mailbox`);
const apiB = await entries({ cookie: ckB });
check(!secrets.some((s) => apiB.includes(s)), `${B} never sees them in the API`);
{
  const { ctx, p } = await open(ckB, 1200, false);
  const t = await p.locator("#thread").innerText();
  check(!secrets.some((s) => t.includes(s)), `…nor on the page`);
  await ctx.close();
}
// In Chinese.
{
  const { ctx, p } = await open(ckA, 1200, false, "zh-CN");
  await p.click("#po-btn");
  const seg = await p.locator(".po-seg").innerText();
  check(/仅限真人/.test(seg) && /仅自己/.test(seg), `the choice in 简体中文 (${seg.replace(/\s+/g, " ")})`);
  const badge = await p.locator(".badge.po.own").first().innerText();
  check(/仅自己/.test(badge), `…and the badge (${badge})`);
  await ctx.close();
}
check(errors.length === 0, `no page errors (${errors.join(" | ")})`);
await b.close();
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
