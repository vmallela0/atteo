// Runs a claim's check (a command another member wrote) on this machine, safely enough to be worth doing:
// in a throwaway git worktree at the claim's commit, inside an OS sandbox with no network, writes only inside that
// checkout, your keys and credentials hidden, a minimal environment (no tokens from your shell), and a time limit.
// A person always reads the exact command and says yes first; with no sandbox available it refuses to run.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

/** Paths under $HOME that commonly hold keys, tokens and logins; the sandbox can't read them. */
const SENSITIVE = [
  ".ssh", ".aws", ".azure", ".gnupg", ".kube", ".docker", ".netrc", ".npmrc", ".pypirc", ".git-credentials",
  ".config/gcloud", ".config/gh", ".config/agent-board", ".config/agent-soup", ".config/atteo", ".config/op", "Library/Keychains",
];
const DEP_DIRS = ["node_modules", ".venv", "venv", "vendor"]; // reused read-only from your checkout (installs need network)
export const OUTPUT_LIMIT = 8000;
/** An attached command cannot turn the verifier's terminal into an unbounded output sink. */
export const TERMINAL_OUTPUT_LIMIT = 64 * 1024;

/** Make untrusted text inert before writing it to a terminal. Newlines and tabs remain readable. */
export function terminalSafe(text: string): string {
  return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, (c) => {
    const n = c.charCodeAt(0);
    return n <= 0xff ? `\\x${n.toString(16).padStart(2, "0")}` : `\\u${n.toString(16).padStart(4, "0")}`;
  }).replace(/\r/g, "\\r");
}

/** Commands are shown literally; controls (including line breaks) are escaped so they cannot forge the prompt. */
export function displayCommand(command: string): string {
  return /[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/.test(command)
    ? JSON.stringify(command.replace(/[\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`))
    : command;
}

export interface Sandbox {
  kind: "sandbox-exec" | "bwrap" | "docker";
  describe: string;
  /** The argv that runs `command` (via sh -c) in `dir` under this sandbox. */
  argv(command: string, dir: string, writable: string[]): string[];
  /** Stop work owned by a service outside the spawned process group (currently Docker). */
  kill?(writable: string[]): void;
}

const which = (cmd: string) => spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).stdout.trim();

/** A small, host-independent PATH plus the Node/npm runtime that launched this CLI. */
function trustedRuntime(): { path: string; mounts: string[] } {
  const bins = [dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"];
  const mounts = [process.execPath];
  const npm = which("npm");
  if (npm) {
    const npmBin = dirname(npm);
    bins.push(npmBin);
    mounts.push(basename(npmBin) === "bin" ? dirname(npmBin) : npm);
  }
  return {
    path: [...new Set(bins.filter(existsSync))].join(":"),
    mounts: [...new Set(mounts.filter(existsSync).map((p) => realpathSync(p)))],
  };
}

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
      describe: `Docker (${image}): no network, read-only container, only the checkout mounted`,
      argv: (command, dir, writable) => [
        "docker", "run", "--rm", "--init", "--cidfile", join(writable[0], "docker.cid"),
        "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--pids-limit", "512", "--memory", "2g", "--cpus", "4", "--ulimit", "nofile=1024:1024",
        "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m", "-v", `${dir}:/w`, "-w", "/w",
        "-e", "HOME=/tmp", "-e", "CI=1", "--entrypoint", "sh", image, "-c", command,
      ],
      kill: (writable) => {
        try {
          const id = readFileSync(join(writable[0], "docker.cid"), "utf8").trim();
          if (id) spawnSync("docker", ["kill", id], { stdio: "ignore", timeout: 10_000 });
        } catch {}
      },
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
      describe: "bubblewrap: no network or host files, read-only system/dependencies, writes only inside the checkout",
      argv: (command, dir, writable) => {
        const system = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc/alternatives", "/etc/ssl", "/etc/pki", "/nix/store"].filter(existsSync);
        const deps = DEP_DIRS.map((d) => join(dir, d)).filter(existsSync).map((p) => realpathSync(p));
        const readable = [...new Set([...system, ...trustedRuntime().mounts, ...deps])];
        return [
          bwrap,
          ...readable.flatMap((p) => ["--ro-bind", p, p]),
          "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--tmpfs", "/var/tmp",
          ...writable.flatMap((w) => ["--bind", w, w]),
          "--unshare-all", "--die-with-parent", "--new-session", "--chdir", dir, "/bin/sh", "-c", command,
        ];
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
  const env: Record<string, string> = { PATH: trustedRuntime().path, HOME: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp, LANG: process.env.LANG ?? "en_US.UTF-8", TERM: "dumb", CI: "1", NO_COLOR: "1" };
  // Docker leaves its cidfile behind even with --rm; each probe/check gets a fresh one.
  if (sb.kind === "docker") rmSync(join(writable[0], "docker.cid"), { force: true });
  const argv = sb.argv(command, dir, writable);
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: dir, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", timedOut = false;
    let shown = 0, truncated = false;
    const take = (b: Buffer) => {
      const s = terminalSafe(b.toString("utf8"));
      const room = Math.max(0, TERMINAL_OUTPUT_LIMIT - shown);
      if (room) {
        const visible = s.slice(0, room);
        shown += visible.length;
        onOutput(visible);
      }
      if (!truncated && s.length > room) {
        truncated = true;
        onOutput("\n[terminal output truncated; the command is still running]\n");
      }
      out = (out + s).slice(-OUTPUT_LIMIT);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const timer = setTimeout(() => {
      timedOut = true;
      sb.kill?.(writable);
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
  const r = git(repo, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${commit}^{commit}`]);
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
  return {
    dir,
    scratch,
    writable: [base],
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
  const hostSecret = join(homedir(), `.atteo-sandbox-read-probe-${process.pid}`);
  const secretDir = join(homedir(), ".ssh");
  writeFileSync(hostSecret, "must stay on the host", { mode: 0o600 });
  const probes: { what: string; cmd: string; expect: "fail" | "pass" }[] = [
    { what: "write inside the checkout", cmd: "echo ok > inside.txt && cat inside.txt", expect: "pass" },
    { what: "network (HTTPS)", cmd: "curl -sS -m 5 -o /dev/null https://example.com", expect: "fail" },
    { what: "network (raw TCP)", cmd: "nc -z -w 3 1.1.1.1 443", expect: "fail" },
    { what: "write to your home folder", cmd: `touch ${JSON.stringify(outside)}`, expect: "fail" },
    { what: "read an unlisted file from your home folder", cmd: `cat ${JSON.stringify(hostSecret)}`, expect: "fail" },
    ...(existsSync(secretDir) ? [{ what: "read ~/.ssh", cmd: `ls ${JSON.stringify(secretDir)}`, expect: "fail" as const }] : []),
    ...(["/var/run/docker.sock", "/run/docker.sock"].filter(existsSync).map((p) => ({ what: `reach ${p}`, cmd: `test -r ${JSON.stringify(p)}`, expect: "fail" as const }))),
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
    rmSync(hostSecret, { force: true });
    rmSync(base, { recursive: true, force: true });
  }
  return { ok, lines };
}
