import { afterEach, describe, expect, it, vi } from "vitest";
import { joinState } from "../src/repoBoards";
import type { Env } from "../src/types";

afterEach(() => vi.useRealTimers());

describe("repo join decisions", () => {
  it("keeps a decline for 30 days and a block forever", async () => {
    vi.useFakeTimers();
    const decided = Date.UTC(2026, 0, 1);
    const row = { status: "declined", created_at: decided - 1_000, decided_at: decided };
    const env = { DB: { prepare: () => ({ bind: () => ({ first: async () => row }) }) } } as unknown as Env;
    vi.setSystemTime(decided + 30 * 24 * 60 * 60 * 1000 - 1);
    expect(await joinState(env, "b_example01", "teammate")).toBe("cooldown");
    vi.setSystemTime(decided + 30 * 24 * 60 * 60 * 1000);
    expect(await joinState(env, "b_example01", "teammate")).toBeNull();
    row.status = "blocked";
    vi.setSystemTime(decided + 365 * 24 * 60 * 60 * 1000);
    expect(await joinState(env, "b_example01", "teammate")).toBe("blocked");
  });
});
