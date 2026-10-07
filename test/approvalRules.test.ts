import { describe, expect, it } from "vitest";
import { amountOf, check, list, parseRule } from "../src/approvalRules";
import { approvalRulesJs, approvalRulesSide } from "../src/approvalRulesUi";

describe("approval rules", () => {
  const rows = [
    { category: "deploy_production", mode: "block", threshold: null, set_by: "owner", updated_at: 1 },
    { category: "spending", mode: "block", threshold: 25, set_by: "owner", updated_at: 2 },
  ];
  let role = "owner", cents = 0;
  const env = { DB: { prepare: (sql: string) => ({ bind: () => ({
    all: async () => ({ results: rows }),
    first: async () => sql.includes("SELECT role") ? { role, expires_at: null } : { cents },
  }) }) } } as never;
  it("defaults missing categories to Always ask and applies a spending threshold", async () => {
    expect((await list(env, "b_test1234")).map(x => x.mode)).toEqual(["block", "ask", "block", "ask", "ask", "ask"]);
    expect((await check(env, "b_test1234", "owner", "spending", 25)).outcome).toBe("auto");
    expect((await check(env, "b_test1234", "owner", "spending", 25.01)).outcome).toBe("block");
    expect((await check(env, "b_test1234", "owner", "deploy_production")).outcome).toBe("block");
  });
  it("asks other members and former owners; spending auto uses the day's cents", async () => {
    expect((await check(env, "b_test1234", "member", "spending", 10)).outcome).toBe("ask");
    expect((await check(env, "b_test1234", "member", "deploy_production")).outcome).toBe("block");
    role = "contributor";
    expect((await check(env, "b_test1234", "owner", "spending", 10)).outcome).toBe("ask");
    role = "owner";
    cents = 2499;
    expect((await check(env, "b_test1234", "owner", "spending", 0.01)).outcome).toBe("auto");
    expect((await check(env, "b_test1234", "owner", "spending", 0.02)).outcome).toBe("ask");
    cents = 0;
  });
  it("refuses missing or malformed spend amounts and thresholds", () => {
    expect(() => amountOf(0)).toThrow("positive dollar");
    expect(() => amountOf(0.001)).toThrow("two decimal");
    expect(() => parseRule("spending", { mode: "auto", threshold: -1 })).toThrow();
    expect(() => parseRule("delete_data", { mode: "auto", threshold: 2 })).toThrow("Only spending");
    expect(() => parseRule("other", { mode: "auto" })).toThrow("Other can only");
    expect(parseRule("other", { mode: "block" }).mode).toBe("block");
    expect(() => parseRule("unknown", { mode: "auto" })).toThrow("category is one of");
  });
  it("shows escaped owner names and edit controls only to owners", async () => {
    const r = await list(env, "b_test1234");
    r[0].set_by = "<owner>";
    const side = approvalRulesSide(r, true, [{ user: "owner", role: "owner" }]);
    expect(side).toContain("&lt;owner&gt;");
    expect(side).toContain("ar-save");
    expect(side.match(/data-rule="other"[^]*?<\/tr>/)?.[0]).not.toContain('value="auto"');
    expect(side).toContain("Agents choose their own category");
    expect(approvalRulesSide(r, false, [{ user: "owner", role: "contributor" }])).toContain("(set by owner, no longer an owner)");
    expect(approvalRulesSide(r, false)).not.toContain("ar-save");
    expect(() => new Function(approvalRulesJs())).not.toThrow();
  });
});
