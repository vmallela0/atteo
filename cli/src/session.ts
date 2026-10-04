// Which agent session a command runs as. Every running agent (a Claude Code window, a Codex run, a bot) is its own
// session: the CLI walks up from its parent process to the first one that isn't a shell or a wrapper, and that
// process (its pid plus start time, so a reused pid is a new session) maps to a session on the server. A person in a
// plain terminal gets one session per terminal. --session or ATTEO_SESSION picks one explicitly; ATTEO_SESSION_NAME names
// the one this agent gets (picked up again by name after a restart: one per Conductor workspace).

import { execFileSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { env } from "./env";

/** Shells and launchers between an agent and this process: skipped when looking for the agent. This CLI is one too,
 * under its name and its names from before the rename (aliases of the same file). */
export const PASS_THROUGH = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "nu", "pwsh", "powershell", "env", "sudo", "doas", "timeout", "xargs", "nohup", "time", "npx", "npm", "pnpm", "yarn", "bunx", "uv", "uvx", "script", "stdbuf", "atteo", "agent-soup", "agent-board"]);
/** A shell script run directly (./ship.sh, a git hook): the kernel names the process after the script. Not an agent. */
const SHELL_SCRIPT = /\.(sh|bash|zsh)$/;
/** Where a person's terminal starts: the session is the shell just below one of these. */
const TERMINAL_HOSTS = /^(tmux|screen|sshd|login|systemd|init|launchd|gnome-terminal|konsole|xterm|alacritty|kitty|wezterm|iterm2|terminal|code|cursor|zellij|ghostty|warp|hyper|tabby|conhost|windowsterminal|wt|explorer)(?![a-z0-9])/i; // whole names: "code" is VS Code, not codex

/** Friendly names for well-known agents (the process name otherwise). */
const CLIENTS: Record<string, string> = { claude: "Claude Code", codex: "Codex", gemini: "Gemini CLI", opencode: "opencode", "cursor-agent": "Cursor", aider: "aider", goose: "Goose", amp: "Amp", qwen: "Qwen Code", crush: "Crush" };

interface Proc {
  pid: number;
  ppid: number;
  start: string;
  comm: string;
}

/** Interpreters that run an agent from a script (npm-installed Claude Code and Gemini CLI run as `node …/claude`). A
 *  shell running a shell script (ship.sh, a git hook) stays a shell, so it's passed through; one running anything else
 *  (an agent that is a shell script) is that agent. macOS reports a shebang script as its shell, so we look either way. */
const INTERPRETERS = new Set(["node", "bun", "deno", "python", "python3", "ruby", "perl", "sh", "bash", "zsh", "dash"]);

/** "node /usr/local/bin/claude" → "claude": the script an interpreter runs, if any (not for interactive shells). */
export function scriptName(comm: string, argv: string[]): string {
  if (!INTERPRETERS.has(base(comm))) return comm;
  const args = argv.slice(1);
  // `bash -c "…"` / `node -e "…"` run an inline command, not a script: the process is just a shell (passed through).
  if (args.some((a) => /^-[a-zA-Z]*[ce]$/.test(a))) return comm;
  const script = args.find((a) => !a.startsWith("-"));
  const name = script && !/\s/.test(script) && !/^-/.test(argv[0] ?? "") ? (script.split("/").pop() ?? comm) : comm;
  return SHELL_SCRIPT.test(name) ? comm : name;
}

