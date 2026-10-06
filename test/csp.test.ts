import { describe, expect, it } from "vitest";
import { page, appPage, formActionSource, CSP_ENFORCE, CSP_REPORT_PATH, VOICE_SOCKET_ORIGIN, BUG_DIALOG, BUG_PAGE_JS, SHELL_PAGE_JS, APP_JS, APP_CSS, ASK_CSS_SRC, DOC_CSS_SRC, GUIDE_CSS_SRC, PAGE_CSS, styleNonce } from "../src/ui";
import { inboxPage } from "../src/inbox";
import { localize, tr } from "../src/i18n";
import budget from "./browser/web-budget.json";
import { FONT_CSS } from "../src/fontfaces";
import { AGENT_LOGO_CSS, agentLogo } from "../src/agent-logos";
import { TALK_JS } from "../src/talk";
import { forYouPage } from "../src/forYou";
import { consentPage } from "../src/oauthPage";
import { trackCapped } from "../src/usage";
import type { Env } from "../src/types";
import { landingPage, boardPage, boardTail, mePage, adminPage, PREVIEW_FRAME_CSP, PREVIEW_FRAME_HTML } from "../src/html";
import { REALTIME_URL } from "../src/voice";
import { MERMAID_JS, MERMAID_SRC, MERMAID_SRI } from "../src/mermaid";
import { CODE_COLOR_JS } from "../src/codecolor";
import { allow, blockedKey, handleReport, parseReports, MAX_KEYS_PER_DAY, OVERFLOW_KEY } from "../src/csp";

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
      () => forYouPage(viewer, [], { approvals: [], boards: [], mentions: [] }),
      () => boardPage(viewer, [], board, [], [], []),
      () => adminPage({ ...viewer, admin: true }, [], { boards: [], users: [], invites: [], recent: [], totalEntries: 0, access: [] }),
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
      expect(csp.split("; ").find((x) => x.startsWith("script-src "))).not.toContain("'unsafe-inline'");
      expect(csp).toContain("script-src-attr 'none'");
      const styleSrc = csp.split("; ").find((x) => x.startsWith("style-src ")) ?? "";
      expect(styleSrc).toBe(`style-src 'self' 'nonce-${nonce}' 'sha256-lCZPv+siQGbLyHufN87S4tT1GlG+V8T7J184kcDeWZ4='`); // + pinned mermaid's own <style>
      expect(styleSrc).not.toContain("'unsafe-inline'");
      expect(csp.split("; ").find((x) => x.startsWith("style-src-attr"))).toBe("style-src-attr 'unsafe-inline'");
      const styles = [...html.matchAll(/<style\b([^>]*)>/g)];
      for (const style of styles) expect(style[1]).toContain(`nonce="${nonce}"`);
      expect(html).not.toMatch(/\son[a-z]+\s*=/i);
      expect(html).not.toMatch(/\b(?:href|src)\s*=\s*["']javascript:/i);
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

  it("mermaid: this origin's pinned file, loaded with SRI and crossorigin, no CDN", async () => {
    const script = directive(policyOf(landingPage()), "script-src");
    expect(script).toMatch(/^script-src 'self' 'nonce-[a-f0-9]{32}'$/);
    expect(script).not.toMatch(/https?:\/\//);
    expect(script).not.toMatch(/jsdelivr/i);
    expect(MERMAID_SRC).toMatch(/^\/mermaid\.min\.js\?v=\d+\.\d+\.\d+$/);
    expect(MERMAID_SRI).toMatch(/^sha384-[A-Za-z0-9+/]{64}$/);
    expect(MERMAID_JS).toContain("s.integrity=SRI");
    expect(MERMAID_JS).toContain("s.nonce=NONCE");
    expect(MERMAID_JS).toContain("s.crossOrigin='anonymous'");
    expect(MERMAID_JS).toContain("withStyleNonce");
    expect(MERMAID_JS).toContain("st.setAttribute('nonce',NONCE)");
    expect((MERMAID_JS.match(/createElement\('script'\)/g) ?? []).length).toBe(1); // the only place it loads
    const { readFileSync } = (await import("node:" + "fs")) as { readFileSync: (p: string) => Uint8Array };
    const { createHash } = (await import("node:" + "crypto")) as { createHash: (a: string) => { update: (b: Uint8Array) => { digest: (e: string) => string } } };
    const bytes = readFileSync("public/mermaid.min.js");
    expect("sha384-" + createHash("sha384").update(bytes).digest("base64")).toBe(MERMAID_SRI);
    const missing = await (await import("../src/mermaid")).mermaidResponse({}, new URL("http://localhost/mermaid.min.js?v=12.1.0"));
    expect(missing.status).toBe(404);
  });

  it("keeps Mermaid's stylesheet nonce hook through asynchronous rendering and restores it on failure", async () => {
    // .nonce only sets the internal slot; CSP also requires the content attribute to exist.
    // The old property-only stub missed this and passed while the browser rejected the stylesheet.
    const helper = MERMAID_JS.slice(MERMAID_JS.indexOf("const withStyleNonce="), MERMAID_JS.indexOf("const load="));
    const element = (localName: string) => ({ localName, nonce: "", attributes: new Map<string, string>(),
      setAttribute(name: string, value: string) { this.attributes.set(name, value); } });
    const Document = class {
      createElement(name: string) { return element(name.toLowerCase()); }
      createElementNS(_ns: string, name: string) { return element(name); }
    };
    const original = Document.prototype.createElement;
    const originalNS = Document.prototype.createElementNS;
    const withNonce = new Function("Document", "NONCE", `${helper};return withStyleNonce`)(Document, "page-nonce");
    for (const fail of [false, true]) {
      const rendering = withNonce(async () => {
        await Promise.resolve();
        const doc = new Document();
        expect(doc.createElement("style").attributes.get("nonce")).toBe("page-nonce");
        expect(doc.createElement("STYLE").attributes.get("nonce")).toBe("page-nonce");
        expect(doc.createElementNS("http://www.w3.org/2000/svg", "style").attributes.get("nonce")).toBe("page-nonce");
        for (const tag of ["div", "script", "iframe"]) expect(doc.createElement(tag).attributes.has("nonce")).toBe(false);
        if (fail) throw new Error("render failed");
      });
      if (fail) await expect(rendering).rejects.toThrow("render failed");
      else await rendering;
      expect(Document.prototype.createElement).toBe(original);
      expect(Document.prototype.createElementNS).toBe(originalNS);
    }
  });

  it("the HTML preview runs from its own shell with its own CSP, and never gets the page's nonce", async () => {
    const res = boardPage(viewer, [], board, [], [], []);
    // The preview's code is in the board's tail script (/board-tail.js): read the page with it put back inline.
    const html = (await res.text()).replace(/<script src="\/board-tail\.js\?f=([01]{4})(?:&amp;|&)v=[^"]+"[^>]*><\/script>/, (_, f) => `<script>${boardTail(f)!.js}</script>`);
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

  it("img, font, and media sources are only what avatars, uploads, captures, and playback use", async () => {
    const csp = policyOf(landingPage());
    expect(directive(csp, "img-src")).toBe("img-src 'self' blob:");
    expect(directive(csp, "font-src")).toBe("font-src 'self'");
    expect(directive(csp, "media-src")).toBe("media-src 'self' blob:");
    expect(csp).not.toMatch(/(?:img-src|font-src|media-src)[^;]*\bdata:/);
    // Icons are clip-path or inline SVG. A data: image in the stylesheet would need img-src data: again.
    expect(APP_CSS).not.toMatch(/url\(\s*['"]?data:/i);
    expect(AGENT_LOGO_CSS).toContain('i.cn-logo[data-lg=chatgpt]{--lg:path(evenodd,"');
    expect(AGENT_LOGO_CSS).not.toMatch(/data:/);
    expect(agentLogo("claude")).toContain('data-lg="claude"');
    expect(agentLogo("")).toContain("<svg");
    expect(agentLogo("nope")).toBe(agentLogo(""));
    // Fonts are this origin's woff2 files, not data: fonts.
    expect(FONT_CSS).toContain('url(/fonts/onest-latin.woff2?v=1)');
    expect(FONT_CSS).not.toMatch(/data:/);
    // Thumbnails and playback are blob: object URLs. Live Talk audio is WebAudio, not a media URL.
    expect(BUG_PAGE_JS).toContain("URL.createObjectURL");
    expect(TALK_JS).toContain("new Audio(URL.createObjectURL(b))");
    expect(TALK_JS).toContain("new Audio(silentWav())");
    expect(TALK_JS).not.toMatch(/data:(?:audio|video|font)/);
    const { readFileSync } = (await import("node:" + "fs")) as { readFileSync: (p: string, e: string) => string };
    const ask = readFileSync("src/ask.ts", "utf8");
    const html = readFileSync("src/html.ts", "utf8");
    expect(ask).toContain("new Audio(URL.createObjectURL(await r.blob()))");
    expect(html).toContain("URL.createObjectURL(x.blob)");
    expect(html).toContain("cache[v]=URL.createObjectURL(await r.blob())");
    expect(ask + html + TALK_JS + BUG_PAGE_JS).not.toMatch(/new Audio\(\s*['"]data:/);
    // The sandboxed preview (gap 5) still needs data: and blob: for an SVG preview and whatever the file embeds.
    expect(PREVIEW_FRAME_CSP).toContain("img-src data: blob:");
    expect(PREVIEW_FRAME_CSP).toContain("font-src data:");
    expect(PREVIEW_FRAME_CSP).toContain("media-src data: blob:");
  });

  it("lazy-loaded scripts inherit the document nonce", () => {
    expect(CODE_COLOR_JS).toContain("s.nonce=NONCE");
    expect(SHELL_PAGE_JS).toContain("s.nonce=NONCE");
    expect(BUG_PAGE_JS).not.toContain("createElement('script')"); // the bug report loads nothing more (no capture library since #4116)
  });

  it("keeps the inbox within the existing byte budgets by loading the bug form on demand", async () => {
    const html = await inboxPage(viewer, [{ id: board.id, title: board.title }, { id: "b_own", title: "Your agent", kind: "agent" }], [{
      id: 1, board_id: board.id, board_title: board.title, seq: 1, kind: "mention", actor: "other",
      actor_via: "person", entry_type: "question", excerpt: "@csp can you check the staging port before the deploy?",
      created_at: Date.now(), read_at: null,
    }]).text();
    const sum = (re: RegExp) => [...html.matchAll(re)].reduce((n, m) => n + Buffer.byteLength(m[1]), 0);
    const inline_js = sum(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g);
    const inline_css = sum(/<style[^>]*>([\s\S]*?)<\/style>/g);
    const measured = { html: Buffer.byteLength(html) - inline_js - inline_css, inline_js, inline_css,
      js: Buffer.byteLength(APP_JS + SHELL_PAGE_JS), css: Buffer.byteLength(APP_CSS) };
    for (const key of Object.keys(measured) as (keyof typeof measured)[]) {
      const base = budget.pages.inbox[key];
      expect(measured[key], key).toBeLessThanOrEqual(Math.max(Math.round(base * 1.1), base + 2048));
    }
    expect(html).not.toContain('<dialog id="bug"');
    expect(BUG_PAGE_JS).toContain("fetch('/bug-form')");
    expect(BUG_DIALOG).not.toMatch(/<script|<style|\sstyle=|\son[a-z]+=/i);
    const zh = localize("zh-Hans", BUG_DIALOG);
    for (const label of ["Report a bug", "What happened? What did you expect?", "Attach files", "Send report"])
      expect(zh).toContain(tr("zh-Hans", label));
  });

  it("page styles live in /app.css and page-only sheets; leftover <style> tags take the page nonce (csp.md #3)", async () => {
    expect(APP_CSS).not.toContain(".fy-askwrap{");
    expect(APP_CSS).not.toContain(".gd-list{");
    expect(APP_CSS).not.toContain(".ask-mic{");
    expect(APP_CSS).not.toContain(".docs .tool{");
    expect(PAGE_CSS["/guide.css"]).toContain(".gd-list{");
    expect(PAGE_CSS["/ask.css"]).toContain(".ask-mic{");
    expect(PAGE_CSS["/docs.css"]).toContain(".docs .tool{");
    expect(GUIDE_CSS_SRC).toMatch(/^\/guide\.css\?v=/);
    expect(ASK_CSS_SRC).toMatch(/^\/ask\.css\?v=/);
    expect(DOC_CSS_SRC).toMatch(/^\/docs\.css\?v=/);
    expect(styleNonce("<noscript><style>#x{color:red}</style></noscript>", "abc")).toBe('<noscript><style nonce="abc">#x{color:red}</style></noscript>');
    expect(styleNonce('<style nonce="abc">x</style>', "abc")).toBe('<style nonce="abc">x</style>');
    const res = boardPage(viewer, [], board, [], [], []);
    const html = await res.text();
    const nonce = policyOf(res).match(/'nonce-([a-f0-9]{32})'/)![1];
    expect(html).toContain(`<noscript><style nonce="${nonce}">`);
    expect(html).not.toMatch(/<style(?![^>]*\bnonce=)/i);
    expect(html).not.toContain("/fy.css");
    const guide = await appPage("Guide", { viewer, boards: [], active: "guide", crumbs: "", body: "", css: [GUIDE_CSS_SRC] }).text();
    expect(guide).toContain(`href="${GUIDE_CSS_SRC}"`);
    // Board/inbox load only /app.css. Folding page CSS into it blew the 10% web-budget (~19% over).
    const base = 139558;
    expect(Buffer.byteLength(APP_CSS)).toBeLessThanOrEqual(Math.max(Math.round(base * 1.1), base + 2048));
    // For you keeps its sheet inline: moving it to a file exceeds the external CSS category's existing cap.
    const fy = await forYouPage(viewer, [], { approvals: [], boards: [], mentions: [] }).text();
    expect(fy).not.toContain('/fy.css');
    const inlineCss = [...fy.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].reduce((n, m) => n + Buffer.byteLength(m[1]), 0);
    expect(inlineCss).toBeGreaterThan(0);
    expect(inlineCss).toBeLessThanOrEqual(Math.max(Math.round(5801 * 1.1), 5801 + 2048));
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

// Before enforcing (#2722, opus-d #2703/#2720).
const { DatabaseSync } = (await import("node:" + "sqlite")) as { DatabaseSync: new (p: string) => any };
function usageDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE usage_daily (day TEXT NOT NULL, metric TEXT NOT NULL, key TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, metric, key))");
  const stmt = (sql: string, args: unknown[] = []): any => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    run: async () => {
      // D1 accepts numbered parameters repeated in one statement; node:sqlite only accepts anonymous positional
      // parameters through run(...args), so expand ?N in this small adapter.
      const expanded: unknown[] = [];
      const query = sql.replace(/\?(\d+)/g, (_, n) => (expanded.push(args[Number(n) - 1]), "?"));
      return db.prepare(query).run(...(expanded.length ? expanded : args));
    },
  });
  return { env: { DB: { prepare: (sql: string) => stmt(sql) } } as unknown as Env, db };
}

describe("before enforcing (#2722)", () => {
  const policyOf = (res: Response) => res.headers.get(HEADER) ?? "";
  const formAction = (res: Response) => policyOf(res).split("; ").find((x) => x.startsWith("form-action ")) ?? "";

  it("the OAuth consent page lets its form redirect to the client's redirect_uri, and only there", () => {
    expect(formAction(consentPage(viewer, "r1", "Claude", "https://claude.ai/api/mcp/auth_callback?x=1"))).toBe("form-action 'self' https://claude.ai");
    expect(formAction(consentPage(viewer, "r1", "CLI", "http://127.0.0.1:53682/callback"))).toBe("form-action 'self' http://127.0.0.1:53682");
    expect(formAction(consentPage(viewer, "r1", "Cursor", "cursor://anysphere.cursor-deeplink/mcp/auth"))).toBe("form-action 'self' cursor:");
    expect(formAction(consentPage(viewer, "r1", "App", "atteo:/oauth", true))).toBe("form-action 'self' atteo:");
    expect(formAction(page("Other", "<p>x</p>"))).toBe("form-action 'self'");
    expect(formAction(landingPage())).toBe("form-action 'self'");
  });

  it("nothing odd gets into the source list", () => {
    for (const raw of ["https://a.example; script-src *", "https://a.example/x;y 'unsafe-inline'", "https://a.example%20'unsafe-inline'/"]) {
      const src = formActionSource(raw);
      expect(src === null || /^https:\/\/[a-z0-9.:-]+$/.test(src)).toBe(true); // only ever an origin: no space, quote or ;
    }
    expect(formActionSource("https://a.example/p?q=';'")).toBe("https://a.example");
    expect(formActionSource("javascript:alert(1)")).toBe(null);
    expect(formActionSource("data:text/html,x")).toBe(null);
    expect(formActionSource("not a url")).toBe(null);
    expect(formActionSource("https://[::1]:8443/cb")).toBe("https://[::1]:8443");
  });

  it("HTML pages are private and revalidated: no shared cache keeps a page or pins its nonce", () => {
    for (const res of [landingPage(), page("P", "<p>x</p>"), appPage("For you", { viewer, boards: [], active: "for-you", crumbs: "", body: "" }), boardPage(viewer, [], board, [], [], [])])
      expect(res.headers.get("cache-control")).toBe("private, no-cache");
  });

  it("the preview shell answers 'ready' with its #token, and the page checks it", () => {
    expect(PREVIEW_FRAME_HTML).toContain("tok:location.hash.slice(1)");
  });

  it("csp-report keeps at most MAX_KEYS_PER_DAY distinct keys a day; past that, new ones count as one overflow row", async () => {
    const { env, db } = usageDb();
    for (let i = 0; i < MAX_KEYS_PER_DAY + 30; i++) await trackCapped(env, "csp", `script-src https://x${i}.example`, MAX_KEYS_PER_DAY, OVERFLOW_KEY);
    await trackCapped(env, "csp", "script-src https://x0.example", MAX_KEYS_PER_DAY, OVERFLOW_KEY); // a known key still counts as itself
    const rows = db.prepare("SELECT key, count FROM usage_daily WHERE metric = 'csp'").all() as { key: string; count: number }[];
    expect(rows.length).toBe(MAX_KEYS_PER_DAY + 1);
    expect(rows.find((r) => r.key === OVERFLOW_KEY)?.count).toBe(30);
    expect(rows.find((r) => r.key === "script-src https://x0.example")?.count).toBe(2);
    expect(OVERFLOW_KEY.split(" ")[0]).toBe("(other)"); // the ops console splits directive / blocked at the first space
  });

  it("a report body over the limit is dropped even without a content-length", async () => {
    const { env, db } = usageDb();
    const big = JSON.stringify({ "csp-report": { "effective-directive": "script-src", "blocked-uri": "inline", pad: "x".repeat(70 * 1024) } });
    const chunked = new Request("http://localhost/api/csp-report", { method: "POST", body: new Blob([big]).stream(), duplex: "half" } as RequestInit);
    expect((await handleReport(chunked, env)).status).toBe(204);
    const small = new Request("http://localhost/api/csp-report", { method: "POST", headers: { "cf-connecting-ip": "9.9.9.9-test" }, body: JSON.stringify({ "csp-report": { "effective-directive": "script-src", "blocked-uri": "inline" } }) });
    expect((await handleReport(small, env)).status).toBe(204);
    const rows = db.prepare("SELECT key, count FROM usage_daily").all() as { key: string; count: number }[];
    expect(rows).toEqual([{ key: "script-src inline", count: 1 }]);
  });
});
