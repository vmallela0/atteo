// atteo.dev's landing Worker: jxn's page at / (signed out) and /landing (#5958, #5972), /og.png a 1200×630 PNG, robots,
// sitemap, /llms.txt, JSON-LD, and /faq and /support with their links.
// /faq and /support send an enforced hash CSP (docs/security/csp.md #8): JSON-LD is allowed by sha256,
// /support is script-src 'none'. It runs against the LANDING Worker, not the app:
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
for (const [path, w] of [["/", 1440], ["/", 390], ["/landing", 1440]]) {
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
  const group = (ua) => (robots.body.split(/\n\s*\n/).find((g) => g.startsWith(`User-agent: ${ua}\n`)) || "");
  check(["*", "GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended"].every((ua) => /^Allow: \/$/m.test(group(ua)) && /^Disallow: \/b\/$/m.test(group(ua)) && /^Disallow: \/api\/$/m.test(group(ua))) && /^Sitemap: https:\/\/atteo\.dev\/sitemap\.xml$/m.test(robots.body), "robots.txt: public pages open to all crawlers, AI ones by name; boards and the API closed");
  check(["/", "/guide", "/support", "/llms.txt"].every((p) => sitemap.body.includes(`<loc>https://atteo.dev${p}</loc>`)), "sitemap.xml lists the public pages");
  check(support.ok && /<title>Atteo · Support<\/title>/.test(support.body) && /mailto:privacy@atteo\.dev/.test(support.body) && /href="https:\/\/atteo\.dev\/privacy"/.test(support.body) && /href="https:\/\/atteo\.dev\/terms"/.test(support.body) && /invite-only boards for people and their agents/.test(support.body), "/support is public, with the privacy contact and legal links");
  check(["/docs", "/guide", "/faq", "/support", "/llms.txt"].every((p) => faqPg.body.includes(`href="https://atteo.dev${p}"`)), "/faq links docs, guide, faq, support and llms.txt (its top bar, #5110)");
  check(/MCP server \(streamable HTTP, OAuth sign-in\): https:\/\/atteo\.dev\/mcp/.test(llms.body), "directories read the MCP endpoint from /llms.txt");
  check(/<link rel="canonical" href="https:\/\/atteo\.dev\/">/.test(home.body) && /<meta property="og:image" content="https:\/\/atteo\.dev\/og\.png\?v=2">/.test(home.body) && !/https?:/.test(home.csp) && /default-src 'none'/.test(home.csp) && /frame-ancestors 'none'/.test(home.csp), "/ (jxn's page) keeps the canonical and share card; its CSP names no other site");
  check(llms.ok && llms.body.startsWith("# Atteo\n") && /\(https:\/\/atteo\.dev\/llms-full\.txt\)/.test(llms.body) && full.ok && /text\/plain/.test(full.type) && /PRIVACY/.test(full.body), "/llms.txt (Markdown, links the full text) and /llms-full.txt answer");
  const ldOf = (h) => { try { return JSON.parse(h.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]); } catch { return null; } };
  const ld = ldOf(home.body), fq = ldOf(faqPg.body);
  const faq = fq?.["@graph"]?.find((g) => g["@type"] === "FAQPage")?.mainEntity?.map((q) => q.name) || [];
  const shown = [...faqPg.body.matchAll(/<summary><span>([\s\S]*?)<\/span>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim());
  check(["Organization", "SoftwareApplication"].every((t) => ld?.["@graph"]?.some((g) => g["@type"] === t)) && faq.length >= 3 && JSON.stringify([...faq].sort()) === JSON.stringify([...shown].sort()), `the JSON-LD parses, and /faq's FAQPage is its questions (${faq.length}; the page groups them, #5110)`);
  const sha = async (s) => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))).toString("base64");
  const inline = (h) => [...h.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi)].filter((m) => !/\ssrc\s*=/i.test(m[1] || "")).map((m) => m[2]);
  for (const [p, r] of [["/faq", faqPg], ["/support", support]]) {
    const scripts = inline(r.body), src = r.csp.split("; ").find((d) => d.startsWith("script-src ")) || "";
    check(!!r.csp && !r.report && /script-src-attr 'none'/.test(r.csp) && !src.includes("'unsafe-inline'"), `${p}: enforced hash CSP, no unsafe-inline scripts`);
    if (p === "/support") check(scripts.length === 0 && /script-src 'none'/.test(src), `${p}: script-src 'none'`);
    else { const hashed = (await Promise.all(scripts.map(sha))).every((h) => src.includes(`'sha256-${h}'`));
      check(scripts.length === 1 && hashed, `${p}: JSON-LD hashed in script-src (${scripts.length})`); }
  }
}
await browser.close();
console.log(fails ? `${fails} FAILED` : "landing look: all passed");
process.exit(fails ? 1 : 0);
