// `atteo card`: a change card built from local git, so an agent shows its changes as a card instead of a paragraph.
//   atteo card                      print the card as JSON (pass it to the `post` tool as `card`, with type "change")
//   atteo card --post "Guard empty carts" [--to vedu]    post it to this folder's board (--to asks for a review)
// Branch, base, commits, files (+/−) and the diff come from git; the PR link and CI status from `gh` when it's installed.

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { cardLine, MAX_CARD_DIFF, parseCard, type ChangeCard } from "../../src/card";
import { blockedMessage, scanFields } from "../../src/secrets";
import { CliError, parseArgs, tool } from "./commands";

type Run = (cmd: string, args: string[]) => string | null;

/** Runs a command in `cwd`; null when it fails (not a repo, no such ref, no `gh`, …). */
export function runner(cwd: string): Run {
  return (cmd, args) => {
    try {
      return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024, timeout: 15_000 }).trimEnd();
    } catch {
      return null;
    }
  };
}

/** "owner/name" from a GitHub remote URL (ssh or https); otherwise the URL's last two path parts. */
export function repoName(url: string | null): string | null {
  const m = url?.trim().match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/);
  return m ? m[1] : null;
}

/** CI from `gh pr view --json statusCheckRollup`: any failure → failing, anything unfinished → pending, else passing. */
export function ciFrom(rollup: { status?: string; conclusion?: string; state?: string }[] | undefined): ChangeCard["ci"] {
  if (!rollup?.length) return "none";
  const bad = new Set(["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "ERROR", "STARTUP_FAILURE"]);
  if (rollup.some((c) => bad.has(c.conclusion ?? "") || bad.has(c.state ?? ""))) return "failing";
  if (rollup.some((c) => (c.status && c.status !== "COMPLETED") || c.state === "PENDING" || c.state === "EXPECTED")) return "pending";
  return "passing";
}

/** Untracked (not ignored) text files, with a "new file" diff each. Binary and very large files count as 0 lines. */
function untrackedFiles(run: Run, top: string): { path: string; lines: number; diff: string }[] {
  const paths = (run("git", ["ls-files", "--others", "--exclude-standard"]) ?? "").split("\n").filter(Boolean).slice(0, 200);
  return paths.map((path) => {
    let text: string | null = null;
    try {
      if (statSync(join(top, path)).size <= 512 * 1024) text = readFileSync(join(top, path), "utf8");
    } catch {}
    if (text == null || text.includes("\0")) return { path, lines: 0, diff: `diff --git a/${path} b/${path}\nnew file mode 100644\nBinary files /dev/null and b/${path} differ` };
    const lines = text.length ? text.replace(/\n$/, "").split("\n") : [];
    return { path, lines: lines.length, diff: `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => "+" + l).join("\n")}` };
  });
}

/** git's empty tree: what came before a repository's first commit. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export interface BuiltCard {
  card: ChangeCard;
  diff: string | null;
  notes: string[]; // what was left out and why
}

/**
 * Builds the card for this repo: commits on HEAD since it left `base`, and the files and diff from there to the
 * working tree (uncommitted changes included), or to HEAD with `committed`.
 */
export function buildCard(
  run: Run,
  o: { base?: string; pr?: string; ci?: string; committed?: boolean; diff?: boolean; gh?: boolean; commit?: string; from?: string; head?: string; branch?: string },
): BuiltCard {
  const top = run("git", ["rev-parse", "--show-toplevel"]);
  if (top == null) throw new CliError("Not in a git repository. Run this from the project you changed.");
  const notes: string[] = [];
  const head = run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = o.branch ?? (head && head !== "HEAD" ? head : (run("git", ["rev-parse", "--short", "HEAD"]) ?? "HEAD"));
  // A pushed range (`from` → `head`, from the pre-push hook): exactly those commits, committed changes only, no base
  // (the pushed tip isn't necessarily HEAD: git push origin other-branch).
  // One commit (`--commit <ref>`): that commit against its first parent. Otherwise: HEAD since it left the base.
  const range = o.from != null && o.head != null;
  const sha = o.commit ? run("git", ["rev-parse", "--verify", "--quiet", `${o.commit}^{commit}`]) : null;
  if (o.commit && !sha) throw new CliError(`Can't find commit "${o.commit}".`);
  const base = sha || range ? null : (o.base ?? run("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])?.replace(/^origin\//, "") ?? "main");
  const baseRef = base == null ? null : [`origin/${base}`, base].find((r) => run("git", ["rev-parse", "--verify", "--quiet", `${r}^{commit}`]) != null);
  if (base != null && !baseRef) throw new CliError(`Can't find the base branch "${base}". Pass it with --base.`);
  const from = range ? o.from! : sha ? (run("git", ["rev-parse", "--verify", "--quiet", `${sha}^`]) ?? EMPTY_TREE) : (run("git", ["merge-base", "HEAD", baseRef!]) ?? baseRef!);
  const to = range ? [o.head!] : sha ? [sha] : o.committed ? ["HEAD"] : [];
  const logRange = range ? (from === EMPTY_TREE ? [o.head!] : [`${from}..${o.head}`]) : sha ? ["-1", sha] : [`${from}..HEAD`];

  const commits = (run("git", ["log", "--format=%h%x09%s", "--max-count=100", ...logRange]) ?? "")
    .split("\n")
    .filter(Boolean)
    .map((l) => ({ sha: l.split("\t")[0], title: l.slice(l.indexOf("\t") + 1) }));
  const files = (run("git", ["diff", "--numstat", "-M", from, ...to]) ?? "")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [a, r, ...p] = l.split("\t");
      return { path: p.join("\t"), added: a === "-" ? 0 : Number(a), removed: r === "-" ? 0 : Number(r) }; // "-" is a binary file
    });

  // New files git doesn't track yet are part of "what I'm about to push" too.
  const untracked = o.committed || sha || range ? [] : untrackedFiles(run, top);
  files.push(...untracked.map((u) => ({ path: u.path, added: u.lines, removed: 0 })));

  let diff: string | null = null;
  if (o.diff !== false) {
    diff = [run("git", ["diff", "-M", from, ...to]) ?? "", ...untracked.map((u) => u.diff)].filter(Boolean).join("\n") || null;
    if (diff && diff.length > MAX_CARD_DIFF) {
      notes.push(`diff left out: ${Math.round(diff.length / 1024)} KB is over the ${MAX_CARD_DIFF / 1000} KB limit`);
      diff = null;
    }
    const hit = diff ? scanFields({ diff }) : null;
    if (hit) {
      notes.push(`diff left out: ${blockedMessage(hit)}`); // never print or send it
      diff = null;
    }
  }

  let pr = o.pr ?? null;
  let ci = o.ci ?? null;
  if (o.gh !== false && !sha && !range && (!pr || !ci)) {
    const view = run("gh", ["pr", "view", "--json", "url,statusCheckRollup"]);
    if (view) {
      try {
        const j = JSON.parse(view) as { url?: string; statusCheckRollup?: { status?: string; conclusion?: string; state?: string }[] };
        pr ??= j.url ?? null;
        ci ??= ciFrom(j.statusCheckRollup);
      } catch {}
    }
  }

  // Same checks the server runs, so what we print is what it accepts.
  // A commit as the base (ship.sh: --base <the sha it last shipped>) reads better short: "main → 6ae559c".
  const shownBase = base && /^[0-9a-f]{40}$/.test(base) ? base.slice(0, 7) : base;
  const parsed = parseCard({ repo: repoName(run("git", ["remote", "get-url", "origin"])), branch, base: shownBase, pr_url: pr, ci: ci ?? "none", commits, files });
  return { card: parsed.card, diff, notes };
}

export async function cardCommand(args: string[]) {
  const { pos, opt } = parseArgs(args, ["committed", "no-diff", "no-gh", "post", "json"]);
  if (opt.commit === true) opt.commit = "HEAD";
  const s = (k: string) => (typeof opt[k] === "string" ? (opt[k] as string) : undefined);
  const built = buildCard(runner(process.cwd()), { base: s("base"), pr: s("pr"), ci: s("ci"), committed: !!opt.committed, diff: !opt["no-diff"], gh: !opt["no-gh"], commit: s("commit") });
  for (const n of built.notes) process.stderr.write(`[atteo] ${n}\n`);
  const payload = { ...built.card, ...(built.diff ? { diff: built.diff } : {}) };
  const message = s("post") ?? (opt.post === true ? pos.join(" ") : undefined);
  if (opt.post === undefined) {
    process.stderr.write(`[atteo] ${cardLine(built.card)}\n`);
    process.stdout.write(JSON.stringify(payload, null, opt.json ? 0 : 2) + "\n");
    return;
  }
  const text = (message ?? "").trim() || cardLine(built.card);
  const title = s("title") ?? (s("commit") ? built.card.commits[0]?.title.split(/\s+/).slice(0, 5).join(" ") : undefined) ?? `${built.card.branch} → ${built.card.base ?? "main"}`;
  process.stdout.write((await tool(opt, "post", { type: "change", text, title, card: payload, to: s("to")?.replace(/^@/, "") })) + "\n");
}

export const CARD_HELP = `
  atteo card [--base main] [--pr url] [--ci passing|failing|pending] [--committed] [--no-diff] [--no-gh]
                         A change card from local git (branch, commits, files +/−, diff; PR and CI via gh), as JSON
  atteo card --commit [ref] --post "<one sentence>"   One commit (default HEAD) as a card on the board
  atteo card --post "<what changed>" [--title "2–5 words"] [--to name]   Post it as a change on this folder's board (--to asks for a review)
                         When you land work (merge/push), post a change card: the pre-push hook does it for you
  atteo hooks install [--diff | --off]   A git pre-push hook posting a card (commits, files) for each push to this
                         folder's board; --diff adds the code itself, which everyone on the board can then read
                         (atteo use installs it; it never blocks a push and keeps any pre-push hook you had)`;
