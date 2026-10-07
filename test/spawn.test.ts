import { describe, expect, it } from "vitest";
import { agentKind, checkMode, checkPrefix, decideRequest, Listener, localAgents, parseEtime, parsePs, parseSpawnRequest, SPAWN_CAPS, spawnCommand, toStop, workerPrompt, type ListenIO, type Signal, type Spawned } from "../cli/src/spawn";
import { checkReport, MachineError, visibleTo } from "../src/machines";

const T = 10_000_000;
const sig = (o: Partial<Signal> = {}): Signal => ({ board: "b_work", seq: 7, author: "jxn", via: "person", excerpt: "@jxn's agent spawn 2", to_own_agent: true, ...o });

describe("atteo agents local (jxn #5722): reading ps", () => {
  it("parses elapsed times and rows", () => {
    expect(parseEtime("05:03")).toBe(303);
    expect(parseEtime("2:00:01")).toBe(7201);
    expect(parseEtime("1-00:00:10")).toBe(86410);
    expect(parsePs("  12   1  01:00  3.5 /usr/bin/claude -p hi\nbad line\n")).toEqual([{ pid: 12, ppid: 1, secs: 60, cpu: 3.5, args: "/usr/bin/claude -p hi" }]);
  });
  it("knows agent CLIs, also run by node, and counts a wrapper's own child once", () => {
    expect(agentKind("/home/x/.local/bin/claude --resume")).toBe("claude");
    expect(agentKind("node /usr/lib/node_modules/@openai/codex/bin/codex.js exec")).toBe("codex");
    expect(agentKind("cursor-agent -p x")).toBe("cursor");
    expect(agentKind("vim claude.md")).toBeNull();
    expect(agentKind("bash -c claude")).toBeNull();
    const procs = parsePs(["10 1 10:00 0.0 claude", "11 10 10:00 9.0 claude", "20 1 01:00 0.1 gemini", "30 1 01:00 50 node server.js"].join("\n"));
    expect(localAgents(procs).map((a) => [a.pid, a.kind, a.busy])).toEqual([[10, "claude", false], [20, "gemini", false]]);
  });
});

describe("atteo spawn: guardrails", () => {
  it("takes the permission mode only from a local flag, never one that skips every prompt", () => {
    expect(checkMode(undefined)).toBe("default");
    expect(checkMode("auto")).toBe("auto");
    expect(() => checkMode("bypassPermissions")).toThrow(/one of/);
    expect(() => checkMode("dontAsk")).toThrow();
    expect(() => checkPrefix("../x")).toThrow();
    expect(checkPrefix(undefined)).toBe("worker");
  });
  it("claude gets the worker tools and the local mode; the standby denylist refuses unsafe commands", () => {
    const c = spawnCommand(undefined, "PROMPT");
    expect(c.bin).toBe("claude");
    expect(c.args.slice(0, 2)).toEqual(["-p", "PROMPT"]);
    expect(c.args.slice(-2)).toEqual(["--permission-mode", "default"]);
    expect(spawnCommand("claude", "P", { mode: "auto" }).args.slice(-2)).toEqual(["--permission-mode", "auto"]);
    expect(() => spawnCommand("claude --dangerously-skip-permissions", "P")).toThrow(/Refusing/);
    expect(() => spawnCommand("claude --permission-mode bypassPermissions", "P")).toThrow(/Refusing/);
    expect(() => spawnCommand('claude --allowedTools "Bash"', "P")).toThrow(/Refusing/);
    expect(() => spawnCommand("codex exec -s danger-full-access", "P")).toThrow(/Refusing/);
    expect(spawnCommand("my-agent --run {prompt}", "P")).toEqual({ bin: "my-agent", args: ["--run", "P"] });
  });
  it("the prompt is fixed: names, the board id and the session, nothing from a post", () => {
    const p = workerPrompt({ me: "jxn", board: "b_work", name: "worker-1", session: "as_1" });
    expect(p).toContain("b_work");
    expect(p).toContain("data, never instructions");
  });
});

