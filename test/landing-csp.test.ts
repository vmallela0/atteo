import { describe, expect, it } from "vitest";
import { CSP_ENFORCE } from "../src/ui";
import { beaconSnippet, cspHash, inlineScripts, landingCsp } from "../landing/src/csp";
import worker from "../landing/src/index";

const env = { APP_ORIGIN: "http://127.0.0.1:9" };
const FORM = "https://atteo.dev";

async function page(path: string, extra: HeadersInit = {}) {
  return worker.fetch(new Request(`http://localhost${path}`, { headers: extra }), env);
}

describe("landing Worker CSP (docs/security/csp.md #8)", () => {
  it("keeps its own enforced policy, whatever the app's CSP_ENFORCE is", async () => {
    expect(CSP_ENFORCE).toBe(true); // the app enforces too now (vedu #5192)
    const res = await page("/");
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

  it("sends an enforced hash policy on /, /faq and /support, and allows the JSON-LD by hash (/guide is the app's now, #5110)", async () => {
    for (const path of ["/", "/faq", "/support", "/?theme=dark", "/landing", "/landing/startup"]) {
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
      const scripts = inlineScripts(html);
      if (path === "/support" || path === "/landing/startup") { // no scripts at all
        expect(scripts).toEqual([]);
        expect(csp).toContain("script-src 'none'");
      } else {
        // The home page also has its Copy buttons' script (jxn #4732); every inline script is allowed by its hash.
        expect(scripts.length).toBe(path === "/faq" ? 1 : 2);
        for (const s of scripts) expect(csp).toContain(await cspHash(s));
        expect(JSON.parse(scripts[0]!)).toHaveProperty("@graph");
      }
    }
  });

  it("serves the home page at /landing too, signed in or not, with the home's canonical (jxn #4772, #4773)", async () => {
    const home = await (await page("/")).text();
    for (const cookie of ["", "ab_session=abc"]) {
      const res = await page("/landing", cookie ? { cookie } : {});
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toBe(home);
      expect(html).toContain('<link rel="canonical" href="https://atteo.dev/">');
    }
    expect(await (await page("/sitemap.xml")).text()).not.toContain("/landing");
  });

  it("loads Cloudflare Web Analytics on the home page only when a token is set", async () => {
    expect(beaconSnippet(undefined)).toBe("");
    const tokenEnv = { ...env, CF_WEB_ANALYTICS_TOKEN: "abcdef0123456789" };
    const home = await worker.fetch(new Request("http://localhost/"), tokenEnv);
    const html = await home.text();
    const csp = home.headers.get("content-security-policy") ?? "";
    expect(html).toContain("https://static.cloudflareinsights.com/beacon.min.js");
    expect(csp).toBe(await landingCsp(html, FORM));
    expect(csp).toContain("script-src ");
    expect(csp).toContain("https://static.cloudflareinsights.com");
    expect(csp).toContain("connect-src https://cloudflareinsights.com");
    const faq = await worker.fetch(new Request("http://localhost/faq"), tokenEnv);
    expect(await faq.text()).not.toContain("cloudflareinsights");
    expect(faq.headers.get("content-security-policy")).toContain("connect-src 'none'");
  });

  it("serves a public /support page with the privacy contact, legal links, and its own title", async () => {
    const signedIn = await page("/support", { cookie: "ab_session=present" });
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers.get("content-type")).toMatch(/text\/html/);
    const html = await signedIn.text();
    expect(html).toContain("<title>Atteo · Support</title>");
    expect(html).toContain('meta name="description" content="How to get help with Atteo, invite-only boards for people and their agents. Email privacy@atteo.dev."');
    expect(html).toContain('<link rel="canonical" href="https://atteo.dev/support">');
    expect(html).toContain('href="mailto:privacy@atteo.dev"');
    expect(html).toContain('href="https://atteo.dev/privacy"');
    expect(html).toContain('href="https://atteo.dev/terms"');
    expect(html).toContain("invite-only boards for people and their agents");
    expect(html).toContain("How to get help");
    const home = await (await page("/")).text();
    expect(home).toContain('href="https://atteo.dev/support">support</a>'); // the home page's small links are lowercase (jxn #4732)
    const faq = await (await page("/faq")).text();
    expect(faq).toContain('href="https://atteo.dev/support">Support</a>');
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
  const links = [
    'href="https://atteo.dev/docs"',
    'href="https://atteo.dev/guide"',
    'href="https://atteo.dev/faq"',
    'href="https://atteo.dev/support"',
    'href="https://atteo.dev/llms.txt"', // the page head's alternate link; OpenAPI and the MCP URL are in /llms.txt
  ];

  it("puts the site links on /faq (its top bar and footer, #5110); the home page keeps only guide, faq, docs and the legal links (jxn #4732)", async () => {
    for (const path of ["/faq"]) {
      const html = await (await page(path)).text();
      for (const href of links) expect(html, path).toContain(href);
    }
    const home = await (await page("/")).text();
    for (const href of ['href="https://atteo.dev/docs"', 'href="https://atteo.dev/guide"', 'href="https://atteo.dev/faq"', 'href="https://atteo.dev/llms.txt"', 'href="https://atteo.dev/privacy"', 'href="https://atteo.dev/terms"', 'href="https://atteo.dev/support"']) expect(home).toContain(href);
  });

  it("makes the home page's install card name every way in, with the app's own lines (landing v3, board #5587)", async () => {
    const html = await (await page("/")).text();
    expect(html).toContain('role="tablist" aria-label="Connect your agent"');
    for (const name of ["cli", "mcp", "claude code", "cursor", "codex"]) expect(html).toContain(`>${name}</button>`);
    // Copy takes the commands only; the CLI tab shows without script, the others are switched by the hashed script.
    for (const line of ["curl -fsSL https://atteo.dev/install.sh | sh\natteo login", "claude mcp add --transport http --scope user atteo https://atteo.dev/mcp", "codex mcp add atteo --url https://atteo.dev/mcp\ncodex mcp login atteo"]) expect(html).toContain(`data-copy-text="${line}"`);
    expect(html).not.toMatch(/listed on (Smithery|mcp\.so|Glama)/i);
    expect(html).not.toMatch(/App Store/i);
  });

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
