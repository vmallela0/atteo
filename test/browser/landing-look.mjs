// atteo.dev's landing page, v3 (landing-v3-spec.md, board #5587, with #5588, #5590 and #5623): a full first screen (on a phone, just its content) with the
// speed of delivery (atteo's bar and the slower channels', all grown in atteo's 0.485s); one statement; the install card
// (cli, mcp, claude code, cursor, codex: picking one shows its lines, the page doesn't move, copy takes the commands);
// what agents do with it, each case a thread drawn by the app's own entries (src/html.ts) in a shadow root, the
// selected case marked by a blue bar only; questions; one last Connect; the small links and "built by asubn". White
// whatever the system theme (?theme=dark previews the dark pair); no sideways scroll from 320 to 1440px; /og.png is a
// 1200×630 PNG. Its type is the app's own files (/fonts/*, forwarded to the app): nothing is asked of Google.
// HTML pages send an enforced hash CSP (docs/security/csp.md #8): JSON-LD and the page script are allowed by sha256,
// /support is script-src 'none'. It runs against the LANDING Worker, not the app:
//   npx wrangler dev -c landing/wrangler.jsonc --port 8798 --inspector-port 9237 --var APP_ORIGIN:http://127.0.0.1:8787
//   LANDING=http://localhost:8798 node test/browser/landing-look.mjs
import { chromium } from "playwright-core";
import { readFileSync, existsSync } from "node:fs";
const FONTS = new URL("../../src/fonts/", import.meta.url);
const BASE = (process.env.LANDING || process.env.BASE || "http://localhost:8811").replace(/\/$/, "");
let fails = 0;
const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const BG = { light: "rgb(255, 255, 255)", dark: "rgb(14, 14, 14)" };
const BLUE = { light: "rgb(45, 91, 255)", dark: "rgb(110, 140, 255)" };

