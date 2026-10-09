// OAuth Client ID Metadata Documents (vedu #6575): src/cimd.ts and its use in src/oauth.ts, with a mocked fetch.
import { beforeEach, describe, expect, it } from "vitest";
import { CIMD_MAX_BYTES, cacheSeconds, checkClientIdUrl, cleanName, clearCimdCache, resolveCimdClient, type CimdOptions } from "../src/cimd";
import { authorizationServer, CIMD_FETCHES_PER_CLIENT, CIMD_FETCHES_PER_PERSON, cimdFetchCap, cimdLabel, cimdStore, exchange, finishAuthorize, register, startAuthorize, type ClientLookup } from "../src/oauth";
import { consentPage } from "../src/oauthPage";
import type { Env } from "../src/types";

const { DatabaseSync } = (await import("node:" + "sqlite")) as { DatabaseSync: new (p: string) => any };
const { readFileSync, readdirSync } = (await import("node:" + "fs")) as { readFileSync: (u: URL, enc: string) => string; readdirSync: (u: URL) => string[] };
const { createHash, randomBytes } = (await import("node:" + "crypto")) as any;
const dir = new URL("../migrations/", (import.meta as unknown as { url: string }).url);

function fakeEnv() {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(f, dir), "utf8"));
  const stmt = (sql: string, args: unknown[] = []): any => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => {
      const r = db.prepare(sql).run(...args);
      return { results: [], meta: { changes: r.changes } };
    },
  });
  return { env: { DB: { prepare: (sql: string) => stmt(sql) } } as unknown as Env, db };
}

// Smithery Connect's live document (fetched Oct 8 2026): client_uri and logo_uri on another host than client_id.
const ID = "https://connect.smithery.ai/.well-known/oauth-client";
const CB = "https://connect.smithery.ai/oauth/callback";
const DOC = {
  client_id: ID,
  client_name: "Smithery Connect",
  client_uri: "https://smithery.ai",
  logo_uri: "https://smithery.ai/logos/profile.png",
  redirect_uris: [CB],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
};
const OWN = ["atteo.dev", "agent-board.vedu-mallela.workers.dev"];

const json = (doc: unknown, headers: Record<string, string> = {}, status = 200) =>
  new Response(typeof doc === "string" ? doc : JSON.stringify(doc), { status, headers: { "content-type": "application/json", ...headers } });

/** A fetch that answers from `answer` and records each call. */
function mock(answer: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (u: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(u), init: init ?? {} });
    return answer(String(u), init ?? {});
  }) as typeof fetch;
  return { f, calls };
}
const opts = (f: typeof fetch, extra: Partial<CimdOptions> = {}): CimdOptions => ({ ownHosts: OWN, fetch: f, ...extra });

beforeEach(() => clearCimdCache());

describe("client_id URL rules (before anything is fetched)", () => {
  it("accepts a canonical https URL with a path on a public host", () => {
    expect(checkClientIdUrl(ID, { ownHosts: OWN }).host).toBe("connect.smithery.ai");
    expect(checkClientIdUrl("https://app.example.com.au/oauth/client.json", { ownHosts: OWN }).host).toBe("app.example.com.au");
  });
  it.each([
    ["http://connect.smithery.ai/c.json", "https"],
    ["https://1.2.3.4/c.json", "public host"],
    ["https://169.254.169.254/latest/meta-data", "public host"],
    ["https://[::1]/c.json", "public host"],
    ["https://[fd00::1]/c.json", "public host"],
    ["https://localhost/c.json", "public host"],
    ["https://api.localhost/c.json", "public host"],
    ["https://printer.local/c.json", "public host"],
    ["https://metadata.google.internal/c.json", "public host"],
    ["https://router.lan/c.json", "public host"],
    ["https://intranet/c.json", "public host"],
    ["https://atteo.dev/files/doc.json", "own host"],
    ["https://evil.atteo.dev/doc.json", "own host"],
    ["https://agent-board.vedu-mallela.workers.dev/x.json", "own host"],
    ["https://user:pw@example.com/c.json", "username or password"],
    ["https://example.com/c.json#x", "fragment"],
    ["https://example.com/c.json#", "fragment"],
    ["https://example.com/c.json?x=1", "query"],
    ["https://example.com:8443/c.json", "port"],
    ["https://example.com", "path"],
    ["https://example.com/", "path"],
    ["https://example.com/a/../c.json", "canonical"],
    ["https://example.com/a/./c.json", "canonical"],
    ["https://example.com/a/%2e%2e/c.json", "canonical"],
    ["https://Example.com/c.json", "canonical"],
    ["https://example.com:443/c.json", "canonical"],
    ["https://exämple.com/c.json", "canonical"],
    ["https://0x7f.0.0.1/c.json", "canonical"],
    ["https://example.com./c.json", "public host"],
    ["javascript:alert(1)//x", "https"],
    ["not a url", "isn't a URL"],
  ])("refuses %s", (raw, why) => {
    expect(() => checkClientIdUrl(raw, { ownHosts: OWN })).toThrow(why);
  });
  it("localhost documents only with allowLocal (a local test server)", () => {
    const u = "http://localhost:8610/__cimd-test/x";
    expect(() => checkClientIdUrl(u, { ownHosts: ["localhost"] })).toThrow();
    expect(checkClientIdUrl(u, { ownHosts: ["localhost"], allowLocal: true }).host).toBe("localhost:8610");
    // allowLocal never opens other private hosts.
    expect(() => checkClientIdUrl("https://10.0.0.1/x", { ownHosts: [], allowLocal: true })).toThrow("public host");
    expect(() => checkClientIdUrl("http://example.com/x", { ownHosts: [], allowLocal: true })).toThrow("https");
  });
});

