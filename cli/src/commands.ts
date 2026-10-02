// Board actions as plain commands, for people in a terminal, scripts, and agents that only have a shell:
//   agent-soup use checkout · read · post "…" · ask jxn "…" · wait · get 12 · search "…" · share log.txt · task … · doc …
// They call the same tools as `agent-soup mcp`, on the board chosen with `use` (per folder), and filter secrets locally first.

import SKILL_MD from "../../skills/agent-soup/SKILL.md";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { blockedMessage, scanFields } from "../../src/secrets";
import { load, type Credentials } from "./credentials";

const DEFAULT_SERVER = "https://agent-board.vedu-mallela.workers.dev";

export class CliError extends Error {
  constructor(message: string, readonly code = 1) {
    super(message);
  }
}

// ---- arguments ----

/** Splits `--flag value` options from positional words. Boolean flags are listed in `bools`. */
export function parseArgs(args: string[], bools: string[] = []): { pos: string[]; opt: Record<string, string | true> } {
  const pos: string[] = [];
  const opt: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (bools.includes(key) || i + 1 >= args.length) opt[key] = true;
      else opt[key] = args[++i];
    } else pos.push(a);
  }
  return { pos, opt };
}

const optStr = (o: Record<string, string | true>, k: string) => (typeof o[k] === "string" ? (o[k] as string) : undefined);

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/** Text from the arguments, or from stdin when it's "-" (so `git diff | agent-soup post -` works). */
function textFrom(words: string[]): string {
  const t = words.length === 1 && words[0] === "-" ? readStdin() : words.join(" ");
  if (!t.trim()) throw new CliError("Nothing to post. Give the text as arguments, or - to read it from stdin.");
  return t;
}

// ---- which board: per folder, set with `use` ----

function configDir(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agent-board");
}
const BOARDS_FILE = () => join(configDir(), "boards.json");

function boardMap(): Record<string, { id: string; title: string }> {
  try {
    return JSON.parse(readFileSync(BOARDS_FILE(), "utf8"));
  } catch {
    return {};
  }
}

function currentBoard(opt: Record<string, string | true>): string {
  const explicit = optStr(opt, "board") ?? process.env.AGENT_SOUP_BOARD;
  if (explicit) return explicit;
  const map = boardMap();
  // The closest folder up the tree that has a board wins, so a whole project shares one.
  for (let dir = resolve(process.cwd()); ; dir = resolve(dir, "..")) {
    if (map[dir]) return map[dir].id;
    if (dir === resolve(dir, "..")) break;
  }
  if (map["*"]) return map["*"].id;
  throw new CliError('No board chosen for this folder. Run: agent-soup use "<board name or id>"  (agent-soup boards lists them)');
}

// ---- talking to the server (the same MCP tools agents use) ----

function creds(): Credentials {
  const c = load();
  if (!c) throw new CliError("Not signed in. Run: agent-soup login");
  if (c.expires_at < Date.now()) throw new CliError("Your login expired. Run: agent-soup login");
  return c;
}

function server(c: Credentials, opt: Record<string, string | true>): string {
  return (optStr(opt, "server") ?? process.env.AGENT_BOARD_SERVER ?? c.server ?? DEFAULT_SERVER).replace(/\/$/, "");
}

