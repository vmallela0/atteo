import { describe, expect, it, vi } from "vitest";
// mcp.ts reaches the Durable Object class through board.ts; the tool list doesn't need it.
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
import { glamaClaim, registryAuth, serverCard } from "../src/listings";
import { SERVER_NAME, SERVER_VERSION, TOOLS } from "../src/mcp";
import type { Env } from "../src/types";
import indexSource from "../src/index.ts?raw";
import serverJson from "../server.json";
import pkg from "../package.json";

const env = (vars: Partial<Env> = {}) => vars as Env;
const RECORD = "v=MCPv1; k=ed25519; p=MCowBQYDK2VwAyEAexampleexampleexampleexampleexample=";

// Public MCP directories (vedu #6562, docs/MCP_LISTINGS.md).
describe("MCP directory listings", () => {
  it("serves the MCP Registry's domain proof only when MCP_REGISTRY_AUTH is set, as plain text with nothing around it", async () => {
    expect(registryAuth(env()).status).toBe(404);
    expect(registryAuth(env({ MCP_REGISTRY_AUTH: "  " })).status).toBe(404);
    const res = registryAuth(env({ MCP_REGISTRY_AUTH: `${RECORD}\n` }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).toBe(RECORD);
  });

  it("serves Glama's claim only when GLAMA_CLAIM is set", async () => {
    expect(glamaClaim(env()).status).toBe(404);
    const res = glamaClaim(env({ GLAMA_CLAIM: "glama_claim_0123456789abcdefABCDEF_-01234567" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ $schema: "https://glama.ai/mcp/schemas/connector.json", claim: "glama_claim_0123456789abcdefABCDEF_-01234567" });
  });

  it("serves a server card with OAuth required and exactly the tools tools/list serves", async () => {
    const card = (await serverCard().json()) as { serverInfo: { name: string; version: string }; authentication: { required: boolean; schemes: string[] }; tools: { name: string; annotations: unknown }[] };
    expect(card.serverInfo).toMatchObject({ name: SERVER_NAME, version: SERVER_VERSION });
    expect(card.authentication).toEqual({ required: true, schemes: ["oauth2"] });
    expect(card.tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    expect(card.tools[0].annotations).toEqual(TOOLS[0].annotations);
  });

  it("routes the three well-known paths in the app Worker", () => {
    expect(indexSource).toContain('if (path === "/.well-known/mcp-registry-auth") return listings.registryAuth(env);');
    expect(indexSource).toContain('if (path === "/.well-known/glama.json") return listings.glamaClaim(env);');
    expect(indexSource).toContain('if (path === "/.well-known/mcp/server-card.json") return listings.serverCard();');
  });

  it("server.json is a remote-only dev.atteo listing that matches the package version", () => {
    expect(serverJson.$schema).toBe("https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json");
    expect(serverJson.name).toBe("dev.atteo/atteo");
    expect(serverJson.version).toBe(pkg.version);
    expect(serverJson.version).toBe(SERVER_VERSION);
    expect(serverJson.description.length).toBeLessThanOrEqual(100);
    expect(serverJson.websiteUrl).toBe("https://atteo.dev");
    expect(serverJson.remotes).toEqual([{ type: "streamable-http", url: "https://atteo.dev/mcp" }]);
    expect(serverJson).not.toHaveProperty("repository"); // the repo is private
  });
});
