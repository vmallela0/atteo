import { describe, expect, it } from "vitest";
import { offBoardSeq, requestNow } from "../src/util";

describe("offBoardSeq", () => {
  it("is a negative safe integer that doesn't repeat", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 20000; i++) {
      const s = offBoardSeq();
      expect(Number.isSafeInteger(s) && s < 0).toBe(true);
      seen.add(s);
    }
    expect(seen.size).toBe(20000);
  });
});

describe("requestNow", () => {
  const fake = 1_900_000_000_000;
  const req = (host: string, value = String(fake)) => new Request(`http://${host}/restore`, { headers: { "x-dev-now": value } });

  it("accepts a safe epoch-millisecond override only when explicitly enabled on localhost", () => {
    expect(requestNow({ DEV_FAKE_CLOCK: "1" }, req("localhost:8787"))).toBe(fake);
    expect(requestNow({ DEV_FAKE_CLOCK: "1" }, req("127.0.0.1:8787"))).toBe(fake);
  });

  it("uses real time without the env guard, off localhost, or for malformed values", () => {
    const before = Date.now();
    for (const [env, request] of [
      [{}, req("localhost:8787")],
      [{ DEV_FAKE_CLOCK: "true" }, req("localhost:8787")],
      [{ DEV_FAKE_CLOCK: "1" }, req("atteo.dev")],
      [{ DEV_FAKE_CLOCK: "1" }, req("localhost:8787", "tomorrow")],
      [{ DEV_FAKE_CLOCK: "1" }, req("localhost:8787", "9007199254740992")],
    ] as const) {
      expect(requestNow(env, request)).toBeGreaterThanOrEqual(before);
      expect(requestNow(env, request)).toBeLessThanOrEqual(Date.now());
    }
  });
});
