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

  it("sends an enforced hash policy on /, /guide and /faq, and allows the JSON-LD by hash", async () => {
    for (const path of ["/", "/guide", "/faq", "/?theme=dark"]) {
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
      if (path.startsWith("/guide")) {
        expect(scripts).toEqual([]);
        expect(csp).toContain("script-src 'none'");
      } else {
        expect(scripts.length).toBe(1);
        expect(csp).toContain(await cspHash(scripts[0]!));
        expect(JSON.parse(scripts[0]!)).toHaveProperty("@graph");
      }
    }
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
    const guide = await worker.fetch(new Request("http://localhost/guide"), tokenEnv);
    expect(await guide.text()).not.toContain("cloudflareinsights");
    expect(guide.headers.get("content-security-policy")).toContain("connect-src 'none'");
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
    'href="https://atteo.dev/llms.txt"',
    'href="https://atteo.dev/openapi.json"',
    'href="https://atteo.dev/mcp"',
  ];

  it("puts directory links in the footer of /, /guide and /faq", async () => {
    for (const path of ["/", "/guide", "/faq"]) {
      const html = await (await page(path)).text();
      for (const href of links) expect(html, path).toContain(href);
    }
  });

  it("makes the home page show MCP, CLI and Claude / Cursor / ChatGPT steps", async () => {
    const html = await (await page("/")).text();
    expect(html).toContain('id="connect"');
    expect(html).toContain("https://atteo.dev/mcp");
    expect(html).toContain("curl -fsSL https://atteo.dev/install.sh | sh");
    expect(html).toContain("atteo connect claude");
    expect(html).toContain("Add custom connector");
    expect(html).toContain("one-click install");
    expect(html).toContain("Custom connectors are not on every ChatGPT plan");
    expect(html).toContain("For directories");
    expect(html).toContain("mcp: https://atteo.dev/mcp");
    expect(html).toContain("stdio: atteo mcp");
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
});