describe("fetching and checking the document", () => {
  it("happy path: Smithery's document; a plain GET, no redirects, no cookies or credentials, a timeout", async () => {
    const m = mock(() => json(DOC));
    const c = await resolveCimdClient(ID, opts(m.f));
    expect(c).toEqual({ client_id: ID, name: "Smithery Connect", host: "connect.smithery.ai", redirect_uris: [CB] });
    expect(m.calls).toHaveLength(1);
    const { url, init } = m.calls[0];
    expect(url).toBe(ID);
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(Object.keys(init).sort()).toEqual(["headers", "method", "redirect", "signal"]);
    const headers = new Headers(init.headers);
    expect([...headers.keys()]).toEqual(["accept"]);
  });

  it("client_id in the document must equal the URL exactly", async () => {
    for (const other of [`${ID}/`, ID.toUpperCase(), "https://connect.smithery.ai/.well-known/oauth-client?x", "https://evil.example/c.json", undefined]) {
      const m = mock(() => json({ ...DOC, client_id: other }));
      await expect(resolveCimdClient(ID, opts(m.f))).rejects.toMatchObject({ code: "invalid_client", message: expect.stringContaining("different client_id") });
    }
  });

  it("a redirect is refused, not followed", async () => {
    for (const status of [301, 302, 307, 308]) {
      const m = mock(() => new Response(null, { status, headers: { location: "http://169.254.169.254/" } }));
      await expect(resolveCimdClient(ID, opts(m.f))).rejects.toMatchObject({ code: "invalid_client", message: expect.stringContaining("redirects") });
      expect(m.calls).toHaveLength(1);
    }
  });

  it("an oversized document is refused, with or without a content-length", async () => {
    const big = JSON.stringify({ ...DOC, client_name: "x".repeat(CIMD_MAX_BYTES) });
    const declared = mock(() => json(big));
    await expect(resolveCimdClient(ID, opts(declared.f))).rejects.toThrow("larger than 5 KB");
    // Streamed, no content-length: the read stops past the cap.
    const streamed = mock(() => {
      const enc = new TextEncoder().encode(big);
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          if (sent >= enc.length) return c.close();
          c.enqueue(enc.slice(sent, sent + 1024));
          sent += 1024;
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    });
    await expect(resolveCimdClient(ID, opts(streamed.f))).rejects.toThrow("larger than 5 KB");
    // A false content-length doesn't help either.
    const lying = mock(() => new Response(big, { status: 200, headers: { "content-type": "application/json", "content-length": "100" } }));
    await expect(resolveCimdClient(ID, opts(lying.f))).rejects.toThrow();
  });

  it("must be JSON: content type and body", async () => {
    for (const ct of ["text/html", "text/plain", "application/javascript", ""]) {
      const m = mock(() => new Response(JSON.stringify(DOC), { status: 200, headers: ct ? { "content-type": ct } : {} }));
      await expect(resolveCimdClient(ID, opts(m.f))).rejects.toMatchObject({ code: "invalid_client", message: expect.stringContaining("isn't JSON") });
    }
    for (const ct of ["application/json; charset=utf-8", "application/oauth-client+json"]) {
      clearCimdCache();
      const m = mock(() => new Response(JSON.stringify(DOC), { status: 200, headers: { "content-type": ct } }));
      expect((await resolveCimdClient(ID, opts(m.f))).name).toBe("Smithery Connect");
    }
    clearCimdCache();
    await expect(resolveCimdClient(ID, opts(mock(() => json("{not json")).f))).rejects.toThrow("isn't valid JSON");
    await expect(resolveCimdClient(ID, opts(mock(() => json([DOC])).f))).rejects.toThrow("isn't a JSON object");
  });

  it("a timeout is a temporary failure (503), and isn't cached", async () => {
    const hang = mock(
      (_u, init) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new DOMException("aborted", "AbortError")));
        }),
    );
    const t0 = Date.now();
    await expect(resolveCimdClient(ID, opts(hang.f, { timeoutMs: 40 }))).rejects.toMatchObject({ code: "temporarily_unavailable", status: 503, message: expect.stringContaining("too long") });
    expect(Date.now() - t0).toBeLessThan(2000);
    const m = mock(() => json(DOC));
    expect((await resolveCimdClient(ID, opts(m.f))).name).toBe("Smithery Connect");
    expect(m.calls).toHaveLength(1);
  });

  it("status codes: 200 only; 5xx is temporary, 4xx is a bad client", async () => {
    await expect(resolveCimdClient(ID, opts(mock(() => json({ error: "x" }, {}, 404)).f))).rejects.toMatchObject({ code: "invalid_client" });
    await expect(resolveCimdClient(ID, opts(mock(() => json(DOC, {}, 201)).f))).rejects.toMatchObject({ code: "invalid_client" });
    await expect(resolveCimdClient(ID, opts(mock(() => json(DOC, {}, 502)).f))).rejects.toMatchObject({ code: "temporarily_unavailable", status: 503 });
    await expect(resolveCimdClient(ID, opts(mock(() => Promise.reject(new TypeError("network"))).f))).rejects.toMatchObject({ code: "temporarily_unavailable" });
  });

  it("token_endpoint_auth_method: none (or absent) only; no secrets", async () => {
    const { token_endpoint_auth_method: _, ...noMethod } = DOC;
    expect((await resolveCimdClient(ID, opts(mock(() => json(noMethod)).f))).client_id).toBe(ID);
    for (const [doc, why] of [
      [{ ...DOC, token_endpoint_auth_method: "private_key_jwt", jwks_uri: "https://connect.smithery.ai/jwks" }, "private_key_jwt"],
      [{ ...DOC, token_endpoint_auth_method: "client_secret_basic" }, "only \"none\""],
      [{ ...DOC, token_endpoint_auth_method: "client_secret_post" }, "only \"none\""],
      [{ ...DOC, client_secret: "s3cret" }, "client_secret"],
      [{ ...DOC, grant_types: ["client_credentials"] }, "authorization_code"],
      [{ ...DOC, response_types: ["token"] }, "response_type code"],
    ] as const) {
      clearCimdCache();
      await expect(resolveCimdClient(ID, opts(mock(() => json(doc)).f))).rejects.toThrow(why);
    }
  });

  it("redirect_uris: https or http://localhost only; app links (atteo://) and remote http are dropped", async () => {
    const m = mock(() => json({ ...DOC, redirect_uris: [CB, "atteo://auth", "agentsoup://auth", "http://evil.example/cb", "javascript://x", "http://127.0.0.1:3000/callback", "https://a.example/cb#f", 7] }));
    expect((await resolveCimdClient(ID, opts(m.f))).redirect_uris).toEqual([CB, "http://127.0.0.1:3000/callback"]);
    clearCimdCache();
    await expect(resolveCimdClient(ID, opts(mock(() => json({ ...DOC, redirect_uris: ["atteo://auth"] })).f))).rejects.toThrow("no usable redirect_uris");
    await expect(resolveCimdClient(ID, opts(mock(() => json({ ...DOC, redirect_uris: CB })).f))).rejects.toThrow("no redirect_uris");
  });

  it("client_name is display text: control, bidi and zero-width characters go; the host stands in for a missing one", async () => {
    expect(cleanName("Smi‮thery​ Conn\u0007ect  ", "h")).toBe("Smithery Connect");
    expect(cleanName("​‮", "connect.smithery.ai")).toBe("connect.smithery.ai");
    expect(cleanName(42, "connect.smithery.ai")).toBe("connect.smithery.ai");
    expect(cleanName("x".repeat(100), "h")).toHaveLength(60);
    const { client_name: _, ...unnamed } = DOC;
    expect((await resolveCimdClient(ID, opts(mock(() => json(unnamed)).f))).name).toBe("connect.smithery.ai");
  });
});

