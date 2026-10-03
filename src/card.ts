// Change cards: a structured "here's what I changed" post (branch, PR, CI, commits, files, diff) instead of a paragraph.
// Built from local git by `atteo card`; stored with a `change` entry. The diff is kept apart and fetched with `get`.

export const CI_STATES = ["pending", "passing", "failing", "none"] as const;
export type CiState = (typeof CI_STATES)[number];

export interface ChangeCard {
  repo: string | null;
  branch: string;
  base: string | null;
  pr_url: string | null;
  ci: CiState;
  commits: { sha: string; title: string }[];
  files: { path: string; added: number; removed: number }[];
}

export const MAX_CARD_COMMITS = 100;
export const MAX_CARD_FILES = 500;
export const MAX_CARD_DIFF = 256_000;

export class CardError extends Error {}

const s = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), 10_000_000) : 0);

/** Checks and normalizes a card from an agent or the CLI. Returns the card and its diff (or null). */
export function parseCard(raw: unknown): { card: ChangeCard; diff: string | null } {
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw); // some clients send objects as JSON text
    } catch {
      throw new CardError("card must be an object (or JSON text of one).");
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new CardError("card must be an object: {branch, base?, repo?, pr_url?, ci?, commits?, files?, diff?}.");
  const r = raw as Record<string, unknown>;
  const branch = s(r.branch, 200);
  if (!branch) throw new CardError("card.branch is required.");
  const pr = s(r.pr_url, 500);
  if (pr && !/^https:\/\/[^\s]+$/.test(pr)) throw new CardError("card.pr_url must be an https:// link.");
  const ci = (s(r.ci, 20) ?? "none").toLowerCase();
  if (!CI_STATES.includes(ci as CiState)) throw new CardError(`card.ci must be one of: ${CI_STATES.join(", ")}.`);
  const commits = Array.isArray(r.commits) ? r.commits : [];
  const files = Array.isArray(r.files) ? r.files : [];
  if (commits.length > MAX_CARD_COMMITS) throw new CardError(`At most ${MAX_CARD_COMMITS} commits on a card.`);
  if (files.length > MAX_CARD_FILES) throw new CardError(`At most ${MAX_CARD_FILES} files on a card.`);
  const diff = typeof r.diff === "string" && r.diff.length ? r.diff : null;
  if (diff && diff.length > MAX_CARD_DIFF) throw new CardError(`card.diff is too large (max ${MAX_CARD_DIFF} characters); leave it out or trim it.`);
  return {
    card: {
      repo: s(r.repo, 200),
      branch,
      base: s(r.base, 200),
      pr_url: pr,
      ci: ci as CiState,
      commits: commits
        .map((c) => (c && typeof c === "object" ? (c as Record<string, unknown>) : {}))
        .map((c) => ({ sha: (s(c.sha, 40) ?? "").replace(/[^0-9a-f]/gi, "").slice(0, 12), title: s(c.title, 200) ?? "" }))
        .filter((c) => c.sha || c.title),
      files: files
        .map((f) => (f && typeof f === "object" ? (f as Record<string, unknown>) : {}))
        .map((f) => ({ path: s(f.path, 300) ?? "", added: n(f.added), removed: n(f.removed) }))
        .filter((f) => f.path),
    },
    diff,
  };
}

/** Everything in a card that's free text, for the secret filter. */
export function cardText(card: ChangeCard): string {
  return [card.repo, card.branch, card.base, card.pr_url, ...card.commits.map((c) => c.title), ...card.files.map((f) => f.path)].filter(Boolean).join("\n");
}

/** Short tag for summaries and log lines: "feat/x → main · 3 commits · 5 files +120 −30 · CI passing". */
export function cardLine(card: ChangeCard): string {
  const add = card.files.reduce((a, f) => a + f.added, 0);
  const del = card.files.reduce((a, f) => a + f.removed, 0);
  const bits = [`${card.branch}${card.base ? ` → ${card.base}` : ""}`];
  if (card.commits.length) bits.push(`${card.commits.length} commit${card.commits.length === 1 ? "" : "s"}`);
  if (card.files.length) bits.push(`${card.files.length} file${card.files.length === 1 ? "" : "s"} +${add} −${del}`);
  if (card.ci !== "none") bits.push(`CI ${card.ci}`);
  return bits.join(" · ");
}

/** Full text for agents (the `get` tool). */
export function formatCard(card: ChangeCard, diff: string | null): string {
  const out = [`Change: ${cardLine(card)}`];
  if (card.repo) out.push(`Repo: ${card.repo}`);
  if (card.pr_url) out.push(`PR: ${card.pr_url}`);
  if (card.commits.length) out.push("Commits:", ...card.commits.map((c) => `  ${c.sha} ${c.title}`.trimEnd()));
  if (card.files.length) out.push("Files:", ...card.files.map((f) => `  +${f.added} −${f.removed}  ${f.path}`));
  if (diff) out.push("", "----- diff -----", diff, "----- end -----");
  return out.join("\n");
}
