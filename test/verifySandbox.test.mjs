import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  displayCommand,
  OUTPUT_LIMIT,
  pickSandbox,
  runSandboxed,
  sandboxSelfTest,
  TERMINAL_OUTPUT_LIMIT,
  terminalSafe,
} from "../cli/src/verify";

const shell = {
  kind: "bwrap",
  describe: "test shell",
  argv: (command) => ["/bin/sh", "-c", command],
};

describe("claim-check terminal safety", () => {
  it("shows controls in attached commands instead of executing them in the terminal", () => {
    expect(displayCommand("npm test")).toBe("npm test");
    expect(displayCommand("printf '\\033]52;c;payload\\a'\ntrue")).toBe(
      "\"printf '\\\\033]52;c;payload\\\\a'\\ntrue\"",
    );
    expect(terminalSafe("ok\u001b]52;c;payload\u0007\rhidden\n")).toBe(
      "ok\\x1b]52;c;payload\\x07\\rhidden\n",
    );
    expect(displayCommand("git status # \u202egnp.mr")).toBe(
      "\"git status # \\\\u202egnp.mr\"",
    );
    expect(terminalSafe("safe\u2066spoof\u2069")).toBe("safe\\u2066spoof\\u2069");
  });

  it("sanitizes, bounds and drains command output", async () => {
    const base = mkdtempSync(join(tmpdir(), "atteo-verify-test-"));
    const dir = join(base, "checkout");
    const scratch = join(base, "scratch");
    mkdirSync(dir);
    let shown = "";
    try {
      const result = await runSandboxed(
        shell,
        `printf '\\033]52;c;payload\\a'; dd if=/dev/zero bs=70000 count=1 2>/dev/null | tr '\\000' x`,
        dir,
        scratch,
        [base],
        10_000,
        (s) => { shown += s; },
      );
      expect(result.code).toBe(0);
      expect(shown).not.toContain("\u001b");
      expect(shown).toContain("\\x1b]52;c;payload\\x07");
      expect(shown).toContain("[terminal output truncated; the command is still running]");
      expect(shown.length).toBeLessThan(TERMINAL_OUTPUT_LIMIT + 200);
      expect(result.output.length).toBe(OUTPUT_LIMIT);
      expect(result.output).toMatch(/^x+$/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("passes the real sandbox's isolation probes when one is installed", async () => {
    const sandbox = pickSandbox();
    if (!sandbox) return;
    const result = await sandboxSelfTest(sandbox);
    expect(result.ok, result.lines.join("\n")).toBe(true);
  });

  it("removes a stale Docker cidfile before a later check", async () => {
    const base = mkdtempSync(join(tmpdir(), "atteo-docker-cid-test-"));
    const dir = join(base, "checkout");
    const scratch = join(base, "scratch");
    mkdirSync(dir);
    writeFileSync(join(base, "docker.cid"), "old-container");
    try {
      await runSandboxed(
        { ...shell, kind: "docker", argv: (command) => {
          expect(existsSync(join(base, "docker.cid"))).toBe(false);
          return ["/bin/sh", "-c", command];
        } },
        "true",
        dir,
        scratch,
        [base],
        10_000,
        () => {},
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
