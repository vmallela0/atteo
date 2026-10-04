import { describe, expect, it } from "vitest";
import { openapi } from "../src/openapi";

const { readFileSync } = (await import("node:" + "fs")) as { readFileSync: (u: URL, enc: string) => string };
const INDEX = readFileSync(new URL("../src/index.ts", (import.meta as unknown as { url: string }).url), "utf8");

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type Route = { method: HttpMethod; path: string };

/** JSON routes index.ts delegates to tts.ts and voice.ts. */
const DELEGATED: Route[] = [
  { method: "POST", path: "/api/app/tts" },
  { method: "GET", path: "/api/app/tts/status" },
  { method: "POST", path: "/api/app/voice/session" },
  { method: "POST", path: "/api/app/voice/session/end" },
  { method: "GET", path: "/api/app/voice/status" },
];

/**
 * Every path.match in src/index.ts that serves the JSON API, keyed by the regex body (between ^ and $).
 * When index.ts adds a new API path.match, add it here or the test fails.
 */
const MATCH_ROUTES: Record<string, Route[]> = {
  "\\/api\\/boards\\/([^/]+)\\/agents$": [{ method: "GET", path: "/api/boards/{id}/agents" }],
  "\\/api\\/webhooks\\/(\\d+)(\\/test)?$": [
    { method: "DELETE", path: "/api/webhooks/{hid}" },
    { method: "POST", path: "/api/webhooks/{hid}/test" },
  ],
  "\\/api\\/keys\\/([a-z0-9][a-z0-9_.-]{0,31})$": [{ method: "GET", path: "/api/keys/{user}" }],
  "\\/api\\/boards\\/(b_[a-z0-9]+)\\/keys$": [{ method: "GET", path: "/api/boards/{id}/keys" }],
  "\\/api\\/me\\/keys\\/([a-z0-9-]{1,40})$": [{ method: "DELETE", path: "/api/me/keys/{kid}" }],
  "\\/api\\/boards\\/(b_[a-z0-9]+)\\/(epochs|grants)$": [
    { method: "GET", path: "/api/boards/{id}/epochs" },
    { method: "POST", path: "/api/boards/{id}/epochs" },
    { method: "POST", path: "/api/boards/{id}/grants" },
  ],
  "\\/api\\/boards\\/(b_[a-z0-9]+)\\/sealed(?:\\/(\\d+))?$": [
    { method: "GET", path: "/api/boards/{id}/sealed" },
    { method: "GET", path: "/api/boards/{id}/sealed/{seq}" },
    { method: "POST", path: "/api/boards/{id}/sealed" },
  ],
  "\\/api\\/approvals(?:\\/(ap_[A-Za-z0-9_-]+))?(?:\\/(approve|reject))?$": [
    { method: "GET", path: "/api/approvals" },
    { method: "GET", path: "/api/approvals/{aid}" },
    { method: "POST", path: "/api/approvals/{aid}/{decision}" },
  ],
  "\\/api\\/dm\\/([a-z0-9][a-z0-9_.-]{0,31})(?:\\/([a-z0-9][a-z0-9._-]{0,31}))?$": [
    { method: "POST", path: "/api/dm/{user}" },
    { method: "POST", path: "/api/dm/{user}/{session}" },
  ],
  "\\/api\\/contacts\\/([a-z0-9][a-z0-9_.-]{0,31})\\/(accept|decline)$": [{ method: "POST", path: "/api/contacts/{user}/{decision}" }],
  "\\/api\\/agents\\/([^/]+)$": [
    { method: "GET", path: "/api/agents/{user}" },
    { method: "POST", path: "/api/agents/me" },
  ],
  "\\/api\\/people\\/([a-z0-9][a-z0-9_.-]{0,31})$": [{ method: "GET", path: "/api/people/{user}" }],
  "\\/api\\/friends\\/([a-z0-9][a-z0-9_.-]{0,31})\\/(accept|decline|remove|block|unblock)$": [{ method: "POST", path: "/api/friends/{user}/{action}" }],
  "\\/api\\/direct\\/([a-z0-9][a-z0-9_.-]{0,31})$": [{ method: "POST", path: "/api/direct/{user}" }],
  "\\/api\\/boards\\/([^/]+)\\/(rename|archive|unarchive)$": [
    { method: "POST", path: "/api/boards/{id}/rename" },
    { method: "POST", path: "/api/boards/{id}/archive" },
    { method: "POST", path: "/api/boards/{id}/unarchive" },
  ],
  "\\/api\\/boards\\/([^/]+)$": [{ method: "DELETE", path: "/api/boards/{id}" }],
  "\\/api\\/boards\\/([^/]+)\\/restore$": [{ method: "POST", path: "/api/boards/{id}/restore" }],
  "\\/api\\/boards\\/([^/]+)\\/delete$": [{ method: "POST", path: "/api/boards/{id}/delete" }],
  "\\/api\\/boards\\/([^/]+)\\/picture$": [
    { method: "POST", path: "/api/boards/{id}/picture" },
    { method: "DELETE", path: "/api/boards/{id}/picture" },
  ],
  "\\/api\\/boards\\/(b_[a-z0-9]+)\\/(members|links|audit)(?:\\/([^/]+))?$": [
    { method: "GET", path: "/api/boards/{id}/members" },
    { method: "POST", path: "/api/boards/{id}/members/{user}" },
    { method: "GET", path: "/api/boards/{id}/audit" },
    { method: "GET", path: "/api/boards/{id}/links" },
    { method: "POST", path: "/api/boards/{id}/links" },
    { method: "DELETE", path: "/api/boards/{id}/links/{lid}" },
  ],
  "\\/api\\/boards\\/([^/]+)\\/members\\/([^/]+)\\/remove$": [{ method: "POST", path: "/api/boards/{id}/members/{user}/remove" }],
  "\\/api\\/boards\\/([^/]+)\\/ws$": [{ method: "GET", path: "/api/boards/{id}/ws" }],
  "\\/api\\/sessions(?:\\/([^/]+))?(?:\\/(boards|read|wait))?(?:\\/([^/]+))?$": [
    { method: "GET", path: "/api/sessions" },
    { method: "POST", path: "/api/sessions" },
    { method: "DELETE", path: "/api/sessions" },
    { method: "GET", path: "/api/sessions/{sid}" },
    { method: "POST", path: "/api/sessions/{sid}" },
    { method: "DELETE", path: "/api/sessions/{sid}" },
    { method: "POST", path: "/api/sessions/{sid}/boards" },
    { method: "DELETE", path: "/api/sessions/{sid}/boards/{id}" },
    { method: "GET", path: "/api/sessions/{sid}/read" },
    { method: "GET", path: "/api/sessions/{sid}/wait" },
  ],
  "\\/api\\/boards\\/([^/]+)\\/(image|upload)$": [
    { method: "GET", path: "/api/boards/{id}/image" },
    { method: "POST", path: "/api/boards/{id}/upload" },
  ],
  "\\/api\\/boards\\/([^/]+)\\/(doc|docs|files|doc-history)$": [
    { method: "GET", path: "/api/boards/{id}/docs" },
    { method: "GET", path: "/api/boards/{id}/files" },
    { method: "GET", path: "/api/boards/{id}/doc-history" },
    { method: "GET", path: "/api/boards/{id}/doc" },
    { method: "POST", path: "/api/boards/{id}/doc" },
  ],
  "\\/api\\/boards\\/(b_[a-z0-9]+)\\/approvals$": [{ method: "GET", path: "/api/boards/{id}/approvals" }],
  "\\/api\\/boards\\/(b_[a-z0-9]+)\\/triggers(?:\\/(tr_[a-z0-9]+))?$": [
    { method: "GET", path: "/api/boards/{id}/triggers" },
    { method: "POST", path: "/api/boards/{id}/triggers" },
    { method: "PATCH", path: "/api/boards/{id}/triggers/{tid}" },
    { method: "DELETE", path: "/api/boards/{id}/triggers/{tid}" },
  ],
  "\\/api\\/boards\\/(b_[a-z0-9]+)\\/schedules(?:\\/(sc_[a-z0-9]+))?$": [
    { method: "GET", path: "/api/boards/{id}/schedules" },
    { method: "POST", path: "/api/boards/{id}/schedules" },
    { method: "PATCH", path: "/api/boards/{id}/schedules/{sid}" },
    { method: "DELETE", path: "/api/boards/{id}/schedules/{sid}" },
  ],
  "\\/api\\/boards\\/(b_[a-z0-9]+)\\/recap$": [{ method: "GET", path: "/api/boards/{id}/recap" }],
  "\\/api\\/boards\\/(b_[a-z0-9]+)\\/pin$": [
    { method: "GET", path: "/api/boards/{id}/pin" },
    { method: "POST", path: "/api/boards/{id}/pin" },
    { method: "DELETE", path: "/api/boards/{id}/pin" },
  ],
  "\\/api\\/boards\\/(b_[a-z0-9]+)\\/soul$": [
    { method: "GET", path: "/api/boards/{id}/soul" },
    { method: "PUT", path: "/api/boards/{id}/soul" },
  ],
  "\\/api\\/boards\\/(b_[a-z0-9]+)\\/memory(?:\\/m?(\\d+))?$": [
    { method: "GET", path: "/api/boards/{id}/memory" },
    { method: "POST", path: "/api/boards/{id}/memory" },
    { method: "DELETE", path: "/api/boards/{id}/memory/{mid}" },
  ],
  "\\/api\\/boards\\/(b_[a-z0-9]+)$": [{ method: "GET", path: "/api/boards/{id}" }],
  "\\/api\\/boards\\/([^/]+)\\/(?:entries\\/(\\d+)\\/react|reactions)$": [
    { method: "GET", path: "/api/boards/{id}/reactions" },
    { method: "POST", path: "/api/boards/{id}/entries/{seq}/react" },
  ],
  "\\/api\\/boards\\/(b_[a-z0-9]+)\\/retention$": [{ method: "POST", path: "/api/boards/{id}/retention" }],
  "\\/api\\/boards\\/([^/]+)\\/meta$": [{ method: "POST", path: "/api/boards/{id}/meta" }],
  "\\/api\\/boards\\/([^/]+)\\/claims$": [{ method: "GET", path: "/api/boards/{id}/claims" }],
  "\\/api\\/boards\\/([^/]+)\\/claims\\/(\\d+)$": [{ method: "POST", path: "/api/boards/{id}/claims/{seq}" }],
  "\\/api\\/boards\\/([^/]+)\\/tasks(?:\\/(\\d+))?$": [
    { method: "GET", path: "/api/boards/{id}/tasks" },
    { method: "POST", path: "/api/boards/{id}/tasks" },
    { method: "GET", path: "/api/boards/{id}/tasks/{seq}" },
    { method: "POST", path: "/api/boards/{id}/tasks/{seq}" },
  ],
  "\\/api\\/boards\\/([^/]+)\\/entries\\/(\\d+)\\/review$": [{ method: "POST", path: "/api/boards/{id}/entries/{seq}/review" }],
  "\\/api\\/boards\\/([^/]+)\\/entries\\/(\\d+)\\/(vote|close)$": [
    { method: "POST", path: "/api/boards/{id}/entries/{seq}/vote" },
    { method: "POST", path: "/api/boards/{id}/entries/{seq}/close" },
  ],
  "\\/api\\/boards\\/([^/]+)\\/entries\\/(\\d+)\\/retract$": [{ method: "POST", path: "/api/boards/{id}/entries/{seq}/retract" }],
  "\\/api\\/boards\\/([^/]+)\\/(updates|entries|invites|seen|search|grep|handle|typing|answered|handoffs)(?:\\/(\\d+))?$": [
    { method: "GET", path: "/api/boards/{id}/updates" },
    { method: "GET", path: "/api/boards/{id}/entries" },
    { method: "POST", path: "/api/boards/{id}/entries" },
    { method: "GET", path: "/api/boards/{id}/entries/{seq}" },
    { method: "POST", path: "/api/boards/{id}/invites" },
    { method: "POST", path: "/api/boards/{id}/seen" },
    { method: "GET", path: "/api/boards/{id}/search" },
    { method: "GET", path: "/api/boards/{id}/grep" },
    { method: "POST", path: "/api/boards/{id}/handle/{seq}" },
    { method: "POST", path: "/api/boards/{id}/typing" },
    { method: "POST", path: "/api/boards/{id}/answered/{seq}" },
    { method: "GET", path: "/api/boards/{id}/handoffs" },
  ],
  "\\/api\\/invitations\\/([^/]+)\\/(accept|decline)$": [
    { method: "POST", path: "/api/invitations/{id}/accept" },
    { method: "POST", path: "/api/invitations/{id}/decline" },
  ],
  "\\/api\\/tokens\\/([^/]+)\\/revoke$": [{ method: "POST", path: "/api/tokens/{tid}/revoke" }],
};

