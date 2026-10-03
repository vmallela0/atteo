// Runs a claim's check (a command another member wrote) on this machine, safely enough to be worth doing:
// in a throwaway git worktree at the claim's commit, inside an OS sandbox with no network, writes only inside that
// checkout, your keys and credentials hidden, a minimal environment (no tokens from your shell), and a time limit.
// A person always reads the exact command and says yes first; with no sandbox available it refuses to run.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";

/** Paths under $HOME that commonly hold keys, tokens and logins; the sandbox can't read them. */
const SENSITIVE = [
  ".ssh", ".aws", ".azure", ".gnupg", ".kube", ".docker", ".netrc", ".npmrc", ".pypirc", ".git-credentials",
  ".config/gcloud", ".config/gh", ".config/agent-board", ".config/agent-soup", ".config/atteo", ".config/op", "Library/Keychains",
];
const DEP_DIRS = ["node_modules", ".venv", "venv", "vendor"]; // reused read-only from your checkout (installs need network)
export const OUTPUT_LIMIT = 8000;

export interface Sandbox {
  kind: "sandbox-exec" | "bwrap" | "docker";
  describe: string;
  /** The argv that runs `command` (via sh -c) in `dir` under this sandbox. */
  argv(command: string, dir: string, writable: string[]): string[];
}

const which = (cmd: string) => spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).stdout.trim();

/** macOS sandbox-exec profile: everything allowed except network, writes outside `writable`, secrets and the keychain. */
function seatbeltProfile(writable: string[]): string {
  const home = realpathSync(homedir());
  const q = (p: string) => JSON.stringify(p);
  return [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    "(deny file-write*)",
    `(allow file-write* ${writable.map((w) => `(subpath ${q(w)})`).join(" ")} (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (regex #"^/dev/fd/") (regex #"^/dev/ttys"))`,
    `(deny file-read* ${SENSITIVE.map((p) => `(subpath ${q(join(home, p))})`).join(" ")})`,
    // The keychain is reached over Mach IPC, not files: keep `security find-generic-password` from reading it.
    '(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd") (global-name "com.apple.securityd.xpc") (global-name "com.apple.security.agent") (global-name "com.apple.security.keychain-agent"))',
  ].join("\n");
}

/** The sandbox to use here, or null (the caller refuses to run without one). `image` opts into Docker. */
export function pickSandbox(image?: string): Sandbox | null {
  if (image) {
    if (!which("docker")) return null;
    return {
      kind: "docker",
      describe: `Docker (${image}): no network, only the checkout mounted`,
      argv: (command, dir) => ["docker", "run", "--rm", "--network", "none", "-v", `${dir}:/w`, "-w", "/w", "-e", "HOME=/tmp", "-e", "CI=1", image, "sh", "-c", command],
    };
  }
  if (platform() === "darwin" && existsSync("/usr/bin/sandbox-exec")) {
    return {
      kind: "sandbox-exec",
      describe: "macOS sandbox: no network, writes only inside the checkout, keys/credentials/keychain hidden",
      argv: (command, _dir, writable) => ["/usr/bin/sandbox-exec", "-p", seatbeltProfile(writable), "/bin/sh", "-c", command],
    };
  }
  const bwrap = platform() === "linux" ? which("bwrap") : "";
  if (bwrap) {
    return {
      kind: "bwrap",
      describe: "bubblewrap: no network, read-only system, writes only inside the checkout, keys/credentials hidden",
      argv: (command, dir, writable) => {
        const home = homedir();
        const hide = SENSITIVE.map((p) => join(home, p)).filter((p) => existsSync(p)).flatMap((p) => (spawnSync("test", ["-d", p]).status === 0 ? ["--tmpfs", p] : ["--ro-bind", "/dev/null", p]));
        return [bwrap, "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", ...writable.flatMap((w) => ["--bind", w, w]), ...hide, "--unshare-all", "--die-with-parent", "--new-session", "--chdir", dir, "/bin/sh", "-c", command];
      },
    };
  }
  return null;
}

export const NO_SANDBOX =
  platform() === "linux"
    ? "No sandbox available: install bubblewrap (e.g. apt install bubblewrap), or pass --image <docker image> to run it in Docker with no network."
    : "No sandbox available here; pass --image <docker image> to run it in Docker with no network.";

export interface CheckResult {
  code: number | null; // null: killed (time limit)
  timedOut: boolean;
  ms: number;
  output: string; // the last OUTPUT_LIMIT characters, stdout and stderr interleaved
}

