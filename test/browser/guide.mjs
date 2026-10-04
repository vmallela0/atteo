// The guide (vedu #2402): /guide lists what people can do by task, with a filter and an anchor per feature; it's public,
// in the reader's language, and linked from the sidebar / phone menu and Account; /agents.md is the agents' copy.
// 1280 and 390, light and dark. BASE, ADMIN_KEY, PW_CHROME.
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": process.env.ADMIN_KEY || "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), U = `gd${run}`;
await ops("users", { name: U, email: `${U}@example.com`, verified: "true", display: { mode: "developer" } });
let fails = 0; const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
async function open(path, { user = null, width = 1280, dark = false, locale } = {}) {
  const phone = width < 500;
  const ctx = await b.newContext({ viewport: { width, height: 844 }, colorScheme: dark ? "dark" : "light", ...(locale ? { locale } : {}), ...(phone ? { isMobile: true, hasTouch: true } : {}) });
  if (user) { const ck = (await ops("sessions", { user })).cookie; const [k, ...v] = ck.split(";")[0].split("="); await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]); }
  const p = await ctx.newPage(); p.errors = []; p.on("pageerror", (e) => p.errors.push(e.message));
  await p.goto(`${BASE}${path}`); await p.waitForTimeout(500);
  return { ctx, p, tap: (sel) => (phone ? p.locator(sel).first().tap() : p.locator(sel).first().click()) };
}
const visibleItems = (p) => p.evaluate(() => [...document.querySelectorAll(".gd-item")].filter((x) => !x.hidden && !x.closest("[hidden]")).map((x) => x.id));
const fits = (p) => p.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

// Signed out, desktop, dark: every section, a working filter, "/" to search, the agents' link.
{ const { ctx, p } = await open("/guide", { dark: true });
  check(/What Atteo can do/.test(await p.locator("h1").innerText()), "signed out: the guide opens without signing in");
  const all = await visibleItems(p);
  check(all.length >= 30 && all.includes("people-only") && all.includes("approve") && !all.includes("batch"), `all people's entries show (${all.length}), agent-only ones don't`);
  check(await p.evaluate(() => getComputedStyle(document.body).backgroundColor !== "rgb(255, 255, 255)"), "dark: the page follows the dark theme");
  await p.keyboard.press("/");
  check(await p.evaluate(() => document.activeElement?.id === "gd-q"), '"/" focuses the search');
  await p.keyboard.type("encrypt");
  await p.waitForTimeout(150);
  const hits = await visibleItems(p);
  check(hits.includes("encryption") && hits.length < 6, `filter "encrypt" narrows it to ${hits.join(", ")}`);
  check(await p.locator("#gd-none").isHidden(), "something matched: no empty note");
  await p.fill("#gd-q", "zzzz nothing like this");
  await p.waitForTimeout(150);
  check((await visibleItems(p)).length === 0 && (await p.locator("#gd-none").isVisible()), "no match: every entry hidden, the empty note shows");
  await p.fill("#gd-q", "");
  await p.waitForTimeout(150);
  check((await visibleItems(p)).length === all.length, "clearing the search brings everything back");
  check(/\/agents\.md$/.test(await p.locator(".gd-agents a").getAttribute("href")), "it links the agents' copy");
  check(!p.errors.length, `no page errors ${p.errors.join(" | ")}`);
  await ctx.close(); }

// An anchor per feature: /guide#people-only lands on it.
{ const { ctx, p } = await open("/guide#people-only");
  check(await p.evaluate(() => { const r = document.getElementById("people-only").getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight; }), "#people-only is on screen on arrival");
  await ctx.close(); }

// The reader's language: ?lang=ja, and Accept-Language when signed out.
{ const { ctx, p } = await open("/guide?lang=ja");
  check((await p.locator("h1").innerText()).includes("Atteo でできること") && (await p.locator("html").getAttribute("lang")) === "ja", "?lang=ja: the guide in Japanese");
  check((await p.locator("#people-only h3").innerText()).includes("人だけ"), "the feature texts are translated too");
  await ctx.close(); }
{ const { ctx, p } = await open("/guide", { locale: "es-ES" });
  check((await p.locator("h1").innerText()).includes("Lo que puede hacer Atteo"), "Accept-Language es: the guide in Spanish");
  await ctx.close(); }

// Signed in on a phone: the menu has Guide, which opens it (current), nothing wider than the phone, in light and dark.
for (const dark of [false, true]) {
  const { ctx, p, tap } = await open("/inbox", { user: U, width: 390, dark });
  await tap("[data-nav]"); await p.waitForTimeout(300);
  const item = p.locator('#sidebar a[href="/guide"]');
  check(await item.isVisible(), `phone${dark ? " dark" : ""}: the menu has Guide`);
  await Promise.all([p.waitForURL(/\/guide$/), tap('#sidebar a[href="/guide"]')]); await p.waitForTimeout(400);
  check((await p.locator('#sidebar a[href="/guide"]').getAttribute("aria-current")) === "page", "it opens the guide, marked current in the menu");
  check(await fits(p), `phone${dark ? " dark" : ""}: nothing wider than the phone`);
  check(await p.evaluate(() => getComputedStyle(document.querySelector(".gd-list")).gridTemplateColumns.split(" ").length === 1), "one column on a phone");
  check(!p.errors.length, `no page errors ${p.errors.join(" | ")}`);
  await ctx.close();
}

// Account links it; desktop sidebar too.
{ const { ctx, p } = await open("/me", { user: U });
  check(await p.locator("#me-guide").isVisible(), "Account has What Atteo can do");
  check(await p.locator('#sidebar a[href="/guide"]').isVisible(), "desktop: the sidebar has Guide");
  await ctx.close(); }

// The agents' copy.
{ const r = await fetch(`${BASE}/agents.md`); const t = await r.text();
  check(r.ok && /text\/markdown/.test(r.headers.get("content-type")) && t.startsWith("# Atteo for agents") && t.includes("`request_approval`"), "/agents.md is served as Markdown with the tools"); }

await b.close(); console.log(fails ? `${fails} FAILED` : "guide: all passed"); process.exit(fails ? 1 : 0);
