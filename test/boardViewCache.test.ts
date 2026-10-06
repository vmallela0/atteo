import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BOARD_VIEW_CACHE_MS,
  boardViewGeneration,
  cachedBoardStub,
  cachedBoardView,
  invalidateBoardViews,
  resetBoardViewCache,
  viewPrincipal,
} from "../src/boardViewCache";
import type { Viewer } from "../src/types";

afterEach(() => {
  resetBoardViewCache();
  vi.useRealTimers();
});

const person = (user: string): Viewer => ({ user, person: true });
const agent = (user: string): Viewer => ({ user, person: false });

describe("viewPrincipal", () => {
  it("separates a person from their agent and from everyone else", () => {
    expect(viewPrincipal(person("vedu"))).toBe("vedu:person");
    expect(viewPrincipal(agent("vedu"))).toBe("vedu:agent");
    expect(viewPrincipal(person("jxn"))).toBe("jxn:person");
    expect(viewPrincipal(null)).toBe("anon");
    expect(viewPrincipal(undefined)).toBe("anon");
  });
});

describe("cachedBoardView", () => {
  it("keeps the TTL in the 2–5s window the hardening leftover asked for", () => {
    expect(BOARD_VIEW_CACHE_MS).toBe(3_000);
  });

  it(`keeps a hit for ${BOARD_VIEW_CACHE_MS / 1000} seconds and expires after that`, async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const load = vi.fn(async () => "summary-v1");
    const parts = { board: "b_hot", view: "snapshot", principal: "vedu:person", after: 0 };
    expect(await cachedBoardView(parts, load)).toBe("summary-v1");
    expect(await cachedBoardView(parts, load)).toBe("summary-v1");
    expect(load).toHaveBeenCalledTimes(1);
    vi.setSystemTime(BOARD_VIEW_CACHE_MS - 1);
    expect(await cachedBoardView(parts, load)).toBe("summary-v1");
    expect(load).toHaveBeenCalledTimes(1);
    vi.setSystemTime(BOARD_VIEW_CACHE_MS);
    expect(await cachedBoardView(parts, load)).toBe("summary-v1");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("coalesces a burst of identical polls into one load", async () => {
    let release!: (v: string) => void;
    const pending = new Promise<string>((r) => {
      release = r;
    });
    const load = vi.fn(() => pending);
    const parts = { board: "b_hot", view: "snapshot", principal: "vedu:person", after: 0 };
    const a = cachedBoardView(parts, load);
    const b = cachedBoardView(parts, load);
    const c = cachedBoardView(parts, load);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(load).toHaveBeenCalledTimes(1);
    release("snap");
    expect(await a).toBe("snap");
    expect(await b).toBe("snap");
  });

  it("does not leak one member's just-mine view to another member or to an agent", async () => {
    const load = vi.fn(async (who: string) => `${who}-private`);
    const vedu = await cachedBoardView({ board: "b_hot", view: "snapshot", principal: viewPrincipal(person("vedu")), after: 0 }, () => load("vedu-person"));
    const veduAgent = await cachedBoardView({ board: "b_hot", view: "snapshot", principal: viewPrincipal(agent("vedu")), after: 0 }, () => load("vedu-agent"));
    const jxn = await cachedBoardView({ board: "b_hot", view: "snapshot", principal: viewPrincipal(person("jxn")), after: 0 }, () => load("jxn-person"));
    expect(vedu).toBe("vedu-person-private");
    expect(veduAgent).toBe("vedu-agent-private");
    expect(jxn).toBe("jxn-person-private");
    expect(load).toHaveBeenCalledTimes(3);
    await cachedBoardView({ board: "b_hot", view: "snapshot", principal: viewPrincipal(person("vedu")), after: 0 }, () => load("vedu-person-again"));
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("does not reuse a snapshot from a different after cursor or board", async () => {
    const load = vi.fn(async (label: string) => label);
    await cachedBoardView({ board: "b_hot", view: "snapshot", principal: "vedu:person", after: 0 }, () => load("after-0"));
    await cachedBoardView({ board: "b_hot", view: "snapshot", principal: "vedu:person", after: 4 }, () => load("after-4"));
    await cachedBoardView({ board: "b_other", view: "snapshot", principal: "vedu:person", after: 0 }, () => load("other"));
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("invalidates on a new post (generation bump) so the next GET is not stale", async () => {
    const load = vi.fn(async () => `seq-${load.mock.calls.length}`);
    const parts = { board: "b_hot", view: "snapshot", principal: "vedu:person", after: 0 };
    expect(await cachedBoardView(parts, load)).toBe("seq-1");
    expect(boardViewGeneration("b_hot")).toBe(0);
    invalidateBoardViews("b_hot");
    expect(boardViewGeneration("b_hot")).toBe(1);
    expect(await cachedBoardView(parts, load)).toBe("seq-2");
    expect(await cachedBoardView(parts, load)).toBe("seq-2");
    expect(load).toHaveBeenCalledTimes(2);
    invalidateBoardViews("b_other");
    expect(await cachedBoardView(parts, load)).toBe("seq-2");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not cache an unsuccessful response", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("overloaded")).mockResolvedValue("ok");
    const parts = { board: "b_hot", view: "pinned" };
    await expect(cachedBoardView(parts, load)).rejects.toThrow("overloaded");
    expect(await cachedBoardView(parts, load)).toBe("ok");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("shares a board-wide pin across members (pin is not just-mine) but not across boards", async () => {
    const load = vi.fn(async (name: string) => name);
    expect(await cachedBoardView({ board: "b_hot", view: "pinned" }, () => load("SPEC.md"))).toBe("SPEC.md");
    expect(await cachedBoardView({ board: "b_hot", view: "pinned" }, () => load("OTHER.md"))).toBe("SPEC.md");
    expect(await cachedBoardView({ board: "b_other", view: "pinned" }, () => load("README.md"))).toBe("README.md");
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("cachedBoardStub", () => {
  it("caches snapshot per principal and invalidates when post settles", async () => {
    const snapshot = vi.fn(async (_after: number, _opts: object, viewer: Viewer) => ({ text: `${viewer.user}:${viewer.person ? "person" : "agent"}:${snapshot.mock.calls.length}` }));
    const post = vi.fn(async () => ({ seq: 2 }));
    const wait = vi.fn(async () => ({ entries: [] }));
    const stub = cachedBoardStub("b_hot", { snapshot, post, wait });
    const a = await stub.snapshot(0, {}, person("vedu"));
    const a2 = await stub.snapshot(0, {}, person("vedu"));
    expect(a).toEqual(a2);
    expect(a).toEqual({ text: "vedu:person:1" });
    const b = await stub.snapshot(0, {}, person("jxn"));
    expect(b).toEqual({ text: "jxn:person:2" });
    const agentView = await stub.snapshot(0, {}, agent("vedu"));
    expect(agentView).toEqual({ text: "vedu:agent:3" });
    expect(snapshot).toHaveBeenCalledTimes(3);
    await stub.post();
    expect(await stub.snapshot(0, {}, person("vedu"))).toEqual({ text: "vedu:person:4" });
    expect(snapshot).toHaveBeenCalledTimes(4);
    await stub.wait();
    expect(await stub.snapshot(0, {}, person("vedu"))).toEqual({ text: "vedu:person:4" });
    expect(snapshot).toHaveBeenCalledTimes(4);
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it("does not cache read (it has side effects) and still invalidates pin writes", async () => {
    const read = vi.fn(async () => ({ summaryText: "once" }));
    const pinned = vi.fn(async () => ({ name: `SPEC-v${pinned.mock.calls.length}` }));
    const pin = vi.fn(async () => ({ name: "SPEC.md" }));
    const stub = cachedBoardStub("b_hot", { read, pinned, pin });
    expect(await stub.read()).toEqual({ summaryText: "once" });
    expect(await stub.read()).toEqual({ summaryText: "once" });
    expect(read).toHaveBeenCalledTimes(2);
    expect(await stub.pinned()).toEqual({ name: "SPEC-v1" });
    expect(await stub.pinned()).toEqual({ name: "SPEC-v1" });
    await stub.pin();
    expect(await stub.pinned()).toEqual({ name: "SPEC-v2" });
    expect(pinned).toHaveBeenCalledTimes(2);
  });
});
