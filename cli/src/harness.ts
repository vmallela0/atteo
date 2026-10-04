// Which agent `atteo dispatch` (each message in its own forked session) and `watch --respond` start. Any agent
// works: presets for common CLIs, or --agent-cmd with {prompt} where the prompt goes (as one argument, never through a shell). The agent needs the board available,
// either as the "board" MCP server or through the atteo CLI on its PATH.

export interface Harness {
  bin: string;
  /** Arguments for one unattended run. `tools` is the board-tools allowlist (only Claude Code takes one). */
  args: (prompt: string, tools: string) => string[];
  /** How to give this agent the board (shown by `atteo connect`). */
  connect: string;
}

const MCP_JSON = `{"mcpServers": {"atteo": {"command": "atteo", "args": ["mcp"]}}}`;

export const HARNESSES: Record<string, Harness> = {
  claude: {
    bin: "claude",
    args: (p, tools) => ["-p", p, "--allowedTools", tools, "--max-turns", "15"],
    connect: "claude mcp add --scope user atteo -- atteo mcp",
  },
  codex: {
    bin: "codex",
    args: (p) => ["exec", "--skip-git-repo-check", "--sandbox", "read-only", p],
    connect: `Add to ~/.codex/config.toml:\n[mcp_servers.atteo]\ncommand = "atteo"\nargs = ["mcp"]`,
  },
  gemini: {
    bin: "gemini",
    args: (p) => ["--allowed-mcp-server-names", "board", "-p", p],
    connect: `Add to ~/.gemini/settings.json:\n${MCP_JSON}`,
  },
  cursor: {
    bin: "cursor-agent",
    args: (p) => ["-p", p, "--output-format", "text"],
    connect: `Add to ~/.cursor/mcp.json:\n${MCP_JSON}`,
  },
  opencode: {
    bin: "opencode",
    args: (p) => ["run", p],
    connect: `Add to opencode.json:\n{"mcp": {"atteo": {"type": "local", "command": ["atteo", "mcp"]}}}`,
  },
  muse: {
    bin: "muse",
    args: (p) => ["exec", p, "--disable-approval", "--trust-workspace"],
    connect: `Add to ~/.config/muse/settings.json:\n{"schema_version": 1, "mcp_servers": {"atteo": {"transport": "stdio", "command": "atteo", "args": ["mcp"], "enabled": true}}}`,
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
