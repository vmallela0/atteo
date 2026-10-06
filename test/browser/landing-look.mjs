// atteo.dev's landing page in the design language v1 (board #2508, task #2529): the tin-can mark and the Schoolbell
// wordmark with its marker filter, Enriqueta headline, Onest text, Courier Prime commands, ink/paper (and the dark
// pair), one accent: oxblood only on Start a chat (jxn #2858), white whatever the system theme; the shapes stay as they were (jxn #2583:
// only fonts, colours and the logo change): rounded box, button and links, round avatars; no sideways scroll from 320 to 1440px;
// the copy is unchanged; /og.png is a 1200×630 PNG. Its type is the app's own files (/fonts/*, which the landing forwards
// to the app): nothing is asked of Google, and every font file it asks for is one the app ships (src/fonts).
// HTML pages send an enforced hash CSP (docs/security/csp.md #8): JSON-LD is allowed by sha256, /guide and /support are script-src 'none'.
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
const ACCENT = { light: "rgb(106, 27, 36)", dark: "rgb(194, 65, 77)" }; // oxblood, and its dark pair
const BG = { light: "rgb(255, 255, 255)", dark: "rgb(14, 14, 14)" };

for (const [w, theme] of [[1440, "light"], [1440, "dark"], [768, "light"], [390, "light"], [390, "dark"], [320, "light"]]) {
  const tag = `${w}px ${theme}`, phone = w < 500;
  const ctx = await browser.newContext({ viewport: { width: w, height: phone ? 844 : 900 }, isMobile: phone, hasTouch: phone });
  const p = await ctx.newPage(), errors = [], off = [], asked = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.addInitScript(() => { document.addEventListener("securitypolicyviolation", (e) => { window.__cspHits = window.__cspHits || []; window.__cspHits.push(`${e.effectiveDirective} ${e.blockedURI}`); }); });
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
    const cherry = getComputedStyle(document.documentElement).getPropertyValue("--oxblood").trim();
    const probe = document.createElement("i"); probe.style.color = cherry; document.body.append(probe); const cherryRgb = getComputedStyle(probe).color; probe.remove();
    const uses = [...document.querySelectorAll("body *:not(svg):not(svg *)")].filter((e) => { const s = getComputedStyle(e); return e.offsetParent !== null && [s.color, s.backgroundColor, s.borderTopColor].includes(cherryRgb) && (s.backgroundColor === cherryRgb || (e.textContent || "").trim()); }).map((e) => e.tagName.toLowerCase() + "." + e.className);
    const radius = [".box", ".box button", ".or a", ".entry .via", ".mention", ".av"].map((s) => [s, cs(s)?.borderTopLeftRadius]);
    return {
      bg: getComputedStyle(document.body).backgroundColor, cherryRgb, uses,
      h1: cs("h1").fontFamily, body: getComputedStyle(document.body).fontFamily, pre: cs(".dev pre").fontFamily, wm: cs(".brand .wm").fontFamily, wmFilter: cs(".brand .wm").filter,
      rule: cs(".top").borderBottomWidth + " " + cs(".top").borderBottomStyle, boxBorder: cs(".box").borderTopWidth, radius,
      mark: !!document.querySelector(".brand svg.mk path[stroke=currentColor]") && !!document.querySelector(".brand .tagl"),
      fonts: ["Onest", "Enriqueta", '"STIX Two Text"', '"Courier Prime"'].filter((f) => !document.fonts.check(`600 20px ${f}`) && !document.fonts.check(`20px ${f}`)),
      sideways: document.documentElement.scrollWidth > innerWidth,
      title: document.title, h1label: document.querySelector("h1").getAttribute("aria-label"), cta: document.querySelector(".box button").textContent,
      elsewhere: (() => { const b = document.body.cloneNode(true); b.querySelector("h1").remove(); return (b.textContent.replace(/\s+/g, " ").match(/talk(ing)? to each other/gi) || []).length; })(), headSays: /talking to each other/i.test(document.head.innerHTML),
    };
  });
  check(r.bg === BG[theme], `${tag}: the ground is ${theme === "light" ? "paper" : "ink"} (${r.bg})`);
  check(r.cherryRgb === ACCENT[theme] && r.uses.length === 1 && /^button/.test(r.uses[0]), `${tag}: one accent, oxblood, on Start a chat only (${JSON.stringify(r.uses)})`);
  check(/Enriqueta/.test(r.h1) && /Onest/.test(r.body) && /Courier Prime/.test(r.pre), `${tag}: Enriqueta headline, Onest text, Courier Prime commands`); // the wordmark is STIX now (jxn #4713), checked below
  check(!r.fonts.length, `${tag}: all four fonts loaded${r.fonts.length ? ` (missing ${r.fonts.join(", ")})` : ""}`);
  check(/STIX Two Text/.test(r.wm) && r.mark, `${tag}: the graph mark, the STIX wordmark and its tagline (${r.wm})`);
  const want = { ".box": "14px", ".box button": "10px", ".or a": "8px", ".entry .via": "999px", ".mention": "4px", ".av": "50%" };
  check(r.boxBorder === "1px" && r.rule !== "2px solid" && r.radius.every(([k, v]) => v === want[k]), `${tag}: shapes as before: rounded corners, 1px borders, round avatars (${JSON.stringify(r.radius)})`);
  check(!r.sideways, `${tag}: nothing scrolls sideways`);
  check(r.title === "Atteo · A shared chat for you, your people and your agents" && r.h1label === "Agents (are now) Talking To Each Other." && r.cta === "Start a chat", `${tag}: the copy is unchanged`);
  check(r.elsewhere === 0 && !r.headSays, `${tag}: "talking to each other" is said once, by the headline; not in the title, meta, footer or anywhere else on the page (vedu #2853${r.elsewhere ? `; ${r.elsewhere} more` : ""})`);
  check(!off.length && asked.length >= 3 && asked.every((f) => existsSync(new URL(f, FONTS))), `${tag}: fonts come from /fonts/ (${[...new Set(asked)].join(", ")}), nothing off-site${off.length ? ` (${[...new Set(off)].join(", ")})` : ""}`);
  check(!errors.length, `${tag}: no page errors${errors.length ? ` (${errors[0]})` : ""}`);
  const cspHits = await p.evaluate(() => window.__cspHits || []);
  check(!cspHits.length, `${tag}: no CSP violations${cspHits.length ? ` (${cspHits.join("; ")})` : ""}`);
  if (process.env.SHOTS) await p.screenshot({ path: `${process.env.SHOTS}/landing-${w}-${theme}.png` }).catch(() => {});
  await ctx.close();
}
const og = await fetch(`${BASE}/og.png`);
const buf = Buffer.from(await og.arrayBuffer());
// White by default: a phone or laptop set to dark still gets the white page (only ?theme=dark previews the dark pair).
{ const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark", isMobile: true });
  const p = await ctx.newPage(); await p.goto(`${BASE}/`); await p.waitForTimeout(300);
  const bg = await p.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check(bg === BG.light, `a system set to dark still gets the white page (${bg})`); await ctx.close(); }
