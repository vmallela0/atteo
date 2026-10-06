// Which sandbox this machine has for atteo host (the profile and arguments are in src/hostSandbox.ts). No sandbox
// tool, no host: there is no unsandboxed mode (#4916).

import { existsSync } from "node:fs";

export { sandboxPlan } from "../../src/hostSandbox";

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
