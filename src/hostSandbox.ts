// atteo host's sandbox (docs/HOST.md, #4916): every approved command runs inside the OS's own sandbox, so the shared
// folders are a real boundary, not just where the shell starts. macOS: sandbox-exec with a generated profile. Linux:
// bubblewrap. No sandbox tool, no host: there is no unsandboxed mode.
//
// What a command can do inside: read the system (programs, libraries, /etc), read and write the shared folders and its
// own temp folder (its HOME), except git hooks and config and .envrc, which run later outside. No network unless the
// person started the host with --allow-network. It can't read or write anything else under your home (keys, logins,
// the CLI's own credentials, keychains) or anyone else's, or reach other apps, launchd or the pasteboard.

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

/** A path as an SBPL regex literal that matches only itself. */
const rx = (s: string) => s.replace(/[\\^$.|?*+()[\]{}]/g, "\\$&").replace(/"/g, '\\"');

/**
 * Files in a share that run later, outside the sandbox, when the owner works there: git hooks and config
 * (core.hooksPath, core.fsmonitor run on a plain `git status`), the `.git` entry itself (so it can't be swapped for a
 * gitfile pointing elsewhere), and direnv's .envrc. Read-only inside (alt-c #4916b).
 */
const LATER_RUNS = (share: string) => [
  `^${rx(share)}(/.*)?/\\.git$`,
  `^${rx(share)}(/.*)?/\\.git/((modules|worktrees)/.+/)?(hooks|hooks/.*|config[^/]*)$`,
  `^${rx(share)}(/.*)?/\\.envrc$`,
];

/** The only Mach services a sandboxed shell reaches: user and group lookups, logging, preferences (alt-c #4916a). */
const MACH_OK = [
  "com.apple.system.opendirectoryd.libinfo",
  "com.apple.system.opendirectoryd.membership",
  "com.apple.system.notification_center",
  "com.apple.system.logger",
  "com.apple.logd",
  "com.apple.diagnosticd",
  "com.apple.sysmond",
  "com.apple.bsd.dirhelper",
  "com.apple.cfprefsd.daemon",
  "com.apple.cfprefsd.agent",
];
/** …plus DNS and network configuration, only with --allow-network. */
const MACH_NET = ["com.apple.dnssd.service", "com.apple.mDNSResponder", "com.apple.SystemConfiguration.configd", "com.apple.SystemConfiguration.DNSConfiguration", "com.apple.networkd"];

/**
 * The macOS profile: deny everything, then allow what a shell and its tools need. Processes may fork and exec (they
 * stay in this sandbox) and signal only each other; Mach services only from MACH_OK, so no LaunchServices (`open`),
 * Apple Events (`osascript`), pasteboard, launchd jobs or keychain. No network at all, not even localhost or a unix
 * socket, unless the person started the host with --allow-network (jxn #4945). Reads: everything but the places
 * people's files live (home, other homes, volumes, other temp folders, keychains). Writes: only the shares and the
 * temp folder. Later rules win in SBPL, so the order matters.
 */
export function macProfile(shares: string[], tmp: string, home: string, network = false): string {
  const open = [...shares, tmp];
  const walk = [...new Set(open.flatMap(ancestors))];
  return [
    "(version 1)",
    "(deny default)",
    "(allow process-fork process-exec)",
    "(allow signal (target same-sandbox))",
    "(allow process-info* (target same-sandbox))",
    "(allow sysctl-read)",
    "(allow ipc-posix-sem ipc-posix-shm-read-data)",
    network ? "(allow network-outbound network-inbound network-bind system-socket)" : "",
    '(allow iokit-open (iokit-registry-entry-class "RootDomainUserClient"))',
    `(allow mach-lookup ${[...MACH_OK, ...(network ? MACH_NET : [])].map((n) => `(global-name ${q(n)})`).join(" ")})`,
    "(allow file-read*)",
    `(deny file-read* (subpath ${q(home)}) (subpath "/Users") (subpath "/home") (subpath "/Volumes") (subpath "/private/var/folders") (subpath "/private/tmp") (subpath "/private/var/root") (subpath "/private/var/db") (subpath "/Library/Keychains"))`,
    walk.length ? `(allow file-read-metadata ${walk.map((d) => `(literal ${q(d)})`).join(" ")})` : "",
    '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (regex #"^/dev/fd/") (regex #"^/dev/tty"))',
    '(allow file-ioctl (literal "/dev/null") (literal "/dev/zero") (regex #"^/dev/fd/"))',
    `(allow file-read* file-write* ${open.map((d) => `(subpath ${q(d)})`).join(" ")})`,
    `(deny file-write* ${shares.flatMap(LATER_RUNS).map((r) => `(regex #"${r}")`).join(" ")})`,
  ]
    .filter(Boolean)
    .join("\n");
}

export interface SandboxOpts {
  /** Only when the person started the host with --allow-network (jxn #4945). */
  network?: boolean;
  /** Linux: the .git folders and .envrc files in the shares (found by the CLI), made read-only where they run later. */
  gitDirs?: string[];
  envrcs?: string[];
}

/**
 * bubblewrap's arguments: system folders read-only, the shares read-write at the same paths, a private /tmp as HOME,
 * no network namespace shared (so no internet, no localhost services, no abstract unix sockets like X11) unless
 * --allow-network. Each .git is its own mount, so it can't be renamed or swapped, with hooks and config read-only on
 * top; existing .envrc files are read-only too.
 */
export function bwrapArgs(shares: string[], cwd: string, command: string, o: SandboxOpts = {}): string[] {
  const ro = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/lib32", "/etc", "/opt", "/nix", "/snap"].flatMap((d) => ["--ro-bind-try", d, d]);
  return [
    "--die-with-parent",
    "--new-session", // no TIOCSTI into the owner's terminal
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    ...(o.network ? [] : ["--unshare-net"]),
    ...ro,
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    ...shares.flatMap((s) => ["--bind", s, s]),
    ...(o.gitDirs ?? []).flatMap((g) => ["--bind", g, g, ...["hooks", "config", "config.worktree"].flatMap((f) => ["--ro-bind-try", `${g}/${f}`, `${g}/${f}`])]),
    ...(o.envrcs ?? []).flatMap((e) => ["--ro-bind", e, e]),
    "--chdir", cwd,
    "/bin/sh", "-c", command,
  ];
}

/** How to run one command sandboxed: macOS gets the profile inline; Linux runs bwrap. `tmp` is the command's HOME. */
export function sandboxPlan(tool: { kind: "mac" | "bwrap"; file: string }, shares: string[], cwd: string, command: string, tmp: string, home: string, o: SandboxOpts = {}): SandboxPlan {
  if (tool.kind === "mac") return { file: tool.file, args: ["-p", macProfile(shares, tmp, home, o.network), "/bin/sh", "-c", command], tmp };
  return { file: tool.file, args: bwrapArgs(shares, cwd, command, o), tmp: "/tmp" };
}
