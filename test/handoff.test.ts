import { describe, expect, it } from "vitest";
import { agentLabel, handoffLine, parseHandoff } from "../src/handoff";
import { compactLine, entryHeader, formatEntry } from "../src/state";
import type { Entry, Handoff } from "../src/types";

const from = { user: "vedu", session: "cursor" };

function entry(partial: Partial<Entry>): Entry {
  return {
    seq: 14,
    ts: Date.UTC(2026, 9, 4, 21, 14),
    author: "vedu",
    type: "handoff",
    text: "Layout work is yours.",
    to: "jxn",
    via: "agent",
    reply_to: null,
    resolves: [],
    supersedes: null,
    retracts: null,
    artifact_name: null,
    artifact_size: null,
    ...partial,
  };
}

describe("handoff", () => {
  it("records who it came from, who it goes to, and the task", () => {
    const { handoff, fromGiven } = parseHandoff({ to: "jxn/opus-a", task: 12 }, from);
    expect(fromGiven).toBe(false);
    expect(handoff).toEqual({ from, to: { user: "jxn", session: "opus-a" }, task: 12 });
    expect(agentLabel(handoff.from)).toBe("vedu/cursor");
    expect(agentLabel(handoff.to)).toBe("jxn/opus-a");
    expect(handoffLine(handoff)).toBe("from vedu/cursor to jxn/opus-a, task #12");
  });

  it("accepts member names, {user, session}, a numeric string, and JSON text", () => {
    expect(parseHandoff({ to: "JXN", task: "9", from: { user: "Vedu", session: "Cursor" } }, from).handoff.to).toEqual({ user: "jxn", session: null });
    expect(parseHandoff({ to: { user: "jxn", session: "Opus-A" }, task: 3 }, from).handoff.to).toEqual({ user: "jxn", session: "opus-a" });
    expect(parseHandoff(JSON.stringify({ to: "jxn", task: 3 }), from).fromGiven).toBe(false);
    expect(parseHandoff({ to: "jxn", task: 3, from: "vedu/cursor" }, from).fromGiven).toBe(true);
  });

  it("rejects a handoff that doesn't name a different agent and a task", () => {
    expect(() => parseHandoff(null, from)).toThrow("object");
    expect(() => parseHandoff({}, from)).toThrow("who it goes to");
    expect(() => parseHandoff({ to: "jxn" }, from)).toThrow("which task");
    expect(() => parseHandoff({ to: "jxn", task: 0 }, from)).toThrow("which task");
    expect(() => parseHandoff({ to: "not a name", task: 1 }, from)).toThrow("Name an agent");
    expect(() => parseHandoff({ to: "jxn/Bad Name", task: 1 }, from)).toThrow("Name an agent");
    expect(() => parseHandoff({ to: "vedu/cursor", task: 4 }, from)).toThrow("different agent");
    expect(() => parseHandoff("not json", from)).toThrow("object");
  });

  it("is returned on read: the header carries from, to, and the task", () => {
    const handoff: Handoff = { from, to: { user: "jxn", session: null }, task: 12 };
    const e = entry({ handoff });
    const header = entryHeader(e);
    expect(header).toContain("#14 handoff");
    expect(header).toContain("from vedu/cursor to jxn's agent, task #12");
    expect(formatEntry(e)).toContain("from vedu/cursor to jxn's agent, task #12");
    expect(formatEntry(e)).toContain("Layout work is yours.");
    expect(compactLine(e)).toContain("task #12");
  });
});
