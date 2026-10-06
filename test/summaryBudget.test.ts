import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

import { openapi } from "../src/openapi";
import { TOOLS } from "../src/mcp";
import {
  computeSummary,
  DEFAULT_SUMMARY_CHARS,
  DEFAULT_SUMMARY_TOKENS,
  formatSummary,
  MAX_SUMMARY_TOKENS,
  parseSummaryBudget,
  SUMMARY_CHARS_PER_TOKEN,
  SUMMARY_TRUNCATION_MARK,
  summaryWithinBudget,
} from "../src/state";
import type { BoardInfo, Entry } from "../src/types";

const { readFileSync } = (await import("node:" + "fs")) as { readFileSync: (u: URL, enc: string) => string };
const source = (f: string) => readFileSync(new URL(`../src/${f}.ts`, (import.meta as unknown as { url: string }).url), "utf8");

function entry(partial: Partial<Entry> & { seq: number; type: Entry["type"]; text: string }): Entry {
  return {
    ts: Date.UTC(2026, 9, 2, 10, 0, partial.seq),
    author: "jxn",
    to: null,
    reply_to: null,
    resolves: [],
    supersedes: null,
    retracts: null,
    artifact_name: null,
    artifact_size: null,
    ...partial,
  };
}

const info: BoardInfo = { id: "b_test1234", title: "Test", created_by: "vedu", created_at: 0, entry_count: 200, last_seq: 200 };

/** Enough open items that the uncapped summary is past the default ~4k tokens. */
function busyBoard(): Entry[] {
  const out: Entry[] = [];
  const add = (n: number, type: Entry["type"], text: (i: number) => string, extra: Partial<Entry> = {}) => {
    for (let i = 0; i < n; i++) out.push(entry({ seq: out.length + 1, type, text: text(i), ...extra }));
  };
  add(30, "question", (i) => `ask vedu ${i} ${"q".repeat(140)}`, { to: "vedu" });
  add(30, "question", (i) => `open question ${i} ${"q".repeat(140)}`);
  add(30, "task", (i) => `task for vedu ${i} ${"t".repeat(140)}`, { to: "vedu" });
  add(30, "task", (i) => `open task ${i} ${"t".repeat(140)}`);
  add(25, "decision", (i) => `decision ${i} ${"d".repeat(140)}`);
  out.push(entry({ seq: out.length + 1, type: "claim", text: "OLDEST-CLAIM " + "c".repeat(140) }));
  add(13, "claim", (i) => `claim ${i} ${"c".repeat(140)}`);
  out.push(entry({ seq: out.length + 1, type: "claim", text: "NEWEST-CLAIM " + "c".repeat(140) }));
  for (let i = 0; i < 20; i++) out.push(entry({ seq: out.length + 1, type: "artifact", text: `file ${i}`, artifact_name: `notes-${i}.txt`, artifact_size: 10 }));
  return out;
}

