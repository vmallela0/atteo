import { describe, expect, it } from "vitest";
import { cleanTrigger, lastOccurrence, matches, TriggerError, type TriggerEvent } from "../src/triggers";
import { formatRecap, parseSince, type Recap } from "../src/recap";

const entry = (over: Partial<NonNullable<TriggerEvent["entry"]>> = {}) =>
  ({ seq: 5, ts: 1, author: "jxn", type: "question", text: "When do we deploy?", to: null, mentions: [], reply_to: null, resolves: [], supersedes: null, retracts: null, artifact_name: null, artifact_size: null, via: "agent", ...over }) as NonNullable<TriggerEvent["entry"]>;
const ev = (e = entry()): TriggerEvent => ({ on: "entry", actor: e.author, via: e.via ?? null, seq: e.seq, entry: e });

describe("triggers", () => {
  it("validates on, prompt and a schedule's time", () => {
    expect(() => cleanTrigger({ on: "nope", prompt: "x" })).toThrow(TriggerError);
    expect(() => cleanTrigger({ on: "entry", prompt: "" })).toThrow(/prompt/);
    expect(() => cleanTrigger({ on: "schedule", prompt: "x", match: { at: "25:00" } })).toThrow(/HH:MM/);
    expect(cleanTrigger({ on: "schedule", prompt: " x ", match: { at: "09:30", text: "ignored" } })).toEqual({ on: "schedule", match: { at: "09:30" }, prompt: "x" });
  });
  it("matches entries by type, text and mention; questions; mentions of the creator", () => {
    const me = { created_by: "vedu" };
    expect(matches({ ...me, on: "entry", match: { type: "question", text: "DEPLOY" } }, ev())).toBe(true);
    expect(matches({ ...me, on: "entry", match: { type: "task" } }, ev())).toBe(false);
    expect(matches({ ...me, on: "entry", match: { mention: "ann" } }, ev(entry({ mentions: [{ user: "ann", agent: true }] })))).toBe(true);
    expect(matches({ ...me, on: "question", match: {} }, ev())).toBe(true);
    expect(matches({ ...me, on: "change", match: {} }, ev())).toBe(false);
    expect(matches({ ...me, on: "mention", match: {} }, ev())).toBe(false);
    expect(matches({ ...me, on: "mention", match: {} }, ev(entry({ to: "vedu" })))).toBe(true);
  });
  it("matches tasks by change, status, assignee and label (priority or a title word)", () => {
    const t: TriggerEvent = { on: "task", actor: "jxn", via: "person", seq: 9, task: { seq: 9, title: "Fix the login bug", status: "done", assignee: "jxn", priority: "high", change: "status" } };
    const m = (match: object) => matches({ created_by: "vedu", on: "task", match }, t);
    expect(m({ status: "done", assignee: "jxn" })).toBe(true);
    expect(m({ task: "created" })).toBe(false);
    expect(m({ label: "high" })).toBe(true);
    expect(m({ label: "login" })).toBe(true);
    expect(m({ label: "log" })).toBe(false);
  });
  it("approval triggers only see their creator's own approvals", () => {
    const a: TriggerEvent = { on: "approval", actor: "vedu", via: "person", seq: null, approval: { id: "ap_1", user: "vedu", status: "approved", title: "t", tool: null, command: null, risk: "low", expires_at: 0, note: null, session: null, about: null, created_at: 0, decided_at: 1 } };
    expect(matches({ created_by: "vedu", on: "approval", match: { status: "approved" } }, a)).toBe(true);
    expect(matches({ created_by: "jxn", on: "approval", match: {} }, a)).toBe(false);
  });
  it("finds a schedule's latest daily occurrence", () => {
    const now = Date.UTC(2026, 9, 3, 10, 0);
    expect(lastOccurrence("09:30", now)).toBe(Date.UTC(2026, 9, 3, 9, 30));
    expect(lastOccurrence("11:00", now)).toBe(Date.UTC(2026, 9, 2, 11, 0));
  });
});

describe("recap text", () => {
  it("parses since and stays within 15 lines", () => {
    expect(parseSince(undefined)).toBe("last-read");
    expect(parseSince("12")).toBe(12);
    expect(() => parseSince("yesterday")).toThrow();
    const many = Array.from({ length: 30 }, (_, i) => i + 1);
    const task = (seq: number) => ({ seq, title: `Task ${seq}`, status: "todo", priority: null, owner: `u${seq}`, owner_label: `u${seq}'s agent`, updated_at: 0 });
    const r: Recap = {
      board: { id: "b_x", title: "X", encrypted: false }, since: 3, since_ts: 0, basis: "seq", until: 90, entries: 87,
      decisions: many.map((seq) => ({ seq, title: `D${seq}`, author: "a", via: "agent", ts: 0, human: false, state: null, waiting_on: [] })),
      questions: many.map((seq) => ({ seq, title: `Q${seq}`, author: "a", via: "agent", to: "b", ts: 0, waiting_on: ["b's agent"], new: true })),
      owed: [],
      tasks_moved: { new: many.map(task), done: [], blocked: [], by_owner: many.map((seq) => ({ owner: `u${seq}`, label: `u${seq}'s agent`, new: [seq], blocked: [], done: [] })) },
      approvals: [{ id: "ap_1", title: "Deploy", risk: "high", tool: null, session: null, created_at: 0, expires_at: 1 }],
      files: [{ name: "a.md", from_version: 0, to_version: 1, versions: 1, authors: ["a"] }],
      members: [{ name: "ann", joined_at: 1 }],
      pinned: null,
    };
    const text = formatRecap(r);
    expect(text.split("\n").length).toBeLessThanOrEqual(15);
    expect(text).toContain("Decisions (30): #1 D1");
    expect(text).toContain("… 25 more (task list)");
  });
});
