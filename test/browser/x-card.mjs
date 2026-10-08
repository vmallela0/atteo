// X post cards (vedu DM #26): a message linking to an X post (x.com, twitter.com, ?s=46…) shows the post under it as a
// card: name, @handle, words, date, linking to the post. /api/x-card is stubbed here (no call to X): the words are set as
// text (markup in a post stays text), a post with no card leaves just the link, other X links get none, the same post
// in two messages is asked once, messages that arrive live get theirs, and the card fits a phone.
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), A = `xc${run}`;
await ops("users", { name: A, email: `${A}@example.com`, verified: "true" });
const board = (await ops("boards", { user: A, title: "X cards" })).board.id;
const cookie = (await ops("sessions", { user: A })).cookie;
let fails = 0; const check = (ok, m) => { console.log(`${ok ? "✓" : "✗"} ${m}`); if (!ok) fails++; };
const post = (text) => fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { cookie: cookie.split(";")[0], "content-type": "application/json" }, body: JSON.stringify({ type: "note", text }) }).then((r) => r.ok);

const HOSTILE = { author: "Whales <b>bold</b>", handle: "unusual_whales", text: "BREAKING: <script>window.pwned=1</script><img src=x id=pwn>\n\nSecond line", date: "October 7, 2026", url: "https://x.com/unusual_whales/status/2107938834180874486" };
const asked = [];
check(await post("look https://x.com/unusual_whales/status/2107938834180874486?s=46 and https://x.com/unusual_whales (profile)"), "a message with an X post link posts");
check(await post("gone: https://twitter.com/jack/status/1"), "a message with a missing post posts");
check(await post("again https://mobile.twitter.com/unusual_whales/status/2107938834180874486"), "the same post again posts");

const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const ctx = await b.newContext({ viewport: { width: 1100, height: 800 } }); const [k, ...v] = cookie.split(";")[0].split("="); await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
await ctx.route("**/api/x-card?*", (r) => {
  const u = new URL(r.request().url()); asked.push(u.searchParams.get("id"));
  if (u.searchParams.get("id") === "2107938834180874486") return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(HOSTILE) });
  return r.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "No preview for that post." }) });
});
const p = await ctx.newPage(); const errors = []; p.on("pageerror", (e) => errors.push(e.message));
await p.goto(`${BASE}/b/${board}`); await p.waitForSelector("#composer-text");
await p.waitForFunction(() => document.querySelectorAll("#thread a.xc").length >= 2, null, { timeout: 8000 }).catch(() => {});
await p.waitForTimeout(300);

const e1 = p.locator(`#${await p.locator("#thread .entry", { hasText: "look https://x.com" }).first().getAttribute("id")}`); // by id: its words change below
const card = e1.locator("a.xc");
check((await card.count()) === 1, `one card under the message, none for the profile link (${await card.count()})`);
check((await card.locator(".xc-who").textContent()) === "Whales <b>bold</b>" && (await card.locator(".xc-h").textContent()) === "@unusual_whales", "name and @handle, as text");
check((await card.locator(".xc-t").textContent()) === HOSTILE.text, "the post's words, as text");
check((await p.locator("#pwn").count()) === 0 && (await card.locator("b, img, script").count()) === 0 && !(await p.evaluate(() => window.pwned)), "markup in the post stays text");
check((await card.locator(".xc-d").textContent()) === "October 7, 2026", "its date");
check((await card.getAttribute("href")) === HOSTILE.url && (await card.getAttribute("target")) === "_blank" && /noopener/.test((await card.getAttribute("rel")) || ""), "the card links to the post in a new tab");
check((await e1.locator(".body a[href*='x.com/unusual_whales/status']").count()) === 1, "the link in the message stays");
const gone = p.locator("#thread .entry", { hasText: "gone: https://twitter.com" }).first();
check((await gone.locator("a.xc, .xcs .xc-slot").count()) === 0, "a post with no card leaves just the link");
const again = p.locator("#thread .entry", { hasText: "again https://mobile.twitter.com" }).first();
check((await again.locator("a.xc").count()) === 1, "a mobile.twitter.com link gets the card too");
check(asked.filter((x) => x === "2107938834180874486").length === 1, `the same post in two messages is asked once (${asked.join(",")})`);
const clamp = await card.locator(".xc-t").evaluate((el) => getComputedStyle(el).webkitLineClamp);
check(clamp === "6", `the words are clamped to six lines (${clamp})`);
const colors = await card.evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).borderTopColor]);
check(colors[0] !== "rgba(0, 0, 0, 0)" && colors[1] !== "rgba(0, 0, 0, 0)", `the card has the board's card look (${colors.join(" / ")})`);
await e1.screenshot({ path: `${SHOTS_DIR}/x-card.png` });

// A body redone in place (an edit, a task's text refreshed): its cards follow its links, never doubled.
const redo = (html) => e1.locator(":scope>.grow>.body").evaluate((b, h) => { b.innerHTML = h; }, html);
await redo('<p>same <a href="https://x.com/unusual_whales/status/2107938834180874486">link</a> again</p>'); await p.waitForTimeout(300);
check((await e1.locator("a.xc").count()) === 1, `the same link redone keeps one card (${await e1.locator("a.xc").count()})`);
await redo("<p>no links now</p>"); await p.waitForTimeout(300);
check((await e1.locator("a.xc, .xcs").count()) === 0, "a body redone without the link loses its card");
await redo('<p>back <a href="https://twitter.com/unusual_whales/status/2107938834180874486?s=20">here</a></p>'); await p.waitForTimeout(300);
check((await e1.locator("a.xc").count()) === 1, "and gets it back with the link");

// Live: a message that arrives while the board is open gets its card.
check(await post("live one https://x.com/unusual_whales/status/2107938834180874486"), "a live message posts");
const live = await p.waitForFunction(() => [...document.querySelectorAll("#thread .entry")].some((e) => /live one/.test(e.textContent) && e.querySelector("a.xc")), null, { timeout: 8000 }).then(() => true).catch(() => false);
check(live, "a live-arriving message gets its card");

// Phone width: the card fits.
await p.setViewportSize({ width: 375, height: 760 }); await p.waitForTimeout(200);
const fit = await card.evaluate((el) => { const r = el.getBoundingClientRect(); return { right: r.right, vw: innerWidth, sw: document.documentElement.scrollWidth }; });
check(fit.right <= fit.vw && fit.sw <= fit.vw, `the card fits a phone (${JSON.stringify(fit)})`);
await e1.screenshot({ path: `${SHOTS_DIR}/x-card-phone.png` });

check(errors.length === 0, `no page errors ${errors.join(" | ")}`);
await b.close(); console.log(fails ? `${fails} FAILED` : "all x-card checks passed");
process.exit(fails ? 1 : 0);