function proc(pid: number): Proc | null {
  try {
    if (platform() === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const fields = stat.slice(close + 2).split(" "); // after "pid (comm) "
      const comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
      const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
      return { pid, ppid: Number(fields[1]), start: fields[19], comm: scriptName(comm, argv) };
    }
    const out = execFileSync("ps", ["-o", "ppid=,lstart=,comm=", "-p", String(pid)], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const m = out.match(/^(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.+)$/);
    if (!m) return null;
    const comm = m[3].split("/").pop() ?? m[3];
    // macOS reports the interpreter for scripts; look at the command line for the script's own name.
    const args = INTERPRETERS.has(base(comm)) ? execFileSync("ps", ["-o", "args=", "-p", String(pid)], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim().split(/\s+/) : [];
    return { pid, ppid: Number(m[1]), start: m[2], comm: args.length ? scriptName(comm, args) : comm };
  } catch {
    return null;
  }
}

const base = (comm: string) => comm.toLowerCase().replace(/\.(exe|js|cjs|mjs)$/, "");

export interface Caller {
  key: string; // stable for the life of the calling agent (or terminal)
  client: string; // "Claude Code", "Codex", "terminal", or the process name
  name: string; // suggested session name: claude, codex, terminal…
}

/** The agent (or terminal) that ran this command. */
export function caller(): Caller {
  let p = proc(process.ppid);
  let lastShell: Proc | null = null;
  for (let hops = 0; p && hops < 12; hops++) {
    const b = base(p.comm);
    if (TERMINAL_HOSTS.test(b) || p.pid <= 1) {
      const t = lastShell ?? p;
      return { key: `${t.pid}:${t.start}`, client: "terminal", name: "terminal" };
    }
    if (!PASS_THROUGH.has(b) && !SHELL_SCRIPT.test(b)) return { key: `${p.pid}:${p.start}`, client: CLIENTS[b] ?? p.comm, name: b in CLIENTS ? b.replace("cursor-agent", "cursor") : b };
    lastShell = p;
    p = proc(p.ppid);
  }
  const t = lastShell ?? { pid: process.ppid, start: "" };
  return { key: `${t.pid}:${t.start}`, client: "terminal", name: "terminal" };
}

// ---- the model the agent runs on: a label for people on the web, never shown to agents (jxn #1191) ----

/** "claude-opus-5-5" → "Opus 5.5", "claude-sonnet-4-5-20250929[1m]" → "Sonnet 4.5 1M", "opus" → "Opus"; others as given. */
export function prettyModel(id: string): string {
  const m = id.trim().match(/^(?:claude-)?(opus|sonnet|haiku|fable)(?:-(\d+)(?:-(\d{1,2}))?)?(?:-\d{8})?(\[1m\])?$/i);
  if (!m) return id.trim();
  const fam = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  return `${fam}${m[2] ? ` ${m[2]}${m[3] ? `.${m[3]}` : ""}` : ""}${m[4] ? " 1M" : ""}`;
}

/** The newest model in a Claude Code session's transcript (its last 64 KB), if there is one. */
function claudeCodeModel(sessionId: string): string | null {
  if (!/^[\w-]{8,64}$/.test(sessionId)) return null;
  const root = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
  try {
    for (const d of readdirSync(root)) {
      const f = join(root, d, `${sessionId}.jsonl`);
      if (!existsSync(f)) continue;
      const fd = openSync(f, "r");
      try {
        const size = fstatSync(fd).size, n = Math.min(size, 65536), buf = Buffer.alloc(n);
        readSync(fd, buf, 0, n, size - n);
        const all = [...buf.toString("utf8").matchAll(/"model":"(claude-[\w.[\]-]+)"/g)];
        return all.length ? all[all.length - 1][1] : null;
      } finally {
        closeSync(fd);
      }
    }
  } catch {}
  return null;
}

/** What the calling agent runs on: ATTEO_MODEL, else (Claude Code) its transcript's newest model with its effort
 *  ("Opus 5.5 high"), else ANTHROPIC_MODEL. Null when nothing says. */
export function detectModel(): string | null {
  const set = env("MODEL")?.trim();
  if (set) return set.slice(0, 60);
  const cc = process.env.CLAUDE_CODE_SESSION_ID ? claudeCodeModel(process.env.CLAUDE_CODE_SESSION_ID) : null;
  const id = cc ?? process.env.ANTHROPIC_MODEL?.trim();
  if (!id) return null;
  const effort = cc && /^[a-z]{1,12}$/.test(process.env.CLAUDE_EFFORT ?? "") ? ` ${process.env.CLAUDE_EFFORT}` : "";
  return (prettyModel(id) + effort).slice(0, 60);
}

// ---- local map: calling process → session (the server holds the session itself) ----

export interface LocalSession {
  id: string;
  name: string;
  boards: string[]; // last known; refreshed on join/leave and whenever the server reports them
  notified?: number; // newest inbox item already shown to this session (the "📣" line)
  pid?: number;
  model?: string | null; // the model last detected here and sent (re-sent only when it changes)
}

function file(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agent-board", "sessions.json");
}

export function loadMap(): Record<string, LocalSession> {
  try {
    return JSON.parse(readFileSync(file(), "utf8"));
  } catch {
    return {};
  }
}

export function saveMap(map: Record<string, LocalSession>) {
  // Forget processes that are gone (Linux can tell cheaply; elsewhere keep the last 200).
  const live = Object.entries(map).filter(([, s]) => platform() !== "linux" || !s.pid || existsSync(`/proc/${s.pid}`));
  const kept = Object.fromEntries(live.slice(-200));
  mkdirSync(join(file(), ".."), { recursive: true, mode: 0o700 });
  writeFileSync(file(), JSON.stringify(kept, null, 2), { mode: 0o600 });
}
