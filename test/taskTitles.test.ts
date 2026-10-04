import { describe, expect, it } from "vitest";
import { similarOpen, similarTitle, taskTitleKey } from "../src/taskTitles";

describe("task titles", () => {
  it("the same title: case and spacing don't count", () => {
    expect(taskTitleKey("  Fix   the Login ")).toBe("fix the login");
  });

  it("similar: an owner suffix or a few changed words (jxn's agent #2357)", () => {
    expect(similarTitle("Web weight budget (opus-b)", "Web weight budget")).toBe(true);
    expect(similarTitle("Web weight budget (opus-b)", "web weight budget (claude)")).toBe(true);
    expect(similarTitle("Tests: the web's weight budget check", "Tests: web weight budget check")).toBe(true);
    expect(similarTitle("Fix the login page redirect", "Fix the login page")).toBe(true); // 4 of 5 words
  });

  it("not similar: different work, or too short to tell", () => {
    expect(similarTitle("Fix the login page", "Fix the signup page")).toBe(false);
    expect(similarTitle("tests", "docs")).toBe(false);
    expect(similarTitle("ship it", "ship it now")).toBe(false); // under 3 words: only exact (suffix-less) matches
    expect(similarTitle("(opus-b)", "(claude)")).toBe(false);
  });

  it("similarOpen: up to 3, never the task itself", () => {
    const open = [1, 2, 3, 4, 5].map((seq) => ({ seq, title: `Web weight budget (agent ${seq})` }));
    expect(similarOpen("Web weight budget", open, 1).map((t) => t.seq)).toEqual([2, 3, 4]);
  });
});
