import { describe, expect, it } from "vitest";
import { legacyHostRedirect } from "../src/util";

const env = { PUBLIC_URL: "https://atteo.dev" };
const WD = "https://agent-board.vedu-mallela.workers.dev";
const nav = { accept: "text/html,application/xhtml+xml" };
const go = (u: string, headers: Record<string, string> = nav, method = "GET", e: { PUBLIC_URL?: string } = env) => {
  const url = new URL(u);
  return legacyHostRedirect(e, new Request(url, { method, headers }), url);
};

describe("legacyHostRedirect", () => {
  it("sends browser page visits on workers.dev to atteo.dev, keeping path and query", () => {
    expect(go(`${WD}/`)).toBe("https://atteo.dev/");
    expect(go(`${WD}/b/b_abc123?x=1&y=2`)).toBe("https://atteo.dev/b/b_abc123?x=1&y=2");
    expect(go(`${WD}/inbox`, { "sec-fetch-mode": "navigate" })).toBe("https://atteo.dev/inbox");
    expect(go(`${WD}/me`, nav, "HEAD")).toBe("https://atteo.dev/me");
    expect(go("https://other.example.workers.dev/boards")).toBe("https://atteo.dev/boards");
  });

  it("never redirects the proxy's subrequests (cf-worker) - that would loop", () => {
    expect(go(`${WD}/`, { ...nav, "cf-worker": "atteo.dev" })).toBeNull();
  });

  it("never redirects localhost, atteo.dev itself, or when PUBLIC_URL is unset", () => {
    expect(go("http://localhost:8813/")).toBeNull();
    expect(go("http://127.0.0.1:8813/inbox")).toBeNull();
    expect(go("https://atteo.dev/")).toBeNull();
    expect(go(`${WD}/`, nav, "GET", {})).toBeNull();
    expect(go(`${WD}/`, nav, "GET", { PUBLIC_URL: WD })).toBeNull();
  });

  it("leaves non-navigations alone: POSTs, JSON clients, websockets", () => {
    expect(go(`${WD}/boards`, nav, "POST")).toBeNull();
    expect(go(`${WD}/inbox`, { accept: "application/json" })).toBeNull();
    expect(go(`${WD}/inbox`, {})).toBeNull();
    expect(go(`${WD}/inbox`, { ...nav, upgrade: "websocket" })).toBeNull();
  });

  it("leaves API, MCP, OAuth, health, install and file routes on workers.dev", () => {
    for (const p of [
      "/api/inbox", "/api/boards/b_x/ws", "/api/boards/b_x/upload", "/api/boards/b_x/files", "/mcp", "/mcp/", "/.well-known/oauth-protected-resource",
      "/oauth/authorize", "/oauth/token", "/auth/callback", "/health", "/health/deep", "/install.sh", "/ws", "/upload", "/upload/x", "/files/a.png",
      "/apple-touch-icon.png", "/favicon.ico", "/favicon.svg", "/cli/atteo.mjs", "/a2a", "/stripe/webhook", "/github/webhook", "/avatar/bob", "/openapi.json", "/skill.md",
    ]) {
      expect(go(`${WD}${p}?z=1`, nav), p).toBeNull();
    }
  });

  it("does not exempt look-alike pages", () => {
    expect(go(`${WD}/apis`)).toBe("https://atteo.dev/apis");
    expect(go(`${WD}/auth/login?return=%2F`)).toBe("https://atteo.dev/auth/login?return=%2F");
  });
});
