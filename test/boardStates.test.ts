import { afterEach, describe, expect, it, vi } from "vitest";
import { BOARD_STATES_SQL, boardState, boardStates, workingAgents } from "../src/boardStates";
import type { Env } from "../src/types";

const { DatabaseSync } = await import("node:" + "sqlite");
const { readFileSync, readdirSync } = await import("node:" + "fs");

afterEach(() => vi.useRealTimers());

describe("board state", () => {
  it.each([
    [0, 0, "quiet"], [2, 0, "working"], [0, 1, "approval"], [3, 2, "approval"],
  ])("%i working and %i approvals gives %s", (working, pending, state) => {
    expect(boardState(Number(working), Number(pending))).toBe(state);
  });

  it("counts sessions once, including idle handlers but excluding idle non-handlers and former members", () => {
    const sessions = [
      { user: "alice", session: "as_one", last_seen: 200_000 },
      { user: "alice", session: "as_two", last_seen: 1 },
      { user: "alice", session: "as_three", last_seen: 1 },
      { user: "bob", session: null, last_seen: 200_000 },
    ];
    expect(workingAgents(sessions, [
      { user: "alice", session: "as_one" }, { user: "alice", session: "as_one" },
      { user: "alice", session: "as_two" }, { user: "former", session: "as_one" },
    ], 200_001)).toBe(3);
    expect(workingAgents(sessions, [], 320_000)).toBe(0);
  });

  it("queries only member boards, own unexpired approvals and eligible presence using the real schema", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const dir = new URL("../migrations/", (import.meta as unknown as { url: string }).url);
      for (const f of readdirSync(dir).filter((f: string) => f.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(f, dir), "utf8"));
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${BOARD_STATES_SQL}`).all("alice", 200_001, 80_001).map((r: any) => r.detail);
      expect(plan.some((p: string) => /SEARCH s USING INDEX agent_sessions_user/.test(p)), plan.join("\n")).toBe(true);
      expect(plan.some((p: string) => /SCAN s\b/.test(p)), plan.join("\n")).toBe(false);
      for (const [id, kind, deleted] of [["board", null, null], ["dm", "direct", null], ["self", "agent", null], ["deleted", null, 1], ["outside", null, null]]) {
        db.prepare("INSERT INTO boards (id, title, kind, created_by, created_at, last_activity, deleted_at) VALUES (?, ?, ?, 'alice', 1, 1, ?)").run(id, id, kind, deleted);
        if (id !== "outside") db.prepare("INSERT INTO members (board_id, user, joined_at, last_seen) VALUES (?, 'alice', 1, 1)").run(id);
      }
      for (const [id, user, status, expires] of [["yes", "alice", "pending", 400_000], ["other", "bob", "pending", 400_000], ["old", "alice", "pending", 1], ["done", "alice", "approved", 400_000]]) {
        db.prepare("INSERT INTO approvals (id, user, board_id, title, details, risk, status, created_at, expires_at) VALUES (?, ?, 'board', 'Allow?', 'details', 'low', ?, 1, ?)").run(id, user, status, expires);
      }
      for (const [id, user, kind, ended] of [["live", "alice", "main", null], ["ended", "alice", "main", 1], ["fork", "alice", "fork", null], ["outsider", "bob", "main", null]]) {
        db.prepare(`INSERT INTO agent_sessions (id, user, name, boards, created_at, last_seen, kind, ended_at) VALUES (?, ?, ?, '["board"]', 1, 200000, ?, ?)`).run(id, user, id, kind, ended);
      }
      db.prepare("INSERT INTO mcp_sessions (id, user, board_id, created_at, last_seen) VALUES ('legacy', 'alice', 'board', 1, 200000)").run();
      const rows = db.prepare(BOARD_STATES_SQL).all("alice", 200_001, 80_001);
      expect(rows.map((r: any) => [r.id, r.kind, r.pending_approvals])).toEqual([["board", "board", 1], ["dm", "dm", 0], ["self", "dm", 0]]);
      expect(JSON.parse(rows[0].sessions)).toEqual([{ user: "alice", session: "live", last_seen: 200_000 }]);
      db.exec("DELETE FROM agent_sessions");
      expect(JSON.parse(db.prepare(BOARD_STATES_SQL).all("alice", 200_001, 80_001)[0].sessions)).toEqual([{ user: "alice", session: null, last_seen: 200_000 }]);
      expect(JSON.parse(db.prepare(BOARD_STATES_SQL).all("alice", 400_001, 280_001)[0].sessions)).toEqual([]);
    } finally { db.close(); }
  });

  it("coalesces polls, fans out once per board in parallel, isolates users and expires after 10 seconds", async () => {
    vi.useFakeTimers();
    const all = vi.fn(async () => ({ results: ["one", "two"].map((id) => ({ id, title: id, kind: "board", pending_approvals: 0, sessions: "[]" })) }));
    let release!: (n: number) => void;
    const pending = new Promise<number>((r) => { release = r; });
    const workingAgentCount = vi.fn(() => pending);
    const env = { PUBLIC_URL: "https://cache-test", DB: { prepare: () => ({ bind: () => ({ all }) }) }, BOARD: { idFromName: (id: string) => id, get: () => ({ workingAgentCount }) } } as unknown as Env;
    const first = boardStates(env, "alice");
    expect(boardStates(env, "alice")).toBe(first);
    await Promise.resolve();
    expect(all).toHaveBeenCalledTimes(1);
    expect(workingAgentCount).toHaveBeenCalledTimes(2);
    release(1);
    expect((await first).map((b) => b.state)).toEqual(["working", "working"]);
    await boardStates(env, "bob");
    expect(all).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(10_000);
    await boardStates(env, "alice");
    expect(all).toHaveBeenCalledTimes(3);
  });

  it("retries a transient DO failure and does not cache an unsuccessful response", async () => {
    vi.useFakeTimers();
    const all = vi.fn(async () => ({ results: [{ id: "one", title: "one", kind: "board", pending_approvals: 1, sessions: "[]" }] }));
    const workingAgentCount = vi.fn().mockRejectedValueOnce(new Error("Network connection lost")).mockResolvedValueOnce(0).mockRejectedValueOnce(new Error("unavailable")).mockResolvedValue(1);
    const env = { PUBLIC_URL: "https://retry-test", DB: { prepare: () => ({ bind: () => ({ all }) }) }, BOARD: { idFromName: (id: string) => id, get: () => ({ workingAgentCount }) } } as unknown as Env;
    const first = boardStates(env, "alice");
    await vi.advanceTimersByTimeAsync(150);
    expect((await first)[0].state).toBe("approval");
    expect(workingAgentCount).toHaveBeenCalledTimes(2);
    await expect(boardStates(env, "bob")).rejects.toThrow("unavailable");
    expect((await boardStates(env, "bob"))[0].working_agents).toBe(1);
    expect(all).toHaveBeenCalledTimes(3);
  });
});