describe("a per-person cap on fetches (beforeFetch)", () => {
  it("is asked only when the cache can't answer; a refusal is a 429 and nothing is fetched", async () => {
    const m = mock(() => json(DOC));
    let asked = 0;
    let allow = false;
    const o = opts(m.f, { beforeFetch: async () => (asked++, allow) });
    await expect(resolveCimdClient(ID, o)).rejects.toMatchObject({ status: 429 });
    expect(m.calls).toHaveLength(0);
    allow = true;
    await resolveCimdClient(ID, o);
    await resolveCimdClient(ID, o);
    expect([asked, m.calls.length]).toEqual([2, 1]);
    // Refused URLs never get that far.
    await expect(resolveCimdClient("https://127.0.0.1/c.json", o)).rejects.toMatchObject({ code: "invalid_client" });
    expect(asked).toBe(2);
  });
});

describe("caching", () => {
  it("max-age within an hour; no-store and no-cache aren't cached; five minutes without a header", () => {
    expect(cacheSeconds(null)).toBe(300);
    expect(cacheSeconds("public, max-age=600")).toBe(600);
    expect(cacheSeconds("max-age=86400")).toBe(3600);
    expect(cacheSeconds("max-age=0")).toBe(0);
    expect(cacheSeconds("no-store")).toBe(0);
    expect(cacheSeconds("private, no-cache")).toBe(0);
  });

  it("a good document is fetched once, then served from the cache until its time is up", async () => {
    let now = 1_000_000;
    const m = mock(() => json(DOC, { "cache-control": "max-age=60" }));
    const o = opts(m.f, { now: () => now });
    await resolveCimdClient(ID, o);
    now += 59_000;
    await resolveCimdClient(ID, o);
    expect(m.calls).toHaveLength(1);
    now += 2_000;
    await resolveCimdClient(ID, o);
    expect(m.calls).toHaveLength(2);
  });

  it("the cap holds (a day asked, an hour kept), keyed by the exact URL", async () => {
    let now = 0;
    const m = mock((u) => json({ ...DOC, client_id: u }, { "cache-control": "max-age=86400" }));
    const o = opts(m.f, { now: () => now });
    await resolveCimdClient(ID, o);
    await resolveCimdClient("https://connect.smithery.ai/.well-known/oauth-client-2", o);
    expect(m.calls).toHaveLength(2);
    now = 3_599_000;
    await resolveCimdClient(ID, o);
    expect(m.calls).toHaveLength(2);
    now = 3_601_000;
    await resolveCimdClient(ID, o);
    expect(m.calls).toHaveLength(3);
  });

  it("no-store documents and failures are never cached", async () => {
    const m = mock(() => json(DOC, { "cache-control": "no-store" }));
    await resolveCimdClient(ID, opts(m.f));
    await resolveCimdClient(ID, opts(m.f));
    expect(m.calls).toHaveLength(2);
    clearCimdCache();
    let fail = true;
    const flaky = mock(() => (fail ? json(DOC, {}, 500) : json(DOC)));
    await expect(resolveCimdClient(ID, opts(flaky.f))).rejects.toThrow();
    fail = false;
    await resolveCimdClient(ID, opts(flaky.f));
    expect(flaky.calls).toHaveLength(2);
  });
});

