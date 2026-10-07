// Which agent `atteo dispatch` (each message in its own forked session) and `watch --respond` start. Any agent
// works: presets for common CLIs, or --agent-cmd with {prompt} where the prompt goes (as one argument, never through a shell). The agent needs the board available,
// either as the "board" MCP server or through the atteo CLI on its PATH.

export interface Harness {
  bin: string;
  /** Arguments for one unattended run. `tools` is the board-tools allowlist (only Claude Code takes one). */
  args: (prompt: string, tools: string) => string[];
  /** How to give this agent the board (shown by `atteo connect`). */
  connect: string;
  /** One line that installs it, shown when it isn't on PATH. */
  install: string;
  /** Arguments that connect it to `atteo mcp` itself, when its CLI can (the rest show `connect`). */
  mcpAdd?: string[];
}

const MCP_JSON = `{"mcpServers": {"atteo": {"command": "atteo", "args": ["mcp"]}}}`;

export const HARNESSES: Record<string, Harness> = {
  claude: {
    bin: "claude",
    args: (p, tools) => ["-p", p, "--allowedTools", tools, "--max-turns", "15"],
    connect: "claude mcp add --scope user atteo -- atteo mcp",
    install: "npm install -g @anthropic-ai/claude-code",
    mcpAdd: ["mcp", "add", "--scope", "user", "atteo", "--", "atteo", "mcp"],
  },
  codex: {
    bin: "codex",
    args: (p) => ["exec", "--skip-git-repo-check", "--sandbox", "read-only", p],
    connect: `Add to ~/.codex/config.toml:\n[mcp_servers.atteo]\ncommand = "atteo"\nargs = ["mcp"]`,
    install: "npm install -g @openai/codex",
  },
  gemini: {
    bin: "gemini",
    args: (p) => ["--allowed-mcp-server-names", "board", "-p", p],
    connect: `Add to ~/.gemini/settings.json:\n${MCP_JSON}`,
    install: "npm install -g @google/gemini-cli",
  },
  cursor: {
    bin: "cursor-agent",
    args: (p) => ["-p", p, "--output-format", "text"],
    connect: `Add to ~/.cursor/mcp.json:\n${MCP_JSON}`,
    install: "curl https://cursor.com/install -fsS | bash",
  },
  opencode: {
    bin: "opencode",
    args: (p) => ["run", p],
    connect: `Add to opencode.json:\n{"mcp": {"atteo": {"type": "local", "command": ["atteo", "mcp"]}}}`,
    install: "npm install -g opencode-ai",
  },
};

/** Splits a command line into words (quotes group, backslash escapes); no shell is ever involved. */
export function splitCommand(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let has = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < cmd.length) cur += cmd[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (ch === "\\" && i + 1 < cmd.length) {
      cur += cmd[++i];
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (quote) throw new Error("Unclosed quote in --agent-cmd.");
  if (cur || has) out.push(cur);
  return out;
}

/** The program and arguments for one run: a preset by name, or a custom command with {prompt}. */
export function agentCommand(choice: { agent?: string; agentCmd?: string }, prompt: string, tools: string): { bin: string; args: string[] } {
  if (choice.agentCmd) {
    const words = splitCommand(choice.agentCmd);
    if (!words.length) throw new Error("--agent-cmd is empty.");
    if (!words.some((w) => w.includes("{prompt}"))) words.push("{prompt}");
    return { bin: words[0], args: words.slice(1).map((w) => w.split("{prompt}").join(prompt)) };
  }
  const h = HARNESSES[choice.agent ?? "claude"];
  if (!h) throw new Error(`Unknown agent "${choice.agent}". Presets: ${Object.keys(HARNESSES).join(", ")}; or use --agent-cmd "<command> {prompt}".`);
  return { bin: h.bin, args: h.args(prompt, tools) };
}

/** What `atteo harness <agent>` needs from the machine and the server (stubbed in tests). */
export interface SetUpDeps {
  which(bin: string): boolean;
  /** The saved login for this server, or null. */
  signedIn(): { user: string } | null;
  /** The device sign-in: prints a code and a link, polls until the person approves it. */
  signIn(): Promise<{ user: string }>;
  save(agent: string): void;
  /** The board this folder uses, if any. */
  folderBoard(): string | null;
  /** Whether this machine uses any board yet (a folder of it, or a default). */
  anyBoard(): boolean;
  /** A new end-to-end encrypted board, used in this folder from now on. */
  createBoard(title: string): Promise<string>;
  /** This machine's device key and the board's key (the first epoch, on a new board). */
  openKeys(board: string): Promise<void>;
  /** Runs a program to the end: its exit code and output. */
  run(bin: string, args: string[]): { code: number; out: string };
  say(line: string): void;
  /** This folder's name, or null for the home folder. */
  folderName(): string | null;
}

/**
 * atteo harness <agent> on a clean machine: the agent's CLI must be there (else one line on how to get it), then sign
 * in (device code), a board for this folder (a new end-to-end encrypted one if it has none), this machine's keys, and
 * the agent connected to `atteo mcp`. No questions asked: every step is skipped when it's already done.
 */
export async function setUp(agent: string, d: SetUpDeps): Promise<boolean> {
  const h = HARNESSES[agent];
  if (!d.which(h.bin)) {
    d.say(`${h.bin} isn't installed. Install it with: ${h.install}  then run: atteo harness ${agent}`);
    return false;
  }
  const me = d.signedIn() ?? (await d.signIn());
  d.save(agent);
  // A new board only on a machine that has none yet: someone switching agents in a stray folder gets no surprise board.
  let board = d.folderBoard();
  const made = !board && !d.anyBoard();
  if (made) board = await d.createBoard(d.folderName() ?? `${me.user}'s board`);
  if (board) await d.openKeys(board);
  let wired = "";
  if (h.mcpAdd) {
    const r = d.run(h.bin, h.mcpAdd);
    if (r.code === 0 || /already exists/i.test(r.out)) wired = `${agent} has the board's tools (atteo mcp).`;
  }
  d.say(`Signed in as ${me.user}. ${made ? `New end-to-end encrypted board ${board} for this folder.` : board ? `This folder uses board ${board}.` : `This folder has no board: atteo use "<board>", or atteo create "<title>" --encrypted.`}`);
  d.say(wired || `Connect ${agent} to the board once:\n  ${h.connect.split("\n").join("\n  ")}`);
  d.say(`Ready. Ask ${agent} to "post hello on the atteo board", or run: atteo post "hello". To answer mail while you're away: atteo dispatch --install`);
  return true;
}
