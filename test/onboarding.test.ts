import { describe, expect, it } from "vitest";
import { startLogin, waitForApproval, type DeviceStart } from "../cli/src/deviceLogin";
import { setUp, type SetUpDeps } from "../cli/src/harness";

const start: DeviceStart = { device_code: "dc_x", user_code: "BCDF-GHJK", verification_uri: "http://s/device", verification_uri_complete: "http://s/device?code=BCDF-GHJK", expires_in: 600, interval: 3 };
const answers = (...bodies: object[]) => {
  const calls: string[] = [];
  const f = async (url: string, init: { body: string }) => {
    calls.push(`${url} ${init.body}`);
    const b = bodies.shift() ?? { status: "pending" };
    return { ok: true, status: 200, json: async () => b };
  };
  return { f, calls };
};

describe("device sign-in (atteo login, atteo harness)", () => {
  it("polls at the server's interval until the person approves, then saves the login", async () => {
    const { f, calls } = answers({ status: "pending" }, { status: "ok", token: "t", user: "ana", expires_at: 9 });
    const saved: unknown[] = [];
    const waits: number[] = [];
    const c = await waitForApproval("http://s", start, (x) => saved.push(x), f, async (ms) => void waits.push(ms));
    expect(c).toEqual({ server: "http://s", user: "ana", token: "t", expires_at: 9 });
    expect(saved).toEqual([c]);
    expect(waits).toEqual([3000, 3000]);
    expect(calls[0]).toBe(`http://s/api/device/token {"device_code":"dc_x"}`);
  });
  it("stops on a denial or an expired code, and when its own time is up", async () => {
    await expect(waitForApproval("http://s", start, () => {}, answers({ status: "denied" }).f, async () => {})).rejects.toThrow("denied");
    await expect(waitForApproval("http://s", start, () => {}, answers({ status: "expired" }).f, async () => {})).rejects.toThrow("expired");
    let t = 0;
    await expect(waitForApproval("http://s", start, () => {}, answers().f, async (ms) => void (t += ms), () => t)).rejects.toThrow("expired");
    expect(t).toBe(600_000);
  });
  it("says so when the server limits sign-ins", async () => {
    const f = async () => ({ ok: false, status: 429, json: async () => ({}) });
    await expect(startLogin("http://s", "Atteo CLI", "ua", f)).rejects.toThrow("Too many sign-ins");
  });
});

function machine(over: Partial<SetUpDeps> = {}) {
  const log: string[] = [];
  const d: SetUpDeps = {
    which: () => true,
    signedIn: () => null,
    signIn: async () => (log.push("sign in"), { user: "ana" }),
    save: (a) => void log.push(`save ${a}`),
    folderBoard: () => null,
    anyBoard: () => false,
    createBoard: async (t) => (log.push(`create "${t}"`), "b_new"),
    openKeys: async (b) => void log.push(`keys ${b}`),
    run: (bin, args) => (log.push(`run ${bin} ${args.join(" ")}`), { code: 0, out: "" }),
    say: (l) => void log.push(`say ${l}`),
    folderName: () => "myproj",
    ...over,
  };
  return { d, log };
}

describe("atteo harness <agent> (spawn stubbed)", () => {
  it("takes a clean machine to an encrypted board for this folder, with the agent connected and no questions", async () => {
    const { d, log } = machine();
    expect(await setUp("claude", d)).toBe(true);
    expect(log.slice(0, 5)).toEqual(["sign in", "save claude", 'create "myproj"', "keys b_new", "run claude mcp add --scope user atteo -- atteo mcp"]);
    expect(log.join("\n")).toContain("New end-to-end encrypted board b_new");
  });
  it("stops with one line on how to install the agent, before signing in", async () => {
    const { d, log } = machine({ which: () => false });
    expect(await setUp("codex", d)).toBe(false);
    expect(log).toEqual(["say codex isn't installed. Install it with: npm install -g @openai/codex  then run: atteo harness codex"]);
  });
  it("skips what's done: the login, the folder's board, an MCP server already added", async () => {
    const { d, log } = machine({ signedIn: () => ({ user: "ana" }), folderBoard: () => "b_old", run: () => ({ code: 1, out: "MCP server atteo already exists in user config" }) });
    expect(await setUp("claude", d)).toBe(true);
    expect(log).not.toContain("sign in");
    expect(log.some((l) => l.startsWith("create"))).toBe(false);
    expect(log).toContain("keys b_old");
    expect(log.join("\n")).toContain("claude has the board's tools");
  });
  it("makes no board in a stray folder of a machine that already uses one", async () => {
    const { d, log } = machine({ signedIn: () => ({ user: "ana" }), anyBoard: () => true });
    expect(await setUp("claude", d)).toBe(true);
    expect(log.some((l) => l.startsWith("create") || l.startsWith("keys"))).toBe(false);
    expect(log.join("\n")).toContain("This folder has no board");
  });
  it("shows how to connect an agent whose CLI can't add MCP servers itself", async () => {
    const { d, log } = machine({ folderName: () => null });
    await setUp("cursor", d);
    expect(log).toContain(`create "ana's board"`);
    expect(log.some((l) => l.startsWith("run"))).toBe(false);
    expect(log.join("\n")).toContain("~/.cursor/mcp.json");
  });
});
