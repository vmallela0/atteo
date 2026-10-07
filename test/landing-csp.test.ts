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
import JXN_404_EXPORT from "../landing/jxn-pages/404.html";
import JXN_LANDING_EXPORT from "../landing/landing-jxn.html";
import STATIC_LANDING from "../landing/jxn-static/landing.html";
import STATIC_DEVELOPERS from "../landing/jxn-static/developers.html";
import STATIC_FAQ from "../landing/jxn-static/faq.html";
import STATIC_SUPPORT from "../landing/jxn-static/support.html";
import STATIC_PRIVACY from "../landing/jxn-static/privacy.html";
import STATIC_TERMS from "../landing/jxn-static/terms.html";
import STATIC_404 from "../landing/jxn-static/404.html";

const env = { APP_ORIGIN: "http://127.0.0.1:9" };
const FORM = "https://atteo.dev";
const STATIC = { landing: STATIC_LANDING, developers: STATIC_DEVELOPERS, faq: STATIC_FAQ, support: STATIC_SUPPORT, privacy: STATIC_PRIVACY, terms: STATIC_TERMS, 404: STATIC_404 };

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

  // jxn's pages are plain HTML (landing/jxn-pages/unbundle.mjs, #6003): what a crawler or a link preview reads is the
  // page itself, and every file comes from atteo.dev. The only other origin in a policy is the sign-in form's.
  const offsite = (csp: string) => csp.replace(`form-action 'self' ${FORM}`, "").match(/https?:\/\/\S+/g) ?? [];
  const text = (h: string) => h.replace(/<(script|style)[\s\S]*?<\/\1>/g, " ").replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

  it("serves jxn's page at / signed out (#5972) and at /landing (#5958) as plain HTML that then runs his own logic, nothing from outside atteo.dev, and keeps it out of the sitemap", async () => {
    for (const [path, cookie] of [["/", ""], ["/landing", ""], ["/landing", "ab_session=abc"]] as const) {
      const res = await page(path, cookie ? { cookie } : {});
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      const csp = res.headers.get("content-security-policy") ?? "";
      const html = await res.text();
      // The hash policy, plus his runtime and React from /landing/a/ ('self'), which compiles his page's logic.
      expect(csp).toBe((await landingCsp(html, FORM)).replace("script-src ", "script-src 'self' 'unsafe-eval' "));
      expect(csp.split("; ").find((d) => d.startsWith("script-src "))).not.toContain("'unsafe-inline'");
      expect(offsite(csp)).toEqual([]);
      expect(html).not.toMatch(/src="https?:\/\/(?!atteo\.dev)/); // links may go elsewhere; nothing loads from there
      expect(html).toMatch(/<script src="\/landing\/a\/[0-9a-f]{16}\.js"><\/script>/);
      expect(text(html)).toContain("agent to agent messaging"); // the page's words are in the HTML
      expect(html).toContain("/landing/icons/");
      expect(html).not.toContain("google.com/s2");
      // The share card, canonical and JSON-LD the old home page had, once, after the charset.
      expect(html.indexOf("<title>")).toBeGreaterThan(html.indexOf("og:image")); // ours stops before its title
      for (const tag of ['<link rel="canonical" href="https://atteo.dev/">', '<meta property="og:image" content="https://atteo.dev/og.png?v=3">', '<meta name="twitter:card" content="summary_large_image">', '"@graph"']) expect(html).toContain(tag);
    }
    expect(await (await page("/sitemap.xml")).text()).not.toContain("/landing");
  });

  it("serves jxn's /developers, /faq, /support, /privacy and /terms (#5977) as static HTML under the hash policy, signed in or not, each with its own head tags, linking to each other by path", async () => {
    for (const [path, title, h1] of [["/developers", "Atteo · Developer docs", "developer docs"], ["/faq", "Atteo · Frequently asked questions", "frequently asked questions"], ["/support", "Atteo · Support", "support"], ["/privacy", "Atteo · Privacy", "privacy"], ["/terms", "Atteo · Terms of Service", "terms of service"]] as const) {
      for (const cookie of ["", "ab_session=abc"]) {
        const res = await page(path, cookie ? { cookie } : {});
        expect(res.status, path).toBe(200);
        const csp = res.headers.get("content-security-policy") ?? "";
        const html = await res.text();
        expect(csp).toBe(await landingCsp(html, FORM)); // no 'unsafe-eval', no 'unsafe-inline' scripts
        expect(offsite(csp)).toEqual([]);
        expect(html).not.toMatch(/src="https?:\/\/(?!atteo\.dev)/);
        expect(html, path).toMatch(new RegExp(`<h1[^>]*>${h1}</h1>`));
        for (const tag of [`<link rel="canonical" href="https://atteo.dev${path}">`, `<meta property="og:title" content="${title}">`, '<meta property="og:image" content="https://atteo.dev/og.png?v=3">']) expect(html, path).toContain(tag);
        expect(html.indexOf("<title>")).toBeGreaterThan(html.indexOf("og:image")); // its own title stays the only one
        for (const p of ["developers", "faq", "support", "privacy", "terms"]) expect(html, path).toContain(`href="/${p}"`);
        expect(html).not.toMatch(/href="[a-z0-9]+\.html"/);
      }
    }
    // The FAQ keeps its FAQPage data: the questions are the ones shown.
    const faq = await (await page("/faq")).text();
    const questions = JSON.parse(inlineScripts(faq).find((s) => s.includes("FAQPage"))!)["@graph"][0].mainEntity.map((q: { name: string }) => q.name);
    expect(questions).toHaveLength(9);
    for (const q of questions) expect(text(faq)).toContain(q);
  });

  it("serves jxn's pages as built from today's code and his exports: the app's privacy policy, every MCP tool and CLI command (jxn #5998)", async () => {
    for (const [page, file] of Object.entries({ developers: JXN_DEVELOPERS, faq: JXN_FAQ, support: JXN_SUPPORT, privacy: JXN_PRIVACY, terms: JXN_TERMS }))
      expect(build(file).out === file, `${page}.html is stale: run node landing/jxn-pages/build.mjs`).toBe(true);
    const hex = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
    for (const [page, [src, out]] of Object.entries({ landing: [JXN_LANDING_EXPORT, STATIC.landing], developers: [JXN_DEVELOPERS, STATIC.developers], faq: [JXN_FAQ, STATIC.faq], support: [JXN_SUPPORT, STATIC.support], privacy: [JXN_PRIVACY, STATIC.privacy], terms: [JXN_TERMS, STATIC.terms], 404: [JXN_404_EXPORT, STATIC[404]] }))
      expect(/unbundled from ([0-9a-f]{64})/.exec(out)?.[1], `jxn-static/${page}.html is stale: run node landing/jxn-pages/unbundle.mjs`).toBe(await hex(src));
    const privacy = text(await (await page("/privacy")).text());
    for (const line of ["Atteo staff don't look at what's on your boards", "end-to-end encrypted", "We'll send the current list of these providers on request", "Last updated October 6, 2026"]) expect(privacy).toContain(line);
    for (const vendor of ["WorkOS", "Resend", "Sentry", "PostHog", "Stripe", "Backblaze"]) expect(privacy).not.toContain(vendor); // by category (vedu #5410/#5412)
  });

  it("answers a page the app doesn't have with jxn's 404 (#5990), and leaves the app's other answers alone", async () => {
    const app = (status: number, type: string, body = "app") => ({ fetch: async () => new Response(body, { status, headers: { "content-type": type } }) });
    const open = (path: string, APP: ReturnType<typeof app>, headers: HeadersInit = { accept: "text/html" }) =>
      worker.fetch(new Request(`http://localhost${path}`, { headers }), { ...env, APP } as never);
    const res = await open("/no/such/page", app(404, "text/html; charset=utf-8"));
    expect(res.status).toBe(404);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(res.headers.get("content-security-policy")).toBe(await landingCsp(html, FORM));
    expect(html).toContain("<title>atteo · page not found</title>");
    expect(html).toContain('<span class="sc-interp" id="jxn-path">/missing-page</span>'); // its script shows the real path, as text
    for (const p of ["developers", "faq", "support", "privacy", "terms"]) expect(html).toContain(`href="/${p}"`);
    expect(html).not.toMatch(/href="[a-z0-9]+\.html"/);
    // An API 404, a fetch() that isn't a page load, and a page the app does have come back as the app sent them.
    expect(await (await open("/api/boards/x", app(404, "application/json", "{}"))).text()).toBe("{}");
    expect(await (await open("/no/such/page", app(404, "text/html"), {})).text()).toBe("app");
    expect(await (await open("/b/x", app(200, "text/html"))).text()).toBe("app");
  });

  it("loads Cloudflare Web Analytics on the signed-out home page only when a token is set", async () => {
    expect(beaconSnippet(undefined)).toBe("");
    const tokenEnv = { ...env, CF_WEB_ANALYTICS_TOKEN: "abcdef0123456789" };
    const home = await worker.fetch(new Request("http://localhost/"), tokenEnv);
    const html = await home.text();
    const csp = home.headers.get("content-security-policy") ?? "";
    expect(html).toContain("https://static.cloudflareinsights.com/beacon.min.js");
    expect(csp.split("; ").find((d) => d.startsWith("script-src "))).toContain("https://static.cloudflareinsights.com");
    expect(csp).toContain("connect-src https://cloudflareinsights.com");
    const landing = await worker.fetch(new Request("http://localhost/landing"), tokenEnv);
    expect(await landing.text()).not.toContain("cloudflareinsights");
    const faq = await worker.fetch(new Request("http://localhost/faq"), tokenEnv);
    expect(await faq.text()).not.toContain("cloudflareinsights");
    expect(faq.headers.get("content-security-policy")).toContain("connect-src 'none'");
  });

  it("serves a public /support page with the privacy contact, legal links, and its own title", async () => {
    const signedIn = await page("/support", { cookie: "ab_session=present" });
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers.get("content-type")).toMatch(/text\/html/);
    const html = await signedIn.text();
    expect(html).toContain('meta name="description" content="How to get help with Atteo, invite-only boards for people and their agents. Email privacy@atteo.dev."');
    expect(html).toContain('<link rel="canonical" href="https://atteo.dev/support">');
    expect(html).toContain('href="mailto:privacy@atteo.dev"');
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
