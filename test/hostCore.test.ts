// atteo host's shared rules (docs/HOST.md): the typed consent, the folder jail, secrets, output caps.
import { describe, expect, it } from "vitest";
import { cleanOutput, clampTimeout, commandProblem, HOST_PHRASE, insideShares, MAX_OUTPUT, normPath, phraseOk, SECRET_ENV } from "../src/hostCore";
import { redactText } from "../src/secrets";
import { HOST_LOADER_JS, HOST_PAGE_JS } from "../src/hostUi";

describe("atteo host rules", () => {
  it("needs the exact phrase (a phone's curly apostrophe counts)", () => {
    expect(phraseOk(HOST_PHRASE)).toBe(true);
    expect(phraseOk("I understand what I’m doing")).toBe(true);
    for (const bad of ["i understand what i'm doing", "I understand what I'm doing.", " I understand what I'm doing", "yes", "", null, 1]) expect(phraseOk(bad)).toBe(false);
  });

  it("keeps a working folder inside the shares: no .. escape, no sibling prefix, never /", () => {
    const shares = ["/home/v/proj"];
    expect(insideShares("/home/v/proj", shares)).toBe(true);
    expect(insideShares("/home/v/proj/src/./lib", shares)).toBe(true);
    expect(insideShares("/home/v/proj/../.ssh", shares)).toBe(false);
    expect(insideShares("/home/v/proj/src/../../..", shares)).toBe(false);
    expect(insideShares("/home/v/project-other", shares)).toBe(false);
    expect(insideShares("relative/path", shares)).toBe(false);
    expect(insideShares("/etc", ["/"])).toBe(false);
    expect(normPath("/a/b/../c/")).toBe("/a/c");
    expect(normPath("a/b")).toBeNull();
  });

  it("refuses commands with credentials, NULs, or nothing in them", () => {
    expect(commandProblem("ls -la")).toBeNull();
    expect(commandProblem("")).toMatch(/Say what to run/);
    expect(commandProblem("echo a\0b")).toMatch(/NUL/);
    expect(commandProblem("curl -H 'Authorization: x' https://api.github.com -u me:ghp_" + "a".repeat(36))).toMatch(/GitHub token/);
    expect(commandProblem("x".repeat(5000))).toMatch(/over/);
  });

  it("redacts secrets from output and caps it", () => {
    const out = cleanOutput("ok\nAWS key AKIAABCDEFGHIJKLMNOP done\npassword=hunter2abc9\n");
    expect(out.text).toContain("[redacted: an AWS access key]");
    expect(out.text).toContain('[redacted: a value for "password"]');
    expect(out.text).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(out.text).not.toContain("hunter2abc9");
    const big = cleanOutput("x".repeat(MAX_OUTPUT + 10));
    expect(big.truncated).toBe(true);
    expect(big.text).toMatch(/10 more characters not kept/);
    expect(redactText("nothing secret here")).toBe("nothing secret here");
  });

  it("the web's /host.js and its loader are valid scripts", () => {
    expect(() => new Function(HOST_PAGE_JS)).not.toThrow();
    expect(() => new Function(HOST_LOADER_JS)).not.toThrow();
    expect(HOST_PAGE_JS).toContain(JSON.stringify(HOST_PHRASE));
  });

  it("clamps timeouts and drops secret-looking environment variables", () => {
    expect(clampTimeout(undefined)).toBe(60);
    expect(clampTimeout(5)).toBe(5);
    expect(clampTimeout(99999)).toBe(600);
    for (const k of ["GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "ATTEO_CREDENTIALS_FILE", "OPENAI_API_KEY", "DB_PASSWORD"]) expect(SECRET_ENV.test(k)).toBe(true);
    for (const k of ["PATH", "HOME", "LANG", "USER", "SHELL"]) expect(SECRET_ENV.test(k)).toBe(false);
  });
});
