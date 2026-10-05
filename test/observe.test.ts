import { beforeEach, describe, expect, it } from "vitest";
import { adminPage } from "../src/html";
import {
  counter,
  egressRefusal,
  egressRefusalText,
  noteContextPack,
  notePaste,
  observability,
  packBucket,
  resetCounters,
  settleCounts,
} from "../src/observe";
import { formatSummary, type Summary } from "../src/state";
import type { BoardInfo, Entry, Env, Member } from "../src/types";

const { DatabaseSync } = (await import("node:" + "sqlite")) as { DatabaseSync: new (p: string) => any };
const { readFileSync, readdirSync } = (await import("node:" + "fs")) as {
  readFileSync: (p: string | URL, enc: string) => string;
  readdirSync: (u: URL) => string[];
};
const here = import.meta as unknown as { url: string };
const dir = new URL("../migrations/", here.url);

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

const src = (file: string) => readFileSync(new URL("../" + file, here.url), "utf8");
const j = (...p: string[]) => p.join("");
const mix = (n: number) => Array.from({ length: n }, (_, i) => "aB3dE5gH7jK9mN1pQ2"[i % 18]).join("");
const github = () => j("token: ", "ghp_", mix(36));

beforeEach(async () => {
  await settleCounts();
  resetCounters();
});

describe("paste, secret-filter blocks and context-pack size", () => {
  it("counts a refused write by rule and leaves a clean write alone", async () => {
    const { env, db } = fakeEnv();
    const secret = github();
    const blocked = egressRefusal(env, null, { text: `please keep ${secret} safe` });
    expect(blocked).toContain("GitHub token");
    expect(blocked).not.toContain(secret);
    expect(counter("egress_block", "github-token")).toBe(1);
    expect(egressRefusal(env, null, { text: "the build is green" })).toBeNull();
    expect(counter("egress_block", "github-token")).toBe(1);
    const again = egressRefusalText(env, null, j("DB_PASSWORD=", "Tr0ub4dor&3"), "note");
    expect(again).toContain("line 1");
    expect(counter("egress_block", "secret-assignment")).toBe(1);
    await settleCounts();
    const rows = db.prepare(`SELECT key, count FROM usage_daily WHERE metric = 'egress_block' ORDER BY key`).all();
    expect(rows).toEqual([
      { key: "github-token", count: 1 },
      { key: "secret-assignment", count: 1 },
    ]);
  });

  it("counts pastes that landed, and skips test accounts", async () => {
    const { env, db } = fakeEnv();
    await notePaste(env, null, "person", "vedu");
    await notePaste(env, null, "person", "vedu");
    await notePaste(env, null, "agent", "jxn");
    await notePaste(env, null, null, "jxn");
    await notePaste(env, null, "person", "e2e-ada");
    expect(counter("paste", "person")).toBe(2);
    expect(counter("paste", "agent")).toBe(2);
    const rows = db.prepare(`SELECT key, count FROM usage_daily WHERE metric = 'paste' ORDER BY key`).all();
    expect(rows).toEqual([
      { key: "agent", count: 2 },
      { key: "person", count: 2 },
    ]);
  });

  it("records a context pack's size, bucket and truncation", async () => {
    const { env } = fakeEnv();
    const info: BoardInfo = { id: "b_test1234", title: "Checkout", created_by: "vedu", created_at: 0, entry_count: 1, last_seq: 1 };
    const members: Member[] = [{ name: "vedu", cursor: 0, joined_at: 0, last_seen: 0 }];
    const entry: Entry = {
      seq: 1,
      ts: 0,
      author: "jxn",
      type: "question",
      text: "how should the empty cart behave? ".repeat(40),
      to: "vedu",
      reply_to: null,
      resolves: [],
      supersedes: null,
      retracts: null,
      artifact_name: null,
      artifact_size: null,
    };
    const summary: Summary = { openQuestions: [entry], openTasks: [], decisions: [], claims: [], artifacts: [], changes: [] };
    const pack = formatSummary(info, members, summary, "vedu", 80);
    expect(pack).toContain("[summary truncated]");
    noteContextPack(env, null, pack, "vedu");
    noteContextPack(env, null, "x".repeat(999), "vedu");
    noteContextPack(env, null, "x".repeat(1000), "vedu");
    noteContextPack(env, null, "x".repeat(4000), "vedu");
    noteContextPack(env, null, "x".repeat(8000), "vedu");
    noteContextPack(env, null, "x".repeat(16000), "vedu");
    noteContextPack(env, null, "ignored", "e2e-ada");
    expect(counter("context_pack", "served")).toBe(6);
    expect(counter("context_pack", "truncated")).toBe(1);
    expect(counter("context_pack", "chars")).toBe(pack.length + 999 + 1000 + 4000 + 8000 + 16000);
    expect(packBucket(pack.length)).toBe("lt_1k");
    expect(counter("context_pack", "lt_1k")).toBe(2);
    expect(counter("context_pack", "1k_4k")).toBe(1);
    expect(counter("context_pack", "4k_8k")).toBe(1);
    expect(counter("context_pack", "8k_16k")).toBe(1);
    expect(counter("context_pack", "16k_plus")).toBe(1);
    await settleCounts();
  });

  it("sums the window into a block rate and an average pack size", async () => {
    const { env, db } = fakeEnv();
    const old = new Date(Date.now() - 100 * 86_400_000).toISOString().slice(0, 10);
    db.prepare(`INSERT INTO usage_daily (day, metric, key, count) VALUES (?, 'paste', 'person', 50)`).run(old);
    await notePaste(env, null, "person", "vedu");
    await notePaste(env, null, "agent", "jxn");
    egressRefusal(env, null, { artifact_content: github() });
    noteContextPack(env, null, "x".repeat(100), "vedu");
    noteContextPack(env, null, "y".repeat(2500), "vedu");
    await settleCounts();

    const o = await observability(env, 14);
    expect(o.days).toBe(14);
    expect(o.paste).toEqual({ person: 1, agent: 1, total: 2 });
    expect(o.egress_blocks.total).toBe(1);
    expect(o.egress_blocks.by_rule).toEqual([{ rule: "github-token", count: 1 }]);
    expect(o.block_rate).toBeCloseTo(1 / 3);
    expect(o.context_pack.served).toBe(2);
    expect(o.context_pack.chars).toBe(2600);
    expect(o.context_pack.avg_chars).toBe(1300);
    expect(o.context_pack.buckets.map((b) => [b.key, b.count])).toEqual([
      ["lt_1k", 1],
      ["1k_4k", 1],
      ["4k_8k", 0],
      ["8k_16k", 0],
      ["16k_plus", 0],
    ]);
    expect(src("src/usage.ts")).toContain("observability(env, n)");
    expect(src("src/usage.ts")).toContain("observe");
  });

  it("shows the counters on the ops page, with how to read them", async () => {
    const { env } = fakeEnv();
    await notePaste(env, null, "agent", "vedu");
    egressRefusal(env, null, { text: github() });
    noteContextPack(env, null, "x".repeat(1200), "vedu");
    await settleCounts();
    const observe = await observability(env);
    const res = adminPage(
      { name: "vedu", email: "vedu@example.com", display_name: null, admin: true },
      [],
      {
        boards: [],
        users: [],
        invites: [],
        recent: [],
        totalEntries: 0,
        access: [],
        metrics: {
          kpis: {
            users: 0, users_7d: 0, users_30d: 0, active_1d: 0, active_7d: 0, active_30d: 0, pro: 0, cancelling: 0, mrr: 0,
            boards: 0, boards_active_7d: 0, agents_7d: 0, posts_7d: 0, errors_24h: 0, errors_24h_total: 0,
          },
          days: [],
          clients: [],
          errors: [],
          csp: [],
          observe,
        },
      },
    );
    const html = await res.text();
    expect(html).toContain("Trust and context");
    expect(html).toContain("GET /api/ops/metrics");
    expect(html).toContain("usage_daily");
    expect(html).toContain("github-token");
    expect(html).toContain("50.0%");
    expect(html).toContain("1,000–3,999 characters");
    expect(html).not.toContain("ghp_");
  });
});

