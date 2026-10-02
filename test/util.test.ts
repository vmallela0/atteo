import { describe, expect, it } from "vitest";
import { offBoardSeq } from "../src/util";

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
