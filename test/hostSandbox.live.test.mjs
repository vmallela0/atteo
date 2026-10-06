// atteo host's sandbox, for real (docs/HOST.md): the generated macOS profile run through sandbox-exec on this machine
// (skipped elsewhere; Linux's bubblewrap arguments are unit-tested in hostCore.test.ts). What a command must still do,
// what it must not (alt-c #4916a/b), and network only with --allow-network (jxn #4945).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { macProfile } from "../src/hostSandbox";
import { safeEnv } from "../src/hostCore";

const mac = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");

describe.skipIf(!mac)("atteo host's macOS sandbox, live", () => {
  let dir, share, outside, tmp, server, port, config;
  beforeAll(async () => {
    dir = realpathSync(mkdtempSync(join(homedir(), "atteo-sbx-test-")));
    share = join(dir, "share");
    outside = join(dir, "outside");
    mkdirSync(share);
    spawnSync("git", ["init", "-q", share]);
    mkdirSync(join(share, ".git", "hooks"), { recursive: true });
    config = readFileSync(join(share, ".git", "config"), "utf8");
    writeFileSync(join(share, ".envrc"), "");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "not yours");
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "atteo-run-")));
    server = createServer((_, res) => res.end("local service"));
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    port = server.address().port;
  });
  afterAll(() => {
    server?.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  });
  // Async, so this process's own test server can answer while a command runs.
  const run = (command, network = false) =>
    new Promise((done) => {
      const c = spawn("/usr/bin/sandbox-exec", ["-p", macProfile([share], tmp, realpathSync(homedir()), network), "/bin/sh", "-c", command], { cwd: share, env: safeEnv(process.env, tmp) });
      let out = "";
      c.stdout.on("data", (d) => (out += d));
      c.stderr.on("data", (d) => (out += d));
      c.on("close", (code) => done({ code, out }));
    });

  it("runs everyday tools, and writes only the share and its own HOME", async () => {
    for (const c of ["ls", "git status", "python3 -c 1", "echo hi > made.txt && cat made.txt", 'echo t > "$HOME/t" && cat "$HOME/t"', "sleep 0.1 & wait"]) expect((await run(c)).code, c).toBe(0);
    expect((await run(`cat ${outside}/secret.txt`)).out).not.toContain("not yours");
    expect((await run(`touch ${outside}/wrote`)).code).not.toBe(0);
    expect(existsSync(join(outside, "wrote"))).toBe(false);
    expect((await run(`ls ${join(homedir(), "Library", "Keychains")}`)).code).not.toBe(0);
    expect((await run(`cat ${join(homedir(), ".zshrc")}`)).code).not.toBe(0);
  });

  it("has no network, not even localhost, unless the host allows it", async () => {
    expect((await run(`curl -sf --max-time 5 http://127.0.0.1:${port}/`)).out).not.toContain("local service");
    expect((await run(`curl -sf --max-time 5 http://127.0.0.1:${port}/`, true)).out).toContain("local service");
  });

  it("can't reach other apps, the pasteboard or launchd", async () => {
    for (const c of ["open -a Calculator", "osascript -e 'tell application \"System Events\" to get name of every process'", "pbpaste", `launchctl asuser ${process.getuid()} /bin/cat ${join(homedir(), ".zshrc")}`]) expect((await run(c)).code, c).not.toBe(0);
    await run(`launchctl submit -l atteo.sbx.live -- /usr/bin/touch ${share}/LAUNCHED; sleep 1`);
    spawnSync("launchctl", ["remove", "atteo.sbx.live"]);
    expect(existsSync(join(share, "LAUNCHED"))).toBe(false);
  });

  it("keeps git hooks, git config and .envrc read-only: they run later, outside the sandbox", async () => {
    for (const c of ["echo '[core] fsmonitor = touch PWNED' >> .git/config", "echo x > .git/hooks/post-checkout", "echo x > .envrc", "mv .git .git2", "mkdir -p sub/.git/hooks && echo x > sub/.git/hooks/pre-commit"]) expect((await run(c)).code, c).not.toBe(0);
    expect(readFileSync(join(share, ".git", "config"), "utf8")).toBe(config);
    expect(existsSync(join(share, ".git", "hooks", "post-checkout"))).toBe(false);
    expect(existsSync(join(share, ".git"))).toBe(true);
  });
});
