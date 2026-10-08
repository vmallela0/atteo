import { describe, expect, it } from "vitest";
import { keepSession, type KeepDeps } from "../cli/src/sessionRetry";

// #6591: a 404 "No live session" mid-deploy dropped a live session and started a new one, off the agent's board. A
// session this agent has on file is now tried again (1s, then 3s) before it's given up; an ended one is replaced at once.
const gone = () => Object.assign(new Error("No live session of yours by that id or name. Start one: atteo session new"), { status: 404 });
const ended = () => new Error("This agent session has ended.");

function harness(opts: { explicit?: boolean; stored?: boolean } = {}) {
  let cur = "as_original0000";
  const waits: number[] = [];
  const log = { dropped: 0, made: 0 };
  const deps: KeepDeps<string> = {
    get: async () => cur,
    drop: () => {
      log.dropped++;
      log.made++;
      cur = `as_new${log.made}000000000`;
    },
    explicit: !!opts.explicit,
    stored: () => opts.stored ?? true,
    sleep: async (ms) => void waits.push(ms),
  };
  return { deps, waits, log };
}

/** A request that fails with each of `errors` in turn, then answers with the session it ran as. */
function request(errors: (() => Error)[]) {
  const ran: string[] = [];
  const fn = async (s: string) => {
    ran.push(s);
    const e = errors.shift();
    if (e) throw e();
    return s;
  };
  return { fn, ran };
}

describe("keepSession (#6591)", () => {
  it("a transient 404 recovers on a retry, and the same session is kept", async () => {
    const { deps, waits, log } = harness();
    const { fn, ran } = request([gone, gone]);
    expect(await keepSession(deps, fn)).toBe("as_original0000");
    expect(ran).toEqual(["as_original0000", "as_original0000", "as_original0000"]);
    expect(waits).toEqual([1000, 3000]);
    expect(log.dropped).toBe(0);
  });

  it("a 404 on every try gives the session up and starts a new one", async () => {
    const { deps, waits, log } = harness();
    const { fn, ran } = request([gone, gone, gone]);
    expect(await keepSession(deps, fn)).toBe("as_new1000000000");
    expect(ran).toEqual(["as_original0000", "as_original0000", "as_original0000", "as_new1000000000"]);
    expect(waits).toEqual([1000, 3000]);
    expect(log.dropped).toBe(1);
  });

  it("an ended session is replaced at once, without retrying", async () => {
    const { deps, waits, log } = harness();
    const { fn, ran } = request([ended]);
    expect(await keepSession(deps, fn)).toBe("as_new1000000000");
    expect(ran).toEqual(["as_original0000", "as_new1000000000"]);
    expect(waits).toEqual([]);
    expect(log.dropped).toBe(1);
  });

  it("a session that ends during the retries is replaced then", async () => {
    const { deps, waits, log } = harness();
    const { fn } = request([gone, ended]);
    expect(await keepSession(deps, fn)).toBe("as_new1000000000");
    expect(waits).toEqual([1000]);
    expect(log.dropped).toBe(1);
  });

  it("a session not on file isn't retried: a 404 replaces it as before", async () => {
    const { deps, waits } = harness({ stored: false });
    const { fn } = request([gone]);
    expect(await keepSession(deps, fn)).toBe("as_new1000000000");
    expect(waits).toEqual([]);
  });

  it("--session / ATTEO_SESSION: the 404 goes back to the caller, with no retry and no new session", async () => {
    const { deps, waits, log } = harness({ explicit: true });
    const { fn, ran } = request([gone]);
    await expect(keepSession(deps, fn)).rejects.toThrow(/No live session/);
    expect(ran.length).toBe(1);
    expect(waits).toEqual([]);
    expect(log.dropped).toBe(0);
  });

  it("other errors pass straight through, also during the retries", async () => {
    const { deps, log } = harness();
    await expect(keepSession(deps, request([() => new Error("boom")]).fn)).rejects.toThrow("boom");
    await expect(keepSession(deps, request([gone, () => Object.assign(new Error("forbidden"), { status: 403 })]).fn)).rejects.toThrow("forbidden");
    expect(log.dropped).toBe(0);
  });
});