// ---------- through src/oauth.ts ----------

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};
const authorizeParams = (client_id: string, redirect_uri: string, challenge: string, extra: Record<string, string> = {}) =>
  new URLSearchParams({ response_type: "code", client_id, redirect_uri, code_challenge: challenge, code_challenge_method: "S256", state: "st", ...extra });
const lookupWith = (f: typeof fetch): ClientLookup => ({ ownHosts: OWN, fetch: f });

/** Authorize + allow: the code Smithery would get back. */
async function codeFor(env: Env, lookup: ClientLookup, challenge: string) {
  const r = await startAuthorize(env, "ada", authorizeParams(ID, CB, challenge), lookup);
  const back = new URL(await finishAuthorize(env, "ada", r.id, true));
  return { r, code: back.searchParams.get("code")!, back };
}

describe("the OAuth flow with a URL client_id", () => {
  it("advertises client_id_metadata_document_supported and keeps registration", () => {
    const as = authorizationServer("https://atteo.dev");
    expect(as.client_id_metadata_document_supported).toBe(true);
    expect(as.registration_endpoint).toBe("https://atteo.dev/oauth/register");
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    expect(as.token_endpoint_auth_methods_supported).toEqual(["none"]);
  });

  it("happy path: authorize shows the domain, the code exchanges for tokens bound to the URL, refresh rotates", async () => {
    const { env, db } = fakeEnv();
    const m = mock(() => json(DOC));
    const lookup = lookupWith(m.f);
    const { verifier, challenge } = pkce();
    const { r, code, back } = await codeFor(env, lookup, challenge);
    expect(r.client.name).toBe("Smithery Connect");
    expect(r.host).toBe("connect.smithery.ai");
    expect(r.person).toBe(false);
    expect(back.origin + back.pathname).toBe(CB);
    expect(back.searchParams.get("state")).toBe("st");
    // Nothing registered: no oauth_clients row for a URL client.
    expect(db.prepare(`SELECT COUNT(*) AS n FROM oauth_clients`).get().n).toBe(0);
    const t = await exchange(env, { grant_type: "authorization_code", code, redirect_uri: CB, client_id: ID, code_verifier: verifier }, null, lookup);
    expect(t.access_token).toMatch(/^ab_/);
    expect(t.scope).toBe("board");
    expect(db.prepare(`SELECT client_id FROM oauth_refresh_tokens`).get().client_id).toBe(ID);
    expect(db.prepare(`SELECT label, kind FROM tokens`).get()).toEqual({ label: "Smithery Connect · connect.smithery.ai", kind: "cli" });
    expect(m.calls).toHaveLength(1); // the token call used the cached document
    const t2 = await exchange(env, { grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: ID }, null, lookup);
    expect(t2.access_token).not.toBe(t.access_token);
    expect(db.prepare(`SELECT label FROM tokens WHERE revoked_at IS NULL`).all()).toEqual([{ label: "Smithery Connect · connect.smithery.ai" }]);
  });

  it("the connection's label keeps the whole domain, even with a 60-character name", async () => {
    const { env, db } = fakeEnv();
    const lookup = lookupWith(mock(() => json({ ...DOC, client_name: "S".repeat(60) })).f);
    const { verifier, challenge } = pkce();
    const { code } = await codeFor(env, lookup, challenge);
    await exchange(env, { grant_type: "authorization_code", code, client_id: ID, code_verifier: verifier }, null, lookup);
    const label = db.prepare(`SELECT label FROM tokens`).get().label as string;
    expect(label.length).toBeLessThanOrEqual(80);
    expect(label.endsWith(" · connect.smithery.ai")).toBe(true);
    expect(cimdLabel("x", "h".repeat(100))).toBe("h".repeat(80));
  });

  it("refuses a redirect_uri the document doesn't list, and a mismatched document", async () => {
    const { env } = fakeEnv();
    const { challenge } = pkce();
    const lookup = lookupWith(mock(() => json(DOC)).f);
    for (const redirect of ["https://connect.smithery.ai/oauth/callback/", "https://evil.example/cb", "atteo://auth"])
      await expect(startAuthorize(env, "ada", authorizeParams(ID, redirect, challenge), lookup)).rejects.toMatchObject({ code: "invalid_request" });
    clearCimdCache();
    const bad = lookupWith(mock(() => json({ ...DOC, client_id: "https://connect.smithery.ai/other" })).f);
    await expect(startAuthorize(env, "ada", authorizeParams(ID, CB, challenge), bad)).rejects.toMatchObject({ code: "invalid_client" });
  });

  it("never the person scope, even if a document lists the app's own link", async () => {
    const { env } = fakeEnv();
    const { challenge } = pkce();
    const lookup = lookupWith(mock(() => json({ ...DOC, redirect_uris: [CB, "atteo://auth"] })).f);
    await expect(startAuthorize(env, "ada", authorizeParams(ID, "atteo://auth", challenge, { scope: "person" }), lookup)).rejects.toMatchObject({ code: "invalid_request" });
    const r = await startAuthorize(env, "ada", authorizeParams(ID, CB, challenge, { scope: "board person" }), lookup);
    expect(r.person).toBe(false);
  });

  it("http, IP-literal and localhost client_ids are refused at authorize without a fetch; no lookup means no URL clients", async () => {
    const { env } = fakeEnv();
    const { challenge } = pkce();
    const m = mock(() => json(DOC));
    for (const id of ["http://connect.smithery.ai/.well-known/oauth-client", "https://127.0.0.1/c.json", "https://localhost/c.json", "https://atteo.dev/c.json"])
      await expect(startAuthorize(env, "ada", authorizeParams(id, CB, challenge), lookupWith(m.f))).rejects.toMatchObject({ code: "invalid_client" });
    expect(m.calls).toHaveLength(0);
    await expect(startAuthorize(env, "ada", authorizeParams(ID, CB, challenge))).rejects.toMatchObject({ code: "invalid_client" });
  });

  it("the token call needs the same client_id; PKCE is still enforced", async () => {
    const { env } = fakeEnv();
    const lookup = lookupWith(mock(() => json(DOC)).f);
    for (const client_id of [undefined, "https://connect.smithery.ai/.well-known/oauth-client/", "oc_someone"]) {
      const { verifier, challenge } = pkce();
      const { code } = await codeFor(env, lookup, challenge);
      await expect(exchange(env, { grant_type: "authorization_code", code, redirect_uri: CB, client_id, code_verifier: verifier }, null, lookup)).rejects.toMatchObject({ code: "invalid_grant" });
    }
    const { challenge } = pkce();
    const { code } = await codeFor(env, lookup, challenge);
    await expect(exchange(env, { grant_type: "authorization_code", code, redirect_uri: CB, client_id: ID, code_verifier: pkce().verifier }, null, lookup)).rejects.toMatchObject({ code: "invalid_grant", message: "PKCE verification failed." });
    const { code: code2 } = await codeFor(env, lookup, challenge);
    await expect(exchange(env, { grant_type: "authorization_code", code: code2, redirect_uri: CB, client_id: ID }, null, lookup)).rejects.toMatchObject({ message: "PKCE verification failed." });
    await expect(startAuthorize(env, "ada", new URLSearchParams({ response_type: "code", client_id: ID, redirect_uri: CB }), lookup)).rejects.toMatchObject({ message: "PKCE (S256) is required." });
  });

  it("refresh needs the same client_id too", async () => {
    const { env } = fakeEnv();
    const lookup = lookupWith(mock(() => json(DOC)).f);
    const { verifier, challenge } = pkce();
    const { code } = await codeFor(env, lookup, challenge);
    const t = await exchange(env, { grant_type: "authorization_code", code, client_id: ID, code_verifier: verifier }, null, lookup);
    for (const client_id of [undefined, "oc_x", `${ID}x`])
      await expect(exchange(env, { grant_type: "refresh_token", refresh_token: t.refresh_token, client_id }, null, lookup)).rejects.toMatchObject({ code: "invalid_grant" });
    // Those attempts didn't use it up.
    expect((await exchange(env, { grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: ID }, null, lookup)).access_token).toMatch(/^ab_/);
  });

  it("/token never fetches a client_id sent with a bad code or refresh token", async () => {
    const { env } = fakeEnv();
    const m = mock(() => json({ ...DOC, client_id: "https://evil.example/c.json" }));
    const lookup = lookupWith(m.f);
    await expect(exchange(env, { grant_type: "authorization_code", code: "ocd_nope", client_id: "https://evil.example/c.json", code_verifier: "v" }, null, lookup)).rejects.toMatchObject({ code: "invalid_grant" });
    await expect(exchange(env, { grant_type: "refresh_token", refresh_token: "ort_nope", client_id: "https://evil.example/c.json" }, null, lookup)).rejects.toMatchObject({ code: "invalid_grant" });
    expect(m.calls).toHaveLength(0);
  });

  it("a document host that's down at token time answers 503 and doesn't use up the code; a document that changed for the worse is refused", async () => {
    const { env } = fakeEnv();
    let answer: () => Response = () => json(DOC, { "cache-control": "no-store" });
    const lookup = lookupWith(mock(() => answer()).f);
    const { verifier, challenge } = pkce();
    const { code } = await codeFor(env, lookup, challenge);
    answer = () => json({}, {}, 503);
    const f = { grant_type: "authorization_code", code, client_id: ID, code_verifier: verifier };
    await expect(exchange(env, f, null, lookup)).rejects.toMatchObject({ code: "temporarily_unavailable", status: 503 });
    answer = () => json({ ...DOC, token_endpoint_auth_method: "private_key_jwt" });
    await expect(exchange(env, f, null, lookup)).rejects.toMatchObject({ code: "invalid_client" });
    answer = () => json({ ...DOC, redirect_uris: ["https://connect.smithery.ai/other"] }, { "cache-control": "no-store" });
    await expect(exchange(env, f, null, lookup)).rejects.toMatchObject({ code: "invalid_grant", message: expect.stringContaining("redirect_uri") });
    answer = () => json(DOC, { "cache-control": "no-store" });
    expect((await exchange(env, f, null, lookup)).access_token).toMatch(/^ab_/);
  });

  it("DCR is unchanged: register, authorize, and a token call that leaves client_id out still works", async () => {
    const { env } = fakeEnv();
    const m = mock(() => json(DOC));
    const reg = await register(env, { client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] });
    expect(reg.client_id).toMatch(/^oc_/);
    const { verifier, challenge } = pkce();
    const r = await startAuthorize(env, "ada", authorizeParams(reg.client_id, "https://claude.ai/api/mcp/auth_callback", challenge), lookupWith(m.f));
    expect(r.host).toBeNull();
    const code = new URL(await finishAuthorize(env, "ada", r.id, true)).searchParams.get("code")!;
    const t = await exchange(env, { grant_type: "authorization_code", code, code_verifier: verifier }, null, lookupWith(m.f));
    expect(t.access_token).toMatch(/^ab_/);
    expect(m.calls).toHaveLength(0);
    // And without a lookup at all (as before this change).
    const p2 = pkce();
    const r2 = await startAuthorize(env, "ada", authorizeParams(reg.client_id, "https://claude.ai/api/mcp/auth_callback", p2.challenge));
    const code2 = new URL(await finishAuthorize(env, "ada", r2.id, true)).searchParams.get("code")!;
    expect((await exchange(env, { grant_type: "authorization_code", code: code2, client_id: reg.client_id, code_verifier: p2.verifier })).scope).toBe("board");
  });
});

