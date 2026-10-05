import { describe, expect, it } from "vitest";
import { BATCH_MAX, BatchError, batchUnits, formatBatch, parseBatch } from "../src/batch";

const known = ["read", "react", "post", "wait", "mailbox", "approval", "task"];

describe("parseBatch", () => {
  it("takes 1–10 known tools in order, args defaulting to {}", () => {
    const p = parseBatch({ calls: [{ tool: "read" }, { tool: "react", args: { seq: 3, emoji: "✅" } }, { tool: "post", args: { text: "hi" } }] }, known);
    expect(p.calls).toEqual([
      { tool: "read", args: {} },
      { tool: "react", args: { seq: 3, emoji: "✅" } },
      { tool: "post", args: { text: "hi" } },
    ]);
    expect(p.continueOnError).toBe(false);
    expect(parseBatch({ calls: [{ tool: "read" }], continue_on_error: true }, known).continueOnError).toBe(true);
  });

  it("refuses the whole batch before anything runs: empty, too long, nested, unknown, bad args", () => {
    const bad = (args: Record<string, unknown>, msg: RegExp) => expect(() => parseBatch(args, known)).toThrow(msg);
    bad({}, /calls must be a list/);
    bad({ calls: [] }, /calls must be a list/);
    bad({ calls: Array.from({ length: BATCH_MAX + 1 }, () => ({ tool: "read" })) }, /At most 10/);
    bad({ calls: [{ tool: "read" }, { tool: "batch", args: { calls: [] } }] }, /Call 2: a batch can't contain another batch/);
    bad({ calls: [{ tool: "rm_rf" }] }, /unknown tool "rm_rf"/);
    bad({ calls: [{ tool: "post", args: [1] }] }, /args must be an object/);
    bad({ calls: ["read"] }, /needs \{tool, args\}/);
    expect(() => parseBatch({ calls: [] }, known)).toThrow(BatchError);
  });

  it("a wait (wait, mailbox with wait_seconds) may only come last", () => {
    expect(parseBatch({ calls: [{ tool: "post", args: { text: "q?" } }, { tool: "wait" }] }, known).calls).toHaveLength(2);
    expect(() => parseBatch({ calls: [{ tool: "wait" }, { tool: "read" }] }, known)).toThrow(/Call 1: a wait can only be the last/);
    expect(() => parseBatch({ calls: [{ tool: "mailbox", args: { wait_seconds: 5 } }, { tool: "read" }] }, known)).toThrow(/last/);
    expect(parseBatch({ calls: [{ tool: "read" }, { tool: "mailbox", args: { wait_seconds: 5 } }] }, known).calls).toHaveLength(2);
    expect(parseBatch({ calls: [{ tool: "mailbox", args: { peek: true } }, { tool: "read" }] }, known).calls).toHaveLength(2); // no wait_seconds: not a wait
  });

  it("everyday tools only: the rest are refused by name before anything runs", () => {
    const all = [...known, "approval", "request_approval", "invite", "join_board", "leave_board", "create_board", "publish", "schedules", "trigger", "memory", "remember", "handle", "review", "claim", "doc", "people", "agents", "session", "get", "search", "grep", "recap", "retract"];
    for (const tool of ["approval", "request_approval", "invite", "join_board", "leave_board", "create_board", "publish", "schedules", "trigger", "memory", "remember", "handle", "review", "claim"]) {
      expect(() => parseBatch({ calls: [{ tool: "read" }, { tool, args: { action: "list" } }] }, all)).toThrow(`Call 2: ${tool} can't run inside batch; call it on its own.`);
    }
    for (const tool of ["read", "get", "search", "grep", "recap", "react", "post", "retract", "mailbox", "wait", "session"]) {
      expect(parseBatch({ calls: [{ tool }] }, all).calls[0].tool).toBe(tool);
    }
  });

  it("tools with risky actions: only their everyday actions, named explicitly", () => {
    const all = [...known, "doc", "people", "agents"];
    const ok = (tool: string, action: string) => expect(parseBatch({ calls: [{ tool, args: { action } }] }, all).calls).toHaveLength(1);
    const no = (tool: string, action?: string) => expect(() => parseBatch({ calls: [{ tool, args: action ? { action } : {} }] }, all)).toThrow(/can't run inside batch; call it on its own \(inside batch: action /);
    for (const a of ["list", "get", "create", "edit", "history", "claim", "release", "update"]) ok("task", a);
    no("task", "stop");
    for (const a of ["list", "read", "grep", "history"]) ok("doc", a);
    for (const a of ["write", "edit", "pin", "unpin"]) no("doc", a);
    for (const a of ["search", "whois", "friends"]) ok("people", a);
    no("people", "direct");
    for (const a of ["find", "get"]) ok("agents", a);
    for (const a of ["profile", "dm"]) no("agents", a);
    no("doc"); // no action: refused, not guessed
    expect(() => parseBatch({ calls: [{ tool: "task", args: { action: "stop", seq: 1 } }] }, all)).toThrow("Call 1: task stop can't run inside batch");
  });
});

describe("batchUnits (what the rate limiter counts)", () => {
  it("a batch counts as its inner calls; anything else as itself", () => {
    const m = { method: "tools/call", params: { name: "batch", arguments: { calls: [{ tool: "read" }, { tool: "post", args: { text: "x" } }, { tool: "wait" }] } } };
    expect(batchUnits(m).map((u) => u.params?.name)).toEqual(["read", "post", "wait"]);
    expect(batchUnits(m)[1].params?.arguments).toEqual({ text: "x" });
    const read = { method: "tools/call", params: { name: "read" } };
    expect(batchUnits(read)).toEqual([read]);
    const empty = { method: "tools/call", params: { name: "batch", arguments: { calls: [] } } };
    expect(batchUnits(empty)).toEqual([empty]);
    const huge = { method: "tools/call", params: { name: "batch", arguments: { calls: Array.from({ length: 50 }, () => ({ tool: "read" })) } } };
    expect(batchUnits(huge)).toHaveLength(BATCH_MAX);
  });
});

describe("formatBatch", () => {
  it("one compact line per call; longer results follow their line; says what didn't run", () => {
    const out = formatBatch(
      [
        { tool: "read", ok: true, text: "== board ==\n#5 jxn: hi" },
        { tool: "react", ok: true, text: "Reacted ✅ to #5." },
        { tool: "post", ok: false, text: "Not posted: #6 is new." },
      ],
      5,
    );
    expect(out).toBe("1 ✓ read\n== board ==\n#5 jxn: hi\n2 ✓ react: Reacted ✅ to #5.\n3 ✗ post: Not posted: #6 is new.\nstopped at 3: 4–5 not run");
    expect(formatBatch([{ tool: "read", ok: false, text: "nope" }], 2)).toBe("1 ✗ read: nope\nstopped at 1: 2 not run");
    expect(formatBatch([{ tool: "read", ok: true, text: "" }], 1)).toBe("1 ✓ read");
  });
});
