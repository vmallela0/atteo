// atteo ping (jxn #5433): the CLI's pong, the target, and one row per session from what the board holds.
import { describe, expect, it } from "vitest";
import { describeRow, liveRows, parseTarget, pongFor } from "../src/listen";

describe("atteo ping", () => {
  it("answers only the board's ping frame", () => {
    expect(pongFor({ type: "ping", id: "p_0123abcd" })).toBe('{"type":"pong","id":"p_0123abcd"}');
    expect(pongFor({ type: "entry", id: "p_0123abcd" })).toBeNull();
    expect(pongFor({ type: "ping", id: "<script>" })).toBeNull();
  });

  it("reads who to ping", () => {
    expect(parseTarget("@Vedu's agent")).toEqual({ user: "vedu", session: null });
    expect(parseTarget("vedu/bender")).toEqual({ user: "vedu", session: "bender" });
    expect(parseTarget("all")).toBeNull();
  });

  it("shows each session's best listener; a silent socket is an old CLI, not offline", () => {
    const names = new Map([
      ["as_1", { name: "bender", client: "Claude Code" }],
      ["as_2", { name: "old", client: null }],
      ["as_3", { name: "waiter", client: null }],
    ]);
    const now = 1_000_000;
    const rows = liveRows(
      [
        { user: "vedu", session: "as_1", kind: "wait" },
        { user: "vedu", session: "as_1", kind: "socket", rtt_ms: 42 },
        { user: "vedu", session: "as_2", kind: "socket", rtt_ms: null },
        { user: "vedu", session: "as_3", kind: "wait" },
      ],
      names,
      [{ user: "vedu", name: "web", client: "claude.ai", last_seen: now - 35_000 }],
      { jxn: now - 5_000 },
      true,
      null,
    );
    const line = (u: string, s: string | null) => describeRow(rows.find((r) => r.user === u && r.session === s)!, now);
    expect(line("vedu", "bender")).toBe("vedu/bender (Claude Code)  listening · 42 ms");
    expect(line("vedu", "old")).toBe("vedu/old  connected (old CLI, atteo update)");
    expect(line("vedu", "waiter")).toContain("listening (atteo wait");
    expect(line("vedu", "web")).toBe("vedu/web (claude.ai)  no listener (MCP), last call 35s ago");
    expect(line("jxn", null)).toBe("jxn's agent  no listener (MCP), last call 5s ago");
    expect(liveRows([], names, [], {}, true, { user: "bo", session: null }).map((r) => r.state)).toEqual(["offline"]);
    expect(liveRows([{ user: "vedu", session: "as_1", kind: "socket" }], names, [], {}, false, null)[0].state).toBe("connected");
  });
});
