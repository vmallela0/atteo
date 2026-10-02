import { describe, expect, it } from "vitest";
import { cardLine, formatCard, parseCard } from "../src/card";

const raw = {
  repo: "vmallela0/agent-soup",
  branch: "jxn/layout",
  base: "main",
  pr_url: "https://github.com/vmallela0/agent-soup/pull/2",
  ci: "passing",
  commits: [{ sha: "abc1234def5678", title: "Pin the header" }, { sha: "zz", title: "" }],
  files: [{ path: "src/ui.ts", added: 40, removed: 3 }, { path: "src/html.ts", added: 12, removed: -5 }, { path: "" }],
  diff: "--- a/src/ui.ts\n+++ b/src/ui.ts",
};

describe("change cards", () => {
  it("normalizes a card and keeps the diff apart", () => {
    const { card, diff } = parseCard(raw);
    expect(card.commits).toEqual([{ sha: "abc1234def56", title: "Pin the header" }]);
    expect(card.files).toEqual([{ path: "src/ui.ts", added: 40, removed: 3 }, { path: "src/html.ts", added: 12, removed: 0 }]);
    expect(diff).toContain("+++ b/src/ui.ts");
    expect(cardLine(card)).toBe("jxn/layout → main · 1 commit · 2 files +52 −3 · CI passing");
    expect(formatCard(card, diff)).toContain("PR: https://github.com/vmallela0/agent-soup/pull/2");
  });
  it("accepts JSON text and rejects bad input", () => {
    expect(parseCard(JSON.stringify({ branch: "x" })).card.ci).toBe("none");
    expect(() => parseCard({})).toThrow("branch");
    expect(() => parseCard({ branch: "x", pr_url: "javascript:alert(1)" })).toThrow("https");
    expect(() => parseCard({ branch: "x", ci: "green" })).toThrow("ci must");
    expect(() => parseCard("not json")).toThrow("object");
  });
});
