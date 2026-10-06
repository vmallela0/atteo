// atteo.dev's landing page, v2 (jxn's design #5102, #5108): the mark across the whole screen, faint and unclipped, with
// dots moving along its curves (still with reduced motion); in front "atteo" (STIX), "> agent communication.", Connect
// (CLI, MCP, Claude Code, Cursor, ChatGPT, Codex, Muse, Grok Bot: picking one shows its command, with Copy) and sign in;
// then what agents do on atteo (six, each with a snippet of the app); the small links and "built by asubn", which on a
// phone sits on its own line, centred and inside the screen (#5104). No oxblood; white whatever the system theme
// (?theme=dark previews the dark pair); no sideways scroll from 320 to 1440px; /og.png is a 1200×630 PNG. Its type is
// the app's own files (/fonts/*, which the landing forwards to the app): nothing is asked of Google, and every font
// file it asks for is one the app ships (src/fonts).
// HTML pages send an enforced hash CSP (docs/security/csp.md #8): JSON-LD and the Copy script are allowed by sha256,
// /support is script-src 'none'. /guide is the app's now (its new frame, board #5110): the landing forwards it.
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
  // The page (jxn's design v2, #5102): the mark behind everything; "atteo", one line, Connect (a name per agent, its
  // command or URL, Copy) and sign in; what agents do on atteo; the links and "built by asubn".
  const r = await p.evaluate(() => {
    const cs = (sel) => { const e = document.querySelector(sel); return e ? getComputedStyle(e) : null; };
    const cherry = getComputedStyle(document.documentElement).getPropertyValue("--oxblood").trim();
    const probe = document.createElement("i"); probe.style.color = cherry; document.body.append(probe); const cherryRgb = getComputedStyle(probe).color; probe.remove();
    const uses = [...document.querySelectorAll("body *:not(svg):not(svg *)")].filter((e) => { const s = getComputedStyle(e); return e.offsetParent !== null && [s.color, s.backgroundColor, s.borderTopColor].includes(cherryRgb); }).map((e) => e.tagName.toLowerCase());
    const bg = document.querySelector("svg.bgmark"), br = bg?.getBoundingClientRect(), bs = bg && getComputedStyle(bg);
    const shown = (e) => e.offsetParent !== null || getComputedStyle(e).position === "fixed";
    const words = [...document.querySelectorAll("body *:not(svg):not(svg *):not(script)")].filter((e) => shown(e) && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())).map((e) => [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(" ").trim()).filter(Boolean);
    return {
      bg: getComputedStyle(document.body).backgroundColor, cherryRgb, uses,
      wm: cs(".hm-wm").fontFamily, wmText: document.querySelector(".hm-wm")?.textContent, tag: document.querySelector(".hm-tag")?.textContent, tagFont: cs(".hm-tag").fontFamily,
      body: getComputedStyle(document.body).fontFamily, code: cs(".h2-cmd code")?.fontFamily,
      back: bg && { cover: br.left <= 0 && br.top <= 0 && br.right >= innerWidth && br.bottom >= innerHeight, fixed: bs.position === "fixed", hidden: bg.getAttribute("aria-hidden") === "true", events: bs.pointerEvents, opacity: +bs.opacity, slice: bg.getAttribute("preserveAspectRatio"), moving: bg.querySelectorAll(".pulse animateMotion").length, clip: !!bg.querySelector("clipPath"), behind: +bs.zIndex < +getComputedStyle(document.querySelector(".h2-hero")).zIndex },
      agents: [...document.querySelectorAll(".h2-tabs [data-i]")].map((b) => b.textContent), cmd: document.querySelector(".h2-cmd code")?.textContent, copy: !!document.querySelector(".h2-cmd [data-copy]"),
      feats: [...document.querySelectorAll(".h2-f h3")].map((h) => h.textContent),
      foot: [...document.querySelectorAll(".hm-ft a")].map((a) => a.textContent), signin: document.querySelector(".h2-in")?.getAttribute("href"),
      built: (() => { const e = document.querySelector(".h2-built"), r = e?.getBoundingClientRect(), last = [...document.querySelectorAll(".hm-ft a")].pop()?.getBoundingClientRect(); return e && { text: `${e.firstElementChild?.textContent.trim()} ${e.querySelector("[role=img]")?.getAttribute("aria-label")}`, inside: r.left >= 0 && r.right <= innerWidth, below: r.top >= last.bottom - 1, centred: Math.abs((r.left + r.right) / 2 - innerWidth / 2) < 24 }; })(),
      words,
      fonts: ['"STIX Two Text"', "Onest", '"Courier Prime"'].filter((f) => !document.fonts.check(`20px ${f}`)),
      sideways: document.documentElement.scrollWidth > innerWidth,
      title: document.title,
    };
  });
  check(r.bg === BG[theme], `${tag}: the ground is ${theme === "light" ? "paper" : "ink"} (${r.bg})`);
  check(!r.uses.length, `${tag}: no oxblood on the page: it's kept for intervening (${JSON.stringify(r.uses)})`);
  check(/STIX Two Text/.test(r.wm) && r.wmText === "atteo" && r.tag === "> agent communication." && /Courier Prime/.test(r.tagFont) && /Onest/.test(r.body) && /Courier Prime/.test(r.code), `${tag}: "atteo" in STIX, its line and the commands in Courier Prime, Onest text`);
  check(!r.fonts.length, `${tag}: all three fonts loaded${r.fonts.length ? ` (missing ${r.fonts.join(", ")})` : ""}`);
  const b = r.back;
  check(b && b.cover && b.fixed && b.hidden && b.events === "none" && b.opacity >= 0.05 && b.opacity <= 0.2 && b.slice === "xMidYMid slice" && !b.clip && b.behind && b.moving === 6, `${tag}: the mark covers the screen behind everything, faint, unclipped, out of the way, with dots moving on its curves (${JSON.stringify(b)})`);
  check(JSON.stringify(r.agents) === JSON.stringify(["CLI", "MCP", "Claude Code", "Cursor", "ChatGPT", "Codex", "Muse", "Grok Bot"]) && r.cmd === "curl -fsSL https://atteo.dev/install.sh | sh" && r.copy, `${tag}: Connect offers CLI, MCP, Claude Code, Cursor, ChatGPT, Codex, Muse and Grok Bot, the CLI line first, with Copy (${r.agents.join(", ")})`);
  await p.locator('.h2-tabs [data-i="2"]').click();
  const cc = await p.locator(".h2-cmd code").textContent();
  await p.locator('.h2-tabs [data-i="5"]').click();
  const cx = await p.locator(".h2-cmd code").textContent();
  check(cc === "claude mcp add --transport http --scope user atteo https://atteo.dev/mcp" && cx === "codex mcp add atteo --url https://atteo.dev/mcp && codex mcp login atteo", `${tag}: picking an agent shows its command (Claude Code, Codex)`);
  check(JSON.stringify(r.feats) === JSON.stringify(["Ask", "Share", "Tasks", "Decisions", "Private", "Any agent"]), `${tag}: what agents do on atteo: ${r.feats.join(", ")}`);
  check(r.built && r.built.text === "built by asubn" && r.built.inside && (!phone || (r.built.below && r.built.centred)), `${tag}: "built by asubn" in the footer${phone ? ", on its own line, centred, inside the screen (jxn #5104)" : ""} (${JSON.stringify(r.built)})`);
  check(JSON.stringify(r.foot) === JSON.stringify(["guide", "faq", "docs", "privacy", "terms", "support"]) && r.signin === "https://atteo.dev/auth/login", `${tag}: sign in, and the small links: ${r.foot.join(" · ")}`);
  check(!r.sideways, `${tag}: nothing scrolls sideways`);
  check(r.title === "Atteo · A shared chat for you, your people and your agents", `${tag}: the title (for search and sharing) is unchanged`);
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
// Reduced motion: the mark stands still (no dots), the page otherwise the same.
{ const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  const p = await ctx.newPage(); await p.goto(`${BASE}/`); await p.waitForTimeout(300);
  const dots = await p.evaluate(() => getComputedStyle(document.querySelector(".bgmark .pulse")).display);
  check(dots === "none", `with reduced motion the mark stands still (${dots})`); await ctx.close(); }
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
