// atteo.dev's landing Worker: jxn's page at / (signed out) and /landing (#5958, #5972), /og.png a 1200×630 PNG, robots,
// sitemap, /llms.txt, JSON-LD, and jxn's /developers, /faq, /support, /privacy and /terms (#5977): each unpacks with no
// errors and nothing off-site, its contents above the text on a phone. It runs against the LANDING Worker, not the app:
//   npx wrangler dev -c landing/wrangler.jsonc --port 8798 --inspector-port 9237 --var APP_ORIGIN:http://127.0.0.1:8787
//   LANDING=http://localhost:8798 node test/browser/landing-look.mjs
import { chromium } from "playwright-core";
const BASE = (process.env.LANDING || process.env.BASE || "http://localhost:8811").replace(/\/$/, "");
let fails = 0;
const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const BG = { light: "rgb(255, 255, 255)", dark: "rgb(14, 14, 14)" };

// jxn's page (#5958, #5972) at / (signed out) and /landing: his Claude Design export, unpacked by its own script under its
// own CSP. It must unpack with no page errors or CSP violations, ask nothing of another site (its agent favicons come
// from /landing/icons), and not scroll sideways on a phone.
for (const [path, w] of [["/", 1440], ["/", 390], ["/", 440], ["/landing", 1440]]) {
  const tag = `${path} ${w}px`, phone = w < 500;
  const ctx = await browser.newContext({ viewport: { width: w, height: phone ? 844 : 800 }, isMobile: phone, hasTouch: phone });
  const p = await ctx.newPage(), errors = [], off = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.addInitScript(() => { document.addEventListener("securitypolicyviolation", (e) => { window.__cspHits = window.__cspHits || []; window.__cspHits.push(`${e.effectiveDirective} ${e.blockedURI}`); }); });
  p.on("request", (q) => { const u = new URL(q.url()); if (/^https?:$/.test(u.protocol) && u.origin !== new URL(BASE).origin) off.push(u.host); });
  await p.goto(`${BASE}${path}`);
  await p.waitForTimeout(1500);
  const r = await p.evaluate(() => ({
    text: document.body.innerText.length, sideways: document.documentElement.scrollWidth > innerWidth + 1,
    icons: [...document.querySelectorAll("img")].map((i) => i.getAttribute("src") || "").filter((s) => s.includes("/icons/")),
    signin: [...document.querySelectorAll("a")].find((a) => /sign in/i.test(a.textContent))?.getAttribute("href"),
  }));
  check(r.text > 200 && r.signin === "https://atteo.dev/auth/login", `${tag}: the page unpacks (${r.text} characters), with sign in`);
  check(r.icons.length >= 7 && r.icons.every((s) => s.startsWith("/landing/icons/")), `${tag}: the agent favicons come from /landing/icons (${r.icons.length})`);
  check(!off.length, `${tag}: nothing asked of another site${off.length ? ` (${[...new Set(off)].join(", ")})` : ""}`);
  check(!r.sideways, `${tag}: nothing scrolls sideways`);
  if (phone) {
    // Its phone layout (#6031, #6074, jxn's v2 #6139): the headline fits, his network's icons stay off the text, the
    // install command is one line with copy and cli beside it, and the demo's three panels stack.
    const m = await p.evaluate(() => {
      const box = (e) => e.getBoundingClientRect(), hub = box(document.querySelector("[data-hub]"));
      const text = [...document.querySelectorAll("[data-hub] h1, [data-hub] p")].map(box);
      const over = [...document.querySelectorAll("[data-node]")].filter((n) => { const b = box(n); return getComputedStyle(n).visibility === "visible" && +getComputedStyle(n).opacity > 0.5 && text.some((t) => b.right > t.left && b.left < t.right && b.bottom > t.top && b.top < t.bottom); });
      const [a, b, c] = ["a", "b", "c"].map((t) => box(document.querySelector(`[data-term="${t}"]`)));
      const row = document.querySelector("[data-hub] div:has(> button[aria-haspopup])"), cli = box(row.querySelector(":scope > button[aria-haspopup]")), cmd = box(row.querySelector(":scope > div"));
      return { h1: box(document.querySelector("[data-hub] h1")).right <= innerWidth, over: over.length, stacked: a.bottom < b.top && b.bottom < c.top && c.height > 200,
        oneLine: Math.abs(cli.top - cmd.top) < 4 && cli.right <= innerWidth && hub.right <= innerWidth,
        rows: (() => { const ns = [...document.querySelectorAll("[data-net] [data-node]")].map(box), bg = document.querySelector("svg[data-bgweb]");
          return ns.length === 14 && ns.slice(0, 7).every((n) => n.bottom < hub.top) && ns.slice(7).every((n) => n.top > hub.bottom) && (!bg || getComputedStyle(bg).display === "none"); })() };
    });
    // jxn #6165: on a phone it's the rows, not the desktop web: 7 agents above the text, 7 below, no web behind the page.
    check(m.rows, `${tag}: the network is a row of 7 above the text and 7 below, with no web behind the page`);
    check(m.h1 && !m.over, `${tag}: the headline fits and no network icon covers the text (${m.over} over it)`);
    check(m.oneLine, `${tag}: the install command is one line, with copy and cli beside it`);
    check(m.stacked, `${tag}: the demo panels stack`);
  }
  check(!errors.length, `${tag}: no page errors${errors.length ? ` (${errors[0]})` : ""}`);
  const cspHits = await p.evaluate(() => window.__cspHits || []);
  check(!cspHits.length, `${tag}: no CSP violations${cspHits.length ? ` (${cspHits.join("; ")})` : ""}`);
  if (process.env.SHOTS) await p.screenshot({ path: `${process.env.SHOTS}/landing-${path === "/" ? "home" : "landing"}-${w}.png` }).catch(() => {});
  await ctx.close();
}
const og = await fetch(`${BASE}/og.png`);
const buf = Buffer.from(await og.arrayBuffer());
check(og.ok && og.headers.get("content-type") === "image/png" && buf.readUInt32BE(16) === 1200 && buf.readUInt32BE(20) === 630, `/og.png is a 1200×630 PNG (${buf.readUInt32BE(16)}×${buf.readUInt32BE(20)})`);
// Found by search and answer engines (vedu #3151, task #3152): robots lets the AI crawlers read the public pages but
// not the app's; the sitemap lists the public pages; /llms.txt and /llms-full.txt answer;
// and the JSON-LD parses: the home page says what Atteo is, and /faq's FAQPage data is its own questions.
{ const txt = async (p) => { const r = await fetch(`${BASE}${p}`); return { ok: r.ok, type: r.headers.get("content-type") || "", csp: r.headers.get("content-security-policy") || "", report: r.headers.get("content-security-policy-report-only") || "", body: await r.text() }; };
  const [robots, sitemap, llms, full, home, faqPg, guide, support] = await Promise.all(["/robots.txt", "/sitemap.xml", "/llms.txt", "/llms-full.txt", "/", "/faq", "/guide", "/support"].map(txt));
  // jxn's pages are plain HTML (#6003); a policy may name atteo.dev for the sign-in form, and no other site.
  const offsite = (csp) => !!csp.replace("form-action 'self' https://atteo.dev", "").match(/https?:/);
  const group = (ua) => (robots.body.split(/\n\s*\n/).find((g) => g.startsWith(`User-agent: ${ua}\n`)) || "");
  check(["*", "GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended"].every((ua) => /^Allow: \/$/m.test(group(ua)) && /^Disallow: \/b\/$/m.test(group(ua)) && /^Disallow: \/api\/$/m.test(group(ua))) && /^Sitemap: https:\/\/atteo\.dev\/sitemap\.xml$/m.test(robots.body), "robots.txt: public pages open to all crawlers, AI ones by name; boards and the API closed");
  check(["/", "/guide", "/support", "/llms.txt"].every((p) => sitemap.body.includes(`<loc>https://atteo.dev${p}</loc>`)), "sitemap.xml lists the public pages");
  check(support.ok && /<link rel="canonical" href="https:\/\/atteo\.dev\/support">/.test(support.body) && /href="mailto:privacy@atteo\.dev"/.test(support.body) && ["/privacy", "/terms"].every((p) => support.body.includes(`href="${p}"`)), "/support is public, with the privacy contact and legal links");
  check(["/developers", "/faq", "/support", "/privacy", "/terms"].every((p) => faqPg.body.includes(`href="${p}"`)) && faqPg.body.includes('href="https://atteo.dev/llms.txt"'), "/faq links the other pages by path, and llms.txt from its head");
  check(/MCP server \(streamable HTTP, OAuth sign-in\): https:\/\/atteo\.dev\/mcp/.test(llms.body), "directories read the MCP endpoint from /llms.txt");
  check(/<link rel="canonical" href="https:\/\/atteo\.dev\/">/.test(home.body) && /<meta property="og:image" content="https:\/\/atteo\.dev\/og\.png\?v=\d+">/.test(home.body) && !offsite(home.csp) && /script-src 'self' 'unsafe-eval' /.test(home.csp) && /default-src 'none'/.test(home.csp) && /frame-ancestors 'none'/.test(home.csp), "/ (jxn's page) keeps the canonical and share card; its CSP names no other site");
  check(llms.ok && llms.body.startsWith("# Atteo\n") && /\(https:\/\/atteo\.dev\/llms-full\.txt\)/.test(llms.body) && full.ok && /text\/plain/.test(full.type) && /PRIVACY/.test(full.body), "/llms.txt (Markdown, links the full text) and /llms-full.txt answer");
  const ldOf = (h) => { try { return JSON.parse(h.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]); } catch { return null; } };
  const ld = ldOf(home.body), fq = ldOf(faqPg.body);
  const faq = fq?.["@graph"]?.find((g) => g["@type"] === "FAQPage")?.mainEntity?.map((q) => q.name) || [];
  const shown = [...faqPg.body.matchAll(/<summary[^>]*>([\s\S]*?)<\/summary>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim().replace(/\s*\+$/, ""));
  check(["Organization", "SoftwareApplication"].every((t) => ld?.["@graph"]?.some((g) => g["@type"] === t)) && faq.length >= 3 && JSON.stringify([...faq].sort()) === JSON.stringify([...shown].sort()), `the JSON-LD parses, and /faq's FAQPage is its questions (${faq.length}; the page groups them, #5110)`);
  for (const [p, r] of [["/faq", faqPg], ["/support", support]])
    check(!!r.csp && !r.report && !offsite(r.csp) && /default-src 'none'/.test(r.csp) && /script-src-attr 'none'/.test(r.csp) && /frame-ancestors 'none'/.test(r.csp) && !/'unsafe-/.test(r.csp.split("; ").find((d) => d.startsWith("script-src "))), `${p}: enforced hash CSP that names no other site, nothing evaluated`);
}
// jxn's pages in a browser: each unpacks to its own page, with no errors (the favicon is the app's, so not here) and no
// request off atteo.dev; on a phone the "contents" column sits above the text instead of beside it (#5995).
for (const [path, h1] of [["/developers", "developer docs"], ["/faq", "frequently asked questions"], ["/support", "support"], ["/privacy", "privacy"], ["/terms", "terms of service"]]) {
  for (const width of [1440, 390]) {
    const p = await browser.newPage({ viewport: { width, height: 900 } });
    const errs = [], offsite = [];
    p.on("pageerror", (e) => errs.push(String(e)));
    p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
    p.on("requestfailed", (r) => { if (!r.url().endsWith("/favicon.ico")) errs.push(`failed ${r.url()}`); });
    p.on("request", (r) => { if (/^https?:/.test(r.url()) && !r.url().startsWith(BASE)) offsite.push(r.url()); });
    await p.goto(BASE + path, { waitUntil: "networkidle" });
    const got = await p.evaluate(() => {
      const nav = document.querySelector('nav[aria-label="contents"]'), main = document.querySelector("h2");
      return { h1: [...document.querySelectorAll("h1")].filter((e) => e.offsetParent).map((e) => e.textContent.trim()), title: document.title,
        above: nav && main ? nav.getBoundingClientRect().bottom <= main.getBoundingClientRect().top : null };
    });
    check(got.h1.length === 1 && got.h1[0] === h1 && got.title === `atteo · ${h1}` && !errs.length && !offsite.length && (width > 720 || got.above !== false),
      `${path} at ${width}: "${got.h1}", title "${got.title}"${width <= 720 && got.above !== null ? `, contents ${got.above ? "above" : "beside"} the text` : ""}${errs.length ? `, errors: ${errs[0]}` : ""}${offsite.length ? `, off-site: ${offsite[0]}` : ""}`);
    await p.close();
  }
}
await browser.close();
console.log(fails ? `${fails} FAILED` : "landing look: all passed");
process.exit(fails ? 1 : 0);