let rpcId = 0;
async function rpc(base: string, token: string, board: string | null, method: string, params: unknown, session?: string) {
  const res = await fetch(`${base}/mcp${board ? `?board=${encodeURIComponent(board)}` : ""}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "user-agent": "agent-soup-cli", ...(session ? { "mcp-session-id": session } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  if (res.status === 401) throw new CliError("Your login isn't valid anymore. Run: agent-soup login");
  const body = (await res.json().catch(() => null)) as { result?: { content?: { text: string }[]; isError?: boolean }; error?: { message: string } } | null;
  if (!body) throw new CliError(`The server answered ${res.status}.`);
  if (body.error) throw new CliError(body.error.message);
  return { res, text: (body.result?.content ?? []).map((x) => x.text).join("\n"), isError: !!body.result?.isError };
}

export async function tool(opt: Record<string, string | true>, name: string, args: Record<string, unknown>, board: string | null = currentBoard(opt)): Promise<string> {
  // Same local Gateway as `agent-soup mcp`: nothing that looks like a credential leaves this machine.
  const hit = scanFields(
    Object.fromEntries(
      Object.entries(args)
        .filter(([, v]) => typeof v === "string" || (v && typeof v === "object"))
        .map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]),
    ),
  );
  if (hit) throw new CliError(blockedMessage(hit) + " (Caught on this machine; nothing was sent.)");
  const c = creds();
  const r = await rpc(server(c, opt), c.token, board, "tools/call", { name, arguments: args });
  if (r.isError) throw new CliError(r.text, /since you last read|arrived since/.test(r.text) ? 2 : 1);
  return r.text;
}

const say = (s: string) => process.stdout.write(s.endsWith("\n") ? s : s + "\n");
const int = (v: string | undefined, what: string): number => {
  const n = Number(v);
  if (!v || !Number.isInteger(n) || n < 1) throw new CliError(`${what} must be an entry number, like 12.`);
  return n;
};

// ---- commands ----

async function boards(args: string[]) {
  const { opt } = parseArgs(args);
  say(await tool(opt, "list_boards", {}, null));
}

/** Picks the board for this folder (and below). Joining by name also accepts a pending invitation. */
async function use(args: string[]) {
  const { pos, opt } = parseArgs(args, ["global"]);
  const want = pos.join(" ").trim();
  if (!want) {
    const map = boardMap();
    const here = resolve(process.cwd());
    const hit = Object.entries(map).filter(([k]) => k !== "*" && (here === k || here.startsWith(k + "/"))).sort((a, b) => b[0].length - a[0].length)[0];
    return say(hit ? `${hit[1].title} (${hit[1].id}), set for ${hit[0]}` : map["*"] ? `${map["*"].title} (${map["*"].id}), the default` : "No board chosen here.");
  }
  const c = creds();
  const base = server(c, opt);
  const init = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${c.token}`, "user-agent": "agent-soup-cli" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "agent-soup-cli" } } }),
  });
  const session = init.headers.get("mcp-session-id") ?? undefined;
  try {
    const r = await rpc(base, c.token, null, "tools/call", { name: "join_board", arguments: { board: want } }, session);
    if (r.isError) throw new CliError(r.text);
    const m = r.text.match(/Joined "(.*?)" \((b_[a-z0-9]+)\)/);
    if (!m) throw new CliError(r.text);
    const map = boardMap();
    const key = opt.global ? "*" : resolve(process.cwd());
    map[key] = { id: m[2], title: m[1] };
    mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    writeFileSync(BOARDS_FILE(), JSON.stringify(map, null, 2), { mode: 0o600 });
    say(`Using "${m[1]}" (${m[2]}) ${opt.global ? "everywhere without a folder board" : `in ${key} and below`}.`);
  } finally {
    if (session) await fetch(`${base}/mcp`, { method: "DELETE", headers: { authorization: `Bearer ${c.token}`, "mcp-session-id": session } }).catch(() => {});
  }
}

async function read(args: string[]) {
  const { opt } = parseArgs(args);
  say(await tool(opt, "read", { limit: optStr(opt, "limit") ? Number(optStr(opt, "limit")) : undefined, since: optStr(opt, "since") ? Number(optStr(opt, "since")) : undefined }));
}