describe("the consent page for a URL client", () => {
  const viewer = { name: "ada", email: "ada@example.com", display_name: null, admin: false };
  it("shows the client_id's domain next to the name, and escapes the name", async () => {
    const html = await consentPage(viewer, "oq_1", `<img src=x onerror=alert(1)>Smithery`, CB, false, "connect.smithery.ai").text();
    expect(html).toContain("data-client-host");
    expect(html).toContain("From <b style=\"color:var(--ink)\">connect.smithery.ai</b>");
    expect(html).toContain("connect.smithery.ai · will return to connect.smithery.ai");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;Smithery wants to be your agent");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("smithery.ai/logos"); // logo_uri is never shown
    expect(html).not.toContain("data-loopback");
  });
  it("warns when it returns to this computer", async () => {
    const html = await consentPage(viewer, "oq_1", "Local tool", "http://127.0.0.1:3000/callback", false, "tool.example.com").text();
    expect(html).toContain("data-loopback");
    expect(html).toContain("127.0.0.1:3000");
  });
  it("a registered client's page is as before (no domain line)", async () => {
    const html = await consentPage(viewer, "oq_1", "Claude", "https://claude.ai/api/mcp/auth_callback").text();
    expect(html).toContain("Claude wants to be your agent");
    expect(html).toContain("will return to claude.ai");
    expect(html).not.toContain("data-client-host");
  });
});

