import { describe, expect, it } from "vitest";
import { computeSummary, entryHeader, formatEntry, formatSummary } from "../src/state";
import { connectCommand, newBoardId, normalizeUser, BOARD_RE } from "../src/util";
import { relTime, renderText, initials } from "../src/ui";
import { rootMap } from "../src/html";
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
    retracts: null,
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

  it("drops retracted entries and closes retracted questions and tasks", () => {
    const q = e({ seq: 1, type: "question" });
    const t = e({ seq: 2, type: "task" });
    const c = e({ seq: 3, type: "claim" });
    const r1 = e({ seq: 4, type: "note", retracts: 1 });
    const r2 = e({ seq: 5, type: "note", retracts: 2 });
    const r3 = e({ seq: 6, type: "note", retracts: 3 });
    const s = computeSummary([q, t, c, r1, r2, r3]);
    expect(s.openQuestions).toHaveLength(0);
    expect(s.openTasks).toHaveLength(0);
    expect(s.claims).toHaveLength(0);
    expect(entryHeader(r1)).toContain("retracts #1");
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

  it("builds the one-time (user scope) and project-pinned connect commands", () => {
    expect(connectCommand("https://x.dev", null, "ab_tok")).toBe(
      'claude mcp add --scope user --transport http board "https://x.dev/mcp" --header "Authorization: Bearer ab_tok"',
    );
    expect(connectCommand("https://x.dev", "b_abc12345", "ab_tok")).toBe(
      'claude mcp add --scope project --transport http board "https://x.dev/mcp?board=b_abc12345" --header "Authorization: Bearer ab_tok"',
    );
  });
});

describe("ui helpers", () => {
  it("renders a safe markdown subset and escapes everything else", () => {
    const html = renderText('Hi <script>alert(1)</script> **bold** `x<y` https://ex.com/a?b=1.\n\n```\n<b>raw</b>\n```');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>x&lt;y</code>");
    expect(html).toContain('<a href="https://ex.com/a?b=1"');
    expect(html).toContain("<pre><code>&lt;b&gt;raw&lt;/b&gt;</code></pre>");
  });

  it("does not turn javascript: or quotes into links or attributes", () => {
    const html = renderText('javascript:alert(1) "onmouseover=x" https://a.b/"onx=1');
    expect(html).not.toContain('href="javascript');
    expect(html).not.toMatch(/href="[^"]*"[^>]*onx/);
  });

  it("formats relative times", () => {
    const now = Date.UTC(2026, 9, 2, 12, 0, 0);
    expect(relTime(now - 10_000, now)).toBe("just now");
    expect(relTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(relTime(now - 3 * 3600_000, now)).toBe("3h ago");
    expect(relTime(now - 2 * 86400_000, now)).toBe("2d ago");
    expect(relTime(now - 30 * 86400_000, now)).toBe("2026-09-02");
  });

  it("makes initials", () => {
    expect(initials("vedu")).toBe("VE");
    expect(initials("jxn.dev")).toBe("JD");
  });

  it("threads replies under the root of their chain", () => {
    const es = [e({ seq: 1, type: "question" }), e({ seq: 2, reply_to: 1 }), e({ seq: 3, reply_to: 2 }), e({ seq: 4 }), e({ seq: 5, reply_to: 99 })];
    const r = rootMap(es);
    expect([r.get(1), r.get(2), r.get(3), r.get(4), r.get(5)]).toEqual([1, 1, 1, 4, 5]);
  });
});
