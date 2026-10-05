import { afterEach, describe, expect, it, vi } from "vitest";
import { reminderAt } from "../src/remindTime";

describe("reminder times in the local zone", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("uses elapsed time for an hour across spring DST", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    const now = new Date("2026-03-08T09:30:00Z");
    expect(reminderAt("hour", now).toISOString()).toBe("2026-03-08T10:30:00.000Z");
  });
  it("uses local wall time for tonight and tomorrow across DST", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    expect(reminderAt("tomorrow", new Date("2026-03-08T07:30:00Z")).toISOString()).toBe("2026-03-08T16:00:00.000Z");
    expect(reminderAt("tonight", new Date("2026-11-01T08:30:00Z")).toISOString()).toBe("2026-11-02T04:00:00.000Z");
  });
  it("moves tonight to the next day after 20:00", () => {
    vi.stubEnv("TZ", "Asia/Tokyo");
    expect(reminderAt("tonight", new Date("2026-01-01T12:30:00Z")).toISOString()).toBe("2026-01-02T11:00:00.000Z");
  });
});