describe("fetch caps per client_id (review follow-up): /token can't make the Worker fetch one URL over and over", () => {
  const ID2 = "https://other.example.org/client.json";
  const capped = (env: Env, f: typeof fetch, user?: string): ClientLookup => ({ ownHosts: OWN, fetch: f, beforeFetch: cimdFetchCap(env, user) });
  const count = (db: any, key: string) => (db.prepare(`SELECT n FROM rate_limits WHERE key = ?`).get(key) as { n: number } | undefined)?.n;

  it("beforeFetch is asked with the client_id URL", async () => {
    const seen: string[] = [];
    await resolveCimdClient(ID, opts(mock(() => json(DOC)).f, { beforeFetch: async (id) => (seen.push(id), true) }));
    expect(seen).toEqual([ID]);
  });

  it("counts fetches the cache can't answer, per client_id, in D1; another client_id has its own count", async () => {
    const { env, db } = fakeEnv();
    const m = mock((u) => json(u === ID ? DOC : { ...DOC, client_id: ID2 }, { "cache-control": "no-store" }));
    const cap = capped(env, m.f);
    for (let i = 0; i < CIMD_FETCHES_PER_CLIENT; i++) await resolveCimdClient(ID, cap);
    await expect(resolveCimdClient(ID, cap)).rejects.toMatchObject({ code: "temporarily_unavailable", status: 429 });
    expect(m.calls).toHaveLength(CIMD_FETCHES_PER_CLIENT); // the refused one fetched nothing
    expect((await resolveCimdClient(ID2, cap)).client_id).toBe(ID2);
    // Keyed by a hash of the URL (client_ids run to 2048 characters), never the URL itself.
    const keys = (db.prepare(`SELECT key FROM rate_limits`).all() as { key: string }[]).map((r) => r.key);
    expect(keys).toHaveLength(2);
    for (const k of keys) expect(k).toMatch(/^cimd:c:[0-9a-f]{32}$/);
  });

  it("a cached document costs nothing against the cap", async () => {
    const { env, db } = fakeEnv();
    const m = mock(() => json(DOC));
    for (let i = 0; i < CIMD_FETCHES_PER_CLIENT + 5; i++) await resolveCimdClient(ID, capped(env, m.f));
    expect(m.calls).toHaveLength(1);
    expect(db.prepare(`SELECT n FROM rate_limits`).get().n).toBe(1);
  });

  it("at /authorize the person's cap applies too, and a person over it doesn't spend the client_id's", async () => {
    const { env, db } = fakeEnv();
    const m = mock(() => json(DOC, { "cache-control": "no-store" }));
    for (let i = 0; i < CIMD_FETCHES_PER_PERSON; i++) await resolveCimdClient(ID, capped(env, m.f, "ada"));
    await expect(resolveCimdClient(ID, capped(env, m.f, "ada"))).rejects.toMatchObject({ status: 429 });
    expect(count(db, "cimd:u:ada")).toBe(CIMD_FETCHES_PER_PERSON + 1);
    const clientKey = (db.prepare(`SELECT key FROM rate_limits WHERE key LIKE 'cimd:c:%'`).get() as { key: string }).key;
    expect(count(db, clientKey)).toBe(CIMD_FETCHES_PER_PERSON);
    expect((await resolveCimdClient(ID, capped(env, m.f, "bob"))).name).toBe("Smithery Connect");
  });

  it("/token: a code whose document is no-store or failing can't be replayed into unlimited fetches; the 429 doesn't use up the code", async () => {
    const { env, db } = fakeEnv();
    let answer: () => Response = () => json(DOC, { "cache-control": "no-store" });
    const m = mock(() => answer());
    const lookup = capped(env, m.f);
    const { verifier, challenge } = pkce();
    const { code } = await codeFor(env, lookup, challenge); // one fetch at /authorize
    answer = () => json({}, {}, 503);
    const f = { grant_type: "authorization_code", code, client_id: ID, code_verifier: verifier };
    for (let i = 1; i < CIMD_FETCHES_PER_CLIENT; i++) await expect(exchange(env, f, null, lookup)).rejects.toMatchObject({ status: 503 });
    await expect(exchange(env, f, null, lookup)).rejects.toMatchObject({ code: "temporarily_unavailable", status: 429 });
    await expect(exchange(env, f, null, lookup)).rejects.toMatchObject({ status: 429 });
    expect(m.calls).toHaveLength(CIMD_FETCHES_PER_CLIENT);
    expect(db.prepare(`SELECT used FROM oauth_codes`).get().used).toBe(0);
    // The next window: the same code still works.
    db.prepare(`UPDATE rate_limits SET reset_at = 0`).run();
    answer = () => json(DOC, { "cache-control": "no-store" });
    expect((await exchange(env, f, null, lookup)).access_token).toMatch(/^ab_/);
  });

  it("/token refresh: capped the same way, and the refused refresh token isn't used up", async () => {
    const { env, db } = fakeEnv();
    let answer: () => Response = () => json(DOC, { "cache-control": "no-store" });
    const m = mock(() => answer());
    const lookup = capped(env, m.f);
    const { verifier, challenge } = pkce();
    const { code } = await codeFor(env, lookup, challenge);
    const t = await exchange(env, { grant_type: "authorization_code", code, client_id: ID, code_verifier: verifier }, null, lookup);
    answer = () => json({}, {}, 503);
    const r = { grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: ID };
    for (let i = 2; i < CIMD_FETCHES_PER_CLIENT; i++) await expect(exchange(env, r, null, lookup)).rejects.toMatchObject({ status: 503 });
    await expect(exchange(env, r, null, lookup)).rejects.toMatchObject({ status: 429 });
    expect(m.calls).toHaveLength(CIMD_FETCHES_PER_CLIENT);
    db.prepare(`UPDATE rate_limits SET reset_at = 0`).run();
    answer = () => json(DOC, { "cache-control": "no-store" });
    expect((await exchange(env, r, null, lookup)).access_token).toMatch(/^ab_/);
  });
});

