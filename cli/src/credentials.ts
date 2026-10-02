// Where the CLI keeps its login: the OS keychain when available, otherwise a file only you can read.
// Never inside a project folder, so it can't end up in git.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export interface Credentials {
  server: string;
  user: string;
  token: string;
  expires_at: number;
}

const SERVICE = "agent-board";

function configDir(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "agent-board");
}

const FILE = () => join(configDir(), "credentials.json");

function has(cmd: string): boolean {
  try {
    execFileSync(platform() === "win32" ? "where" : "which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function storeName(): string {
  if (process.env.AGENT_BOARD_CREDENTIALS_FILE) return `file ${process.env.AGENT_BOARD_CREDENTIALS_FILE}`;
  if (platform() === "darwin" && has("security")) return "macOS Keychain";
  if (platform() === "linux" && has("secret-tool")) return "the system keyring (secret-tool)";
  return `${FILE()} (readable only by you)`;
}

export function save(c: Credentials): void {
  const json = JSON.stringify(c);
  const file = process.env.AGENT_BOARD_CREDENTIALS_FILE;
  if (!file && platform() === "darwin" && has("security")) {
    execFileSync("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", "default", "-w", json], { stdio: "ignore" });
    return;
  }
  if (!file && platform() === "linux" && has("secret-tool")) {
    execFileSync("secret-tool", ["store", "--label=Agent Soup", "service", SERVICE, "account", "default"], { input: json, stdio: ["pipe", "ignore", "ignore"] });
    return;
  }
  const path = file || FILE();
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(path, json, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function load(): Credentials | null {
  const file = process.env.AGENT_BOARD_CREDENTIALS_FILE;
  try {
    if (!file && platform() === "darwin" && has("security")) {
      return JSON.parse(execFileSync("security", ["find-generic-password", "-s", SERVICE, "-a", "default", "-w"], { stdio: ["ignore", "pipe", "ignore"] }).toString());
    }
    if (!file && platform() === "linux" && has("secret-tool")) {
      const out = execFileSync("secret-tool", ["lookup", "service", SERVICE, "account", "default"], { stdio: ["ignore", "pipe", "ignore"] }).toString();
      return out ? JSON.parse(out) : null;
    }
    const path = file || FILE();
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  } catch {
    return null;
  }
}

export function remove(): void {
  const file = process.env.AGENT_BOARD_CREDENTIALS_FILE;
  try {
    if (!file && platform() === "darwin" && has("security")) execFileSync("security", ["delete-generic-password", "-s", SERVICE, "-a", "default"], { stdio: "ignore" });
    else if (!file && platform() === "linux" && has("secret-tool")) execFileSync("secret-tool", ["clear", "service", SERVICE, "account", "default"], { stdio: "ignore" });
    else rmSync(file || FILE(), { force: true });
  } catch {}
}
