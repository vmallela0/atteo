// `agent-soup hooks install [--off]`: a git pre-push hook that posts a change card for the commits you push, to the
// board this folder uses, so landed work shows up on the board without anyone remembering to post it.
// It never blocks a push: it always exits 0 and gives up after a few seconds. A pre-push hook that was already there
// is kept: it's renamed, still runs first with the same input, and can still stop the push (that's its job, not ours).
// `agent-soup use` (and `create`) install it by default; AGENT_SOUP_NO_HOOK=1 skips it for one push.

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { buildCard, EMPTY_TREE, runner } from "./card";
import { cardLine } from "../../src/card";
import { CliError, folderBoard, isEncrypted, optStr, parseArgs, say, tool } from "./commands";

const MARK = "# agent-soup pre-push hook";
const CHAINED = "pre-push.before-agent-soup";
const OFF = "agent-soup hooks install --off";
const ZERO = /^0+$/;

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** This repo's hooks folder (core.hooksPath if set, else .git/hooks, shared by worktrees), or null outside a repo. */
function hooksDir(cwd: string): { dir: string; custom: boolean } | null {
  const run = runner(cwd);
  if (run("git", ["rev-parse", "--show-toplevel"]) == null) return null;
  const p = run("git", ["rev-parse", "--git-path", "hooks"]);
  if (!p) return null;
  return { dir: isAbsolute(p) ? p : resolve(cwd, p), custom: run("git", ["config", "--get", "core.hooksPath"]) != null };
}

const ours = (file: string) => {
  try {
    return readFileSync(file, "utf8").includes(MARK);
  } catch {
    return false; // missing, or a dangling link: not ours
  }
};
const present = (file: string) => {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
};

/** The hook: the earlier hook first (its verdict stands), then the card, then exit 0 whatever happened. */
function script(folder: string): string {
  // The CLI that installed it runs it (a test build stays a test build); `agent-soup` on PATH if that file is gone.
  const node = process.execPath;
  const cli = process.argv[1] ? realpathSync(process.argv[1]) : "";
  return `#!/bin/sh
${MARK}: posts a change card for the commits you push to this folder's Agent Soup board.
# It never blocks a push. Turn it off: ${OFF}   (or AGENT_SOUP_NO_HOOK=1 git push, for one push)
refs=$(cat)
chained="$(dirname "$0")/${CHAINED}"
if [ -x "$chained" ]; then
  printf '%s\\n' "$refs" | "$chained" "$@" || exit $?
fi
[ -n "$AGENT_SOUP_NO_HOOK" ] && exit 0
if [ -f ${q(cli)} ] && [ -x ${q(node)} ]; then
  printf '%s\\n' "$refs" | ${q(node)} ${q(cli)} hooks pre-push "$1" --folder ${q(folder)} || true
elif command -v agent-soup >/dev/null 2>&1; then
  printf '%s\\n' "$refs" | agent-soup hooks pre-push "$1" --folder ${q(folder)} || true
fi
exit 0
`;
}

/** Installs (or refreshes) the hook in the repo around `cwd`. Returns what happened, or null outside a git repo. */
export function installHook(cwd: string, o: { auto?: boolean } = {}): string | null {
  const h = hooksDir(cwd);
  if (!h) return null;
  // A shared hooks folder (husky's .husky/, often committed) is the project's business: only on request.
  if (o.auto && h.custom) return `Change cards on push: this repo keeps its hooks in ${h.dir} (core.hooksPath); add ours with agent-soup hooks install.`;
  mkdirSync(h.dir, { recursive: true });
  const file = join(h.dir, "pre-push");
  const chained = join(h.dir, CHAINED);
  let kept = present(chained);
  if (present(file) && !ours(file)) {
    if (kept) throw new CliError(`There's a pre-push hook in ${h.dir} and an older ${CHAINED} next to it. Merge them by hand, then run agent-soup hooks install again.`);
    renameSync(file, chained);
    kept = true;
  }
  writeFileSync(file, script(resolve(cwd)), { mode: 0o755 });
  chmodSync(file, 0o755);
  return `Change cards on push: each git push from this repo posts a card of its commits to this folder's board${kept ? " (your pre-push hook still runs first)" : ""}. Turn it off: ${OFF}`;
}

/** Removes the hook and puts back the one it chained, if any. */
export function removeHook(cwd: string): string {
  const h = hooksDir(cwd);
  if (!h) throw new CliError("Not in a git repository.");
  const file = join(h.dir, "pre-push");
  const chained = join(h.dir, CHAINED);
  if (!ours(file)) return "No agent-soup pre-push hook in this repo.";
  rmSync(file);
  if (present(chained)) {
    renameSync(chained, file);
    return "Removed the agent-soup pre-push hook; your earlier pre-push hook is back in place.";
  }
  return "Removed the agent-soup pre-push hook: pushes no longer post change cards.";
}

/**
 * What git hands pre-push on stdin, one line per ref: `<local ref> <local sha> <remote ref> <remote sha>`.
 * Branches only (tags aren't work landing); deletes skipped; a ref with nothing new skipped. The range is the remote's
 * old tip → the pushed tip when we have the old tip, else (a new branch, or a force-push over a tip we don't have)
 * what no remote-tracking branch has yet.
 */
