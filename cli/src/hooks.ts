// `atteo hooks install [--off]`: a git pre-push hook that posts a change card for the commits you push, to the
// board this folder uses, so landed work shows up on the board without anyone remembering to post it.
// It never blocks a push: it always exits 0 and gives up after a few seconds. A pre-push hook that was already there
// is kept: it's renamed, still runs first with the same input, and can still stop the push (that's its job, not ours).
// `atteo use` (and `create`) install it by default; ATTEO_NO_HOOK=1 skips it for one push. Cards carry the
// commits and the files changed; the diff itself (your code) only with `hooks install --diff`, since boards are shared.

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { env } from "./env";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { buildCard, EMPTY_TREE, runner } from "./card";
import { cardLine } from "../../src/card";
import { api, CliError, folderBoard, isEncrypted, optStr, parseArgs, say, tool } from "./commands";

const MARK = "# atteo pre-push hook";
// Hooks installed before the rename carry the old mark and keep the earlier hook under the old file name: both stay
// recognized (and the file name stays), so refreshing or removing an existing install never chains our own hook.
const OLD_MARK = "# agent-soup pre-push hook";
const CHAINED = "pre-push.before-agent-soup";
const OFF = "atteo hooks install --off";
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
    const s = readFileSync(file, "utf8");
    return s.includes(MARK) || s.includes(OLD_MARK);
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
function script(folder: string, diff: boolean): string {
  // The CLI that installed it runs it (a test build stays a test build); `atteo` on PATH if that file is gone.
  const node = process.execPath;
  const cli = process.argv[1] ? realpathSync(process.argv[1]) : "";
  return `#!/bin/sh
${MARK}: posts a change card for the commits you push to this folder's Atteo board.
# It never blocks a push. Turn it off: ${OFF}   (or ATTEO_NO_HOOK=1 git push, for one push)
refs=$(cat)
chained="$(dirname "$0")/${CHAINED}"
if [ -x "$chained" ]; then
  printf '%s\\n' "$refs" | "$chained" "$@" || exit $?
fi
[ -n "$ATTEO_NO_HOOK$AGENT_SOUP_NO_HOOK" ] && exit 0
if [ -f ${q(cli)} ] && [ -x ${q(node)} ]; then
  printf '%s\\n' "$refs" | ${q(node)} ${q(cli)} hooks pre-push "$1" --folder ${q(folder)}${diff ? " --diff" : ""} || true
elif command -v atteo >/dev/null 2>&1; then
  printf '%s\\n' "$refs" | atteo hooks pre-push "$1" --folder ${q(folder)}${diff ? " --diff" : ""} || true
elif command -v agent-soup >/dev/null 2>&1; then
  printf '%s\\n' "$refs" | agent-soup hooks pre-push "$1" --folder ${q(folder)}${diff ? " --diff" : ""} || true
fi
exit 0
`;
}

/** Installs (or refreshes) the hook in the repo around `cwd`. Returns what happened, or null outside a git repo. */
export function installHook(cwd: string, o: { auto?: boolean; diff?: boolean } = {}): string | null {
  const h = hooksDir(cwd);
  if (!h) return null;
  // A shared hooks folder (husky's .husky/, often committed) is the project's business: only on request.
  if (o.auto && h.custom) return `Change cards on push: this repo keeps its hooks in ${h.dir} (core.hooksPath); add ours with atteo hooks install.`;
  mkdirSync(h.dir, { recursive: true });
  const file = join(h.dir, "pre-push");
  const chained = join(h.dir, CHAINED);
  let kept = present(chained);
  if (present(file) && !ours(file)) {
    if (kept) throw new CliError(`There's a pre-push hook in ${h.dir} and an older ${CHAINED} next to it. Merge them by hand, then run atteo hooks install again.`);
    renameSync(file, chained);
    kept = true;
  }
  writeFileSync(file, script(resolve(cwd), !!o.diff), { mode: 0o755 });
  chmodSync(file, 0o755);
  return `Change cards on push: each git push from this repo posts a card of its commits and changed files to this folder's board${o.diff ? ", with the diff" : " (not the diff: add it with atteo hooks install --diff)"}${kept ? "; your pre-push hook still runs first" : ""}. Turn it off: ${OFF}`;
}

