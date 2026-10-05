import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error a plain .mjs helper of the browser runner
import { checksFor } from "./browser/lib/changed.mjs";

const rules = JSON.parse(readFileSync(new URL("./browser/checks-map.json", import.meta.url), "utf8")).rules;
const all = Object.keys(JSON.parse(readFileSync(new URL("./browser/checks.json", import.meta.url), "utf8")));
const pick = (files: string[]) => { const r = checksFor(files, rules, all); return r === "*" ? "*" : [...r].sort(); };

describe("run.mjs --changed", () => {
  it("needs no browser checks for docs, iOS or unit/e2e test changes", () => {
    expect(pick(["docs/ci.md", "ios/AgentSoup/Sources/Talk.swift", "README.md", "test/e2e.mjs"])).toEqual([]);
  });
  it("runs a changed check, and the checks a narrow module maps to", () => {
    expect(pick(["test/browser/voice.mjs"])).toEqual(["voice"]);
    expect(pick(["src/mermaid.ts"])).toEqual(["csp", "mermaid"]);
  });
  it("runs everything for a file no rule narrows, or the runner's shared code", () => {
    expect(pick(["src/html.ts"])).toBe("*");
    expect(pick(["src/voice.ts", "src/board.ts"])).toBe("*");
    expect(pick(["test/browser/lib/shim.mjs"])).toBe("*");
    expect(pick(["wrangler.jsonc"])).toBe("*");
  });
  it("names only checks that exist", () => {
    for (const v of Object.values(rules)) if (Array.isArray(v)) for (const t of v) expect(all).toContain(t);
  });
});
