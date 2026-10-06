import { describe, expect, it } from "vitest";
// @ts-expect-error a plain .mjs helper of the browser runner
import { checksFor } from "./browser/lib/changed.mjs";
import map from "./browser/checks-map.json";
import timings from "./browser/checks.json";

const rules = map.rules as Record<string, string[] | "*">;
const all = Object.keys(timings);
const pick = (files: string[]) => { const r = checksFor(files, rules, all); return r === "*" ? "*" : [...r].sort(); };

describe("run.mjs --changed", () => {
  it("needs no browser checks for docs, iOS or unit/e2e test changes", () => {
    expect(pick(["docs/ci.md", "ios/AgentSoup/Sources/Talk.swift", "README.md", "test/e2e.mjs", "src/githubApp.ts"])).toEqual([]);
  });
  it("runs a changed check, and the checks a narrow module maps to", () => {
    expect(pick(["test/browser/voice.mjs"])).toEqual(["voice"]);
    expect(pick(["src/mermaid.ts"])).toEqual(["csp", "mermaid"]);
    expect(pick(["public/mermaid.min.js"])).toEqual(["csp", "mermaid"]);
    expect(pick(["src/webAssets.ts"])).toEqual(["csp", "fonts", "web-budget"]);
    expect(pick(["scripts/build-web-assets.mjs"])).toEqual(["fonts", "web-budget"]);
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
