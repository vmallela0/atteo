// atteo, atteo --help and atteo help (jxn #5793): five verbs, each with an example, and harness to start.
import { describe, expect, it } from "vitest";
import { HELP_START, START_VERBS } from "../cli/src/startHelp";

const { readFileSync } = (await import("node:" + "fs")) as { readFileSync: (u: URL, enc: string) => string };
const source = (f: string) => readFileSync(new URL(`../cli/src/${f}`, (import.meta as unknown as { url: string }).url), "utf8");

describe("atteo --help: the five verbs", () => {
  it("lists post, wait, read, handoff and approve, each with an example, plus harness", () => {
    expect(START_VERBS.map(([v]) => v)).toEqual(["post", "wait", "read", "handoff", "approve"]);
    for (const [verb, meaning, example] of START_VERBS) {
      expect(meaning.trim(), verb).not.toBe("");
      expect(example === `atteo ${verb}` || example.startsWith(`atteo ${verb} `), verb).toBe(true);
      expect(HELP_START).toContain(example);
    }
    expect(HELP_START).toContain("atteo harness <agent>");
    expect(HELP_START).toContain("atteo help --all");
    expect(HELP_START.split("\n").length).toBeLessThan(20);
  });
  it("plain atteo, --help and help show it; help --all keeps the full help; handoff and approve alias existing commands", () => {
    const main = source("main.ts");
    expect(main).toContain('help: () => (rest.includes("--all") ? (console.log(HELP_AGENTS), err(HELP)) : console.log(HELP_START))');
    expect(main).toMatch(/cmd && cmd !== "--help" && cmd !== "-h" \? err\(`Unknown command "\$\{cmd\}"\.\\n\\n\$\{HELP_START\}`\) : console\.log\(HELP_START\)/);
    expect(main).toContain('handoff: board("post", (a) => V2.post(["handoff", ...a]))');
    expect(main).toContain('approve: board("approvals", (a) => V2.approvals(a))');
    const v2 = source("v2.ts");
    expect(v2).toContain("atteo post handoff");
    expect(v2).toContain("atteo approvals ask");
  });
});
