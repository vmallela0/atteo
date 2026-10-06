import { afterEach, describe, expect, it, vi } from "vitest";
import * as approvals from "../src/approvals";
import { generateSigningKey, jwks, unb64url } from "../src/cardsign";
import * as pact from "../src/pact";
import type { Env } from "../src/types";

const { DatabaseSync } = (await import("node:" + "sqlite")) as { DatabaseSync: new (p: string) => any };
const { readFileSync, readdirSync } = (await import("node:" + "fs")) as { readFileSync: (u: URL, enc: string) => string; readdirSync: (u: URL) => string[] };
const dir = new URL("../migrations/", (import.meta as unknown as { url: string }).url);

async function fakeEnv() {
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
  const DB = { prepare: (sql: string) => stmt(sql), batch: async (s: any[]) => Promise.all(s.map((x) => x.run())) };
  const key = await generateSigningKey();
  const env = { DB, A2A_SIGNING_KEY: JSON.stringify(key) } as unknown as Env;
  db.prepare(`INSERT INTO pact_providers (origin, audience, label, added_at) VALUES (?, ?, ?, ?)`).run("https://provider.example.com", "https://provider.example.com/a2a", "Example", 0);
  return { env, db };
}

const CARD = "https://brand.example/.well-known/agent-card.json";
const IFACE = "https://provider.example.com/a2a/01J";
const card = (over: Record<string, unknown> = {}) => ({
  name: "Loom & Co.",
  supportedInterfaces: [{ url: IFACE, protocolBinding: "HTTP+JSON", protocolVersion: "1.0" }],
  securitySchemes: { paJwt: { httpAuthSecurityScheme: { scheme: "Bearer", bearerFormat: "JWT" } } },
  ...over,
});
const json = (b: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", ...headers } });
const claims = (jwt: string) => JSON.parse(new TextDecoder().decode(unb64url(jwt.split(".")[1])));

async function verifyJwt(env: Env, jwt: string): Promise<boolean> {
  const [h, b, s] = jwt.split(".");
  const kid = JSON.parse(new TextDecoder().decode(unb64url(h))).kid;
  const k = (await jwks(env)).keys.find((x) => x.kid === kid)!;
  const pub = await crypto.subtle.importKey("jwk", { kty: k.kty, crv: k.crv, x: k.x, y: k.y }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, unb64url(s), new TextEncoder().encode(`${h}.${b}`));
}

/** prepare → requestApproval → (decide) — what agents {action: "call"} does. */
async function ask(env: Env, text = "Where is my order?") {
  const o = await pact.prepare(env, null, { card: "brand.example", text, board: null });
  return approvals.requestApproval(env, "ada", { client: "test", ...pact.approvalFields(o) });
}

afterEach(() => vi.restoreAllMocks());

describe("PACT personal-agent JWT", () => {
  it("verifies against our JWKS with the claims PACT §3.2 asks for", async () => {
    const { env } = await fakeEnv();
    const jwt = await pact.signPaJwt(env, { iss: "https://atteo.dev", sub: "u_x", aud: "https://provider.example.com/a2a", now: 1_000_000 });
    expect(await verifyJwt(env, jwt)).toBe(true);
    const c = claims(jwt);
    expect(c).toMatchObject({ iss: "https://atteo.dev", sub: "u_x", aud: "https://provider.example.com/a2a", iat: 1000 });
    expect(c.exp - c.iat).toBeLessThanOrEqual(300);
    expect(JSON.parse(new TextDecoder().decode(unb64url(jwt.split(".")[0])))).toMatchObject({ alg: "ES256", typ: "JWT" });
  });

  it("gives each person one opaque id per provider", async () => {
    const { env } = await fakeEnv();
    const a = await pact.subjectFor(env, "ada", "https://provider.example.com");
    expect(a).toMatch(/^u_/);
    expect(a).not.toContain("ada");
    expect(await pact.subjectFor(env, "ada", "https://provider.example.com")).toBe(a);
    expect(await pact.subjectFor(env, "ada", "https://other.example.com")).not.toBe(a);
    expect(await pact.subjectFor(env, "bob", "https://provider.example.com")).not.toBe(a);
  });
});

describe("PACT cards", () => {
  it("takes a domain or a card URL, and only public https hosts", () => {
    expect(pact.cardUrl("brand.example")).toBe(CARD);
    expect(pact.cardUrl("https://brand.example/a2a/x/.well-known/agent-card.json")).toBe("https://brand.example/a2a/x/.well-known/agent-card.json");
    for (const bad of ["http://brand.example", "https://127.0.0.1", "https://localhost", "https://[::1]/", "https://intranet", "https://x.internal", "https://u:p@brand.example", "file:///etc/passwd"]) {
      expect(() => pact.cardUrl(bad), bad).toThrow(pact.PactError);
    }
  });

  it("picks the HTTP+JSON 1.0 interface and needs a Bearer JWT scheme", () => {
    expect(pact.interfaceOf(card() as pact.Card)).toBe(IFACE);
    expect(() => pact.interfaceOf(card({ supportedInterfaces: [{ url: IFACE, protocolBinding: "JSONRPC", protocolVersion: "0.3" }] }) as pact.Card)).toThrow(/A2A 1.0/);
    expect(() => pact.interfaceOf(card({ securitySchemes: {} }) as pact.Card)).toThrow(/JWT/);
    expect(() => pact.interfaceOf(card({ supportedInterfaces: [{ url: "http://10.0.0.1/a2a", protocolBinding: "HTTP+JSON", protocolVersion: "1.0" }] }) as pact.Card)).toThrow(pact.PactError);
  });

  it("never follows a redirect", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }));
    await expect(pact.fetchCard(CARD)).rejects.toThrow(/redirect/);
  });
});

