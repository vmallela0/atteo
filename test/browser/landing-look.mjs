// atteo.dev's landing page in the design language v1 (board #2508, task #2529): the tin-can mark and the Schoolbell
// wordmark with its marker filter, Enriqueta headline, Onest text, Courier Prime commands, ink/paper (and the dark
// pair), cherry only on atteo's initials in the headline (the old clay accent); the shapes stay as they were (jxn #2583:
// only fonts, colours and the logo change): rounded box, button and links, round avatars; no sideways scroll from 320 to 1440px;
// the copy is unchanged; /og.png is a 1200×630 PNG. Its type is the app's own files (/fonts/*, which the landing forwards
// to the app): nothing is asked of Google, and every font file it asks for is one the app ships (src/fonts).
// It runs against the LANDING Worker, not the app:
//   npx wrangler dev -c landing/wrangler.jsonc --port 8798 --inspector-port 9237 --var APP_ORIGIN:http://127.0.0.1:9
//   LANDING=http://localhost:8798 node test/browser/landing-look.mjs
import { chromium } from "playwright-core";
import { readFileSync, existsSync } from "node:fs";
const FONTS = new URL("../../src/fonts/", import.meta.url);
const BASE = (process.env.LANDING || process.env.BASE || "http://localhost:8811").replace(/\/$/, "");
let fails = 0;
const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const CHERRY = { light: "rgb(168, 18, 30)", dark: "rgb(224, 48, 63)" };
const BG = { light: "rgb(250, 250, 247)", dark: "rgb(14, 14, 14)" };

for (const [w, theme] of [[1440, "light"], [1440, "dark"], [768, "light"], [390, "light"], [390, "dark"], [320, "light"]]) {
  const tag = `${w}px ${theme}`, phone = w < 500;
  const ctx = await browser.newContext({ viewport: { width: w, height: phone ? 844 : 900 }, isMobile: phone, hasTouch: phone });
  const p = await ctx.newPage(), errors = [], off = [], asked = [];
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("request", (q) => { const u = new URL(q.url()); if (u.origin !== new URL(BASE).origin) off.push(u.host); });
  // /fonts/* is the app's (the landing forwards it): answer from the files the app ships, and note each one asked for.
  await p.route(/\/fonts\/[^/?]+/, async (route) => { const f = new URL(route.request().url()).pathname.split("/").pop(); asked.push(f); const path = new URL(f, FONTS);
    if (existsSync(path)) await route.fulfill({ status: 200, contentType: "font/woff2", body: readFileSync(path) }); else await route.fulfill({ status: 404, body: "" }); });
  await p.goto(`${BASE}/?theme=${theme}`);
  await p.waitForTimeout(1500);
  await p.evaluate(() => document.fonts.ready);
  const r = await p.evaluate(() => {
    const cs = (sel) => { const e = document.querySelector(sel); return e ? getComputedStyle(e) : null; };
    // Every element whose text, background or border is the page's cherry (the logo's SVG strokes aside).
    const cherry = getComputedStyle(document.documentElement).getPropertyValue("--cherry").trim();
    const probe = document.createElement("i"); probe.style.color = cherry; document.body.append(probe); const cherryRgb = getComputedStyle(probe).color; probe.remove();
    const uses = [...document.querySelectorAll("body *:not(svg):not(svg *)")].filter((e) => { const s = getComputedStyle(e); return e.offsetParent !== null && [s.color, s.backgroundColor, s.borderTopColor].includes(cherryRgb) && (s.backgroundColor === cherryRgb || (e.textContent || "").trim()); }).map((e) => e.tagName.toLowerCase() + "." + e.className);
    const radius = [".box", ".box button", ".or a", ".entry .via", ".mention", ".av"].map((s) => [s, cs(s)?.borderTopLeftRadius]);
    return {
      bg: getComputedStyle(document.body).backgroundColor, cherryRgb, uses,
      h1: cs("h1").fontFamily, body: getComputedStyle(document.body).fontFamily, pre: cs(".dev pre").fontFamily, wm: cs(".brand .wm").fontFamily, wmFilter: cs(".brand .wm").filter,
      rule: cs(".top").borderBottomWidth + " " + cs(".top").borderBottomStyle, boxBorder: cs(".box").borderTopWidth, radius,
      mark: !!document.querySelector(".brand svg.mk .mk-c") && !!document.querySelector("#wm-marker"),
      fonts: ["Onest", "Enriqueta", "Schoolbell", '"Courier Prime"'].filter((f) => !document.fonts.check(`600 20px ${f}`) && !document.fonts.check(`20px ${f}`)),
      sideways: document.documentElement.scrollWidth > innerWidth,
      title: document.title, h1label: document.querySelector("h1").getAttribute("aria-label"), cta: document.querySelector(".box button").textContent,
    };
  });
  check(r.bg === BG[theme], `${tag}: the ground is ${theme === "light" ? "paper" : "ink"} (${r.bg})`);
  check(r.cherryRgb === CHERRY[theme] && r.uses.length === 5 && r.uses.every((u) => u === "span.i"), `${tag}: cherry only on atteo's initials in the headline (${JSON.stringify(r.uses)})`);
  check(/Enriqueta/.test(r.h1) && /Onest/.test(r.body) && /Courier Prime/.test(r.pre) && /Schoolbell/.test(r.wm), `${tag}: Enriqueta headline, Onest text, Courier Prime commands, Schoolbell wordmark`);
  check(!r.fonts.length, `${tag}: all four fonts loaded${r.fonts.length ? ` (missing ${r.fonts.join(", ")})` : ""}`);
  check(/wm-marker/.test(r.wmFilter) && r.mark, `${tag}: the tin-can mark and the wordmark with its marker filter`);
  const want = { ".box": "14px", ".box button": "10px", ".or a": "8px", ".entry .via": "999px", ".mention": "4px", ".av": "50%" };
  check(r.boxBorder === "1px" && r.rule !== "2px solid" && r.radius.every(([k, v]) => v === want[k]), `${tag}: shapes as before: rounded corners, 1px borders, round avatars (${JSON.stringify(r.radius)})`);
  check(!r.sideways, `${tag}: nothing scrolls sideways`);
  check(r.title === "Atteo · Agents Talking To Each Other" && r.h1label === "Agents (are now) Talking To Each Other." && r.cta === "Start a chat", `${tag}: the copy is unchanged`);
  check(!off.length && asked.length >= 3 && asked.every((f) => existsSync(new URL(f, FONTS))), `${tag}: fonts come from /fonts/ (${[...new Set(asked)].join(", ")}), nothing off-site${off.length ? ` (${[...new Set(off)].join(", ")})` : ""}`);
  check(!errors.length, `${tag}: no page errors${errors.length ? ` (${errors[0]})` : ""}`);
  if (process.env.SHOTS) await p.screenshot({ path: `${process.env.SHOTS}/landing-${w}-${theme}.png` }).catch(() => {});
  await ctx.close();
}
const og = await fetch(`${BASE}/og.png`);
const buf = Buffer.from(await og.arrayBuffer());
check(og.ok && og.headers.get("content-type") === "image/png" && buf.readUInt32BE(16) === 1200 && buf.readUInt32BE(20) === 630, `/og.png is a 1200×630 PNG (${buf.readUInt32BE(16)}×${buf.readUInt32BE(20)})`);
await browser.close();
console.log(fails ? `${fails} FAILED` : "landing look: all passed");
process.exit(fails ? 1 : 0);
