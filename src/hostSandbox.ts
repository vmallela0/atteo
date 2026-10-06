// atteo host's sandbox (docs/HOST.md, #4916): every approved command runs inside the OS's own sandbox, so the shared
// folders are a real boundary, not just where the shell starts. macOS: sandbox-exec with a generated profile. Linux:
// bubblewrap. No sandbox tool, no host: there is no unsandboxed mode.
//
// What a command can do inside: read the system (programs, libraries, /etc), read and write the shared folders and its
// own temp folder (its HOME), and use the network (npm, git and friends need it). It can't read or write anything else
// under your home (keys, logins, the CLI's own credentials, keychains) or anyone else's.

// Pure (no Node imports), so its rules are unit-tested; cli/src/sandbox.ts finds the tool on the machine.

const dirname = (p: string): string => {
  const i = p.replace(/\/+$/, "").lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
};

export interface SandboxPlan {
  file: string;
  args: string[];
  /** HOME and TMPDIR inside the sandbox. */
  tmp: string;
}

/** A path as an SBPL string literal. */
const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Every ancestor of a path, root excluded (so a tool can stat its way down to a shared folder). */
function ancestors(p: string): string[] {
  const out: string[] = [];
  for (let d = dirname(p); d !== "/" && d !== "."; d = dirname(d)) out.push(d);
  return out;
}

/**
 * The macOS profile. Later rules win in SBPL, so: allow by default (process, network, mach services a shell needs),
 * then forbid every write, forbid reading the places people's files live, forbid the keychain's services, then open the
 * shared folders and the temp folder again for read and write. Ancestors of those get metadata only.
 */
export function macProfile(shares: string[], tmp: string, home: string): string {
  const open = [...shares, tmp];
  const walk = [...new Set(open.flatMap(ancestors))];
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (regex #"^/dev/fd/") (regex #"^/dev/tty"))',
    `(deny file-read* (subpath ${q(home)}) (subpath "/Users") (subpath "/home") (subpath "/Volumes") (subpath "/private/var/folders") (subpath "/private/tmp") (subpath "/private/var/root") (subpath "/private/var/db") (subpath "/Library/Keychains"))`,
    '(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd") (global-name "com.apple.securityd.xpc") (global-name "com.apple.security.agent") (global-name "com.apple.secd") (global-name "com.apple.trustd.agent"))',
    walk.length ? `(allow file-read-metadata ${walk.map((d) => `(literal ${q(d)})`).join(" ")})` : "",
    `(allow file-read* file-write* ${open.map((d) => `(subpath ${q(d)})`).join(" ")})`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** bubblewrap's arguments: system folders read-only, the shares read-write at the same paths, a private /tmp as HOME. */
export function bwrapArgs(shares: string[], cwd: string, command: string): string[] {
  const ro = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/lib32", "/etc", "/opt", "/nix", "/snap"].flatMap((d) => ["--ro-bind-try", d, d]);
  return [
    "--die-with-parent",
    "--new-session", // no TIOCSTI into the owner's terminal
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    ...ro,
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    ...shares.flatMap((s) => ["--bind", s, s]),
    "--chdir", cwd,
    "/bin/sh", "-c", command,
  ];
}

/** How to run one command sandboxed: macOS gets the profile inline; Linux runs bwrap. `tmp` is the command's HOME. */
export function sandboxPlan(tool: { kind: "mac" | "bwrap"; file: string }, shares: string[], cwd: string, command: string, tmp: string, home: string): SandboxPlan {
  if (tool.kind === "mac") return { file: tool.file, args: ["-p", macProfile(shares, tmp, home), "/bin/sh", "-c", command], tmp };
  return { file: tool.file, args: bwrapArgs(shares, cwd, command), tmp: "/tmp" };
}
