import { describe, expect, it } from "vitest";
import { page, appPage } from "../src/ui";
import { landingPage, boardPage, mePage } from "../src/html";

const viewer = { name: "csp", email: "csp@example.com", display_name: null, admin: false };
const board = { id: "b_csp", title: "CSP", created_by: "csp", created_at: 0, entry_count: 0, last_seq: 0 };

describe("HTML page CSP", () => {
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
      const csp = res.headers.get("content-security-policy") ?? "";
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
