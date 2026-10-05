// Which process an atteo command belongs to: shells and shell scripts are passed through, agents are kept.
// (An .mjs file: the Workers tsconfig has no Node types, and cli/src/session.ts uses Node.)
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectModel, PASS_THROUGH, prettyModel, scriptName } from "../cli/src/session.ts";

describe("scriptName", () => {
  it("an agent that is a shell script, as macOS reports it (/bin/bash + the script)", () => {
    expect(scriptName("bash", ["/bin/bash", "/tmp/x/codex"])).toBe("codex");
  });
  it("a shell script run by a shell stays the shell (passed through): ship.sh, run.sh, hooks", () => {
    expect(scriptName("bash", ["/bin/bash", "./scripts/ship.sh"])).toBe("bash");
    expect(scriptName("sh", ["sh", "/repo/.git/hooks/pre-push.sh"])).toBe("sh");
  });
  it("inline commands and interactive shells are the shell", () => {
    expect(scriptName("bash", ["bash", "-c", "atteo read"])).toBe("bash");
    expect(scriptName("zsh", ["-zsh"])).toBe("zsh");
  });
  it("node running an agent's script is that agent", () => {
    expect(scriptName("node", ["node", "/usr/local/bin/claude"])).toBe("claude");
  });
  it("this CLI is passed through under its name and the names it had before the rename (aliases still run it)", () => {
    for (const n of ["atteo", "agent-soup", "agent-board"]) expect(PASS_THROUGH.has(scriptName("node", ["node", `/usr/local/bin/${n}`])), n).toBe(true);
    expect(PASS_THROUGH.has("claude")).toBe(false);
  });
});

// jxn #1191: the model a session runs on, a label for people on the web (agents never get it back).
describe("model", () => {
  it("reads model ids the way people say them", () => {
    expect(prettyModel("claude-opus-5-5")).toBe("Opus 5.5");
    expect(prettyModel("claude-sonnet-4-5-20250929")).toBe("Sonnet 4.5");
    expect(prettyModel("claude-opus-4-6[1m]")).toBe("Opus 4.6 1M");
    expect(prettyModel("claude-haiku-4")).toBe("Haiku 4");
    expect(prettyModel("opus")).toBe("Opus");
    expect(prettyModel("gpt-5-codex")).toBe("gpt-5-codex");
  });
});

describe("the CLI detects its agent's model", () => {
  const saved = { ...process.env };
  afterEach(() => {
    // Keep Node's live environment object: replacing it breaks subsequent TZ changes.
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  const clean = () => {
    for (const k of ["ATTEO_MODEL", "AGENT_SOUP_MODEL", "AGENT_BOARD_MODEL", "ANTHROPIC_MODEL", "CLAUDE_CODE_SESSION_ID", "CLAUDE_EFFORT", "CLAUDE_CONFIG_DIR"]) delete process.env[k];
  };
  it("from ATTEO_MODEL first, as given", () => {
    clean();
    process.env.ATTEO_MODEL = "gpt-5 high";
    process.env.ANTHROPIC_MODEL = "claude-opus-5-5";
    expect(detectModel()).toBe("gpt-5 high");
  });
  it("from Claude Code's transcript (its newest model) with its effort, else ANTHROPIC_MODEL", () => {
    clean();
    expect(detectModel()).toBeNull();
    process.env.ANTHROPIC_MODEL = "claude-sonnet-4-5";
    expect(detectModel()).toBe("Sonnet 4.5");
    const dir = mkdtempSync(join(tmpdir(), "atteo-model-"));
    mkdirSync(join(dir, "projects", "-home-x"), { recursive: true });
    writeFileSync(join(dir, "projects", "-home-x", "0123abcd-0000-4000-8000-000000000000.jsonl"), ['{"message":{"model":"claude-sonnet-4-5"}}', '{"message":{"model":"<synthetic>"}}', '{"message":{"model":"claude-opus-5-5"}}', ""].join("\n"));
    process.env.CLAUDE_CONFIG_DIR = dir;
    process.env.CLAUDE_CODE_SESSION_ID = "0123abcd-0000-4000-8000-000000000000";
    process.env.CLAUDE_EFFORT = "high";
    expect(detectModel()).toBe("Opus 5.5 high");
    process.env.CLAUDE_CODE_SESSION_ID = "../../etc/passwd";
    expect(detectModel()).toBe("Sonnet 4.5");
  });
});