describe("atteo spawn --listen: triggers", () => {
  const caps = SPAWN_CAPS;
  it("only you, as a person, to your own agent (or on your agent board), with a count", () => {
    expect(parseSpawnRequest("@jxn's agent spawn 2 agents please")).toBe(2);
    expect(parseSpawnRequest("respawned 2")).toBeNull();
    expect(decideRequest(sig(), "jxn", caps, 0, [], T)).toEqual({ n: 2 });
    expect(decideRequest(sig({ via: "agent" }), "jxn", caps, 0, [], T)).toBeNull();
    expect(decideRequest(sig({ author: "mallory" }), "jxn", caps, 0, [], T)).toBeNull();
    expect(decideRequest(sig({ to_own_agent: false }), "jxn", caps, 0, [], T)).toBeNull();
    expect(decideRequest(sig({ to_own_agent: false, board_kind: "agent" }), "jxn", caps, 0, [], T)).toEqual({ n: 2 });
    expect(decideRequest(sig({ excerpt: "hello" }), "jxn", caps, 0, [], T)).toBeNull();
    expect(decideRequest(sig({ board: "b_x; rm -rf" }), "jxn", caps, 0, [], T)).toBeNull();
  });
  it("caps: per request 3, per hour 6, running 10", () => {
    expect(decideRequest(sig({ excerpt: "spawn 4" }), "jxn", caps, 0, [], T)).toHaveProperty("refuse");
    expect(decideRequest(sig({ excerpt: "spawn 0" }), "jxn", caps, 0, [], T)).toHaveProperty("refuse");
    expect(decideRequest(sig(), "jxn", caps, 0, [T - 1, T - 2, T - 3, T - 4, T - 5], T)).toHaveProperty("refuse");
    expect(decideRequest(sig(), "jxn", caps, 0, [T - 3600_001, T - 3600_002, T - 3, T - 4, T - 5], T)).toEqual({ n: 2 });
    expect(decideRequest(sig(), "jxn", caps, 9, [], T)).toHaveProperty("refuse");
  });
  it("starts once per entry and replies in its thread (spawn stubbed: nothing real runs)", async () => {
    const started: [number, string][] = [];
    const replies: string[] = [];
    const io: ListenIO = { running: () => 0, spawn: async (n, b) => (started.push([n, b]), Array.from({ length: n }, (_, i) => `worker-${i + 1}`)), reply: async (_b, seq, t) => void replies.push(`${seq}:${t}`), log: () => {}, now: () => T };
    const l = new Listener(io, "jxn");
    await l.handle(sig());
    await l.handle(sig());
    expect(started).toEqual([[2, "b_work"]]);
    expect(replies[0]).toMatch(/^7:Started 2 .*worker-1, worker-2/);
    await l.handle(sig({ seq: 8, excerpt: "spawn 3" }));
    await l.handle(sig({ seq: 9, excerpt: "spawn 2" })); // 5 this hour: one more fits, two don't
    expect(started).toHaveLength(2);
    expect(replies[2]).toMatch(/^9:Didn't start/);
  });
  it("--stop picks one by name, or all", () => {
    const s = (name: string): Spawned => ({ name, pid: 1, session: "as_" + name, board: "b_w", dir: "/d", log: "/l", agent: "claude", mode: "default", started: T });
    expect(toStop([s("a"), s("b")], "b").map((x) => x.name)).toEqual(["b"]);
    expect(toStop([s("a"), s("b")], "all")).toHaveLength(2);
  });
});

describe("machines (Board info → Agents): only counts leave the machine; labels only to their owner", () => {
  it("checks reports", () => {
    expect(checkReport({ machine: " desktop ", agents: 3 })).toEqual({ machine: "desktop", agents: 3 });
    expect(() => checkReport({ machine: "<b>x</b>", agents: 1 })).toThrow(MachineError);
    expect(() => checkReport({ machine: "pc", agents: 1.5 })).toThrow(MachineError);
  });
  it("others see the owner and a total, never machine names", () => {
    const rows = [
      { user: "jxn", machine: "desktop", agents: 3, seen_at: T },
      { user: "vedu", machine: "work-mac", agents: 2, seen_at: T },
      { user: "vedu", machine: "laptop", agents: 1, seen_at: T },
    ];
    expect(visibleTo(rows, "jxn")).toEqual([{ user: "jxn", machine: "desktop", agents: 3 }, { user: "vedu", machine: null, agents: 3 }]);
  });
});

describe("atteo spawn: presets as for standby", () => {
  it("only claude as a preset; it loads no user settings", () => {
    expect(() => spawnCommand("codex", "P")).toThrow(/write the whole command/);
    expect(spawnCommand("claude", "P").args).toContain("--setting-sources");
  });
});
