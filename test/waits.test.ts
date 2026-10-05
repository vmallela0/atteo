import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QUIET_MS, SETTLE_MS, SETTLE_ROUNDS, settle } from "../src/waits";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

// The waking post has already been read; `more` drains and appends subsequent posts, as both callers do.
function wake(postTimes: number[] = [], cap = Infinity) {
  const received = [0];
  const unread: number[] = [];
  for (const at of postTimes) setTimeout(() => unread.push(at), at);
  const more = vi.fn(async () => {
    const posts = unread.splice(0);
    received.push(...posts);
    return posts.length;
  });
  let returnedAt: number | undefined;
  const waiting = settle(more, () => received.length >= cap).then(() => {
    returnedAt = Date.now();
  });
  return { received, unread, more, waiting, returnedAt: () => returnedAt };
}

describe("settling after a board wake", () => {
  it("returns a lone post in less than 100ms of fake time", async () => {
    const w = wake();
    await vi.advanceTimersByTimeAsync(QUIET_MS - 1);
    expect(w.returnedAt()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await w.waiting;
    expect(w.received).toEqual([0]);
    expect(w.returnedAt()).toBe(QUIET_MS);
    expect(w.returnedAt()).toBeLessThan(100);
    expect(w.more).toHaveBeenCalledTimes(1);
  });

  it("returns a burst of posts 30ms apart together, including bursts beyond four quiet checks", async () => {
    const posts = [30, 60, 90, 120, 150, 180];
    const w = wake(posts);
    await vi.advanceTimersByTimeAsync(180);
    expect(w.returnedAt()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(100);
    await w.waiting;
    expect(w.received).toEqual([0, ...posts]);
    expect(w.unread).toEqual([]);
    expect(w.returnedAt()! - 180).toBeGreaterThanOrEqual(QUIET_MS);
    expect(w.returnedAt()! - 180).toBeLessThan(2 * QUIET_MS);
  });

  it("ends a continuous burst at the original four-round time cap", async () => {
    expect(SETTLE_MS).toBe(250);
    expect(SETTLE_ROUNDS).toBe(4);
    const max = SETTLE_MS * SETTLE_ROUNDS;
    const posts = Array.from({ length: 40 }, (_, i) => (i + 1) * 30);
    const w = wake(posts);
    await vi.advanceTimersByTimeAsync(max - 1);
    expect(w.returnedAt()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await w.waiting;
    expect(w.returnedAt()).toBe(max);
    expect(w.received).toEqual([0, ...posts.filter((at) => at <= max)]);
    const reads = w.more.mock.calls.length;
    await vi.advanceTimersByTimeAsync(200);
    expect(w.more).toHaveBeenCalledTimes(reads);
    expect(w.unread).toEqual(posts.filter((at) => at > max));
  });

  it("skips gathering when the caller is already full", async () => {
    const w = wake([], 1);
    await w.waiting;
    expect(w.returnedAt()).toBe(0);
    expect(w.more).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops gathering as soon as the caller's entry cap is reached", async () => {
    const w = wake([30, 60], 2);
    await vi.advanceTimersByTimeAsync(QUIET_MS);
    await w.waiting;
    expect(w.received).toEqual([0, 30]);
    expect(w.returnedAt()).toBe(QUIET_MS);
    await vi.advanceTimersByTimeAsync(100);
    expect(w.more).toHaveBeenCalledTimes(1);
    expect(w.unread).toEqual([60]);
  });
});
