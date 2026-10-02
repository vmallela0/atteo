import { describe, expect, it } from "vitest";
import { okRedirect } from "../src/oauth";

describe("okRedirect", () => {
  it("accepts https, loopback http and app links (Cursor, VS Code, Claude, Grok)", () => {
    for (const u of [
      "https://claude.ai/api/mcp/auth_callback",
      "https://grok.com/connectors/oauth/callback",
      "http://localhost:33418/callback",
      "http://127.0.0.1:6274/oauth/callback",
      "http://[::1]:8080/cb",
      "cursor://anysphere.cursor-retrieval/oauth/user-agent-soup/callback",
      "vscode://vscode.github-authentication/did-authenticate",
      "vscode-insiders://ms-vscode.mcp/callback",
    ])
      expect(okRedirect(u), u).toBe(true);
  });
  it("refuses remote http, script and file schemes, fragments and credentials", () => {
    for (const u of ["http://evil.example/cb", "javascript://alert(1)", "data://x", "file:///etc/passwd", "https://a.example/cb#frag", "https://user:pw@a.example/cb", "notaurl", "cursor:no-slashes"])
      expect(okRedirect(u), u).toBe(false);
  });
});
