import { describe, expect, it } from "vitest";
import { page, appPage, CSP_ENFORCE, CSP_REPORT_PATH, VOICE_SOCKET_ORIGIN } from "../src/ui";
import { landingPage, boardPage, mePage, PREVIEW_FRAME_CSP, PREVIEW_FRAME_HTML } from "../src/html";
import { REALTIME_URL } from "../src/voice";
import { MERMAID_JS, MERMAID_SRC, MERMAID_SRI } from "../src/mermaid";
import { allow, blockedKey, parseReports } from "../src/csp";

const viewer = { name: "csp", email: "csp@example.com", display_name: null, admin: false };
const board = { id: "b_csp", title: "CSP", created_by: "csp", created_at: 0, entry_count: 0, last_seq: 0 };
const HEADER = CSP_ENFORCE ? "content-security-policy" : "content-security-policy-report-only";

describe("HTML page CSP", () => {
  it("is report-only for now (jxn's agent #2636), reporting to /api/csp-report", () => {
    expect(CSP_ENFORCE).toBe(false);
    const res = landingPage();
    expect(res.headers.get("content-security-policy")).toBeNull();
    const csp = res.headers.get("content-security-policy-report-only") ?? "";
    expect(csp).toContain(`report-uri ${CSP_REPORT_PATH}`);
    expect(csp).toContain("report-to csp");
    expect(res.headers.get("reporting-endpoints")).toBe(`csp="${CSP_REPORT_PATH}"`);
  });

  it("gives each page a fresh nonce and puts it on every inline script", async () => {
    const pages = [
      () => landingPage(),
      () => page("OAuth", "<form method=post action='/oauth/authorize'></form>"),
      () => appPage("For you", { viewer, boards: [], active: "for-you", crumbs: "", body: "" }),
      () => mePage(viewer, [], []),
      () => boardPage(viewer, [], board, [], [], []),
    ];
    const seen = new Set<string>();
    for (const render of pages) {
      const res = render();
      const html = await res.text();
      const csp = res.headers.get(HEADER) ?? "";
      const nonce = csp.match(/'nonce-([a-f0-9]{32})'/)?.[1];
      expect(nonce).toBeTruthy();
      expect(seen.has(nonce!)).toBe(false);
      seen.add(nonce!);
      const scripts = [...html.matchAll(/<script\b([^>]*)>/g)];
      expect(scripts.length).toBeGreaterThan(0);
      for (const script of scripts) expect(script[1]).toContain(`nonce="${nonce}"`);
      expect(csp.split("; ").find((x) => x.startsWith("script-src"))).not.toContain("'unsafe-inline'");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    }
  });
});

describe("CSP follow-ups (opus-b #2678, jxn's agent #2681)", () => {
  const policyOf = (res: Response) => res.headers.get(HEADER) ?? "";
  const directive = (csp: string, name: string) => csp.split("; ").find((x) => x.startsWith(name + " ")) ?? "";

  it("sockets: only this host and the voice provider, never any wss host", () => {
    const connect = directive(policyOf(landingPage()), "connect-src");
    expect(connect).toBe(`connect-src 'self' ${VOICE_SOCKET_ORIGIN}`);
    expect(connect).not.toMatch(/(^| )wss?:( |$)/);
    expect(new URL(REALTIME_URL).origin).toBe(VOICE_SOCKET_ORIGIN);
  });

  it("mermaid: the one pinned file, loaded with SRI and crossorigin, not the whole CDN", () => {
    const script = directive(policyOf(landingPage()), "script-src");
    expect(script).toContain(MERMAID_SRC);
    expect(MERMAID_SRC).toMatch(/^https:\/\/cdn\.jsdelivr\.net\/npm\/mermaid@\d+\.\d+\.\d+\/dist\/mermaid\.min\.js$/);
    expect(script).not.toMatch(/https:\/\/cdn\.jsdelivr\.net\/?( |$)/);
    expect(MERMAID_SRI).toMatch(/^sha384-[A-Za-z0-9+/]{64}$/);
    expect(MERMAID_JS).toContain("s.integrity=SRI");
    expect(MERMAID_JS).toContain("s.crossOrigin='anonymous'");
    expect((MERMAID_JS.match(/createElement\('script'\)/g) ?? []).length).toBe(1); // the only place it loads
  });

  it("the HTML preview runs from its own shell with its own CSP, and never gets the page's nonce", async () => {
    const res = boardPage(viewer, [], board, [], [], []);
    const html = await res.text();
    const nonce = policyOf(res).match(/'nonce-([a-f0-9]{32})'/)![1];
    expect(html).toContain("fr.src='/preview-frame?'");
    expect(html).not.toContain("srcdoc=");
    expect(html).not.toMatch(/withCsp|\.nonce\b/);
    expect(PREVIEW_FRAME_HTML).not.toContain(nonce);
    expect(PREVIEW_FRAME_HTML).not.toContain("nonce");
    for (const d of ["sandbox allow-scripts", "default-src 'none'", "connect-src 'none'", "form-action 'none'", "base-uri 'none'", "frame-ancestors 'self'"]) expect(PREVIEW_FRAME_CSP).toContain(d);
    expect(PREVIEW_FRAME_CSP).not.toContain("allow-same-origin");
    expect(PREVIEW_FRAME_CSP).not.toMatch(/'nonce-/);
  });
});

describe("CSP reports", () => {
  it("reads the report-uri shape and the Reporting API shape", () => {
    expect(parseReports({ "csp-report": { "effective-directive": "script-src-elem", "blocked-uri": "https://evil.example/x.js?a=1" } })).toEqual([{ directive: "script-src-elem", blocked: "https://evil.example" }]);
    expect(parseReports([{ type: "csp-violation", body: { effectiveDirective: "script-src-attr", blockedURL: "inline" } }, { type: "deprecation", body: {} }])).toEqual([{ directive: "script-src-attr", blocked: "inline" }]);
  });

  it("ignores junk and caps one request at 20 hits", () => {
    expect(parseReports(null)).toEqual([]);
    expect(parseReports("x")).toEqual([]);
    expect(parseReports({ other: 1 })).toEqual([]);
    const many = Array.from({ length: 50 }, () => ({ type: "csp-violation", body: { effectiveDirective: "img-src", blockedURL: "data:image/png;base64,AAA" } }));
    const hits = parseReports(many);
    expect(hits).toHaveLength(20);
    expect(hits[0]).toEqual({ directive: "img-src", blocked: "data" });
    expect(parseReports({ "csp-report": { "violated-directive": "<script>alert(1)</script>", "blocked-uri": "" } })).toEqual([{ directive: "(unknown)", blocked: "(none)" }]);
  });

  it("keeps only the origin of a blocked URL, never its path or query", () => {
    expect(blockedKey("https://a.b/secret/path?token=x")).toBe("https://a.b");
    expect(blockedKey("wss://live.example/socket")).toBe("wss://live.example");
    expect(blockedKey("eval")).toBe("eval");
  });

  it("rate-limits one address to 30 a minute", () => {
    const t = 1_000_000;
    let ok = 0;
    for (let i = 0; i < 40; i++) if (allow("1.2.3.4-test", t)) ok++;
    expect(ok).toBe(30);
    expect(allow("1.2.3.4-test", t + 61_000)).toBe(true);
  });
});
