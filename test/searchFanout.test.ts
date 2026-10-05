import { describe, expect, it, vi } from "vitest";
vi.mock("../src/registry", async (original) => ({ ...await original<typeof import("../src/registry")>(), grepBoards: vi.fn() }));
import * as registry from "../src/registry";
import { compactHitLine, cursorKey, decodeCursor, encodeCursor, GREP_BOARDS, GREP_CONCURRENCY, GrepError, runGrep, type BoardGrepHit, type BoardGrepOpts, type BoardGrepResult } from "../src/grep";
import type { Env } from "../src/types";

const result = (hits: BoardGrepHit[] = [], more: BoardGrepResult["more"] = null): BoardGrepResult => ({ title: "Dev board", hits, more, encrypted: false, fallback: false, capped: false, budget: false });
const hit = (seq: number, text = `«hit» ${seq}`): BoardGrepHit => ({ seq, author: "vedu", ts: Date.UTC(2026, 9, 2), text, after: { mode: "fts", before: seq, line: 0 } });
const ticks = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function rig(n: number, fn: (id: string, opts: BoardGrepOpts) => Promise<BoardGrepResult>, encrypted = 0) {
  vi.mocked(registry.grepBoards).mockResolvedValue(Array.from({ length: n + encrypted }, (_, i) => ({ id: `b_${i}`, title: `Dev board ${i}`, encrypted: i >= n ? 1 : 0 })));
  const calls: { id: string; opts: BoardGrepOpts }[] = [];
  const env = { BOARD: { idFromName: (id: string) => id, get: (id: string) => ({ grepLines: (_pattern: string, opts: BoardGrepOpts) => { calls.push({ id, opts }); return fn(id, opts); } }) } } as unknown as Env;
  return { env, calls };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("parallel cross-board grep", () => {
  it("starts at most GREP_CONCURRENCY and returns at max without waiting for slow boards", async () => {
    const slow = deferred<BoardGrepResult>();
    const fast = deferred<BoardGrepResult>();
    const { env, calls } = rig(12, (id, opts) => id === "b_1" ? fast.promise.then((r) => {
      const available = r.hits.filter((h) => !opts.more || h.seq! < opts.more.before);
      const hits = available.slice(0, opts.max);
      return result(hits, available.length > hits.length ? hits[hits.length - 1].after : null);
    }) : slow.promise, 2);
    const running = runGrep(env, "vedu", "hit", { max: 2 }, null, null);
    await ticks();
    expect(calls).toHaveLength(GREP_CONCURRENCY);
    fast.resolve(result([hit(3), hit(2)], { mode: "fts", before: 2, line: 0 }));
    const out = await running;
    expect(out.count).toBe(2);
    expect(out.boards).toBe(1);
    expect(out.encrypted_skipped).toBe(2);
    expect(out.more).toBeTruthy();
    expect(out.compact).toContain("#3 · vedu · 10-02 · «hit» 3");
    expect(calls).toHaveLength(GREP_CONCURRENCY + 1); // one small refill on the fast board
    const frozen = JSON.stringify(out);
    slow.resolve(result([hit(9)]));
    await ticks();
    expect(JSON.stringify(out)).toBe(frozen);
  });
  it("retains both truncated results and unfinished boards in the cursor", async () => {
    const a = deferred<BoardGrepResult>();
    const b = deferred<BoardGrepResult>();
    const slow = deferred<BoardGrepResult>();
    let continuing = false;
    const { env } = rig(6, (id, opts) => {
      if (!continuing) return id === "b_0" ? a.promise : id === "b_1" ? b.promise : slow.promise;
      const hits = id === "b_0" ? [hit(4)] : id === "b_1" ? [hit(3), hit(2)] : [];
      return Promise.resolve(result(hits.filter((h) => !opts.more || h.seq! < opts.more.before)));
    });
    const running = runGrep(env, "vedu", "hit", { max: 2 }, null, null);
    await ticks();
    a.resolve(result([hit(4)]));
    await ticks();
    b.resolve(result([hit(3), hit(2)]));
    const first = await running;
    expect(first.hits.map((h) => h.seq)).toEqual([4, 3]);
    continuing = true;
    const next = await runGrep(env, "vedu", "hit", { max: 20, more: first.more! }, null, null);
    expect(next.hits.map((h) => h.seq)).toEqual([2]);
    expect(next.more).toBeNull();
    slow.resolve(result());
  });
  it("never exceeds the pool size, skips encrypted boards and can exhaust no-hit searches", async () => {
    let active = 0, peak = 0;
    const { env, calls } = rig(20, async () => {
      peak = Math.max(peak, ++active);
      await ticks();
      active--;
      return result();
    }, 3);
    const out = await runGrep(env, "vedu", "hit", {}, null, null);
    expect(peak).toBe(GREP_CONCURRENCY);
    expect(calls).toHaveLength(20);
    expect(out.count).toBe(0);
    expect(out.boards).toBe(20);
    expect(out.encrypted_skipped).toBe(3);
    expect(out.more).toBeNull();
  });
  it("uses small per-board limits and refills a productive board without losing hits", async () => {
    const { env, calls } = rig(10, async (_id, opts) => {
      const available = Array.from({ length: 40 }, (_, i) => hit(40 - i)).filter((h) => !opts.more || h.seq! < opts.more.before);
      const hits = available.slice(0, opts.max);
      return result(hits, available.length > hits.length ? hits[hits.length - 1].after : null);
    });
    const first = await runGrep(env, "vedu", "hit", { max: 20 }, null, null);
    expect(first.count).toBe(20);
    expect(calls.every((c) => c.opts.max! <= 4)).toBe(true);
    expect(first.more).toBeTruthy();
    expect(first.hits.every((h) => !("after" in h))).toBe(true);
    const identities = new Set(first.hits.map((h) => `${h.board}:${h.seq}`));
    const second = await runGrep(env, "vedu", "hit", { max: 20, more: first.more! }, null, null);
    expect(second.count).toBe(20);
    expect(second.hits.every((h) => !identities.has(`${h.board}:${h.seq}`))).toBe(true);
  });
  it("continues past GREP_BOARDS and revalidates membership before using a cursor", async () => {
    const { env, calls } = rig(GREP_BOARDS + 3, async () => result());
    const first = await runGrep(env, "vedu", "hit", {}, null, null);
    expect(calls).toHaveLength(GREP_BOARDS);
    expect(first.more).toBeTruthy();
    // One remaining membership disappears between pages.
    vi.mocked(registry.grepBoards).mockResolvedValue([{ id: `b_${GREP_BOARDS}`, title: "Dev", encrypted: 0 }, { id: `b_${GREP_BOARDS + 2}`, title: "Dev", encrypted: 1 }]);
    calls.length = 0;
    const next = await runGrep(env, "vedu", "hit", { more: first.more! }, null, null);
    expect(calls.map((c) => c.id)).toEqual([`b_${GREP_BOARDS}`]);
    expect(next.more).toBeNull();
  });
  it("reports and retains failed boards for retry; duplicate hits don't consume max", async () => {
    let retry = false;
    const { env } = rig(2, async (id) => {
      if (id === "b_0" && !retry) throw new Error("temporarily unavailable");
      return result(id === "b_0" ? [hit(2)] : [hit(1), hit(1)]);
    });
    const first = await runGrep(env, "vedu", "hit", { max: 2 }, null, null);
    expect(first.count).toBe(1);
    expect(first.notes).toContain("1 board failed");
    expect(first.more).toBeTruthy();
    retry = true;
    const next = await runGrep(env, "vedu", "hit", { more: first.more! }, null, null);
    expect(next.hits.map((h) => h.seq)).toEqual([2]);
    expect(next.more).toBeNull();
  });
  it("binds cursors to query, scope, filters and viewer and rejects malformed cursors", async () => {
    const { env } = rig(1, async () => result([hit(1)], { mode: "fts", before: 1, line: 0 }));
    const first = await runGrep(env, "vedu", "hit", { max: 1 }, "b_0", { user: "vedu", person: false });
    for (const [pattern, opts, board, user] of [
      ["other", {}, "b_0", "vedu"], ["hit", { author: "jxn" }, "b_0", "vedu"], ["hit", {}, null, "vedu"], ["hit", {}, "b_0", "jxn"],
    ] as const) await expect(runGrep(env, user, pattern, { ...opts, more: first.more! }, board, { user, person: false })).rejects.toThrow(/cursor/);
    for (const more of ["invalid", "!", "a".repeat(65537)]) await expect(runGrep(env, "vedu", "hit", { more }, "b_0", null)).rejects.toThrow(GrepError);
  });
});

describe("compact output and cursors", () => {
  it("uses a stable short UTC date, a single line and retains cross-board and file references", () => {
    expect(compactHitLine({ seq: 12, author: "vedu", ts: Date.UTC(2026, 9, 2), text: "a\n«hit»\tline" })).toBe("#12 · vedu · 10-02 · a «hit» line");
    expect(compactHitLine({ file: "PLAN.md", line: 3, author: "jxn", ts: Date.UTC(2026, 9, 3), text: "«hit»" }, "dev")).toBe("dev PLAN.md:3 · jxn · 10-03 · «hit»");
    expect(compactHitLine({ seq: 1, text: "hit" })).toBe("#1 · — · — · hit");
  });
  it("round-trips URL-safe positions and rejects another query's cursor", () => {
    const key = cursorKey(["hit", "vedu"]);
    const cursor = encodeCursor(key, { before: 12 });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(key, cursor)).toEqual({ before: 12 });
    expect(() => decodeCursor(cursorKey(["different"]), cursor)).toThrow(GrepError);
  });
});
