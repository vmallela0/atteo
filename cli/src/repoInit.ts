// The GitHub remote names a repo; .atteo.json names its board. Neither proves who may read it.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BOARD_RE = /^b_[a-z0-9]{8,32}$/;
const REPO_RE = /^[a-z0-9][a-z0-9_.-]{0,99}\/[a-z0-9][a-z0-9_.-]{0,99}$/;
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

export function githubRepo(remote: string): string | null {
  const m = remote.trim().match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (!m) return null;
  const repo = `${m[1]}/${m[2]}`.toLowerCase();
  return REPO_RE.test(repo) && !repo.endsWith(".git") ? repo : null;
}

export type RepoContext = { root: string; repo: string; board: string | null; file: string };

export function repoContext(from = process.cwd()): RepoContext | null {
  let root: string, remote: string;
  try {
    root = git(from, "rev-parse", "--show-toplevel");
    remote = git(root, "remote", "get-url", "origin");
  } catch { return null; }
  const repo = githubRepo(remote);
  if (!repo) return null;
  const file = join(root, ".atteo.json");
  if (!existsSync(file)) return { root, repo, board: null, file };
  let data: { board?: unknown; repo?: unknown };
  try { data = JSON.parse(readFileSync(file, "utf8")); }
  catch { throw new Error(".atteo.json is not valid JSON. Ask the board owner to check it."); }
  if (!BOARD_RE.test(String(data.board ?? "")) || data.repo !== repo || Object.keys(data).sort().join(",") !== "board,repo")
    throw new Error(".atteo.json must contain only this GitHub repo and a valid board id. Ask the board owner to check it.");
  return { root, repo, board: String(data.board), file };
}

/** Commit only .atteo.json: a person's other staged changes stay out of this commit. */
export function commitLink(ctx: RepoContext, board: string): "committed" | "already committed" {
  if (!BOARD_RE.test(board)) throw new Error("The server returned an invalid board id.");
  const wanted = JSON.stringify({ board, repo: ctx.repo }, null, 2) + "\n";
  if (!existsSync(ctx.file)) writeFileSync(ctx.file, wanted, { flag: "wx" });
  else if (readFileSync(ctx.file, "utf8") !== wanted) throw new Error(".atteo.json differs from the server link. Ask the board owner to check it.");
  if (!git(ctx.root, "status", "--porcelain", "--", ".atteo.json")) return "already committed";
  git(ctx.root, "add", "--", ".atteo.json");
  git(ctx.root, "commit", "--only", "-m", `Link Atteo board for ${ctx.repo}`, "--", ".atteo.json");
  return "committed";
}
