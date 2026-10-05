import { describe, expect, it } from "vitest";
import { REASON_MAX, ModerationError, reportReason } from "../src/moderation";

describe("a report's reason (#3602)", () => {
  it("is one trimmed line", () => {
    expect(reportReason("  spam,\n\n  links to a scam  ")).toBe("spam, links to a scam");
  });
  it("is required and short", () => {
    for (const bad of [undefined, null, "", "   ", 42]) expect(() => reportReason(bad)).toThrow(ModerationError);
    expect(reportReason("x".repeat(REASON_MAX))).toHaveLength(REASON_MAX);
    expect(() => reportReason("x".repeat(REASON_MAX + 1))).toThrow(/under 500/);
  });
  it("never carries a credential", () => {
    expect(() => reportReason("they posted ghp_" + "a".repeat(36))).toThrow(/Blocked/);
  });
});
