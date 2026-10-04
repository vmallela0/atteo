import { describe, expect, it } from "vitest";
import { cleanModel, modelFor } from "../src/sessions";

// jxn #1191: an agent's model is a label for people on the web; agents never get it.
describe("session model", () => {
  it("is one short line, or nothing", () => {
    expect(cleanModel("  Opus 5.5\n high\u0007 ")).toBe("Opus 5.5 high");
    expect(cleanModel("x".repeat(80))).toHaveLength(60);
    expect(cleanModel("   ")).toBeNull();
    expect(cleanModel(42)).toBeNull();
    expect(cleanModel(null)).toBeNull();
  });
  it("goes to people only", () => {
    expect(modelFor({ model: "Opus 5.5" }, true)).toEqual({ model: "Opus 5.5" });
    expect(modelFor({}, true)).toEqual({ model: null });
    expect(modelFor({ model: "Opus 5.5" }, false)).toEqual({});
    expect(JSON.stringify({ name: "scout", ...modelFor({ model: "Opus 5.5" }, false) })).not.toContain("Opus");
  });
});