for (const [w, theme] of [[1440, "light"], [1440, "dark"], [768, "light"], [390, "light"], [320, "light"]]) {
  const tag = `${w}px ${theme}`, phone = w < 500;
  const ctx = await browser.newContext({ viewport: { width: w, height: phone ? 844 : 800 }, isMobile: phone, hasTouch: phone });
  const p = await ctx.newPage(), errors = [], off = [], asked = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.addInitScript(() => { document.addEventListener("securitypolicyviolation", (e) => { window.__cspHits = window.__cspHits || []; window.__cspHits.push(`${e.effectiveDirective} ${e.blockedURI}`); }); });
  p.on("request", (q) => { const u = new URL(q.url()); if (u.origin !== new URL(BASE).origin) off.push(u.host); });
  await p.route(/\/fonts\/[^/?]+/, async (route) => { const f = new URL(route.request().url()).pathname.split("/").pop(); asked.push(f); const path = new URL(f, FONTS);
    if (existsSync(path)) await route.fulfill({ status: 200, contentType: "font/woff2", body: readFileSync(path) }); else await route.fulfill({ status: 404, body: "" }); });
  await p.goto(`${BASE}/?theme=${theme}`);
  await p.waitForTimeout(1000);
  await p.evaluate(() => document.fonts.ready);
  const r = await p.evaluate(() => {
    const q = (s) => document.querySelector(s), cs = (s) => q(s) && getComputedStyle(q(s));
    const host = q("#v3-thread"), root = host?.shadowRoot;
    const shown = root ? [...root.querySelectorAll(".case")].filter((c) => getComputedStyle(c).display !== "none") : [];
    const bars = [...document.querySelectorAll(".v3-list [data-case]")].map((b) => getComputedStyle(b).borderLeftColor + "|" + getComputedStyle(b).borderBottomColor);
    return {
      bg: getComputedStyle(document.body).backgroundColor,
      h1: q(".v3-hero h1")?.textContent, h1Font: cs(".v3-hero h1")?.fontFamily, heroH: q(".v3-hero")?.getBoundingClientRect().height,
      speed: [...document.querySelectorAll(".v3-speed .k")].map((e) => e.textContent), first: q(".v3-speed .n.me")?.textContent,
      barW: [...document.querySelectorAll(".v3-speed .bar")].map((b) => Math.round(b.getBoundingClientRect().width)),
      statement: q(".v3-statement mark")?.textContent,
      tabs: [...document.querySelectorAll(".v3-tabs [data-tab]")].map((b) => b.textContent), codeFont: cs(".v3-code")?.fontFamily, codeH: q(".v3-code:not([hidden])")?.getBoundingClientRect().height,
      cases: [...document.querySelectorAll(".v3-list b")].map((b) => b.textContent), caseFont: cs(".v3-list b")?.fontFamily, bars,
      entries: shown.length === 1 ? shown[0].querySelectorAll("article.entry").length : -1, agentEntries: shown[0]?.querySelectorAll("article.entry.by-agent").length ?? 0,
      tint: getComputedStyle(q(".v3-cases").closest("section")).backgroundColor,
      questions: [...document.querySelectorAll(".v3-qa summary")].map((s) => s.textContent), firstOpen: q(".v3-qa details")?.open,
      foot: [...document.querySelectorAll(".v3-ft a")].map((a) => a.textContent), signin: q(".v3-in")?.getAttribute("href"), pill: q(".v3-pill")?.getAttribute("href"),
      fonts: ['"STIX Two Text"', "Onest", '"Courier Prime"'].filter((f) => !document.fonts.check(`20px ${f}`)),
      sideways: document.documentElement.scrollWidth > innerWidth, title: document.title, body: getComputedStyle(document.body).fontFamily,
    };
  });
  check(r.bg === BG[theme], `${tag}: the ground is ${theme === "light" ? "paper" : "ink"} (${r.bg})`);
  check(r.h1 === "The fastest channel for agent communication." && /STIX Two Text/.test(r.h1Font) && /Onest/.test(r.body) && /Courier Prime/.test(r.codeFont), `${tag}: the headline in STIX, text in Onest, code in Courier Prime`);
  check(phone ? r.heroH < 700 : r.heroH >= 719, `${tag}: ${phone ? "on a phone the hero is as tall as its content (jxn #5623)" : "the hero is a full first screen"} (${r.heroH}px)`);
  check(JSON.stringify(r.speed) === JSON.stringify(["atteo", "github issue", "synced folder", "email", "through you and them"]) && r.first === "0.485s" && r.barW.every((x, i) => i === 0 || x < r.barW[i - 1]), `${tag}: the speed bars, atteo first at 0.485s, each slower one shorter (${r.barW.join(", ")})`);
  check(r.statement === "in under a second", `${tag}: the statement marks "in under a second"`);
  check(JSON.stringify(r.tabs) === JSON.stringify(["cli", "mcp", "claude code", "cursor", "codex"]) && Math.round(r.codeH) === 200, `${tag}: the install card's tabs, its body 200px tall (${r.codeH})`);
  const top = await p.evaluate(() => document.querySelector(".v3-guide").getBoundingClientRect().top + scrollY);
  await p.locator('.v3-tabs [data-tab="2"]').click();
  const after = await p.evaluate(() => ({ top: document.querySelector(".v3-guide").getBoundingClientRect().top + scrollY, copy: document.querySelector(".v3-tabs .copy").dataset.copy, guide: document.querySelector(".v3-guide").textContent }));
  check(after.top === top && after.copy === "claude mcp add --transport http --scope user atteo https://atteo.dev/mcp" && after.guide === "Full claude code setup guide →", `${tag}: switching tabs doesn't move the page; copy takes the commands only`);
  check(JSON.stringify(r.cases) === JSON.stringify(["Unblock a teammate", "Hand off a task", "Review before merge", "Plan a dinner", "Swap a shift"]) && /STIX Two Text/.test(r.caseFont), `${tag}: the five use cases`);
  check(r.entries === 4 && r.agentEntries >= 2, `${tag}: one case shows at a time, as the app's own entries (${r.entries}, ${r.agentEntries} by agents)`);
  const blue = r.bars.filter((b) => b.includes(BLUE[theme])).length;
  check(blue === 1 && /rgba\(0, 0, 0, 0\)|transparent/.test(r.tint), `${tag}: the section is neutral; only the selected case has the blue bar (${r.bars.join(" / ")})`);
  await p.locator('.v3-list [data-case="3"]').click();
  const picked = await p.evaluate(() => { const root = document.getElementById("v3-thread").shadowRoot; return [...root.querySelectorAll(".case")].findIndex((c) => getComputedStyle(c).display !== "none"); });
  check(picked === 3, `${tag}: picking a case shows its thread (${picked})`);
  check(r.questions.length === 7 && r.questions.includes("How much does it cost?") && r.firstOpen === true, `${tag}: seven questions (pricing among them), the first open`);
  check(JSON.stringify(r.foot.slice(0, 7)) === JSON.stringify(["guide", "faq", "developers", "docs", "privacy", "terms", "support"]) && r.foot.includes("asubn") && r.signin === "https://atteo.dev/auth/login" && r.pill === "#connect", `${tag}: sign in, Connect your agent, and the small links: ${r.foot.join(" · ")}`);
  check(!r.sideways, `${tag}: nothing scrolls sideways`);
  check(r.title === "atteo · agent communication.", `${tag}: the title (tab, search and link previews) is "atteo · agent communication." (jxn #5162)`);
  check(!r.fonts.length && !off.length && asked.length >= 3 && asked.every((f) => existsSync(new URL(f, FONTS))), `${tag}: fonts come from /fonts/ (${[...new Set(asked)].join(", ")}), nothing off-site${off.length ? ` (${[...new Set(off)].join(", ")})` : ""}`);
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
// Reduced motion: the speed bars stand at their lengths, no growing.
{ const ctx = await browser.newContext({ viewport: { width: 1440, height: 800 }, reducedMotion: "reduce" });
  const p = await ctx.newPage(); await p.goto(`${BASE}/`);
  const anim = await p.evaluate(() => getComputedStyle(document.querySelector(".v3-speed .bar")).animationName);
  check(anim === "none", `with reduced motion the bars don't grow (${anim})`); await ctx.close(); }
check(og.ok && og.headers.get("content-type") === "image/png" && buf.readUInt32BE(16) === 1200 && buf.readUInt32BE(20) === 630, `/og.png is a 1200×630 PNG (${buf.readUInt32BE(16)}×${buf.readUInt32BE(20)})`);
// Found by search and answer engines (vedu #3151, task #3152): robots lets the AI crawlers read the public pages but
// not the app's; the sitemap lists the public pages; /llms.txt and /llms-full.txt answer;
// and the JSON-LD parses: the home page says what Atteo is, and /faq's FAQPage data is its own questions.
{ const txt = async (p) => { const r = await fetch(`${BASE}${p}`); return { ok: r.ok, type: r.headers.get("content-type") || "", csp: r.headers.get("content-security-policy") || "", report: r.headers.get("content-security-policy-report-only") || "", body: await r.text() }; };
  const [robots, sitemap, llms, full, home, faqPg, guide, support] = await Promise.all(["/robots.txt", "/sitemap.xml", "/llms.txt", "/llms-full.txt", "/", "/faq", "/guide", "/support"].map(txt));
  const group = (ua) => (robots.body.split(/\n\s*\n/).find((g) => g.startsWith(`User-agent: ${ua}\n`)) || "");
  check(["*", "GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended"].every((ua) => /^Allow: \/$/m.test(group(ua)) && /^Disallow: \/b\/$/m.test(group(ua)) && /^Disallow: \/api\/$/m.test(group(ua))) && /^Sitemap: https:\/\/atteo\.dev\/sitemap\.xml$/m.test(robots.body), "robots.txt: public pages open to all crawlers, AI ones by name; boards and the API closed");
  check(["/", "/guide", "/support", "/llms.txt"].every((p) => sitemap.body.includes(`<loc>https://atteo.dev${p}</loc>`)), "sitemap.xml lists the public pages");
  check(support.ok && /<title>Atteo · Support<\/title>/.test(support.body) && /mailto:privacy@atteo\.dev/.test(support.body) && /href="https:\/\/atteo\.dev\/privacy"/.test(support.body) && /href="https:\/\/atteo\.dev\/terms"/.test(support.body) && /invite-only boards for people and their agents/.test(support.body) && /href="https:\/\/atteo\.dev\/support">support<\/a>/i.test(home.body), "/support is public, with the privacy contact, legal links, and a home footer link");
  check(["/docs", "/llms.txt", "/guide", "/faq"].every((p) => home.body.includes(`href="https://atteo.dev${p}"`)) && ["/docs", "/guide", "/faq", "/support", "/llms.txt"].every((p) => faqPg.body.includes(`href="https://atteo.dev${p}"`)), "home and /faq link docs, guide, faq and llms.txt (/faq in its top bar, #5110)");
  check(/claude mcp add --transport http --scope user atteo https:\/\/atteo\.dev\/mcp/.test(home.body) && /MCP server \(streamable HTTP, OAuth sign-in\): https:\/\/atteo\.dev\/mcp/.test(llms.body) && !/listed on Smithery/i.test(home.body), "home has the connect lines; directories read the MCP endpoint from /llms.txt; no fake listings");
  check(llms.ok && llms.body.startsWith("# Atteo\n") && /\(https:\/\/atteo\.dev\/llms-full\.txt\)/.test(llms.body) && full.ok && /text\/plain/.test(full.type) && /PRIVACY/.test(full.body), "/llms.txt (Markdown, links the full text) and /llms-full.txt answer");
  const ldOf = (h) => { try { return JSON.parse(h.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]); } catch { return null; } };
  const ld = ldOf(home.body), fq = ldOf(faqPg.body);
  const faq = fq?.["@graph"]?.find((g) => g["@type"] === "FAQPage")?.mainEntity?.map((q) => q.name) || [];
  const shown = [...faqPg.body.matchAll(/<summary><span>([\s\S]*?)<\/span>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim());
  check(["Organization", "SoftwareApplication"].every((t) => ld?.["@graph"]?.some((g) => g["@type"] === t)) && faq.length >= 3 && JSON.stringify([...faq].sort()) === JSON.stringify([...shown].sort()), `the JSON-LD parses, and /faq's FAQPage is its questions (${faq.length}; the page groups them, #5110)`);
  const sha = async (s) => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))).toString("base64");
  const inline = (h) => [...h.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi)].filter((m) => !/\ssrc\s*=/i.test(m[1] || "")).map((m) => m[2]);
  for (const [p, r] of [["/", home], ["/faq", faqPg], ["/support", support]]) {
    const scripts = inline(r.body), src = r.csp.split("; ").find((d) => d.startsWith("script-src ")) || "";
    check(!!r.csp && !r.report && /script-src-attr 'none'/.test(r.csp) && !src.includes("'unsafe-inline'"), `${p}: enforced hash CSP, no unsafe-inline scripts`);
    if (p === "/support") check(scripts.length === 0 && /script-src 'none'/.test(src), `${p}: script-src 'none'`);
    else { const want = p === "/" ? 2 : 1; const hashed = (await Promise.all(scripts.map(sha))).every((h) => src.includes(`'sha256-${h}'`));
      check(scripts.length === want && hashed, `${p}: ${want === 2 ? "JSON-LD and the Copy script" : "JSON-LD"} hashed in script-src (${scripts.length})`); }
  }
}
await browser.close();
console.log(fails ? `${fails} FAILED` : "landing look: all passed");
process.exit(fails ? 1 : 0);
