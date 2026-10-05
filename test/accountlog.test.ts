import { describe, expect, it } from "vitest";
import { describeClient, jsonl, list, prune, record } from "../src/accountlog";
import { mePage } from "../src/html";
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
    run: async () => ({ results: [], meta: { changes: db.prepare(sql).run(...args).changes } }),
  });
  return { env: { DB: { prepare: (sql: string) => stmt(sql) } } as unknown as Env, db };
}

const day = 86_400_000;
const T0 = Date.UTC(2026, 9, 5, 12, 0, 0);
const req = (ua: string | null, country?: string, ip = "203.0.113.9") => {
  const r = new Request("https://atteo.dev/x", { headers: { ...(ua ? { "user-agent": ua } : {}), "cf-connecting-ip": ip } });
  return Object.assign(r, { cf: country ? { country } : undefined });
};

describe("account log (#3490)", () => {
  it("names the client in a few words, not the whole User-Agent", () => {
    expect(describeClient("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36")).toBe("Chrome on macOS");
    expect(describeClient("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1")).toBe("Safari on iPhone");
    expect(describeClient("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0")).toBe("Firefox on Windows");
    expect(describeClient("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/129.0 Safari/537.36 Edg/129.0")).toBe("Edge on Windows");
    expect(describeClient("atteo-cli/0.9.3 node/22")).toBe("atteo-cli/0.9.3");
    expect(describeClient(null)).toBeNull();
  });

  it("records the event, client and country, never the IP", async () => {
    const { env, db } = fakeEnv();
    await record(env, "ada", "signin.web", req("Mozilla/5.0 (X11; Linux x86_64) Chrome/129.0 Safari/537.36", "DE"), { now: T0 });
    await record(env, "ada", "token.created", req(null), { label: "laptop agent", kind: "manual", now: T0 + 1 });
    await record(env, "ada", "token.created", req("curl/8"), { label: "ops", client: "operator", now: T0 + 2 });
    const rows = db.prepare(`SELECT * FROM account_audit ORDER BY id`).all();
    expect(rows.map((r: any) => [r.event, r.client, r.country, r.label])).toEqual([
      ["signin.web", "Chrome on Linux", "DE", null],
      ["token.created", null, null, "laptop agent"],
      ["token.created", "operator", null, "ops"],
    ]);
    expect(JSON.stringify(rows)).not.toContain("203.0.113.9");
  });

  it("lists one person's lines newest first, pages, and downloads JSON Lines", async () => {
    const { env } = fakeEnv();
    for (let i = 0; i < 5; i++) await record(env, "ada", "signin.web", null, { now: T0 + i });
    await record(env, "bea", "cli.login", null, { label: "Atteo CLI", now: T0 + 9 });
    const first = await list(env, "ada", { limit: 3 });
    expect(first.events.map((e) => e.at)).toEqual([T0 + 4, T0 + 3, T0 + 2]);
    const rest = await list(env, "ada", { before: first.next_before, limit: 3 });
    expect(rest.events.map((e) => e.at)).toEqual([T0 + 1, T0]);
    expect(rest.next_before).toBeUndefined();
    expect((await list(env, "bea")).events.map((e) => e.event)).toEqual(["cli.login"]);
    const lines = (await jsonl(env, "ada")).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatchObject({ event: "signin.web", at: new Date(T0 + 4).toISOString() });
    expect(await jsonl(env, "nobody")).toBe("");
  });

  it("keeps a year", async () => {
    const { env } = fakeEnv();
    await record(env, "ada", "signin.web", null, { now: T0 - 366 * day });
    await record(env, "ada", "signin.web", null, { now: T0 - 364 * day });
    expect(await prune(env, T0)).toBe(1);
    expect((await list(env, "ada")).events.map((e) => e.at)).toEqual([T0 - 364 * day]);
  });

  it("never fails the sign-in it records", async () => {
    const env = { DB: { prepare: () => ({ bind: () => ({ run: async () => { throw new Error("D1 down"); } }) }) } } as unknown as Env;
    const err = console.error;
    console.error = () => {};
    try {
      await expect(record(env, "ada", "signin.web", null)).resolves.toBeUndefined();
    } finally {
      console.error = err;
    }
  });

  it("shows the last lines and a download link on the Account page", async () => {
    const viewer = { name: "ada", email: "ada@example.com", display_name: null, admin: false };
    const html = await mePage(viewer, [], [], undefined, false, [], null, [], [
      { id: 2, at: T0, event: "token.revoked", label: "old laptop", kind: "manual", client: "Firefox on Linux", country: "FR" },
      { id: 1, at: T0 - day, event: "signin.web", label: null, kind: null, client: null, country: null },
    ]).text();
    expect(html).toContain('href="/api/me/audit?format=jsonl"');
    expect(html).toMatch(/Revoked a connection.*old laptop.*Firefox on Linux · FR/s);
    expect(html).toContain("Signed in on the web");
    expect(await mePage(viewer, [], []).text()).toContain("Nothing yet.");
  });
});
