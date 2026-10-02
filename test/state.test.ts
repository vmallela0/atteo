import { describe, expect, it } from "vitest";
import { computeSummary, entryHeader, formatEntry, formatSummary } from "../src/state";
import { joinCommand, newBoardId, normalizeUser, BOARD_RE } from "../src/util";
import type { BoardInfo, Entry } from "../src/types";

let seq = 0;
function e(partial: Partial<Entry>): Entry {
  seq += 1;
  return {
    seq: partial.seq ?? seq,
    ts: Date.UTC(2026, 9, 2, 10, 0, seq),
    author: "vedu",
    type: "note",
    text: `entry ${seq}`,
    to: null,
    reply_to: null,
    resolves: [],
    supersedes: null,
    artifact_name: null,
    artifact_size: null,
    ...partial,
  };
}

const info: BoardInfo = { id: "b_test1234", title: "Test", created_by: "vedu", created_at: 0, entry_count: 0, last_seq: 0 };

describe("computeSummary", () => {
  it("keeps a question open until a non-question reply answers it", () => {
    const q = e({ seq: 1, type: "question", to: "jxn", text: "stack trace?" });
    const followUp = e({ seq: 2, type: "question", author: "jxn", reply_to: 1, text: "which service?" });
    expect(computeSummary([q, followUp]).openQuestions.map((x) => x.seq)).toEqual([1, 2]);

    const answer = e({ seq: 3, type: "claim", author: "jxn", reply_to: 1, text: "here it is" });
    expect(computeSummary([q, followUp, answer]).openQuestions.map((x) => x.seq)).toEqual([2]);
  });

  it("closes questions and tasks named in resolves", () => {
    const q = e({ seq: 1, type: "question" });
    const t = e({ seq: 2, type: "task" });
    const done = e({ seq: 3, type: "note", resolves: [1, 2] });
    const s = computeSummary([q, t, done]);
    expect(s.openQuestions).toHaveLength(0);
    expect(s.openTasks).toHaveLength(0);
  });

  it("a reply to a task does not complete it", () => {
    const t = e({ seq: 1, type: "task" });
    const r = e({ seq: 2, type: "note", reply_to: 1 });
    expect(computeSummary([t, r]).openTasks.map((x) => x.seq)).toEqual([1]);
  });

  it("drops superseded entries from the summary", () => {
    const d1 = e({ seq: 1, type: "decision", text: "use v1 API" });
    const d2 = e({ seq: 2, type: "decision", text: "use v2 API", supersedes: 1 });
    expect(computeSummary([d1, d2]).decisions.map((x) => x.seq)).toEqual([2]);
  });

  it("keeps only the 15 most recent claims", () => {
    const claims = Array.from({ length: 20 }, (_, i) => e({ seq: i + 1, type: "claim" }));
    const s = computeSummary(claims);
    expect(s.claims).toHaveLength(15);
    expect(s.claims[0].seq).toBe(6);
  });

  it("lists artifacts", () => {
    const a = e({ seq: 1, type: "artifact", artifact_name: "trace.log", artifact_size: 42 });
    expect(computeSummary([a]).artifacts.map((x) => x.artifact_name)).toEqual(["trace.log"]);
  });
});

describe("formatting", () => {
  it("entry header names type, direction, links and time", () => {
    const h = entryHeader(e({ seq: 12, type: "claim", author: "jxn", to: "vedu", reply_to: 9, resolves: [9], ts: Date.UTC(2026, 9, 2, 10, 31) }));
    expect(h).toBe("#12 claim · jxn → vedu · re #9 · resolves #9 · 2026-10-02 10:31Z");
  });

  it("truncates long entry text with a pointer to get", () => {
    const out = formatEntry(e({ seq: 5, text: "x".repeat(50) }), 10);
    expect(out).toContain("truncated; use get with seq 5");
  });

  it("puts questions addressed to you first", () => {
    const entries = [e({ seq: 1, type: "question", author: "jxn", to: "vedu", text: "what env?" }), e({ seq: 2, type: "question", text: "general?" })];
    const text = formatSummary(info, [], computeSummary(entries), "vedu");
    expect(text.indexOf("Questions waiting for YOU")).toBeGreaterThan(-1);
    expect(text.indexOf("Questions waiting for YOU")).toBeLessThan(text.indexOf("Open questions"));
    expect(text).toContain("#1 (jxn → vedu) what env?");
  });

  it("stays within the character budget by dropping oldest claims first", () => {
    const entries = Array.from({ length: 15 }, (_, i) => e({ seq: i + 1, type: "claim", text: "c".repeat(200) }));
    entries.push(e({ seq: 16, type: "decision", text: "keep me" }));
    const text = formatSummary(info, [], computeSummary(entries), "vedu", 1200);
    expect(text.length).toBeLessThanOrEqual(1200 + 30);
    expect(text).toContain("keep me");
    expect(text).toContain("#15 (vedu)");
    expect(text).not.toContain("#1 (vedu)");
  });
});

describe("util", () => {
  it("normalizes member names", () => {
    expect(normalizeUser("  Vedu ")).toBe("vedu");
    expect(normalizeUser("jxn.dev_2")).toBe("jxn.dev_2");
    expect(normalizeUser("")).toBeNull();
    expect(normalizeUser("-bad")).toBeNull();
    expect(normalizeUser("has space")).toBeNull();
    expect(normalizeUser("x".repeat(33))).toBeNull();
  });

  it("makes unguessable board ids", () => {
    const ids = new Set(Array.from({ length: 500 }, newBoardId));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(id).toMatch(BOARD_RE);
  });

  it("builds the join command", () => {
    expect(joinCommand("https://x.dev", "b_abc12345", "jxn")).toBe(
      'claude mcp add --scope user --transport http board "https://x.dev/mcp?board=b_abc12345" --header "X-User: jxn"',
    );
  });
});
