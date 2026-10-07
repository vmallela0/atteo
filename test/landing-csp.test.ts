import { describe, expect, it } from "vitest";
import { CSP_ENFORCE } from "../src/ui";
import { beaconSnippet, cspHash, inlineScripts, landingCsp } from "../landing/src/csp";
import worker from "../landing/src/index";
// @ts-expect-error: a plain .mjs script, no types
import { build } from "../landing/jxn-pages/build.mjs";
import JXN_DEVELOPERS from "../landing/jxn-pages/developers.html";
import JXN_FAQ from "../landing/jxn-pages/faq.html";
import JXN_PRIVACY from "../landing/jxn-pages/privacy.html";
import JXN_SUPPORT from "../landing/jxn-pages/support.html";
import JXN_TERMS from "../landing/jxn-pages/terms.html";

const env = { APP_ORIGIN: "http://127.0.0.1:9" };
const FORM = "https://atteo.dev";

async function page(path: string, extra: HeadersInit = {}) {
  return worker.fetch(new Request(`http://localhost${path}`, { headers: extra }), env);
}

describe("landing Worker CSP (docs/security/csp.md #8)", () => {
  it("keeps its own enforced policy, whatever the app's CSP_ENFORCE is", async () => {
    expect(CSP_ENFORCE).toBe(true); // the app enforces too now (vedu #5192)
    const res = await page("/faq");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("content-security-policy-report-only")).toBeNull();
  });

  it("hashes inline scripts and uses 'none' when there are none", async () => {
    const body = `<script type="application/ld+json">{"@type":"WebSite"}</script>`;
    const hash = await cspHash('{"@type":"WebSite"}');
    const csp = await landingCsp(body, FORM);
    expect(inlineScripts(body)).toEqual(['{"@type":"WebSite"}']);
    expect(csp.split("; ").find((d) => d.startsWith("script-src ")) ?? "").toContain(hash);
    expect(csp.split("; ").find((d) => d.startsWith("script-src ")) ?? "").not.toContain("'unsafe-inline'");
    expect(await landingCsp("<p>no scripts</p>", FORM)).toContain("script-src 'none'");
    expect(inlineScripts(`<script src="/x.js"></script>`)).toEqual([]);
    expect(await landingCsp("<p>x</p>", "https://evil.example; script-src *")).toContain("form-action 'self'");
    expect(await landingCsp("<p>x</p>", "https://evil.example; script-src *")).not.toContain("evil");
  });

  it("sends an enforced hash policy on /landing/startup (/guide is the app's now, #5110)", async () => {
    for (const path of ["/landing/startup"]) {
      const res = await page(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      expect(res.headers.get("content-security-policy-report-only")).toBeNull();
      const csp = res.headers.get("content-security-policy") ?? "";
      const html = await res.text();
      expect(csp).toBe(await landingCsp(html, FORM));
      expect(csp).toContain("script-src-attr 'none'");
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("connect-src 'none'");
      expect(csp).toContain(`form-action 'self' ${FORM}`);
      expect(csp).toContain("report-uri /api/csp-report");
      expect(res.headers.get("reporting-endpoints")).toBe('csp="/api/csp-report"');
      expect(res.headers.get("cache-control")).toBe("public, max-age=300");
      expect(csp.split("; ").find((d) => d.startsWith("script-src ")) ?? "").not.toContain("'unsafe-inline'");
      expect(html).not.toMatch(/\son[a-z]+\s*=/i);
      expect(html).not.toMatch(/\b(?:href|src)\s*=\s*["']javascript:/i);
      expect(inlineScripts(html)).toEqual([]); // no scripts at all
      expect(csp).toContain("script-src 'none'");
    }
  });

  it("serves jxn's page at / signed out (#5972) and at /landing (#5958) with nothing loaded from outside atteo.dev, and keeps it out of the sitemap", async () => {
    for (const [path, cookie] of [["/", ""], ["/landing", ""], ["/landing", "ab_session=abc"]] as const) {
      const res = await page(path, cookie ? { cookie } : {});
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      const csp = res.headers.get("content-security-policy") ?? "";
      for (const d of ["default-src 'none'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'", "img-src 'self' data: blob:"]) expect(csp).toContain(d);
      expect(csp).not.toMatch(/https?:/);
      const html = await res.text();
      expect(html).toContain("/landing/icons/");
      expect(html).not.toContain("google.com/s2");
      // The share card, canonical and JSON-LD the old home page had, once, after the charset.
      expect(html.indexOf("<title>")).toBeGreaterThan(html.indexOf("og:image")); // ours stops before its title
      for (const tag of ['<link rel="canonical" href="https://atteo.dev/">', '<meta property="og:image" content="https://atteo.dev/og.png?v=2">', '<meta name="twitter:card" content="summary_large_image">', '"@graph"']) expect(html).toContain(tag);
    }
    expect(await (await page("/sitemap.xml")).text()).not.toContain("/landing");
  });

  it("serves jxn's /developers, /faq, /support, /privacy and /terms (#5977) signed in or not, each with its own head tags, linking to each other by path", async () => {
    for (const [path, title] of [["/developers", "Atteo · Developer docs"], ["/faq", "Atteo · Frequently asked questions"], ["/support", "Atteo · Support"], ["/privacy", "Atteo · Privacy"], ["/terms", "Atteo · Terms of Service"]] as const) {
      for (const cookie of ["", "ab_session=abc"]) {
        const res = await page(path, cookie ? { cookie } : {});
        expect(res.status, path).toBe(200);
        const csp = res.headers.get("content-security-policy") ?? "";
        for (const d of ["default-src 'none'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'"]) expect(csp).toContain(d);
        expect(csp).not.toMatch(/https?:/);
        const html = await res.text();
        for (const tag of [`<link rel="canonical" href="https://atteo.dev${path}">`, `<meta property="og:title" content="${title}">`, '<meta property="og:image" content="https://atteo.dev/og.png?v=2">']) expect(html, path).toContain(tag);
        expect(html.indexOf("<title>")).toBeGreaterThan(html.indexOf("og:image")); // its own title stays the only one
        for (const p of ["developers", "faq", "support", "privacy", "terms"]) expect(html, path).toContain(`href=\\"/${p}\\"`);
        expect(html).not.toMatch(/href=\\"[a-z]+\.html\\"/);
      }
    }
    // The FAQ keeps its FAQPage data: the questions are the same as before.
    const faq = await (await page("/faq")).text();
    expect(JSON.parse(inlineScripts(faq).find((s) => s.includes("FAQPage"))!)["@graph"][0].mainEntity).toHaveLength(9);
  });

  it("serves jxn's pages as landing/jxn-pages/build.mjs makes them from today's code: the app's privacy policy, every MCP tool and CLI command (jxn #5998)", async () => {
    for (const [page, file] of Object.entries({ developers: JXN_DEVELOPERS, faq: JXN_FAQ, support: JXN_SUPPORT, privacy: JXN_PRIVACY, terms: JXN_TERMS }))
      expect(build(file).out === file, `${page}.html is stale: run node landing/jxn-pages/build.mjs`).toBe(true);
    const t = (html: string) => JSON.parse(/<script type="__bundler\/template">([\s\S]*?)<\/script>/.exec(html)![1]!) as string;
    const privacy = t(await (await page("/privacy")).text());
    const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const shown = text(privacy.slice(privacy.indexOf('<sc-if value="{{ is_privacy }}"'), privacy.indexOf('<sc-if value="{{ is_terms }}"')));
    for (const line of ["Atteo staff don't look at what's on your boards", "end-to-end encrypted", "We'll send the current list of these providers on request", "Last updated October 6, 2026"]) expect(shown).toContain(line);
    for (const vendor of ["WorkOS", "Resend", "Sentry", "PostHog", "Stripe", "Backblaze"]) expect(shown).not.toContain(vendor); // by category (vedu #5410/#5412)
  });

  it("loads Cloudflare Web Analytics on the signed-out home page only when a token is set", async () => {
    expect(beaconSnippet(undefined)).toBe("");
    const tokenEnv = { ...env, CF_WEB_ANALYTICS_TOKEN: "abcdef0123456789" };
    const home = await worker.fetch(new Request("http://localhost/"), tokenEnv);
    const html = await home.text();
    const csp = home.headers.get("content-security-policy") ?? "";
    expect(html).toContain("https://static.cloudflareinsights.com/beacon.min.js");
    expect(csp).toContain("script-src https://static.cloudflareinsights.com ");
    expect(csp).toContain("connect-src https://cloudflareinsights.com ");
    const landing = await worker.fetch(new Request("http://localhost/landing"), tokenEnv);
    expect(await landing.text()).not.toContain("cloudflareinsights");
    const faq = await worker.fetch(new Request("http://localhost/faq"), tokenEnv);
    expect(await faq.text()).not.toContain("cloudflareinsights");
    expect(faq.headers.get("content-security-policy")).not.toContain("cloudflareinsights");
  });

  it("serves a public /support page with the privacy contact, legal links, and its own title", async () => {
    const signedIn = await page("/support", { cookie: "ab_session=present" });
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers.get("content-type")).toMatch(/text\/html/);
    const html = await signedIn.text();
    expect(html).toContain('meta name="description" content="How to get help with Atteo, invite-only boards for people and their agents. Email privacy@atteo.dev."');
    expect(html).toContain('<link rel="canonical" href="https://atteo.dev/support">');
    expect(html).toContain('href=\\"mailto:privacy@atteo.dev\\"');
    const sitemap = await (await page("/sitemap.xml")).text();
    expect(sitemap).toContain("<loc>https://atteo.dev/support</loc>");
  });

  it("does not put CSP on the non-HTML files", async () => {
    const robots = await page("/robots.txt");
    expect(robots.headers.get("content-security-policy")).toBeNull();
    expect(robots.headers.get("content-security-policy-report-only")).toBeNull();
    expect(await robots.text()).toContain("Sitemap: https://atteo.dev/sitemap.xml");
  });
});

describe("landing public connect and directory links", () => {
  it("keeps /llms.txt and /llms-full.txt aligned with the public connect facts", async () => {
    const llms = await (await page("/llms.txt")).text();
    const full = await (await page("/llms-full.txt")).text();
    expect(llms).toContain("https://atteo.dev/docs");
    expect(llms).toContain("https://atteo.dev/mcp");
    expect(llms).toContain("Settings → Connectors → Add custom connector");
    expect(full).toContain("DIRECTORY FACTS");
    expect(full).toContain("openapi: https://atteo.dev/openapi.json");
    const sitemap = await (await page("/sitemap.xml")).text();
    expect(sitemap).toContain("<loc>https://atteo.dev/guide</loc>");
    expect(sitemap).not.toContain("<loc>https://atteo.dev/connect</loc>");
  });

  it("serves the short startup landing at /landing/startup (jxn #5664): one line, the board, one CTA", async () => {
    const body = await (await page("/landing/startup")).text();
    expect(body).toContain("<h1>The shared board for your team's agents.</h1>");
    expect(body).toContain('shadowrootmode="open"');
    expect(body.match(/class="su-cta"/g)).toHaveLength(1);
  });
});
