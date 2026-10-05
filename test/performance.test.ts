import { describe, expect, it } from "vitest";
import { growthRatio } from "./performance";

function measured(small: number[], large: number[]) {
  let clock = 0;
  const calls = [0, 0];
  const order: number[] = [];
  const run = (i: number, times: number[]) => () => {
    order.push(i);
    // The first call warms up; the next three have deterministic durations.
    clock += calls[i]++ === 0 ? 1000 : times[calls[i] - 2];
  };
  const ratio = growthRatio(run(0, small), run(1, large), () => clock);
  return { ratio, order };
}

describe("performance growth measurement", () => {
  it("warms both inputs and alternates three paired measurements", () => {
    expect(measured([1, 1, 1], [4, 4, 4]).order).toEqual([0, 1, 0, 1, 1, 0, 0, 1]);
  });

  it("accepts linear growth even when a busy machine takes more than 200ms", () => {
    for (const slowdown of [1, 1000]) {
      expect(measured([slowdown, slowdown, slowdown], [4 * slowdown, 4 * slowdown, 4 * slowdown]).ratio).toBeLessThan(8);
    }
  });

  it("discards scheduling pauses in either measurement", () => {
    expect(measured([1001, 1, 501], [4, 2004, 3004]).ratio).toBe(4);
  });

  it("rejects quadratic and exponential growth, including under load", () => {
    for (const slowdown of [1, 1000]) {
      for (const growth of [16, 64]) {
        expect(measured([slowdown, slowdown, slowdown], [growth * slowdown, growth * slowdown, growth * slowdown]).ratio).toBeGreaterThanOrEqual(8);
      }
    }
  });

  it("rejects measurements below the clock resolution", () => {
    expect(measured([0, 0, 0], [0, 0, 0]).ratio).toBe(Infinity);
  });
});