describe("summary_budget", () => {
  it("parses a token budget into characters and ignores anything else", () => {
    expect(parseSummaryBudget(undefined)).toBeUndefined();
    expect(parseSummaryBudget(null)).toBeUndefined();
    expect(parseSummaryBudget("")).toBeUndefined();
    expect(parseSummaryBudget("nope")).toBeUndefined();
    expect(parseSummaryBudget("10.5")).toBeUndefined();
    expect(parseSummaryBudget("-1")).toBeUndefined();
    expect(parseSummaryBudget(-3)).toBeUndefined();
    expect(parseSummaryBudget("0")).toBe(0);
    expect(parseSummaryBudget(0)).toBe(0);
    expect(parseSummaryBudget("1000")).toBe(1000 * SUMMARY_CHARS_PER_TOKEN);
    expect(parseSummaryBudget(1000.9)).toBe(1000 * SUMMARY_CHARS_PER_TOKEN);
    expect(parseSummaryBudget(DEFAULT_SUMMARY_TOKENS)).toBe(DEFAULT_SUMMARY_CHARS);
    expect(parseSummaryBudget(MAX_SUMMARY_TOKENS + 50)).toBe(MAX_SUMMARY_TOKENS * SUMMARY_CHARS_PER_TOKEN);
    expect(parseSummaryBudget("  80  ")).toBe(80 * SUMMARY_CHARS_PER_TOKEN);
  });

  it("omitting the budget keeps the usual summary, and setting it changes the size", () => {
    const summary = computeSummary(busyBoard());
    const usual = formatSummary(info, [], summary, "vedu");
    const explicitDefault = formatSummary(info, [], summary, "vedu", parseSummaryBudget(DEFAULT_SUMMARY_TOKENS));
    const wide = formatSummary(info, [], summary, "vedu", parseSummaryBudget(MAX_SUMMARY_TOKENS));
    const smallChars = parseSummaryBudget(80)!;
    const small = formatSummary(info, [], summary, "vedu", smallChars);

    expect(explicitDefault).toBe(usual);
    expect(usual.length).toBeLessThanOrEqual(DEFAULT_SUMMARY_CHARS);
    expect(wide.length).toBeGreaterThan(usual.length);
    expect(wide.length).toBeGreaterThan(DEFAULT_SUMMARY_CHARS);
    expect(wide).toContain("OLDEST-CLAIM");
    expect(usual).not.toContain("OLDEST-CLAIM");
    expect(wide).toContain("NEWEST-CLAIM");
    expect(small.length).toBeLessThanOrEqual(smallChars);
    expect(small.length).toBeLessThan(usual.length);
    expect(small).not.toContain("OLDEST-CLAIM");
    expect(small).toContain(SUMMARY_TRUNCATION_MARK.trim());
  });

  it("a small board is unchanged when the caller asks for the default", () => {
    const summary = computeSummary([entry({ seq: 1, type: "decision", text: "Ship Friday" })]);
    const usual = formatSummary(info, [], summary, "vedu");
    expect(usual.length).toBeLessThan(DEFAULT_SUMMARY_CHARS);
    expect(formatSummary(info, [], summary, "vedu", parseSummaryBudget(DEFAULT_SUMMARY_TOKENS))).toBe(usual);
    expect(usual).not.toContain("summary truncated");
  });

  it("counts the pinned-doc line and never exceeds the budget", () => {
    const pin = "Pinned doc (source of truth): SPEC.md v4 (doc read SPEC.md)";
    const budget = 240;
    let room = -1;
    const text = summaryWithinBudget(
      (n) => {
        room = n;
        return ["Board T", "Members: vedu", "body line"].join("\n");
      },
      budget,
      pin,
    );
    expect(room).toBe(budget - pin.length - 1);
    expect(text.split("\n")[2]).toBe(pin);
    expect(text.length).toBeLessThanOrEqual(budget);

    const withCharter = summaryWithinBudget(() => ["Board T", "Charter: goal: Ship", "Members: vedu", "body"].join("\n"), budget, pin);
    expect(withCharter.split("\n")[3]).toBe(pin);
    expect(withCharter).toContain("Members: vedu");
    expect(withCharter.indexOf("Members:")).toBeLessThan(withCharter.indexOf(pin));

    const summary = computeSummary(busyBoard());
    const packed = summaryWithinBudget((n) => formatSummary(info, [], summary, "vedu", n), parseSummaryBudget(120)!, pin);
    expect(packed.length).toBeLessThanOrEqual(120 * SUMMARY_CHARS_PER_TOKEN);
    expect(packed).toContain(pin);

    expect(summaryWithinBudget(() => "HELLO", 0, null)).toBe("");
    expect(summaryWithinBudget(() => "Board\nMembers\nbody", 8, pin).length).toBeLessThanOrEqual(8);
  });

  it("MCP read and the session HTTP read both take summary_budget", () => {
    const read = TOOLS.find((t) => t.name === "read");
    const prop = (read?.inputSchema as { properties: Record<string, { maximum?: number; description?: string }> }).properties.summary_budget;
    expect(prop.maximum).toBe(MAX_SUMMARY_TOKENS);
    expect(prop.description).toContain(String(DEFAULT_SUMMARY_TOKENS));
    expect(read?.description).toContain("summary_budget");

    const mcp = source("mcp");
    const http = source("index");
    const board = source("board");
    expect(mcp).toContain("parseSummaryBudget(args.summary_budget)");
    expect(mcp).toContain("summaryChars");
    const join = mcp.slice(mcp.indexOf('case "join_board"'), mcp.indexOf('case "leave_board"'));
    expect(join).not.toContain("summary_budget");
    expect(join).not.toContain("summaryChars");
    expect(http).toContain('parseSummaryBudget(url.searchParams.get("summary_budget"))');
    expect(http).toContain("summaryChars");
    expect(board).toContain("summaryWithinBudget");
    expect(board).toContain("opts.summaryChars ?? DEFAULT_SUMMARY_CHARS");

    const spec = openapi("https://example.test").paths["/api/sessions/{sid}/read"].get;
    const param = spec.parameters.find((p: { name: string }) => p.name === "summary_budget") as { schema: { type: string; minimum: number; maximum: number }; description: string };
    expect(param.schema).toMatchObject({ type: "integer", minimum: 0, maximum: MAX_SUMMARY_TOKENS });
    expect(param.description).toContain(String(DEFAULT_SUMMARY_TOKENS));
    expect(spec.summary).toContain("summary_budget");

    const skill = readFileSync(new URL("../skills/atteo/SKILL.md", (import.meta as unknown as { url: string }).url), "utf8");
    expect(skill).toContain("summary_budget");
    expect(skill).toContain("GET /api/sessions/{sid}/read?summary_budget=1000");
    expect(source("guide")).toContain("summary_budget");
  });
});
