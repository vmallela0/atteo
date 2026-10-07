import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitLink, githubRepo, repoContext } from "../cli/src/repoInit.ts";

const dirs = [];
const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
const makeRepo = () => {
  const dir = mkdtempSync(join(tmpdir(), "atteo-init-"));
  dirs.push(dir);
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Atteo test");
  git(dir, "remote", "add", "origin", "git@github.com:Acme/Widgets.git");
  return dir;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("repo init", () => {
  it("accepts only a GitHub owner and repo from the remote", () => {
    expect(githubRepo("git@github.com:Acme/Widgets.git")).toBe("acme/widgets");
    expect(githubRepo("https://github.com/Acme/Widgets")).toBe("acme/widgets");
    expect(githubRepo("ssh://git@github.com/Acme/Widgets.git")).toBe("acme/widgets");
    expect(githubRepo("https://evil.example/Acme/Widgets")).toBeNull();
    expect(githubRepo("git@github.com:Acme/Widgets/other.git")).toBeNull();
  });

  it("commits only the link file and rejects a changed repo or extra fields", () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "other.txt"), "keep staged\n");
    git(dir, "add", "other.txt");
    const ctx = repoContext(dir);
    expect(ctx.repo).toBe("acme/widgets");
    expect(commitLink(ctx, "b_abcdefgh")).toBe("committed");
    expect(JSON.parse(readFileSync(ctx.file, "utf8"))).toEqual({ board: "b_abcdefgh", repo: "acme/widgets" });
    expect(git(dir, "show", "--pretty=format:", "--name-only", "HEAD")).toBe(".atteo.json");
    expect(git(dir, "diff", "--cached", "--name-only")).toBe("other.txt");
    expect(commitLink(repoContext(dir), "b_abcdefgh")).toBe("already committed");
    writeFileSync(ctx.file, JSON.stringify({ board: "b_abcdefgh", repo: "acme/other" }));
    expect(() => repoContext(dir)).toThrow(/must contain only this GitHub repo/);
    writeFileSync(ctx.file, JSON.stringify({ board: "b_abcdefgh", repo: "acme/widgets", token: "no" }));
    expect(() => repoContext(dir)).toThrow(/must contain only this GitHub repo/);
  });
});
