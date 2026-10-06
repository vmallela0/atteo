// Live change-card posts call notifyGithubChangeCard. Unset App secrets: posted:false, no fetch.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));
vi.stubGlobal("WebSocketRequestResponsePair", class {});
import { Board } from "../src/board";
import { GITHUB_API, pemToPkcs8, signAppJwt, type GithubHttp } from "../src/githubApp";
import type { Env } from "../src/types";

const { DatabaseSync } = (await import("node:" + "sqlite")) as { DatabaseSync: new (p: string) => any };

const databases: { close(): void }[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

const BOARD_ID = "b_ghcheck1";
const SHA40 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function sqlFor(db: { exec(q: string): void; prepare(q: string): { all(...a: unknown[]): unknown[]; run(...a: unknown[]): unknown } }) {
  return {
    exec(query: string, ...args: unknown[]) {
      if (args.length === 0 && query.includes(";")) {
        db.exec(query.replace(/CREATE VIRTUAL TABLE IF NOT EXISTS search_idx USING fts5\([^;]*\);/, "CREATE TABLE IF NOT EXISTS search_idx (body TEXT, name TEXT, kind TEXT, ref TEXT);"));
        const empty: unknown[] = [];
        return { toArray: () => empty, one: () => undefined, [Symbol.iterator]: () => empty[Symbol.iterator]() };
      }
      const stmt = db.prepare(query);
      const returns = /^\s*(select|pragma|with|explain)\b/i.test(query) || /\breturning\b/i.test(query);
      const rows = returns ? stmt.all(...args) : (stmt.run(...args), [] as unknown[]);
      return { toArray: () => rows, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
    },
  };
}

function d1Stub() {
  const stmt = {
    bind(..._a: unknown[]) {
      return stmt;
    },
    async first() {
      return null;
    },
    async all() {
      return { results: [] as unknown[] };
    },
    async run() {
      return { success: true, meta: { changes: 0 } };
    },
  };
  return {
    prepare: () => stmt,
    batch: async (stmts: { run(): Promise<unknown> }[]) => {
      for (const s of stmts) await s.run();
    },
  };
}

function derPem(label: string, der: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < der.length; i += 0x8000) bin += String.fromCharCode(...der.subarray(i, i + 0x8000));
  const b64 = btoa(bin).match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----`;
}

async function testPem() {
  const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign"])) as CryptoKeyPair;
  return derPem("PRIVATE KEY", new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer));
}

type GhCall = { method: string; url: string; body: unknown };

function mockGithub(script: (url: URL, method: string) => { status: number; json?: unknown }, calls: GhCall[]): GithubHttp {
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    expect(url.origin).toBe(GITHUB_API);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, url: url.pathname + url.search, body });
    const r = script(url, method);
    return new Response(r.json === undefined ? null : JSON.stringify(r.json), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  };
}

function openBoard(envExtra: Partial<Env> = {}) {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const pending: Promise<unknown>[] = [];
  const env = {
    DB: d1Stub(),
    PUBLIC_URL: "https://atteo.dev",
    ...envExtra,
  } as unknown as Env;
  const board = new Board(
    {
      storage: {
        sql: sqlFor(db),
        transactionSync(fn: () => void) {
          fn();
        },
      },
      setWebSocketAutoResponse() {},
      getWebSockets: () => [],
      getTags: () => [],
      waitUntil(p: Promise<unknown>) {
        pending.push(p);
      },
    } as unknown as DurableObjectState,
    env,
  );
  const meta = board as unknown as { setMeta(key: string, value: string): void };
  meta.setMeta("id", BOARD_ID);
  meta.setMeta("title", "GitHub hook");
  meta.setMeta("created_by", "vedu");
  meta.setMeta("created_at", "1");
  meta.setMeta("kind", "board");
  return { board, pending, env };
}

const cardBody = {
  repo: "vmallela0/agent-soup",
  branch: "cursor/github-app",
  base: "main",
  pr_url: "https://github.com/vmallela0/agent-soup/pull/44",
  ci: "passing" as const,
  commits: [{ sha: SHA40, title: "Wire the hook" }],
  files: [{ path: "src/githubApp.ts", added: 10, removed: 0 }],
};

describe("Board.post GitHub change-card hook", () => {
  let pem: string;
  beforeAll(async () => {
    pem = await testPem();
    expect(pemToPkcs8(pem)).not.toBeNull();
    expect(await signAppJwt("4242", pem)).toMatch(/^[A-Za-z0-9_-]+\./);
  });

  it("does not fetch when App credentials are unset", async () => {
    const { board, pending } = openBoard();
    const orig = globalThis.fetch;
    const calls: GhCall[] = [];
    globalThis.fetch = mockGithub(() => {
      throw new Error("fetch must not run");
    }, calls) as typeof fetch;
    try {
      const entry = await board.post("vedu", { type: "change", text: "Wire the GitHub hook", title: "GitHub hook", via: "agent", card: { ...cardBody, diff: "diff --git a/src/githubApp.ts b/src/githubApp.ts\n+secret" } });
      expect(entry.type).toBe("change");
      expect(entry.seq).toBeGreaterThan(0);
      await Promise.all(pending);
      expect(calls).toHaveLength(0);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("creates a Check run from a public change card and never sends the diff", async () => {
    const { board, pending } = openBoard({ GITHUB_APP_ID: "4242", GITHUB_APP_PRIVATE_KEY: pem, GITHUB_APP_INSTALLATION_ID: "99" });
    const orig = globalThis.fetch;
    const calls: GhCall[] = [];
    globalThis.fetch = mockGithub((url, method) => {
      if (method === "POST" && url.pathname.endsWith("/access_tokens")) return { status: 201, json: { token: "ghs_test_installation_token" } };
      if (method === "GET" && /\/commits\/[0-9a-f]{7,39}$/i.test(url.pathname)) {
        return { status: 200, json: { sha: SHA40 } };
      }
      if (method === "GET" && url.pathname.includes("/check-runs")) return { status: 200, json: { check_runs: [] } };
      if (method === "POST" && url.pathname.endsWith("/check-runs")) return { status: 201, json: { id: 501 } };
      if (method === "POST" && url.pathname.endsWith("/comments")) return { status: 201, json: { id: 77 } };
      return { status: 404, json: { message: "unexpected " + method + " " + url.pathname } };
    }, calls) as typeof fetch;
    try {
      const entry = await board.post("vedu", {
        type: "change",
        text: "Wire the GitHub hook",
        title: "GitHub hook",
        via: "agent",
        card: { ...cardBody, diff: "diff --git a/src/githubApp.ts b/src/githubApp.ts\n+private board token" },
      });
      await Promise.all(pending);
      expect(entry.card?.repo).toBe("vmallela0/agent-soup");
      expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/check-runs"))).toBe(true);
      expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/comments"))).toBe(true);
      const check = calls.find((c) => c.method === "POST" && c.url.endsWith("/check-runs"))!.body as { head_sha: string; details_url: string; output: { summary: string } };
      expect(check.head_sha).toBe(SHA40);
      expect(check.details_url).toBe(`https://atteo.dev/b/${BOARD_ID}#e${entry.seq}`);
      expect(check.output.summary).toContain(`Change card #${entry.seq} by vedu`);
      expect(JSON.stringify(calls.map((c) => c.body))).not.toContain("private board");
      expect(JSON.stringify(calls.map((c) => c.body))).not.toContain("diff --git");
      expect(JSON.stringify(calls.map((c) => c.body))).not.toContain("ghs_test_installation_token");
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("does not notify GitHub for a seed or a non-change post", async () => {
    const { board, pending } = openBoard({ GITHUB_APP_ID: "4242", GITHUB_APP_PRIVATE_KEY: pem });
    const orig = globalThis.fetch;
    const calls: GhCall[] = [];
    globalThis.fetch = mockGithub(() => {
      throw new Error("fetch must not run");
    }, calls) as typeof fetch;
    try {
      await board.post("vedu", { type: "change", text: "seeded card", title: "Seed", via: "agent", card: cardBody }, { seeding: true });
      await board.post("vedu", { type: "note", text: "not a change card", via: "agent" });
      await Promise.all(pending);
      expect(calls).toHaveLength(0);
    } finally {
      globalThis.fetch = orig;
    }
  });
});
