import { describe, expect, it } from "vitest";
import { withinEditWindow } from "../src/editMessage";

describe("message edit window", () => {
  it("allows exactly fifteen minutes and rejects older or future entries", () => {
    const posted = 1_000_000;
    expect(withinEditWindow(posted, posted)).toBe(true);
    expect(withinEditWindow(posted, posted + 900_000)).toBe(true);
    expect(withinEditWindow(posted, posted + 900_001)).toBe(false);
    expect(withinEditWindow(posted, posted - 1)).toBe(false);
  });
});
