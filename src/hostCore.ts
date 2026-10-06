// atteo host (docs/HOST.md): the rules both sides apply, pure so the Worker and the CLI share them exactly.

import { blockedMessage, redactText, scanText } from "./secrets";

/** What the owner types to attach a machine (vedu #4815). A curly apostrophe (phones) counts as the straight one. */
export const HOST_PHRASE = "I understand what I'm doing";
export const phraseOk = (s: unknown): boolean => typeof s === "string" && s.replace(/[‘’]/g, "'") === HOST_PHRASE;

/** The id `atteo host` makes for one start of one machine; a consent code is bound to it. */
export const MACHINE_RE = /^m_[A-Za-z0-9_-]{12,40}$/;
/** Consent codes: 10 characters without look-alikes (0/O, 1/I/L), shown as XXXXX-XXXXX; case and dashes don't matter. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function newConsentCode(rand: Uint8Array): string {
  const c = Array.from(rand.slice(0, 10), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
  return `${c.slice(0, 5)}-${c.slice(5)}`;
}
export const normCode = (s: unknown): string => (typeof s === "string" ? s.toUpperCase().replace(/[^A-Z0-9]/g, "") : "");

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
  if (typeof p !== "string" || !p.startsWith("/") || CONTROL_RE.test(p)) return null; // no escapes in a path (#4919)
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

/** Why a command can't be sent, or null: empty, too long, a NUL or other control character, characters that make it
 * display differently from how it runs (bidi, zero-width: #4929), or a credential in it. */
export function commandProblem(cmd: unknown): string | null {
  if (typeof cmd !== "string" || !cmd.trim()) return "Say what to run (command).";
  if (cmd.length > MAX_COMMAND) return `The command is over ${MAX_COMMAND} characters.`;
  if (cmd.includes("\0")) return "The command contains a NUL byte.";
  if (INVISIBLE_RE.test(cmd)) return "The command contains invisible or direction-changing characters (bidi controls, zero-width): what you'd see isn't what would run. Type it plainly.";
  if (/[\x01-\x08\x0b-\x1f\x7f-\x9f]/.test(cmd)) return "The command contains control characters (only tabs and new lines are allowed).";
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

/** Characters a path never has: C0 controls, DEL and C1 controls (terminal escapes start with them, #4919). */
export const CONTROL_RE = /[\x00-\x1f\x7f-\x9f]/;
/** Bidi controls and zero-width / invisible characters: they make text display differently from how it runs (#4929). */
export const INVISIBLE_RE = /[­؜᠎​-‏‪-‮⁠-⁤⁦-⁯﻿]/;

/** A run's id and a host's id from the server, checked before they go into a URL path (the host trusts nobody, #4920). */
export const RUN_ID_RE = /^hr_[A-Za-z0-9_-]{6,64}$/;
export const HOST_ID_RE = /^h_[A-Za-z0-9_-]{6,64}$/;

/** The only environment a command gets (an allowlist, #4918): a fixed PATH, the locale, the time zone, a dumb terminal,
 * and HOME / TMPDIR inside the sandbox's own temp folder. Nothing else from the owner's shell (tokens, *_URL, SSH_AUTH_SOCK…). */
export const SAFE_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
export function safeEnv(src: Record<string, string | undefined>, tmp: string): Record<string, string> {
  const env: Record<string, string> = { PATH: SAFE_PATH, TERM: "dumb", HOME: tmp, TMPDIR: tmp };
  for (const [k, v] of Object.entries(src)) if (v !== undefined && (k === "LANG" || k === "TZ" || /^LC_[A-Z]+$/.test(k))) env[k] = v;
  return env;
}

/** Text from the server made safe to print in the owner's terminal: control characters (escapes) shown as \xNN, bidi
 * and invisible characters as \u{…} (#4919). */
export function termSafe(s: unknown): string {
  return String(s ?? "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, (c) => "\\x" + c.charCodeAt(0).toString(16).padStart(2, "0"))
    .replace(new RegExp(INVISIBLE_RE.source, "g"), (c) => "\\u{" + c.codePointAt(0)!.toString(16) + "}");
}

/** Folders never shared, nor anything inside them (#4917). */
const SYSTEM_DIRS = ["/tmp", "/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/System", "/Library", "/var", "/private", "/dev", "/proc", "/sys", "/boot", "/opt", "/Applications", "/cores", "/root", "/run", "/snap"];

/** Why a folder can't be shared, or null. Both sides check: the CLI on realpaths with its HOME, the server without it.
 * Never /, a system folder, a hidden folder or anything in one (.ssh, .config), the folder holding people's homes, a
 * home folder itself, or any folder that contains the owner's home (#4917). */
export function shareProblem(p: unknown, home: string | null = null): string | null {
  const n = normPath(p);
  if (!n) return "Share an absolute path (with no control characters).";
  if (n === "/") return "Sharing / (the whole machine) isn't allowed. Share a project folder.";
  if (n.split("/").some((part) => part.startsWith("."))) return `Sharing ${n} isn't allowed: hidden folders (.ssh, .config, …) hold keys and logins.`;
  if (SYSTEM_DIRS.some((d) => n === d || n.startsWith(d + "/"))) return `Sharing ${n} isn't allowed: it's a system folder.`;
  if (/^\/(home|Users)(\/[^/]+)?$/.test(n)) return `Sharing ${n} isn't allowed: it's a home folder (or the folder holding them). Share a project folder.`;
  const h = home ? normPath(home) : null;
  if (h && (n === h || h.startsWith(n + "/"))) return `Sharing ${n} isn't allowed: it is (or contains) your home folder, where keys and logins live. Share a project folder.`;
  return null;
}

/** A working folder the requester names: plain path characters only, so it can't read as markdown or someone's words (#5003). */
export const CWD_RE = /^[\w./ -]{1,1024}$/;
/** A path or name shown in a board line or approval title, as a code span (no backtick can end it early). */
export const codeSpan = (s: string): string => "`" + s.replace(/`/g, "ʼ") + "`";

/** What a consent code covers (#4917): the shares, the allowlist and network or not (jxn #4945), as the person saw them. */
export const consentScope = (shares: unknown, allow: unknown, network: unknown = false): string =>
  JSON.stringify({ s: (Array.isArray(shares) ? shares : []).map((x) => normPath(x) ?? String(x)), a: (Array.isArray(allow) ? allow : []).map((x) => String(x)), n: network === true });
