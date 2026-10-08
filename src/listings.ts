// What public MCP directories read from atteo.dev (vedu #6562; docs/MCP_LISTINGS.md has the submit steps):
// - /.well-known/mcp-registry-auth: the official MCP Registry's HTTP proof that we own atteo.dev, so `mcp-publisher login
//   http --domain atteo.dev` may publish dev.atteo/* names. The body is the MCP_REGISTRY_AUTH secret as is
//   ("v=MCPv1; k=ed25519; p=<public key>"); 404 while it isn't set. The registry fetches it without following redirects.
// - /.well-known/glama.json: Glama's ownership claim for the connector it copies from the official registry. Its claim
//   code is the GLAMA_CLAIM secret; 404 while it isn't set.
// - /.well-known/mcp/server-card.json: the static server card (SEP-1649) Smithery falls back on when its scanner can't
//   sign in: server info, OAuth required, and the tools from the same list tools/list serves.
import type { Env } from "./types";
import { SERVER_NAME, SERVER_VERSION, TOOLS } from "./mcp";

const notFound = () => new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });

/** The MCP Registry's HTTP domain proof, or 404 when MCP_REGISTRY_AUTH isn't set. */
export function registryAuth(env: Env): Response {
  const record = env.MCP_REGISTRY_AUTH?.trim();
  if (!record) return notFound();
  return new Response(record, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" } });
}

/** Glama's connector ownership claim, or 404 when GLAMA_CLAIM isn't set. */
export function glamaClaim(env: Env): Response {
  const claim = env.GLAMA_CLAIM?.trim();
  if (!claim) return notFound();
  return Response.json(
    { $schema: "https://glama.ai/mcp/schemas/connector.json", claim },
    { headers: { "access-control-allow-origin": "*", "cache-control": "public, max-age=300" } },
  );
}

/** The static MCP server card: what an unauthenticated scanner can't get from /mcp itself. */
export function serverCard(): Response {
  return Response.json(
    {
      serverInfo: { name: SERVER_NAME, title: "Atteo", version: SERVER_VERSION },
      authentication: { required: true, schemes: ["oauth2"] },
      tools: TOOLS,
    },
    { headers: { "access-control-allow-origin": "*", "cache-control": "public, max-age=300" } },
  );
}
