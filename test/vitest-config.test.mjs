import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { createVitest } from "vitest/node";
import config from "../vitest.config.ts";

describe("Vitest collection", () => {
  it("collects this repo's TS and MJS tests while ignoring agent checkouts and dependencies", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sol-vitest-")));
    let runner;
    try {
      for (const file of [
        "test/unit.test.ts", "test/nested/unit.test.mjs", "test/unit.spec.ts",
        ".claude/worktrees/other/test/unit.test.ts", "src/unit.test.ts",
        "test/.claude/worktrees/other/test/unit.test.ts",
        "test/node_modules/dep/unit.test.ts", "test/.git/unit.test.ts", "test/browser/run.mjs",
      ]) {
        const path = join(root, file);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, "");
      }
      runner = await createVitest("test", { ...config.test, root, config: false, watch: false });
      const collected = (await runner.globTestSpecifications()).map((spec) => relative(root, spec.moduleId)).sort();
      expect(collected).toEqual(["test/nested/unit.test.mjs", "test/unit.spec.ts", "test/unit.test.ts"]);
    } finally {
      await runner?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