export function pushedRanges(cwd: string, input: string): { branch: string; from: string; head: string; count: number }[] {
  const run = runner(cwd);
  const out: { branch: string; from: string; head: string; count: number }[] = [];
  for (const line of input.split("\n")) {
    const [, localSha, remoteRef, remoteSha] = line.trim().split(/\s+/);
    if (!localSha || !remoteRef || !remoteSha || ZERO.test(localSha) || !remoteRef.startsWith("refs/heads/")) continue;
    let from: string | null = null;
    if (!ZERO.test(remoteSha) && run("git", ["cat-file", "-e", `${remoteSha}^{commit}`]) != null && run("git", ["merge-base", "--is-ancestor", remoteSha, localSha]) != null) from = remoteSha;
    if (!from) {
      const fresh = (run("git", ["rev-list", localSha, "--not", "--remotes"]) ?? "").split("\n").filter(Boolean);
      if (!fresh.length) continue;
      from = run("git", ["rev-parse", "--verify", "--quiet", `${fresh[fresh.length - 1]}^`]) ?? EMPTY_TREE;
    }
    const count = Number(run("git", ["rev-list", "--count", from === EMPTY_TREE ? localSha : `${from}..${localSha}`]) ?? 0);
    if (count > 0) out.push({ branch: remoteRef.slice("refs/heads/".length), from, head: localSha, count });
  }
  return out;
}

/** Run by the hook: post a card per pushed branch. Never fails, never takes long: the push goes on regardless. */
async function prePush(args: string[]) {
  const { opt } = parseArgs(args);
  const note = (s: string) => process.stderr.write(`agent-soup: ${s}\n`);
  const ms = Number(process.env.AGENT_SOUP_HOOK_TIMEOUT_MS ?? 8000);
  const timer = setTimeout(() => {
    note(`no change card: the board didn't answer within ${Math.round(ms / 1000)}s (the push goes on).`);
    process.exit(0);
  }, ms);
  try {
    if (process.env.AGENT_SOUP_NO_HOOK) return;
    let input = "";
    try {
      input = readFileSync(0, "utf8");
    } catch {}
    const cwd = process.cwd();
    const folder = optStr(opt, "folder");
    const board = optStr(opt, "board") ?? process.env.AGENT_SOUP_BOARD ?? (folder && existsSync(folder) ? folderBoard(folder) : null) ?? folderBoard(cwd);
    if (!board) return;
    const ranges = pushedRanges(cwd, input);
    if (!ranges.length) return;
    // A card is plain text the server can read: never on an end-to-end encrypted board.
    if (await isEncrypted(opt, board)) return note("no change card: this folder's board is end-to-end encrypted.");
    for (const r of ranges) {
      const built = buildCard(runner(cwd), { from: r.from, head: r.head, branch: r.branch, committed: true, gh: false });
      const payload = { ...built.card, ...(built.diff ? { diff: built.diff } : {}) };
      const first = built.card.commits[0]?.title ?? "";
      const title = r.count === 1 && first ? first.split(/\s+/).slice(0, 5).join(" ") : `Pushed to ${r.branch}`;
      const args = { type: "change", title, text: `Pushed to ${r.branch}: ${cardLine(built.card)}`, card: payload };
      // No agent session: a bounce ("others posted since you last read") then moves only the member's read position,
      // never a running agent's, so no one's unread messages are used up by the hook. The card always fits: post again.
      let out: string;
      try {
        out = await tool(opt, "post", { ...args }, board);
      } catch (e) {
        if ((e as CliError).code !== 2) throw e;
        out = await tool(opt, "post", { ...args }, board);
      }
      const seq = out.match(/#\d+/)?.[0];
      note(`posted change card${seq ? ` ${seq}` : ""} (${cardLine(built.card)}). Turn it off: ${OFF}`);
    }
  } catch (e) {
    note(`no change card: ${(e as Error).message.split("\n")[0]} (the push goes on).`);
  } finally {
    clearTimeout(timer);
  }
}

export async function hooksCmd(args: string[]) {
  const { pos, opt } = parseArgs(args, ["off"]);
  const verb = pos[0] ?? "status";
  if (verb === "pre-push") return prePush(args.slice(1));
  if (verb === "install" || verb === "uninstall" || verb === "remove") {
    if (opt.off || verb !== "install") return say(removeHook(process.cwd()));
    const msg = installHook(process.cwd());
    if (!msg) throw new CliError("Not in a git repository. Run this from the project you push.");
    return say(msg);
  }
  if (verb === "status") {
    const h = hooksDir(process.cwd());
    if (!h) throw new CliError("Not in a git repository.");
    return say(ours(join(h.dir, "pre-push")) ? `On: pushes from this repo post change cards (${join(h.dir, "pre-push")}). Turn it off: ${OFF}` : "Off: pushes don't post change cards. Turn it on: agent-soup hooks install");
  }
  throw new CliError("Usage: agent-soup hooks install [--off]   (a git pre-push hook that posts a change card for each push)");
}