/** Removes the hook and puts back the one it chained, if any. */
export function removeHook(cwd: string): string {
  const h = hooksDir(cwd);
  if (!h) throw new CliError("Not in a git repository.");
  const file = join(h.dir, "pre-push");
  const chained = join(h.dir, CHAINED);
  if (!ours(file)) return "No atteo pre-push hook in this repo.";
  rmSync(file);
  if (present(chained)) {
    renameSync(chained, file);
    return "Removed the atteo pre-push hook; your earlier pre-push hook is back in place.";
  }
  return "Removed the atteo pre-push hook: pushes no longer post change cards.";
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
  const { opt } = parseArgs(args, ["diff"]);
  const note = (s: string) => process.stderr.write(`atteo: ${s}\n`);
  const ms = Number(env("HOOK_TIMEOUT_MS") ?? 8000);
  const timer = setTimeout(() => {
    note(`no change card: the board didn't answer within ${Math.round(ms / 1000)}s (the push goes on).`);
    process.exit(0);
  }, ms);
  try {
    if (env("NO_HOOK")) return;
    let input = "";
    try {
      input = readFileSync(0, "utf8");
    } catch {}
    const cwd = process.cwd();
    const folder = optStr(opt, "folder");
    const board = optStr(opt, "board") ?? env("BOARD") ?? (folder && existsSync(folder) ? folderBoard(folder) : null) ?? folderBoard(cwd);
    if (!board) return;
    const ranges = pushedRanges(cwd, input);
    if (!ranges.length) return;
    // A card is plain text the server can read: never on an end-to-end encrypted board.
    if (await isEncrypted(opt, board)) return note("no change card: this folder's board is end-to-end encrypted.");
    for (const r of ranges) {
      const built = buildCard(runner(cwd), { from: r.from, head: r.head, branch: r.branch, committed: true, gh: false, diff: opt.diff === true });
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

// ---- `atteo hooks install --approvals`: Claude Code's permission prompts become Atteo approvals (jxn #871) ----
// For agents nobody watches: instead of a terminal prompt no one sees, each tool permission request becomes an approval
// the person decides on the web or phone. Only that person can decide (an agent's token never can, the server makes
// sure); no decision in time is a deny. It changes this machine's Claude Code settings, so it's opt-in: only when run.
const APPROVE_CMD = "hooks approve";
const APPROVALS_OFF = "atteo hooks install --approvals --off";
const claudeSettings = () => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json");
type HookGroup = { matcher?: string; hooks?: { type?: string; command?: string; timeout?: number }[] };

function installApprovals(off: boolean): string {
  const f = claudeSettings();
  let s: { hooks?: Record<string, HookGroup[]> } & Record<string, unknown> = {};
  if (existsSync(f)) {
    try {
      s = JSON.parse(readFileSync(f, "utf8"));
    } catch {
      throw new CliError(`${f} isn't valid JSON, so it was left alone. Fix it, then run this again.`);
    }
  }
  const ours = (g: HookGroup) => (g.hooks ?? []).some((h) => String(h.command ?? "").includes(APPROVE_CMD));
  const kept = (s.hooks?.PermissionRequest ?? []).filter((g) => !ours(g));
  const hooks = { ...(s.hooks ?? {}) };
  if (off) {
    if (kept.length) hooks.PermissionRequest = kept;
    else delete hooks.PermissionRequest;
  } else {
    const cli = process.argv[1] ? realpathSync(process.argv[1]) : "atteo";
    hooks.PermissionRequest = [...kept, { matcher: "*", hooks: [{ type: "command", command: `${q(process.execPath)} ${q(cli)} ${APPROVE_CMD}`, timeout: 600 }] }];
  }
  s.hooks = hooks;
  if (!Object.keys(hooks).length) delete s.hooks;
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(s, null, 2) + "\n");
  return off
    ? `Off: Claude Code asks for permission in its terminal again (${f}).`
    : `On: Claude Code's permission prompts on this machine go to Atteo as approvals, for your person to decide on the web or phone; no decision in 9 minutes denies (${f}). Turn it off: ${APPROVALS_OFF}`;
}

/** The hook Claude Code runs (PermissionRequest): ask on Atteo, wait for the person, answer allow or deny. */
async function approveHook(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  let req: { tool_name?: string; tool_input?: Record<string, unknown>; cwd?: string } = {};
  try {
    req = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {}
  const name = String(req.tool_name ?? "a tool"), input = req.tool_input ?? {};
  const what = typeof input.command === "string" ? input.command : typeof input.file_path === "string" ? input.file_path : JSON.stringify(input);
  const title = `${name}: ${what.split("\n")[0].slice(0, 100)}`;
  const details = `Claude Code wants to use ${name}${req.cwd ? ` in ${req.cwd}` : ""}:\n\n${JSON.stringify(input, null, 2).slice(0, 4000)}`;
  const answer = (behavior: "allow" | "deny", message?: string) =>
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior, ...(message ? { message } : {}) } } }) + "\n");
  const waitS = Number(env("APPROVAL_WAIT_S")) || 540;
  const until = Date.now() + waitS * 1000;
  // Any error (not signed in, offline) exits non-zero: Claude Code then asks in its terminal as usual. So does a
  // request the server blocks (a secret in the command): it can't be shown on the board.
  const text = await tool({}, "request_approval", { title, details, tool: name, command: what.slice(0, 2000), risk: name === "Bash" ? "medium" : "low", expires_in: waitS + 30, wait_seconds: 0 }, null);
  const id = text.match(/ap_[A-Za-z0-9_-]+/)?.[0];
  if (!id || /^Blocked/i.test(text)) throw new CliError(`Atteo couldn't take this one (${text.split("\n")[0]}); asking in the terminal.`);
  for (;;) {
    const left = Math.round((until - Date.now()) / 1000);
    if (left <= 0) return answer("deny", "No decision on Atteo in time, so it's denied. Ask again if it's still needed.");
    const j = await api({}, "GET", `/api/approvals/${id}?wait=${Math.max(1, Math.min(25, left))}`);
    if (j.decision === "approved") return answer("allow");
    if (j.decision === "denied") return answer("deny", j.reason === "timed out" ? "No decision on Atteo in time, so it's denied. Ask again if it's still needed." : `Denied on Atteo${j.approval?.note ? `: "${j.approval.note}"` : ""}.`);
  }
}