describe("the write and read paths record those counters", () => {
  const board = src("src/board.ts");

  it("a post that lands counts a paste, and a served summary counts a context pack", () => {
    expect(board).toContain("notePaste(this.env, this.ctx, input.via)");
    expect(board).toContain("noteContextPack(this.env, this.ctx, pack, user)");
    expect(board).toContain('if (!user.startsWith("e2e-") && !internal.system && !internal.notice) notePaste');
  });

  it("every board secret-filter refusal goes through the counter", () => {
    expect(board).toContain("noteEgressBlock(this.env, this.ctx, hit.rule)");
    expect(board.match(/this\.secretBlock\(hit\)/g)).toHaveLength(15);
    expect(board.match(/blockedMessage\(hit\)/g)).toHaveLength(1);
  });

  it("worker, MCP, approval and decision refusals count too; the CLI filter stays on the machine", () => {
    for (const file of ["src/index.ts", "src/mcp.ts", "src/approvals.ts"]) expect(src(file)).toContain("egressRefusal(");
    expect(src("src/decisions.ts")).toContain("egressRefusalText(");
    expect(src("src/index.ts")).not.toContain("blockedMessage(");
    expect(src("cli/src/commands.ts")).not.toContain("observe");
    expect(src("cli/src/v2.ts")).not.toContain("observe");
  });
});
