// Which sandbox this machine has for atteo host (the profile and arguments are in src/hostSandbox.ts). No sandbox
// tool, no host: there is no unsandboxed mode (#4916).

import { existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

export { sandboxPlan } from "../../src/hostSandbox";

/**
 * Linux: the .git folders (a few levels deep, not inside node_modules) and existing .envrc files in the shares, for
 * bubblewrap to make read-only (alt-c #4916b). A missing .git/hooks is created first so it can be covered.
 */
export function laterRuns(shares: string[], depth = 4): { gitDirs: string[]; envrcs: string[] } {
  const gitDirs: string[] = [], envrcs: string[] = [];
  const walk = (dir: string, d: number) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    try {
      if (names.includes(".envrc") && lstatSync(join(dir, ".envrc")).isFile()) envrcs.push(join(dir, ".envrc"));
    } catch {}
    if (names.includes(".git")) {
      const g = join(dir, ".git");
      try {
        if (lstatSync(g).isDirectory()) {
          if (!existsSync(join(g, "hooks"))) mkdirSync(join(g, "hooks"));
          gitDirs.push(g);
        }
      } catch {}
    }
    if (d <= 0) return;
    for (const n of names) {
      if (n === ".git" || n === "node_modules") continue;
      try {
        if (lstatSync(join(dir, n)).isDirectory()) walk(join(dir, n), d - 1);
      } catch {}
    }
  };
  for (const s of shares) walk(s, depth);
  return { gitDirs, envrcs };
}

function onPath(name: string, path = process.env.PATH ?? ""): string | null {
  for (const d of [...path.split(":"), "/usr/bin", "/usr/local/bin", "/bin"]) if (d && existsSync(`${d}/${name}`)) return `${d}/${name}`;
  return null;
}

/** What this machine sandboxes with, or why it can't host. */
export function sandboxTool(platform: string = process.platform): { kind: "mac" | "bwrap"; file: string } | { error: string } {
  if (platform === "darwin") return existsSync("/usr/bin/sandbox-exec") ? { kind: "mac", file: "/usr/bin/sandbox-exec" } : { error: "atteo host needs macOS's sandbox-exec (/usr/bin/sandbox-exec), which isn't here." };
  if (platform === "linux") {
    const b = onPath("bwrap");
    return b
      ? { kind: "bwrap", file: b }
      : { error: "atteo host needs bubblewrap to sandbox commands. Install it (Debian/Ubuntu: sudo apt install bubblewrap; Fedora: sudo dnf install bubblewrap) and run atteo host again." };
  }
  return { error: `atteo host can't sandbox commands on ${platform} yet, so it won't run here (macOS and Linux only).` };
}
