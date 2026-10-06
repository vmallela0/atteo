import { describe, expect, it } from "vitest";
import { adminPage } from "../src/html";
import { okRedirect, pruneUnusedClients } from "../src/oauth";
import type { Env } from "../src/types";

const { DatabaseSync } = (await import("node:" + "sqlite")) as { DatabaseSync: new (p: string) => any };
const { readFileSync, readdirSync } = (await import("node:" + "fs")) as { readFileSync: (u: URL, enc: string) => string; readdirSync: (u: URL) => string[] };
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

const day = 86_400_000;
const T0 = Date.UTC(2026, 9, 6, 12, 0, 0);

function insertClient(db: any, id: string, createdAt: number) {
  db.prepare(`INSERT INTO oauth_clients (client_id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)`).run(id, "An MCP client", '["https://example.com/cb"]', createdAt);
}

function insertRequest(db: any, clientId: string, expiresAt: number) {
  db.prepare(
    `INSERT INTO oauth_requests (id, client_id, redirect_uri, code_challenge, state, user, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(`oq_${clientId}`, clientId, "https://example.com/cb", "challenge", null, "ada", expiresAt);
}

function insertCode(db: any, clientId: string, expiresAt: number, used = 0) {
  db.prepare(
    `INSERT INTO oauth_codes (code_hash, client_id, user, redirect_uri, code_challenge, expires_at, used) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(`h_${clientId}`, clientId, "ada", "https://example.com/cb", "challenge", expiresAt, used);
}

function insertToken(
  db: any,
  clientId: string,
  opts: { tokenId?: string; refreshExp: number; usedAt?: number | null; tokenExp?: number | null; lastUsed?: number | null; revokedAt?: number | null } ,
) {
  const tokenId = opts.tokenId ?? `tok_${clientId}`;
  db.prepare(`INSERT INTO tokens (id, hash, user, label, created_at, expires_at, kind, last_used, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    tokenId,
    `hash_${tokenId}`,
    "ada",
    "MCP app",
    T0 - 40 * day,
    opts.tokenExp ?? null,
    "cli",
    opts.lastUsed ?? null,
    opts.revokedAt ?? null,
  );
  db.prepare(
    `INSERT INTO oauth_refresh_tokens (hash, user, client_id, scope, token_id, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(`rh_${tokenId}`, "ada", clientId, null, tokenId, T0 - 40 * day, opts.refreshExp, opts.usedAt ?? null);
}

function remaining(db: any): string[] {
  return db.prepare(`SELECT client_id FROM oauth_clients ORDER BY client_id`).all().map((r: { client_id: string }) => r.client_id);
}

describe("okRedirect", () => {
  it("accepts https, loopback http and app links (Cursor, VS Code, Claude, Grok)", () => {
    for (const u of [
      "https://claude.ai/api/mcp/auth_callback",
      "https://grok.com/connectors/oauth/callback",
      "http://localhost:33418/callback",
      "http://127.0.0.1:6274/oauth/callback",
      "http://[::1]:8080/cb",
      "cursor://anysphere.cursor-retrieval/oauth/user-atteo/callback",
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

describe("unused OAuth client prune", () => {
  it("deletes a never-used client older than 30 days; keeps a younger unused one", async () => {
    const { env, db } = fakeEnv();
    insertClient(db, "oc_old", T0 - 31 * day);
    insertClient(db, "oc_new", T0 - 5 * day);
    insertClient(db, "oc_edge", T0 - 30 * day);
    expect(await pruneUnusedClients(env, T0)).toBe(1);
    expect(remaining(db)).toEqual(["oc_edge", "oc_new"]);
    const usage = db.prepare(`SELECT day, metric, key, count FROM usage_daily WHERE metric = 'oauth_clients_pruned'`).all();
    expect(usage).toEqual([{ day: "2026-10-06", metric: "oauth_clients_pruned", key: "cron", count: 1 }]);
  });

  it("keeps a client with a recent authorize request or code, even if those rows have already expired", async () => {
    const { env, db } = fakeEnv();
    insertClient(db, "oc_req", T0 - 40 * day);
    insertClient(db, "oc_code", T0 - 40 * day);
    insertRequest(db, "oc_req", T0 - 10 * day); // expired minutes after creation, but still inside the 30-day window
    insertCode(db, "oc_code", T0 - 10 * day, 1);
    expect(await pruneUnusedClients(env, T0)).toBe(0);
    expect(remaining(db)).toEqual(["oc_code", "oc_req"]);
  });

  it("keeps a client with an unexpired refresh token (used or unused)", async () => {
    const { env, db } = fakeEnv();
    insertClient(db, "oc_live", T0 - 40 * day);
    insertClient(db, "oc_used", T0 - 40 * day);
    insertToken(db, "oc_live", { refreshExp: T0 + day, tokenExp: T0 - day, lastUsed: T0 - 40 * day, revokedAt: T0 - 20 * day });
    insertToken(db, "oc_used", { refreshExp: T0 + day, usedAt: T0 - day, tokenExp: T0 - day, lastUsed: T0 - 40 * day, revokedAt: T0 - day });
    expect(await pruneUnusedClients(env, T0)).toBe(0);
    expect(remaining(db)).toEqual(["oc_live", "oc_used"]);
  });

  it("keeps a client whose access token has no expiry or is still live, even without a live refresh", async () => {
    const { env, db } = fakeEnv();
    insertClient(db, "oc_forever", T0 - 40 * day);
    insertClient(db, "oc_access", T0 - 40 * day);
    insertToken(db, "oc_forever", { refreshExp: T0 - day, tokenExp: null, lastUsed: T0 - 40 * day });
    insertToken(db, "oc_access", { refreshExp: T0 - day, tokenExp: T0 + day, lastUsed: T0 - 40 * day });
    expect(await pruneUnusedClients(env, T0)).toBe(0);
    expect(remaining(db)).toEqual(["oc_access", "oc_forever"]);
  });

  it("keeps a client used in the last 30 days even if every token looks expired", async () => {
    const { env, db } = fakeEnv();
    insertClient(db, "oc_recent", T0 - 40 * day);
    insertToken(db, "oc_recent", { refreshExp: T0 - day, tokenExp: T0 - day, lastUsed: T0 - 5 * day, revokedAt: T0 - day });
    expect(await pruneUnusedClients(env, T0)).toBe(0);
    expect(remaining(db)).toEqual(["oc_recent"]);
  });

  it("keeps a client that ever got a token, even long expired: connectors cache its id (#5290)", async () => {
    const { env, db } = fakeEnv();
    insertClient(db, "oc_expired", T0 - 100 * day);
    insertClient(db, "oc_never", T0 - 100 * day);
    insertToken(db, "oc_expired", { refreshExp: T0 - day, tokenExp: T0 - 60 * day, lastUsed: T0 - 60 * day, revokedAt: T0 - 60 * day, usedAt: T0 - 70 * day });
    expect(await pruneUnusedClients(env, T0)).toBe(1);
    expect(remaining(db)).toEqual(["oc_expired"]);
  });

  it("leaves nothing to delete when every old client is still in use", async () => {
    const { env, db } = fakeEnv();
    insertClient(db, "oc_ok", T0 - 40 * day);
    insertToken(db, "oc_ok", { refreshExp: T0 + 50 * day, tokenExp: T0 + 20 * day, lastUsed: T0 });
    expect(await pruneUnusedClients(env, T0)).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM usage_daily`).get().n).toBe(0);
  });

  it("shows registered and pruned counts on /_ops", async () => {
    const html = await adminPage(
      { name: "vedu", email: "vedu@example.com", display_name: null, admin: true },
      [],
      { boards: [], users: [], invites: [], recent: [], totalEntries: 0, access: [], oauth_clients: 67, oauth_clients_pruned: 12 },
    ).text();
    expect(html).toContain("data-oauth-clients");
    expect(html).toContain("OAuth clients: 67 registered");
    expect(html).toContain("12 unused pruned in 14 days");
    expect(html).toContain("sign-in never finished");
  });
});