export async function hooksCmd(args: string[]) {
  const { pos, opt } = parseArgs(args, ["off", "diff", "approvals"]);
  const verb = pos[0] ?? "status";
  if (verb === "pre-push") return prePush(args.slice(1));
  if (verb === "approve") return approveHook();
  if ((verb === "install" || verb === "uninstall" || verb === "remove") && opt.approvals) return say(installApprovals(opt.off === true || verb !== "install"));
  if (verb === "install" || verb === "uninstall" || verb === "remove") {
    if (opt.off || verb !== "install") return say(removeHook(process.cwd()));
    const msg = installHook(process.cwd(), { diff: opt.diff === true });
    if (!msg) throw new CliError("Not in a git repository. Run this from the project you push.");
    return say(msg);
  }
  if (verb === "status") {
    const h = hooksDir(process.cwd());
    if (!h) throw new CliError("Not in a git repository.");
    const f = join(h.dir, "pre-push");
    if (!ours(f)) return say("Off: pushes don't post change cards. Turn it on: atteo hooks install");
    const withDiff = readFileSync(f, "utf8").includes(" --diff");
    return say(`On: pushes from this repo post change cards (${withDiff ? "commits, files and the diff" : "commits and files, not the diff"}; ${f}). Turn it off: ${OFF}`);
  }
  throw new CliError("Usage: atteo hooks install [--diff | --off]   (a git pre-push hook that posts a change card for each push; --diff includes the code)\n       atteo hooks install --approvals [--off]   (Claude Code's permission prompts go to Atteo, for your person to decide on the web or phone)");
}