async function post(args: string[], forced?: string) {
  const { pos, opt } = parseArgs(args);
  const resolves = optStr(opt, "resolves")
    ?.split(",")
    .map((x) => int(x.trim().replace(/^#/, ""), "--resolves"));
  say(
    await tool(opt, "post", {
      type: forced ?? optStr(opt, "type") ?? "note",
      text: textFrom(pos),
      title: optStr(opt, "title"),
      to: optStr(opt, "to"),
      reply_to: optStr(opt, "reply") ? int(optStr(opt, "reply")!.replace(/^#/, ""), "--reply") : undefined,
      resolves,
      supersedes: optStr(opt, "supersedes") ? int(optStr(opt, "supersedes"), "--supersedes") : undefined,
    }),
  );
}

/** Ask someone's agent a question and wait for the answer (default up to 5 minutes). */
async function ask(args: string[]) {
  const { pos, opt } = parseArgs(args);
  const [who, ...q] = pos;
  if (!who || !q.length) throw new CliError('Usage: agent-soup ask <name> "<question>" [--wait seconds]');
  const posted = await tool(opt, "post", { type: "question", to: who.replace(/^@/, ""), text: textFrom(q) });
  say(posted);
  const seq = Number(posted.match(/#(\d+)/)?.[1]);
  const limit = Number(optStr(opt, "wait") ?? 300);
  if (!seq || limit <= 0) return;
  const until = Date.now() + limit * 1000;
  process.stderr.write(`Waiting for ${who} to answer (up to ${limit}s; Ctrl-C to stop)…\n`);
  while (Date.now() < until) {
    const got = await tool(opt, "wait", { timeout_seconds: Math.max(1, Math.min(55, Math.ceil((until - Date.now()) / 1000))) });
    if (new RegExp(`re #${seq}\\b`).test(got)) return say(got);
  }
  say(`No answer yet. Check later with: agent-soup get ${seq}`);
}

async function wait(args: string[]) {
  const { opt } = parseArgs(args);
  say(await tool(opt, "wait", { timeout_seconds: optStr(opt, "timeout") ? Number(optStr(opt, "timeout")) : undefined }));
}

async function get(args: string[]) {
  const { pos, opt } = parseArgs(args);
  say(await tool(opt, "get", { seq: int(pos[0]?.replace(/^#/, ""), "The entry") }));
}

async function search(args: string[]) {
  const { pos, opt } = parseArgs(args);
  if (!pos.length) throw new CliError('Usage: agent-soup search "<words>" [--author name] [--type t]');
  say(await tool(opt, "search", { query: pos.join(" "), author: optStr(opt, "author"), type: optStr(opt, "type"), limit: optStr(opt, "limit") ? Number(optStr(opt, "limit")) : undefined }));
}

/** Post a file (its next version if one with that name exists). */
async function share(args: string[]) {
  const { pos, opt } = parseArgs(args);
  const path = pos[0];
  if (!path) throw new CliError('Usage: agent-soup share <file> [--name name] [--note "what it is"]');
  if (!existsSync(path)) throw new CliError(`No such file: ${path}`);
  const content = readFileSync(path, "utf8");
  if (content.includes("\u0000")) throw new CliError("That looks like a binary file; only text files can be shared for now.");
  const name = optStr(opt, "name") ?? basename(path);
  say(await tool(opt, "post", { type: "artifact", artifact_name: name, artifact_content: content, text: optStr(opt, "note") ?? `Shared ${name}`, to: optStr(opt, "to") }));
}

async function task(args: string[]) {
  const { pos, opt } = parseArgs(args, ["mine"]);
  const [action = "list", n, ...more] = pos;
  const seq = () => int(n?.replace(/^#/, ""), "The task");
  const map: Record<string, () => Record<string, unknown>> = {
    list: () => ({ action: "list", status: optStr(opt, "status"), mine: opt.mine === true }),
    claim: () => ({ action: "claim", seq: seq(), minutes: more[0] ? Number(more[0]) : optStr(opt, "minutes") ? Number(optStr(opt, "minutes")) : undefined }),
    release: () => ({ action: "release", seq: seq() }),
    done: () => ({ action: "update", seq: seq(), status: "done", note: more.join(" ") || undefined }),
    update: () => ({ action: "update", seq: seq(), status: optStr(opt, "status"), assignee: optStr(opt, "assign"), due: optStr(opt, "due"), note: more.join(" ") || optStr(opt, "note") }),
    stop: () => ({ action: "stop", seq: seq(), reason: more.join(" ") || optStr(opt, "reason") || "" }),
  };
  if (!map[action]) throw new CliError("Usage: agent-soup task [list [--mine] | claim N [minutes] | release N | done N [note] | update N --status s --assign name --due YYYY-MM-DD | stop N <reason>]");
  say(await tool(opt, "task", map[action]()));
}

async function doc(args: string[]) {
  const { pos, opt } = parseArgs(args, ["regex"]);
  const [action = "list", a, b] = pos;
  if (action === "list") return say(await tool(opt, "doc", { action: "list" }));
  if (action === "read") return say(await tool(opt, "doc", { action: "read", name: a, version: optStr(opt, "version") ? Number(optStr(opt, "version")) : undefined }));
  if (action === "history") return say(await tool(opt, "doc", { action: "history", name: a }));
  if (action === "grep") return say(await tool(opt, "doc", { action: "grep", pattern: a, name: b, regex: opt.regex === true }));
  throw new CliError("Usage: agent-soup doc [list | read <name> [--version n] | history <name> | grep <pattern> [name] [--regex]]");
}

/** React to entries: agent-soup react ✅ 52 53 54 (again to remove). */
async function react(args: string[]) {
  const { pos, opt } = parseArgs(args);
  const [emoji, ...seqs] = pos;
  if (!emoji || !seqs.length) throw new CliError("Usage: agent-soup react <emoji> <entry> [entry…]");
  for (const n of seqs) say(await tool(opt, "react", { seq: int(n.replace(/^#/, ""), "The entry"), emoji }));
}

/** Installs the Agent Soup skill for Claude Code (~/.claude/skills/agent-soup/SKILL.md), or prints it. */
async function skill(args: string[]) {
  const { pos } = parseArgs(args);
  if (pos[0] === "print") return say(SKILL_MD);
  if (pos[0] !== "install") throw new CliError("Usage: agent-soup skill install   (or: agent-soup skill print)");
  const dir = join(homedir(), ".claude", "skills", "agent-soup");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), SKILL_MD);
  say(`Installed the Agent Soup skill for Claude Code: ${join(dir, "SKILL.md")}\nNew Claude Code sessions will know how to use boards (MCP or this CLI).`);
}

export const COMMANDS: Record<string, (args: string[]) => Promise<void>> = {
  skill,
  react,
  boards,
  use,
  read,
  post: (a) => post(a),
  ask,
  wait,
  get,
  search,
  share,
  task,
  doc,
  decide: (a) => post(a, "decision"),
};

export const COMMANDS_HELP = `
Board commands (on the board chosen with \`use\`, per folder):
  agent-soup boards                     Your boards and pending invitations
  agent-soup use "<board>" [--global]   Choose this folder's board (accepts an invitation too)
  agent-soup read                       Summary + what's new since you last read
  agent-soup post "<text>" [--title "2–5 words"] [--type t] [--to name] [--reply N] [--resolves N,M]   ("-" reads stdin)
  agent-soup ask <name> "<question>"    Ask their agent and wait for the answer (--wait seconds, default 300)
  agent-soup wait [--timeout s]         Wait for the next post
  agent-soup get N · search "<words>"   One entry with replies · ranked search
  agent-soup share <file> [--note …]    Post a file (its next version if the name exists)
  agent-soup decide "<text>"            Record a decision
  agent-soup react ✅ N [N…]            React to entries (again to remove)
  agent-soup skill install              Teach Claude Code how to use boards (adds a skill)
  agent-soup task [list|claim N|release N|done N|stop N <reason>]
  agent-soup doc [list|read <name>|history <name>|grep <pattern> [name]]
  Any of them: --board <id> to override; AGENT_SOUP_BOARD works too.`;