describe("the stored copy in D1 (cimd_documents): a capped client_id never fails a real flow when one exists", () => {
  const full = (env: Env, f: typeof fetch, user?: string): ClientLookup => ({ ownHosts: OWN, fetch: f, beforeFetch: cimdFetchCap(env, user), store: cimdStore(env) });
  const exhaust = (db: any) => {
    // Someone hammered this client_id: its window's count is far past the cap.
    expect(db.prepare(`UPDATE rate_limits SET n = 10000 WHERE key LIKE 'cimd:c:%'`).run().changes).toBe(1);
  };

  it("a fresh stored copy (under five minutes) answers with no fetch, in any isolate", async () => {
    const { env, db } = fakeEnv();
    const m = mock(() => json(DOC));
    await resolveCimdClient(ID, full(env, m.f));
    expect(db.prepare(`SELECT client_id FROM cimd_documents`).get().client_id).toBe(ID);
    clearCimdCache(); // another isolate
    expect((await resolveCimdClient(ID, full(env, m.f))).name).toBe("Smithery Connect");
    expect(m.calls).toHaveLength(1);
    // Past five minutes it's fetched again (a document's own no-store means the copy is never "fresh").
    clearCimdCache();
    const later = { ...full(env, m.f), now: () => Date.now() + 6 * 60_000 };
    await resolveCimdClient(ID, later);
    expect(m.calls).toHaveLength(2);
  });

  it("capped client_id with a stored copy: authorize, token and refresh all succeed without fetching", async () => {
    const { env, db } = fakeEnv();
    const m = mock(() => json(DOC, { "cache-control": "no-store" })); // never fresh: every lookup would fetch
    await resolveCimdClient(ID, full(env, m.f));
    exhaust(db);
    const calls = m.calls.length;
    const lookup = full(env, m.f, "ada");
    const { verifier, challenge } = pkce();
    const { r, code } = await codeFor(env, lookup, challenge);
    expect(r.client.name).toBe("Smithery Connect");
    const t = await exchange(env, { grant_type: "authorization_code", code, client_id: ID, code_verifier: verifier }, null, full(env, m.f));
    expect(t.access_token).toMatch(/^ab_/);
    expect((await exchange(env, { grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: ID }, null, full(env, m.f))).access_token).toMatch(/^ab_/);
    expect(m.calls).toHaveLength(calls);
  });

  it("capped client_id with no stored copy (or one over a day old): 429", async () => {
    const { env, db } = fakeEnv();
    const m = mock(() => json(DOC, { "cache-control": "no-store" }));
    for (let i = 0; i < CIMD_FETCHES_PER_CLIENT; i++) await resolveCimdClient(ID, { ...full(env, m.f), store: undefined });
    await expect(resolveCimdClient(ID, full(env, m.f))).rejects.toMatchObject({ code: "temporarily_unavailable", status: 429 });
    // A copy from 25 hours ago doesn't serve.
    await cimdStore(env).put(ID, { client: { client_id: ID, name: "Old", host: "connect.smithery.ai", redirect_uris: [CB] }, fetched_at: Date.now() - 25 * 3600_000, fresh_until: 0 });
    await expect(resolveCimdClient(ID, full(env, m.f))).rejects.toMatchObject({ status: 429 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM cimd_documents`).get().n).toBe(1);
  });

  it("a fetch that finds a bad document drops the stored copy, so it can't stand in later", async () => {
    const { env, db } = fakeEnv();
    let answer: () => Response = () => json(DOC, { "cache-control": "no-store" });
    const m = mock(() => answer());
    await resolveCimdClient(ID, full(env, m.f));
    answer = () => json({ ...DOC, client_secret: "x" });
    await expect(resolveCimdClient(ID, full(env, m.f))).rejects.toMatchObject({ code: "invalid_client" });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM cimd_documents`).get().n).toBe(0);
    // A host that's only down for now keeps it.
    answer = () => json(DOC, { "cache-control": "no-store" });
    await resolveCimdClient(ID, full(env, m.f));
    answer = () => json({}, {}, 503);
    await expect(resolveCimdClient(ID, full(env, m.f))).rejects.toMatchObject({ status: 503 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM cimd_documents`).get().n).toBe(1);
  });
});

describe("client names on the consent page: no tag or bidi characters (review follow-up)", () => {
  it("CIMD client_name loses tag characters, bidi overrides and isolates, and variation selectors", async () => {
    expect(cleanName("Smithery\u{E0049}\u{E0047}\u{E004E} Connect", "h")).toBe("Smithery Connect");
    expect(cleanName("‮tcennoC‬ ⁦Smithery⁩⁧", "h")).toBe("tcennoC Smithery");
    expect(cleanName("\u{E0001}\u{E0020}\u{E007F}", "connect.smithery.ai")).toBe("connect.smithery.ai");
    expect(cleanName("A️\u{E0100}pp￹", "h")).toBe("App");
    const doc = { ...DOC, client_name: "Smithery\u{E0020}\u{E0069}\u{E0067}\u{E006E}\u{E006F}\u{E0072}\u{E0065} Connect" };
    expect((await resolveCimdClient(ID, opts(mock(() => json(doc)).f))).name).toBe("Smithery Connect");
  });

  it("a registered (DCR) client's name is cleaned the same way", async () => {
    const { env } = fakeEnv();
    const reg = await register(env, { client_name: "Cl\u{E0041}aude‮ ⁦", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] });
    expect(reg.client_name).toBe("Claude");
    expect((await register(env, { client_name: "\u{E0041}​", redirect_uris: ["https://claude.ai/cb"] })).client_name).toBe("An MCP client");
  });
});
