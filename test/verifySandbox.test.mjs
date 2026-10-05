import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  displayCommand,
  OUTPUT_LIMIT,
  pickSandbox,
  runSandboxed,
  sandboxSelfTest,
  seatbeltProfile,
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
  }, 60_000); // the macOS Apple Event probe waits out its 5s alarm

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

describe("macOS seatbelt profile", () => {
  it("denies the host home so unlisted files are blocked, then re-allows checkout paths under it", () => {
    const home = realpathSync(homedir());
    const allowed = join(home, "atteo-verify-allowed-under-home");
    const nvm = join(home, ".nvm", "versions", "node", "v20.0.0");
    const profile = seatbeltProfile([allowed], [nvm]);
    const lines = profile.split("\n");
    const homeDeny = lines.find((line) => line.startsWith("(deny file-read*") && line.includes(JSON.stringify(home)) && !line.includes(".ssh"));
    const homeAllow = lines.find((line) => line.startsWith("(allow file-read*"));
    expect(homeDeny).toBeTruthy();
    expect(homeAllow).toContain(`(subpath ${JSON.stringify(allowed)})`);
    expect(homeAllow).toContain(`(subpath ${JSON.stringify(nvm)})`);
    expect(homeAllow).not.toContain(`(subpath ${JSON.stringify(home)})`);
    expect(profile).toContain(`(subpath ${JSON.stringify(join(home, ".ssh"))})`);
    expect(profile).toContain(`(subpath ${JSON.stringify(join(home, "Library/Keychains"))})`);
    expect(homeAllow).not.toContain(".atteo-sandbox-read-probe");
    expect(homeAllow).not.toContain("/Library");
  });

  it("denies Apple Events, LaunchServices and the clipboard (jxn's agent #4314)", () => {
    const profile = seatbeltProfile(["/var/folders/tmp-checkout"]);
    expect(profile).toContain("(deny appleevent-send)");
    expect(profile).toContain('(global-name "com.apple.coreservices.launchservicesd")');
    expect(profile).toContain('(global-name-prefix "com.apple.lsd.")');
    expect(profile).toContain('(global-name "com.apple.pasteboard.1")');
  });

  it("does not re-allow the whole home when a listed path is the home itself", () => {
    const home = realpathSync(homedir());
    const profile = seatbeltProfile(["/var/folders/tmp-checkout"], [home]);
    expect(profile).toContain(`(subpath ${JSON.stringify(home)})`);
    expect(profile).not.toContain("(allow file-read*");
  });
});
