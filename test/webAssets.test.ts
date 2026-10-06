import { describe, expect, it } from "vitest";
import { CODE_COLOR_PATH, CODE_COLOR_SCRIPT, CODE_COLOR_SRC } from "../src/codecolor";
import { FONT_FACES } from "../src/fontfaces";
import { BOARD_JS, BOARD_JS_PATH, BOARD_JS_SRC, BOARD_TAIL_PATH } from "../src/html";
import { HOST_JS_SRC, HOST_PAGE_JS } from "../src/hostUi";
import { MERMAID_PATH } from "../src/mermaid";
import { PALETTE_CSS, PALETTE_CSS_SRC, PALETTE_JS, PALETTE_JS_SRC } from "../src/palette";
import {
  APP_CSS,
  APP_CSS_SRC,
  APP_JS,
  APP_JS_SRC,
  ASK_CSS_SRC,
  BOARD_PREFETCH_PATH,
  BUG_JS_SRC,
  BUG_PAGE_JS,
  CSP_ENFORCE,
  DOC_CSS_SRC,
  FEEDBACK_JS_SRC,
  FEEDBACK_PAGE_JS,
  GUIDE_CSS_SRC,
  PAGE_CSS,
  SHELL_JS_SRC,
  SHELL_PAGE_JS,
  SITE_CSS_SRC,
} from "../src/ui";
import { builtTextAssets, isBuiltAssetPath, isFontAssetPath, serveBuiltAsset, staticAssetHeadersFile } from "../src/webAssets";

describe("built CSS/JS static assets (CLOUDFLARE_HARDENING leftover)", () => {
  const byPath = Object.fromEntries(builtTextAssets().map((a) => [a.path, a]));

  it("does not flip CSP_ENFORCE", () => {
    expect(CSP_ENFORCE).toBe(true);
  });

  it("keeps versioned cache-busting URLs", () => {
    expect(APP_CSS_SRC).toMatch(/^\/app\.css\?v=[0-9a-z]+$/);
    expect(APP_JS_SRC).toMatch(/^\/app\.js\?v=[0-9a-z]+$/);
    expect(BOARD_JS_SRC).toMatch(/^\/board\.js\?v=[0-9a-z]+$/);
    expect(SHELL_JS_SRC).toMatch(/^\/shell\.js\?v=[0-9a-z]+$/);
    expect(BUG_JS_SRC).toMatch(/^\/bug\.js\?v=[0-9a-z]+$/);
    expect(FEEDBACK_JS_SRC).toMatch(/^\/feedback\.js\?v=[0-9a-z]+$/);
    expect(HOST_JS_SRC).toMatch(/^\/host\.js\?v=[0-9a-z]+$/);
    expect(PALETTE_JS_SRC).toMatch(/^\/palette\.js\?v=[0-9a-z]+$/);
    expect(PALETTE_CSS_SRC).toMatch(/^\/palette\.css\?v=[0-9a-z]+$/);
    expect(CODE_COLOR_SRC).toMatch(/^\/code-colors\.js\?v=[0-9a-z]+$/);
    expect(SITE_CSS_SRC).toMatch(/^\/site\.css\?v=[0-9a-z]+$/);
    expect(GUIDE_CSS_SRC).toMatch(/^\/guide\.css\?v=[0-9a-z]+$/);
    expect(ASK_CSS_SRC).toMatch(/^\/ask\.css\?v=[0-9a-z]+$/);
    expect(DOC_CSS_SRC).toMatch(/^\/docs\.css\?v=[0-9a-z]+$/);
  });

  it("catalog bodies are the strings the pages link", () => {
    expect(byPath["/app.css"]?.body).toBe(APP_CSS);
    expect(byPath["/app.js"]?.body).toBe(APP_JS);
    expect(byPath[BOARD_JS_PATH]?.body).toBe(BOARD_JS);
    expect(byPath["/shell.js"]?.body).toBe(SHELL_PAGE_JS);
    expect(byPath["/bug.js"]?.body).toBe(BUG_PAGE_JS);
    expect(byPath["/feedback.js"]?.body).toBe(FEEDBACK_PAGE_JS);
    expect(byPath["/host.js"]?.body).toBe(HOST_PAGE_JS);
    expect(byPath["/palette.js"]?.body).toBe(PALETTE_JS);
    expect(byPath["/palette.css"]?.body).toBe(PALETTE_CSS);
    expect(byPath[CODE_COLOR_PATH]?.body).toBe(CODE_COLOR_SCRIPT);
    expect(byPath[BOARD_PREFETCH_PATH]?.body).toBeDefined();
    for (const [path, body] of Object.entries(PAGE_CSS)) expect(byPath[path]?.body).toBe(body);
  });

  it("does not take over mermaid or parameterized board-tail", () => {
    expect(isBuiltAssetPath(MERMAID_PATH)).toBe(false);
    expect(isBuiltAssetPath(BOARD_TAIL_PATH)).toBe(false);
    expect(builtTextAssets().some((a) => a.path === MERMAID_PATH || a.path === BOARD_TAIL_PATH)).toBe(false);
  });

  it("treats real font files as assets and unknown names as not (404 later)", () => {
    expect(isFontAssetPath("/fonts/onest-latin.woff2")).toBe(true);
    expect(isBuiltAssetPath("/fonts/onest-latin.woff2")).toBe(true);
    expect(isFontAssetPath("/fonts/constructor")).toBe(false);
    expect(isBuiltAssetPath("/fonts/constructor")).toBe(false);
    expect(isFontAssetPath("/fonts/nope.woff2")).toBe(true);
    expect(FONT_FACES.every((f) => isFontAssetPath(`/fonts/${f.file}`))).toBe(true);
  });

  it("404s built assets when the ASSETS binding is missing", async () => {
    const res = await serveBuiltAsset({}, new Request("http://localhost/app.css"), "/app.css");
    expect(res?.status).toBe(404);
    expect(await serveBuiltAsset({}, new Request("http://localhost/board.js", { method: "POST" }), "/board.js")).toBeNull();
  });

  it("emits _headers for every catalog file and fonts", () => {
    const headers = staticAssetHeadersFile();
    for (const a of builtTextAssets()) {
      expect(headers).toContain(`\n${a.path}\n`);
      expect(headers).toContain(a.cacheControl);
    }
    expect(headers).toContain("/fonts/*");
    expect(headers).toContain("Access-Control-Allow-Origin: *");
    expect(headers).toContain("X-Content-Type-Options: nosniff");
  });

  it("wrangler serves dist/web as assets-first except mermaid", async () => {
    const { readFileSync } = (await import("node:" + "fs")) as { readFileSync: (p: string, e: string) => string };
    const wrangler = readFileSync("wrangler.jsonc", "utf8");
    expect(wrangler).toContain('"directory": "./dist/web"');
    expect(wrangler).toContain('"run_worker_first": ["/mermaid.min.js"]');
    expect(wrangler).toContain("build:assets");
  });
});