/** Runs `command` under `sb` in `dir`, streaming output to `onOutput`; a private HOME/TMPDIR live in `scratch`. */
export function runSandboxed(sb: Sandbox, command: string, dir: string, scratch: string, writable: string[], timeoutMs: number, onOutput: (s: string) => void): Promise<CheckResult> {
  const home = join(scratch, "home"), tmp = join(scratch, "tmp");
  mkdirSync(home, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  // A minimal environment: nothing from your shell (tokens, cloud credentials) beyond what finds the tools.
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp, LANG: process.env.LANG ?? "en_US.UTF-8", TERM: "dumb", CI: "1", NO_COLOR: "1" };
  const argv = sb.argv(command, dir, writable);
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: dir, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", timedOut = false;
    const take = (b: Buffer) => {
      const s = b.toString("utf8");
      onOutput(s);
      out = (out + s).slice(-OUTPUT_LIMIT);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGKILL"); // the whole process group, not just the shell
      } catch {}
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? null : code, timedOut, ms: Date.now() - started, output: out });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 127, timedOut: false, ms: Date.now() - started, output: String(e) });
    });
  });
}

const git = (cwd: string, args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });

/** The repo this folder is in (or null). */
export function repoRoot(cwd: string): string | null {
  const r = git(cwd, ["rev-parse", "--show-toplevel"]);
  return r.status === 0 ? r.stdout.trim() : null;
}

export function resolveCommit(repo: string, commit: string): string | null {
  const r = git(repo, ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`]);
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * A throwaway checkout of `commit` (a detached git worktree in a temp folder), with your dependency folders linked in
 * read-only. Returns the checkout, a scratch folder for HOME/TMPDIR, what may be written, and a cleanup.
 */
export function throwawayCheckout(repo: string, commit: string): { dir: string; scratch: string; writable: string[]; cleanup: () => void } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "atteo-verify-")));
  const dir = join(base, "checkout"), scratch = join(base, "scratch");
  const add = git(repo, ["worktree", "add", "--detach", "--quiet", dir, commit]);
  if (add.status !== 0) {
    rmSync(base, { recursive: true, force: true });
    throw new Error(`Couldn't check out ${commit.slice(0, 7)}: ${add.stderr.trim()}`);
  }
  for (const d of DEP_DIRS) if (existsSync(join(repo, d)) && !existsSync(join(dir, d))) symlinkSync(join(repo, d), join(dir, d));
  // git inside the checkout writes to its admin folder in the main repo (.git/worktrees/<name>).
  const admin = git(dir, ["rev-parse", "--git-dir"]).stdout.trim();
  const writable = [base, ...(admin ? [realpathSync(admin)] : [])];
  return {
    dir,
    scratch,
    writable,
    cleanup: () => {
      git(repo, ["worktree", "remove", "--force", dir]);
      rmSync(base, { recursive: true, force: true });
      git(repo, ["worktree", "prune"]);
    },
  };
}

/**
 * Proves the sandbox holds here: network blocked, writes outside the checkout blocked (home, and a sibling folder),
 * credentials unreadable, writes inside allowed. Returns one line per probe.
 */
export async function sandboxSelfTest(sb: Sandbox): Promise<{ ok: boolean; lines: string[] }> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "atteo-sbtest-")));
  const dir = join(base, "checkout"), scratch = join(base, "scratch");
  mkdirSync(dir);
  const outside = join(homedir(), `.atteo-sandbox-probe-${process.pid}`);
  const secretDir = join(homedir(), ".ssh");
  const probes: { what: string; cmd: string; expect: "fail" | "pass" }[] = [
    { what: "write inside the checkout", cmd: "echo ok > inside.txt && cat inside.txt", expect: "pass" },
    { what: "network (HTTPS)", cmd: "curl -sS -m 5 -o /dev/null https://example.com", expect: "fail" },
    { what: "network (raw TCP)", cmd: "nc -z -w 3 1.1.1.1 443", expect: "fail" },
    { what: "write to your home folder", cmd: `touch ${JSON.stringify(outside)}`, expect: "fail" },
    ...(existsSync(secretDir) ? [{ what: "read ~/.ssh", cmd: `ls ${JSON.stringify(secretDir)}`, expect: "fail" as const }] : []),
    ...(platform() === "darwin" ? [{ what: "read the login keychain", cmd: "security find-generic-password -s agent-board -w", expect: "fail" as const }] : []),
    { what: "your shell's environment", cmd: 'test -z "$ATTEO_SBTEST"', expect: "pass" },
  ];
  process.env.ATTEO_SBTEST = "leak";
  const lines: string[] = [];
  let ok = true;
  try {
    for (const p of probes) {
      const r = await runSandboxed(sb, p.cmd, dir, scratch, [base], 15_000, () => {});
      const passed = r.code === 0;
      const good = (p.expect === "pass") === passed;
      ok &&= good;
      lines.push(`${good ? "✓" : "✗"} ${p.what}: ${passed ? "allowed" : "blocked"}${good ? "" : p.expect === "fail" ? " (should be blocked)" : " (should be allowed)"}`);
    }
    if (existsSync(outside)) {
      ok = false;
      rmSync(outside, { force: true });
    }
  } finally {
    delete process.env.ATTEO_SBTEST;
    rmSync(base, { recursive: true, force: true });
  }
  return { ok, lines };
}