/** path.match patterns in index.ts that are guards, not routes. */
const SKIP_MATCH = new Set([
  "\\/(?:api\\/boards|b)\\/(b_[a-z0-9]{8,32})(?:\\/|$)",
  "\\/api\\/boards\\/(b_[a-z0-9]+)\\/(.+)$",
]);

function shouldDocument(path: string): boolean {
  return (
    path.startsWith("/api/") ||
    path === "/mcp" ||
    path.startsWith("/health") ||
    path.startsWith("/oauth/") ||
    path.startsWith("/.well-known/") ||
    path === "/a2a" ||
    path === "/openapi.json"
  );
}

function addRoute(routes: Route[], method: HttpMethod, path: string) {
  if (!shouldDocument(path)) return;
  routes.push({ method, path });
}

function routesFromIndex(): Route[] {
  const routes: Route[] = [...DELEGATED];

  addRoute(routes, "GET", "/mcp");
  addRoute(routes, "POST", "/mcp");
  addRoute(routes, "DELETE", "/mcp");
  addRoute(routes, "GET", "/health");
  addRoute(routes, "GET", "/health/deep");

  for (const m of INDEX.matchAll(/if \(path === "([^"]+)" && method === "([A-Z]+)"/g)) addRoute(routes, m[2] as HttpMethod, m[1]);
  for (const m of INDEX.matchAll(/if \(path === "([^"]+)" && \(method === "([A-Z]+)" \|\| method === "([A-Z]+)"\)/g)) {
    addRoute(routes, m[2] as HttpMethod, m[1]);
    addRoute(routes, m[3] as HttpMethod, m[1]);
  }
  for (const m of INDEX.matchAll(/\(path === "([^"]+)" \|\| path === "([^"]+)"\) && method === "([A-Z]+)"/g)) {
    addRoute(routes, m[3] as HttpMethod, m[1]);
    addRoute(routes, m[3] as HttpMethod, m[2]);
  }
  for (const m of INDEX.matchAll(/\(path === "([^"]+)" && method === "([A-Z]+)"\) \|\| \(path === "([^"]+)" && method === "([A-Z]+)"\)/g)) {
    addRoute(routes, m[2] as HttpMethod, m[1]);
    addRoute(routes, m[4] as HttpMethod, m[3]);
  }
  for (const m of INDEX.matchAll(/if \(path === "([^"]+)" \|\| path === "([^"]+)"\)/g)) {
    addRoute(routes, "GET", m[1]);
    addRoute(routes, "GET", m[2]);
  }
  for (const m of INDEX.matchAll(/if \(path === "([^"]+)"\) return/g)) addRoute(routes, "GET", m[1]);
  if (INDEX.includes('if (path === "/api/ops/limits")')) {
    addRoute(routes, "GET", "/api/ops/limits");
    addRoute(routes, "POST", "/api/ops/limits");
  }

  const apiMatchKeys = new Set<string>();
  for (const m of INDEX.matchAll(/path\.match\(\/\^(.+?)\/\)/g)) {
    const key = m[1];
    if (!key.includes("api\\/") && !key.includes("api/")) continue;
    if (SKIP_MATCH.has(key)) continue;
    apiMatchKeys.add(key);
    const mapped = MATCH_ROUTES[key];
    if (!mapped) throw new Error(`index.ts path.match /^${key}$/ is not listed in MATCH_ROUTES (test/openapi-routes.test.ts)`);
    routes.push(...mapped);
  }

  const unused = Object.keys(MATCH_ROUTES).filter((k) => !apiMatchKeys.has(k));
  if (unused.length) throw new Error(`MATCH_ROUTES has stale entries (no longer in index.ts): ${unused.join(", ")}`);

  const seen = new Set<string>();
  return routes.filter((r) => {
    const k = `${r.method} ${r.path}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function routesFromOpenapi() {
  const doc = openapi("https://example.test");
  const routes: Route[] = [];
  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const method of Object.keys(ops)) {
      if (method === "parameters") continue;
      routes.push({ method: method.toUpperCase() as HttpMethod, path });
    }
  }
  return routes;
}

describe("openapi route coverage", () => {
  it("lists every JSON API route from src/index.ts and fails when openapi.ts lacks one", () => {
    const indexRoutes = routesFromIndex();
    const doc = openapi("https://example.test");
    const paths = doc.paths as Record<string, Record<string, unknown>>;
    const missing = indexRoutes.filter(({ method, path }) => !paths[path]?.[method.toLowerCase()]);
    expect(missing, `openapi.json is missing ${missing.length} route(s) from index.ts:\n${missing.map((r) => `${r.method} ${r.path}`).join("\n")}`).toEqual([]);
  });

  it("does not document routes that index.ts no longer serves", () => {
    const index = new Set(routesFromIndex().map((r) => `${r.method} ${r.path}`));
    const extra = routesFromOpenapi().filter((r) => !index.has(`${r.method} ${r.path}`));
    expect(extra, `openapi.json documents ${extra.length} route(s) not in index.ts:\n${extra.map((r) => `${r.method} ${r.path}`).join("\n")}`).toEqual([]);
  });
});
