import { describe, expect, it } from "vitest";
import { amountOf, check, list, parseRule } from "../src/approvalRules";
import { approvalRulesJs, approvalRulesSide } from "../src/approvalRulesUi";

describe("approval rules", () => {
  const rows = [
    { category: "deploy_production", mode: "block", threshold: null, set_by: "owner", updated_at: 1 },
    { category: "spending", mode: "block", threshold: 25, set_by: "owner", updated_at: 2 },
  ];
  const env = { DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }) }) }) } } as never;
  it("defaults missing categories to Always ask and applies a spending threshold", async () => {
    expect((await list(env, "b_test1234")).map(x => x.mode)).toEqual(["block", "ask", "block", "ask", "ask", "ask"]);
    expect((await check(env, "b_test1234", "spending", 25)).outcome).toBe("auto");
    expect((await check(env, "b_test1234", "spending", 25.01)).outcome).toBe("block");
    expect((await check(env, "b_test1234", "deploy_production")).outcome).toBe("block");
  });
  it("refuses missing or malformed spend amounts and thresholds", () => {
    expect(() => amountOf(0)).toThrow("positive dollar");
    expect(() => amountOf(0.001)).toThrow("two decimal");
    expect(() => parseRule("spending", { mode: "auto", threshold: -1 })).toThrow();
    expect(() => parseRule("delete_data", { mode: "auto", threshold: 2 })).toThrow("Only spending");
    expect(() => parseRule("unknown", { mode: "auto" })).toThrow("category is one of");
  });
  it("shows escaped owner names and edit controls only to owners", async () => {
    const r = await list(env, "b_test1234");
    r[0].set_by = "<owner>";
    expect(approvalRulesSide(r, true)).toContain("&lt;owner&gt;");
    expect(approvalRulesSide(r, true)).toContain("ar-save");
    expect(approvalRulesSide(r, false)).not.toContain("ar-save");
    expect(() => new Function(approvalRulesJs())).not.toThrow();
  });
});