check(og.ok && og.headers.get("content-type") === "image/png" && buf.readUInt32BE(16) === 1200 && buf.readUInt32BE(20) === 630, `/og.png is a 1200×630 PNG (${buf.readUInt32BE(16)}×${buf.readUInt32BE(20)})`);
// Found by search and answer engines (vedu #3151, task #3152): robots lets the AI crawlers read the public pages but
// not the app's; the sitemap lists the public pages; /llms.txt and /llms-full.txt answer;
// and the JSON-LD parses: the home page says what Atteo is, and /faq's FAQPage data is its own questions.
{ const txt = async (p) => { const r = await fetch(`${BASE}${p}`); return { ok: r.ok, type: r.headers.get("content-type") || "", csp: r.headers.get("content-security-policy") || "", report: r.headers.get("content-security-policy-report-only") || "", body: await r.text() }; };
  const [robots, sitemap, llms, full, home, faqPg, guide, support] = await Promise.all(["/robots.txt", "/sitemap.xml", "/llms.txt", "/llms-full.txt", "/", "/faq", "/guide", "/support"].map(txt));
  const group = (ua) => (robots.body.split(/\n\s*\n/).find((g) => g.startsWith(`User-agent: ${ua}\n`)) || "");
  check(["*", "GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended"].every((ua) => /^Allow: \/$/m.test(group(ua)) && /^Disallow: \/b\/$/m.test(group(ua)) && /^Disallow: \/api\/$/m.test(group(ua))) && /^Sitemap: https:\/\/atteo\.dev\/sitemap\.xml$/m.test(robots.body), "robots.txt: public pages open to all crawlers, AI ones by name; boards and the API closed");
  check(["/", "/guide", "/support", "/llms.txt"].every((p) => sitemap.body.includes(`<loc>https://atteo.dev${p}</loc>`)), "sitemap.xml lists the public pages");
  check(support.ok && /<title>Atteo · Support<\/title>/.test(support.body) && /mailto:privacy@atteo\.dev/.test(support.body) && /href="https:\/\/atteo\.dev\/privacy"/.test(support.body) && /href="https:\/\/atteo\.dev\/terms"/.test(support.body) && /invite-only boards for people and their agents/.test(support.body) && /href="https:\/\/atteo\.dev\/support">Support<\/a>/.test(home.body), "/support is public, with the privacy contact, legal links, and a home footer link");
  check(["/docs", "/llms.txt", "/guide", "/faq", "/openapi.json", "/mcp"].every((p) => home.body.includes(`href="https://atteo.dev${p}"`) && faqPg.body.includes(`href="https://atteo.dev${p}"`)), "footer has docs, llms.txt, guide, faq, OpenAPI and the MCP URL");
  check(/id="connect"/.test(home.body) && /For directories/.test(home.body) && /mcp: https:\/\/atteo\.dev\/mcp/.test(home.body) && !/listed on Smithery/i.test(home.body), "home has connect steps and directory facts, without fake listings");
  check(llms.ok && llms.body.startsWith("# Atteo\n") && /\(https:\/\/atteo\.dev\/llms-full\.txt\)/.test(llms.body) && full.ok && /text\/plain/.test(full.type) && /PRIVACY/.test(full.body), "/llms.txt (Markdown, links the full text) and /llms-full.txt answer");
  const ldOf = (h) => { try { return JSON.parse(h.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]); } catch { return null; } };
  const ld = ldOf(home.body), fq = ldOf(faqPg.body);
  const faq = fq?.["@graph"]?.find((g) => g["@type"] === "FAQPage")?.mainEntity?.map((q) => q.name) || [];
  const shown = [...faqPg.body.matchAll(/<h2>([\s\S]*?)<\/h2>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim());
  check(["Organization", "SoftwareApplication"].every((t) => ld?.["@graph"]?.some((g) => g["@type"] === t)) && faq.length >= 3 && JSON.stringify(faq) === JSON.stringify(shown), `the JSON-LD parses, and /faq's FAQPage is its questions (${faq.length})`);
  const sha = async (s) => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))).toString("base64");
  const inline = (h) => [...h.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi)].filter((m) => !/\ssrc\s*=/i.test(m[1] || "")).map((m) => m[2]);
  for (const [p, r] of [["/", home], ["/guide", guide], ["/faq", faqPg], ["/support", support]]) {
    const scripts = inline(r.body), src = r.csp.split("; ").find((d) => d.startsWith("script-src ")) || "";
    check(!!r.csp && !r.report && /script-src-attr 'none'/.test(r.csp) && !src.includes("'unsafe-inline'"), `${p}: enforced hash CSP, no unsafe-inline scripts`);
    if (p === "/guide" || p === "/support") check(scripts.length === 0 && /script-src 'none'/.test(src), `${p}: script-src 'none'`);
    else check(scripts.length === 1 && src.includes(`'sha256-${await sha(scripts[0])}'`), `${p}: JSON-LD hash is in script-src`);
  }
}
await browser.close();
console.log(fails ? `${fails} FAILED` : "landing look: all passed");
process.exit(fails ? 1 : 0);
