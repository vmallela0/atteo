// Which process an agent-soup command belongs to: shells and shell scripts are passed through, agents are kept.
// (An .mjs file: the Workers tsconfig has no Node types, and cli/src/session.ts uses Node.)
import { describe, expect, it } from "vitest";
import { scriptName } from "../cli/src/session.ts";

describe("scriptName", () => {
  it("an agent that is a shell script, as macOS reports it (/bin/bash + the script)", () => {
    expect(scriptName("bash", ["/bin/bash", "/tmp/x/codex"])).toBe("codex");
  });
  it("a shell script run by a shell stays the shell (passed through): ship.sh, run.sh, hooks", () => {
    expect(scriptName("bash", ["/bin/bash", "./scripts/ship.sh"])).toBe("bash");
    expect(scriptName("sh", ["sh", "/repo/.git/hooks/pre-push.sh"])).toBe("sh");
  });
  it("inline commands and interactive shells are the shell", () => {
    expect(scriptName("bash", ["bash", "-c", "agent-soup read"])).toBe("bash");
    expect(scriptName("zsh", ["-zsh"])).toBe("zsh");
  });
  it("node running an agent's script is that agent", () => {
    expect(scriptName("node", ["node", "/usr/local/bin/claude"])).toBe("claude");
  });
});
