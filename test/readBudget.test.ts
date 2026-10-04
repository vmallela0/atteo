import { describe, expect, it } from "vitest";
import { openapi } from "../src/openapi";
import { parseReadBudget, presentReadEntries, MAX_READ_BUDGET } from "../src/state";
import type { Entry } from "../src/types";

const { readFileSync } = (await import("node:" + "fs")) as { readFileSync: (u: URL, enc: string) => string };
const source = (f: string) => readFileSync(new URL(`../src/${f}.ts`, (import.meta as unknown as { url: string }).url), "utf8");

function entry(text: string, seq: number): Entry {
  return {
    seq,
    ts: Date.UTC(2026, 9, 2, 10, 0, seq),
    author: "vedu",
    type: "note",
    text,
    to: null,
    reply_to: null,
    resolves: [],
    supersedes: null,
    retracts: null,
    artifact_name: null,
    artifact_size: null,
  };
}

/** The entry text inside a rendered read line, without the header or the truncation notice. */
function renderedEntryText(line: string, seq: number): string {
  const notice = `… [truncated; use get with seq ${seq}]`;
  const body = line
    .split("\n")
    .slice(1)
    .map((l) => (l.startsWith("    ") ? l.slice(4) : l))
    .join("\n");
  if (body === notice) return "";
  const mark = "\n" + notice;
  return body.endsWith(mark) ? body.slice(0, -mark.length) : body;
}

describe("read max_chars", () => {
  const long = "hello " + "x".repeat(180) + "TAIL-9f3a";

  it("does not return a long entry in full when a small budget is set", () => {
    const view = presentReadEntries([entry(long, 4)], 20, "vedu");
    const packed = JSON.stringify(view);
    expect(packed).not.toContain(long);
    expect(packed).not.toContain("TAIL-9f3a");
    expect(view.entries[0].text.length).toBeLessThanOrEqual(20);
    expect(view.entries[0].text).toBe(long.slice(0, 20));
    expect(view.entries[0].truncated).toBe(true);
    expect(view.lines[0]).toContain("truncated; use get with seq 4");
    expect(renderedEntryText(view.lines[0], 4)).toBe(long.slice(0, 20));
    expect(renderedEntryText(view.lines[0], 4).length).toBeLessThanOrEqual(20);
  });

  it("returns a long entry in full when the budget is omitted", () => {
    const view = presentReadEntries([entry(long, 4)], undefined, "vedu");
    expect(view.entries[0].text).toBe(long);
    expect(view.entries[0].truncated).toBeUndefined();
    expect(view.lines[0]).toContain(long);
    expect(view.lines[0]).not.toContain("truncated");
  });

  it("keeps the entry object whole and cuts the rendered line at 4000 when the budget is omitted", () => {
    const text = "z".repeat(4500);
    const view = presentReadEntries([entry(text, 3)], undefined);
    expect(view.entries[0].text).toBe(text);
    expect(view.entries[0].truncated).toBeUndefined();
    expect(view.lines[0]).not.toContain("z".repeat(4001));
    expect(view.lines[0]).toContain("truncated; use get with seq 3");
    expect(renderedEntryText(view.lines[0], 3)).toBe("z".repeat(4000));
  });

  it("spends the budget across entries, oldest first", () => {
    const first = "a".repeat(30);
    const second = "b".repeat(30) + "BTAIL";
    const view = presentReadEntries([entry(first, 1), entry(second, 2)], 40);
    expect(view.entries[0].text).toBe(first);
    expect(view.entries[0].truncated).toBeUndefined();
    expect(view.entries[1].text).toBe("b".repeat(10));
    expect(view.entries[1].truncated).toBe(true);
    expect(view.lines[1]).toContain("truncated; use get with seq 2");
    expect(JSON.stringify(view)).not.toContain("BTAIL");
    const chars = view.entries.reduce((n, e) => n + e.text.length, 0);
    expect(chars).toBeLessThanOrEqual(40);
    expect(renderedEntryText(view.lines[0], 1).length + renderedEntryText(view.lines[1], 2).length).toBeLessThanOrEqual(40);
  });

  it("a budget that fits an entry longer than 4000 returns that entry whole", () => {
    const text = "q".repeat(5000);
    const view = presentReadEntries([entry(text, 9)], 5000);
    expect(view.entries[0].text).toBe(text);
    expect(view.entries[0].truncated).toBeUndefined();
    expect(view.lines[0]).toContain(text);
    expect(view.lines[0]).not.toContain("truncated");
  });

  it("a zero budget returns no entry text and still says how to fetch it", () => {
    const text = "secret-body";
    const view = presentReadEntries([entry(text, 8)], 0);
    expect(view.entries[0].text).toBe("");
    expect(view.entries[0].truncated).toBe(true);
    expect(JSON.stringify(view)).not.toContain(text);
    expect(view.lines[0]).toContain("truncated; use get with seq 8");
    expect(renderedEntryText(view.lines[0], 8)).toBe("");
  });

  it("parses max_chars and ignores anything that is not a non-negative integer", () => {
    expect(parseReadBudget(undefined)).toBeUndefined();
    expect(parseReadBudget(null)).toBeUndefined();
    expect(parseReadBudget("")).toBeUndefined();
    expect(parseReadBudget("nope")).toBeUndefined();
    expect(parseReadBudget("-1")).toBeUndefined();
    expect(parseReadBudget(-3)).toBeUndefined();
    expect(parseReadBudget("20")).toBe(20);
    expect(parseReadBudget(20.9)).toBe(20);
    expect(parseReadBudget(0)).toBe(0);
    expect(parseReadBudget(MAX_READ_BUDGET + 50)).toBe(MAX_READ_BUDGET);
  });

  it("MCP read and the session HTTP read both take max_chars", () => {
    const mcp = source("mcp");
    const http = source("index");
    expect(mcp).toContain('max_chars: { type: "integer"');
    expect(mcp).toContain("parseReadBudget(args.max_chars)");
    expect(mcp).toContain("presentReadEntries(r.entries, maxChars, user)");
    expect(http).toContain('parseReadBudget(url.searchParams.get("max_chars"))');
    expect(http).toContain("presentReadEntries(r.entries, maxChars, viewer.name)");
    const read = openapi("https://example.test").paths["/api/sessions/{sid}/read"].get;
    expect(read.parameters.some((p: { name: string }) => p.name === "max_chars")).toBe(true);
  });
});
