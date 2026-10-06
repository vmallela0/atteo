// atteo host (docs/HOST.md): the rules both sides apply, pure so the Worker and the CLI share them exactly.

import { blockedMessage, redactText, scanText } from "./secrets";

/** What the owner types to attach a machine (vedu #4815). A curly apostrophe (phones) counts as the straight one. */
export const HOST_PHRASE = "I understand what I'm doing";
export const phraseOk = (s: unknown): boolean => typeof s === "string" && s.replace(/[‘’]/g, "'") === HOST_PHRASE;

export const MAX_COMMAND = 4000;
export const MAX_OUTPUT = 64_000; // stored per run
export const BOARD_OUTPUT = 4_000; // shown in the board's audit entry
export const DEFAULT_TIMEOUT_S = 60;
export const MAX_TIMEOUT_S = 600;
export const MAX_SHARES = 10;
export const MAX_ALLOW = 20;
export const MAX_WAITING = 10; // runs waiting (for approval or the host) per host
export const ONLINE_MS = 60_000; // a host that polled within this is online
export const CONFIRM_TTL_MS = 10 * 60_000;

/** A clean absolute POSIX path: `.` and `..` resolved lexically, no trailing slash. null when it isn't absolute. */
export function normPath(p: unknown): string | null {
  if (typeof p !== "string" || !p.startsWith("/") || p.includes("\0")) return null;
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return "/" + out.join("/");
}

/** Whether `dir` is one of `shares` or inside one (both normalized first). The host repeats this on realpaths. */
export function insideShares(dir: unknown, shares: string[]): boolean {
  const d = normPath(dir);
  if (!d) return false;
  return shares.some((s) => {
    const n = normPath(s);
    return !!n && n !== "/" && (d === n || d.startsWith(n + "/"));
  });
}

/** Why a command can't be sent, or null: empty, too long, a NUL, or a credential in it. */
export function commandProblem(cmd: unknown): string | null {
  if (typeof cmd !== "string" || !cmd.trim()) return "Say what to run (command).";
  if (cmd.length > MAX_COMMAND) return `The command is over ${MAX_COMMAND} characters.`;
  if (cmd.includes("\0")) return "The command contains a NUL byte.";
  const hit = scanText(cmd, "command");
  return hit ? blockedMessage(hit).replace("Nothing was posted.", "Nothing was run.") : null;
}

/** Output as stored: secrets cut out, then capped at `max` (the note says how much was dropped). */
export function cleanOutput(out: unknown, max = MAX_OUTPUT): { text: string; truncated: boolean } {
  const red = redactText(String(out ?? ""));
  if (red.length <= max) return { text: red, truncated: false };
  return { text: red.slice(0, max) + `\n… (${red.length - max} more characters not kept)`, truncated: true };
}

export const clampTimeout = (s: unknown): number => {
  const n = Math.trunc(Number(s));
  return Number.isFinite(n) && n > 0 ? Math.min(MAX_TIMEOUT_S, n) : DEFAULT_TIMEOUT_S;
};

/** Environment variable names a host drops before running a command (they usually hold credentials). */
export const SECRET_ENV = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|SESSION|COOKIE|^ATTEO_|^AGENT_SOUP_|^AWS_|^GH_|^GITHUB_|^NPM_|^OPENAI|^ANTHROPIC|^OPENROUTER/i;
