import { describe, expect, it } from "vitest";
import { agentCommand, HARNESSES, splitCommand } from "../cli/src/harness";

describe("agent harnesses", () => {
  it("splits commands like a shell would, without one", () => {
    expect(splitCommand(`my-agent --model "gpt 5" -p {prompt}`)).toEqual(["my-agent", "--model", "gpt 5", "-p", "{prompt}"]);
    expect(splitCommand(`a 'b c' d\\ e ""`)).toEqual(["a", "b c", "d e", ""]);
    expect(() => splitCommand(`a "b`)).toThrow("Unclosed");
  });
  it("puts the prompt in one argument, even with shell characters in it", () => {
    const p = `answer #3; rm -rf / $(whoami) "quoted"`;
    expect(agentCommand({ agentCmd: "bot --ask {prompt} --fast" }, p, "")).toEqual({ bin: "bot", args: ["--ask", p, "--fast"] });
    expect(agentCommand({ agentCmd: "bot run" }, p, "").args).toEqual(["run", p]); // appended when there's no {prompt}
  });
  it("has presets for common agents", () => {
    expect(agentCommand({ agent: "claude" }, "hi", "mcp__board__read").args).toEqual(["-p", "hi", "--allowedTools", "mcp__board__read", "--max-turns", "15"]);
    expect(agentCommand({ agent: "codex" }, "hi", "").bin).toBe("codex");
    expect(Object.keys(HARNESSES)).toEqual(expect.arrayContaining(["claude", "codex", "gemini", "cursor", "opencode"]));
    expect(() => agentCommand({ agent: "nope" }, "hi", "")).toThrow("Unknown agent");
  });
});
