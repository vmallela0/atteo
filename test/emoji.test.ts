import { describe, expect, it } from "vitest";
import { EMOJI } from "../src/emoji";
import { EMOJI_RE } from "../src/util";

describe("reaction picker emoji", () => {
  const all = EMOJI.flatMap(([, , s]) => s.split("|").map((x) => x.split(" ")));
  it("every one is a single emoji the server accepts as a reaction", () => {
    for (const [e] of all) expect(EMOJI_RE.test(e), e).toBe(true);
    for (const [, icon] of EMOJI) expect(EMOJI_RE.test(icon), icon).toBe(true);
  });
  it("each has a shortcode name, and emoji and names are unique", () => {
    for (const [e, name] of all) expect(name, e).toMatch(/^[a-z0-9_+-]{1,32}$/);
    expect(new Set(all.map((x) => x[0])).size).toBe(all.length);
    expect(new Set(all.map((x) => x[1])).size).toBe(all.length);
  });
  it("is a good-sized set (250–350)", () => {
    expect(all.length).toBeGreaterThanOrEqual(250);
    expect(all.length).toBeLessThanOrEqual(350);
  });
});
