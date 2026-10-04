// Behaviour checks for the board layout (#29) against the local Worker. Usage: node verify-layout.mjs '<json from layout-shots>'
import { after } from "./seed.mjs";
import { chromium } from "playwright-core";
const { board, A, cookieB } = (process.argv[2] ? JSON.parse(process.argv[2]) : await after());
const BASE = process.env.BASE || "http://localhost:8787", KEY = "ci-admin-key";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": KEY, "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const tokA = (await ops("tokens", { user: A })).token;
const mcp = async (name, args) =>
  (await fetch(`${BASE}/mcp?board=${board}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tokA}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json();
const agentPost = async (text) => { await mcp("read", {}); await mcp("post", { type: "note", text }); };

let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? "✓" : "✗"} ${msg}`); if (!ok) fails++; };
const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });

for (const [label, w, h] of [["desktop", 1280, 800], ["mobile", 390, 844]]) {
  console.log(`-- ${label}`);
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const [k, ...v] = cookieB.split(";")[0].split("=");
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${BASE}/b/${board}`);
  await p.waitForTimeout(700);
  const st = () => p.evaluate(() => { const s = document.getElementById("thread-scroll"); return { top: s.scrollTop, max: s.scrollHeight - s.clientHeight, win: window.scrollY, docH: document.documentElement.scrollHeight, vh: innerHeight }; });
  let s = await st();
  // On a slow machine late layout (fonts, avatars) can still grow the thread after 700ms; the page should stay pinned to the bottom.
  for (let i = 0; i < 20 && !(s.max > 0 && s.max - s.top < 5); i++) { await p.waitForTimeout(150); s = await st(); }
  check(s.max > 0 && s.max - s.top < 5, `opens at the latest entry (scrollTop ${s.top}/${s.max})`);
  check(s.docH <= s.vh + 1, `the page itself doesn't scroll (doc ${s.docH} vs viewport ${s.vh})`);
  const box = async (sel) => p.locator(sel).first().boundingBox();
  const tabs0 = await box("#board-tabs");
  const head = await box(".bp-head");
  check(head.y + head.height < (label === "desktop" ? 100 : 140), `header is compact (ends at ${Math.round(head.y + head.height)}px)`);
  const comp0 = await box(".composer");
  check(comp0 && comp0.y + comp0.height <= h + 1, `composer is on screen (bottom ${Math.round(comp0.y + comp0.height)} ≤ ${h})`);
  // scroll up inside the thread: header and composer don't move
  await p.evaluate(() => { const s = document.getElementById("thread-scroll"); s.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 })); s.scrollTop = 0; });
  await p.waitForTimeout(100);
  const tabs1 = await box("#board-tabs"), comp1 = await box(".composer");
  check(tabs0.y === tabs1.y && comp0.y === comp1.y, "tabs and composer stay put while the thread scrolls");
  // a new entry while scrolled up → pill, no jump
  await agentPost(`while you were reading (${label})`);
  await p.waitForSelector("#new-pill:not([hidden])", { timeout: 5000 }).catch(() => {});
  s = await st();
  check(await p.locator("#new-pill").isVisible(), "scrolled up + new entry → 'New messages ↓' pill");
  check(s.top < 5, `…and the view doesn't jump (scrollTop ${s.top})`);
  await p.click("#new-pill");
  await p.waitForTimeout(700);
  s = await st();
  check(s.max - s.top < 5 && !(await p.locator("#new-pill").isVisible()), `pill jumps to the bottom and hides (${s.top}/${s.max}, pill ${await p.locator("#new-pill").isVisible()})`);
  // at the bottom + new entry → follows
  await agentPost(`at the bottom (${label})`);
  await p.waitForFunction((t) => document.getElementById("thread").textContent.includes(t), `at the bottom (${label})`, { timeout: 5000 });
  await p.waitForTimeout(200);
  s = await st();
  check(s.max - s.top < 5 && !(await p.locator("#new-pill").isVisible()), "at the bottom + new entry → auto-scrolls, no pill");
  // keyboard: C focuses composer; 2 / 3 / 1 switch tabs without page scroll
  await p.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => {});
  await p.keyboard.press("Escape");
  await p.evaluate(() => document.activeElement && document.activeElement.blur());
  await p.keyboard.press("2");
  check(await p.locator("#panel-log").isVisible(), "2 → Log");
  const logTh = await box("#panel-log th");
  await p.evaluate(() => (document.querySelector("#panel-log .list").scrollTop = 400));
  if (logTh) check((await box("#panel-log th")).y === logTh.y, "Log header row stays pinned while the log scrolls");
  else check(await p.locator("#panel-log tr.ev").first().isVisible(), "phones: the Log has no header row, each entry is two lines (#997)");
  await p.keyboard.press("3");
  await p.waitForTimeout(400);
  check(await p.locator("#panel-docs").isVisible(), "3 → Docs");
  check((await box("#board-tabs")).y === tabs0.y, "tabs in the same place on every view");
  await p.click("[data-doc]");
  await p.waitForTimeout(400);
  await p.click("#doc-edit");
  const ed = await box("#doc-text");
  check(ed && ed.height > h * (label === "desktop" ? 0.45 : 0.3), `doc editor uses the height (${Math.round(ed?.height)}px of ${h})`);
  await p.click("#doc-cancel");
  await p.keyboard.press("1");
  await p.waitForTimeout(200);
  s = await st();
  check(await p.locator("#panel-conv").isVisible() && s.max - s.top < 5, "1 → Conversation, still at the bottom");
  check(await p.evaluate(() => window.scrollY) === 0, "never needed a page scroll");
  await p.keyboard.press("k");
  check((await p.locator("#thread .entry.sel").count()) === 1, "J/K select entries");
  await p.keyboard.press("c");
  check(await p.evaluate(() => document.activeElement?.id === "composer-text"), "C focuses the composer");
  // mention menu opens upward, fully on screen
  await p.keyboard.type("hi @");
  await p.waitForSelector("#mention-menu:not([hidden])");
  const mm = await box("#mention-menu"), cp = await box(".composer");
  check(mm.y >= 0 && mm.y + mm.height <= cp.y + 8, "mention menu opens upward, on screen");
  await p.keyboard.press("Enter");
  check((await p.inputValue("#composer-text")).startsWith("hi @"), "Enter picks the mention (doesn't post)");
  await p.keyboard.type(`posted from the pinned composer (${label})`);
  await p.keyboard.press("Enter");
  await p.waitForFunction((t) => document.getElementById("thread").textContent.includes(t), `posted from the pinned composer (${label})`, { timeout: 5000 });
  await p.waitForTimeout(300);
  s = await st();
  check(s.max - s.top < 5 && (await p.inputValue("#composer-text")) === "", "Enter posts; you land on your post; composer clears");
  if (label === "mobile") {
    check(await p.locator("#info-btn").isVisible(), "Board info toggle shows on mobile");
    check(!(await p.locator("#board-info").isVisible()), "sidebar hidden until toggled");
    check((await p.locator("#info-count").textContent()) !== "" , "toggle shows a count of what's waiting on you");
    await p.click("#info-btn");
    check(await p.locator("#board-info").isVisible(), "toggle opens Board info");
    await p.keyboard.press("Escape");
    check(!(await p.locator("#board-info").isVisible()), "Escape closes it");
    await p.keyboard.press("2");
    check(!(await p.locator("#info-btn").isVisible()), "toggle hides on other tabs");
    await p.keyboard.press("1");
  } else {
    const w0=(await box("#thread-scroll")).width;
    await p.click("#info-btn"); await p.waitForTimeout(150);
    const tw=(await box("#thread-scroll")).width;
    check(!(await p.locator("#board-info").isVisible()) && tw<=860, `desktop: Board info hides the sidebar; the thread keeps a readable width (${Math.round(tw)}px, was ${Math.round(w0)}px)`);
    await p.reload(); await p.waitForTimeout(500);
    check(!(await p.locator("#board-info").isVisible()), "…and stays hidden after a reload");
    await p.click("#info-btn"); await p.waitForTimeout(150);
    check(await p.locator("#board-info").isVisible(), "…and comes back on the next click");
    const a = await box("#board-info");
    const scrollable = await p.evaluate(() => { const el = document.getElementById("board-info"); return el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY === "auto"; });
    check(a && a.y + a.height <= h + 1, "sidebar fits the viewport");
    console.log(`   (sidebar scrolls on its own when long: ${scrollable})`);
  }
  // deep link to an entry lands on it, not the bottom
  await p.goto("about:blank"); await p.goto(`${BASE}/b/${board}#e3`); // a fresh load (a hash change alone is a same-page jump)
  await p.waitForTimeout(600);
  const e3 = await box("#e3");
  check(e3 && e3.y > 0 && e3.y < h, "a link to #e3 lands on that entry");
  // retract still works from the scroll area
  check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
  await ctx.close();
}
await browser.close();
console.log(fails ? `${fails} FAILED` : "all checks passed");
process.exit(fails ? 1 : 0);