describe("PACT sending", () => {
  it("asks first, sends exactly what was approved once, and keeps the conversation", async () => {
    const { env } = await fakeEnv();
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json(card()));
    const a = await ask(env);
    expect(f).toHaveBeenCalledTimes(1); // the card only: nothing sent to the business yet
    expect(a.tool).toBe("pact");
    expect(a.details).toContain("Where is my order?");
    await expect(pact.sendApproved(env, "ada", "https://atteo.dev", a.id)).rejects.toThrow(/Not approved yet/);
    expect(f).toHaveBeenCalledTimes(1);

    await approvals.decide(env, "ada", a.id, true, "");
    f.mockResolvedValueOnce(json({ message: { role: "ROLE_AGENT", contextId: "ctx-1", parts: [{ text: "Sure, what is the order number?" }] } }));
    const { reply } = await pact.sendApproved(env, "ada", "https://atteo.dev", a.id);
    expect(reply).toEqual({ text: "Sure, what is the order number?", contextId: "ctx-1" });
    const [url, init] = f.mock.calls[1] as [string, RequestInit];
    expect(url).toBe(`${IFACE}/message:send`);
    const h = init.headers as Record<string, string>;
    expect(h["a2a-version"]).toBe("1.0");
    const jwt = h.authorization.replace(/^Bearer /, "");
    expect(await verifyJwt(env, jwt)).toBe(true);
    expect(claims(jwt)).toMatchObject({ iss: "https://atteo.dev", aud: "https://provider.example.com/a2a" });
    expect(JSON.parse(String(init.body))).toEqual({ message: { messageId: `atteo-${a.id}`, role: "ROLE_USER", parts: [{ text: "Where is my order?" }] } });

    await expect(pact.sendApproved(env, "ada", "https://atteo.dev", a.id)).rejects.toThrow(/sends once/);
    expect(f).toHaveBeenCalledTimes(2);

    // The next message continues the same conversation as the same person.
    f.mockResolvedValueOnce(json(card()));
    const b = await ask(env, "Order 4471");
    await approvals.decide(env, "ada", b.id, true, "");
    f.mockResolvedValueOnce(json({ message: { role: "ROLE_AGENT", contextId: "ctx-1", parts: [{ text: "Found it." }] } }));
    await pact.sendApproved(env, "ada", "https://atteo.dev", b.id);
    const next = f.mock.calls[3] as [string, RequestInit];
    expect(JSON.parse(String(next[1].body)).message.contextId).toBe("ctx-1");
    expect(claims((next[1].headers as Record<string, string>).authorization.slice(7)).sub).toBe(claims(jwt).sub);
  });

  it("refuses an approval it didn't prepare, a rejected one, and another person's", async () => {
    const { env } = await fakeEnv();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json(card()));
    const o = await pact.prepare(env, null, { card: "brand.example", text: "hi", board: null });
    // An agent's own request_approval with a PACT-looking command but a different text in details.
    const forged = await approvals.requestApproval(env, "ada", { title: pact.approvalFields(o).title, details: "harmless", tool: "pact", command: pact.approvalFields(o).command });
    await approvals.decide(env, "ada", forged.id, true, "");
    await expect(pact.sendApproved(env, "ada", "https://atteo.dev", forged.id)).rejects.toThrow(/isn't a PACT send Atteo prepared/);

    const rejected = await approvals.requestApproval(env, "ada", { client: "test", ...pact.approvalFields(o) });
    await approvals.decide(env, "ada", rejected.id, false, "");
    await expect(pact.sendApproved(env, "ada", "https://atteo.dev", rejected.id)).rejects.toThrow(/Denied/);

    const mine = await approvals.requestApproval(env, "ada", { client: "test", ...pact.approvalFields(o) });
    await approvals.decide(env, "ada", mine.id, true, "");
    await expect(pact.sendApproved(env, "bob", "https://atteo.dev", mine.id)).rejects.toThrow(/No such/);
  });

  it("won't prepare for an unregistered provider or a secret", async () => {
    const { env, db } = await fakeEnv();
    const f = vi.spyOn(globalThis, "fetch").mockImplementation(async () => json(card()));
    await expect(pact.prepare(env, null, { card: "brand.example", text: "my key is sk-ant-api03-" + "x".repeat(90), board: null })).rejects.toThrow(pact.PactError);
    expect(f).not.toHaveBeenCalled(); // refused before anything goes out
    db.exec(`DELETE FROM pact_providers`);
    await expect(pact.prepare(env, null, { card: "brand.example", text: "hi", board: null })).rejects.toThrow(/isn't registered/);
  });

  it("starts a new conversation when the old one is closed, and maps errors", async () => {
    const tok = async () => "t";
    const closed = json({ error: { code: 400, status: "FAILED_PRECONDITION", message: "closed", details: [{ reason: "UNSUPPORTED_OPERATION" }] } }, 400);
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(closed).mockResolvedValueOnce(json({ message: { role: "ROLE_AGENT", contextId: "ctx-2", parts: [{ text: "Hi again" }] } }));
    expect(await pact.sendMessage(IFACE, tok, "hello", "ctx-1", "m1")).toEqual({ text: "Hi again", contextId: "ctx-2" });
    expect(JSON.parse(String((f.mock.calls[1] as [string, RequestInit])[1].body)).message.contextId).toBeUndefined();

    f.mockResolvedValueOnce(new Response(null, { status: 401, headers: { "www-authenticate": 'Bearer realm="a2a"' } }));
    await expect(pact.sendMessage(IFACE, tok, "hello", null, "m2")).rejects.toThrow(/401/);
    f.mockResolvedValueOnce(new Response(null, { status: 429, headers: { "retry-after": "7" } }));
    await expect(pact.sendMessage(IFACE, tok, "hello", null, "m3")).rejects.toThrow(/7s/);
    f.mockResolvedValueOnce(new Response("", { status: 404 }));
    await expect(pact.sendMessage(IFACE, tok, "hello", null, "m4")).rejects.toThrow(/404/);
  });

  it("reports a step-up (delegated authority) instead of failing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      json({ task: { id: "t1", contextId: "ctx-1", status: { state: "TASK_STATE_AUTH_REQUIRED", message: { role: "ROLE_AGENT", parts: [{ text: "I need permission to issue refunds." }] } }, metadata: { "pact.missingScopes": ["refunds:issue"], "pact.verificationUriComplete": "https://brand.example/login" } } }),
    );
    const r = await pact.sendMessage(IFACE, async () => "t", "refund it", "ctx-1", "m1");
    expect(r).toEqual({ text: "I need permission to issue refunds.", contextId: "ctx-1", needsAuth: { scopes: ["refunds:issue"], link: "https://brand.example/login" } });
  });
});
