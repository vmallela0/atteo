import { describe, expect, it } from "vitest";
import { CSP_ENFORCE } from "../src/ui";
import { cspHash, inlineScripts, landingCsp } from "../landing/src/csp";
import worker from "../landing/src/index";

const env = { APP_ORIGIN: "http://127.0.0.1:9" };
const FORM = "https://atteo.dev";

async function page(path: string, extra: HeadersInit = {}) {
  return worker.fetch(new Request(`http://localhost${path}`, { headers: extra }), env);
}

describe("landing Worker CSP (docs/security/csp.md #8)", () => {
  it("does not flip the app's CSP_ENFORCE", () => {
    expect(CSP_ENFORCE).toBe(false);
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

  it("sends an enforced hash policy on /, /guide, /faq and /support, and allows the JSON-LD by hash", async () => {
    for (const path of ["/", "/guide", "/faq", "/support", "/?theme=dark"]) {
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
      if (path.startsWith("/guide") || path === "/support") {
        expect(scripts).toEqual([]);
        expect(csp).toContain("script-src 'none'");
      } else {
        expect(scripts.length).toBe(1);
        expect(csp).toContain(await cspHash(scripts[0]!));
        expect(JSON.parse(scripts[0]!)).toHaveProperty("@graph");
      }
    }
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
    expect(home).toContain('href="https://atteo.dev/support">Support</a>');
    const faq = await (await page("/faq")).text();
    expect(faq).toContain('href="https://atteo.dev/support">Support</a>');
    const sitemap = await (await page("/sitemap.xml")).text();
    expect(sitemap).toContain("<loc>https://atteo.dev/support</loc>");
    expect(CSP_ENFORCE).toBe(false);
  });

  it("does not put CSP on the non-HTML files", async () => {
    const robots = await page("/robots.txt");
    expect(robots.headers.get("content-security-policy")).toBeNull();
    expect(robots.headers.get("content-security-policy-report-only")).toBeNull();
    expect(await robots.text()).toContain("Sitemap: https://atteo.dev/sitemap.xml");
  });
});
