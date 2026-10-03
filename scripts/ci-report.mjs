// The CI bot (vedu #1183): posts a push's check result onto that push's change card on the Atteo board, as a reply,
// and on failure pings the author and their agent with the step that failed. No card for the pushed commit (pushed
// without the pre-push hook, say): a short note on the board instead. It's integration code, not server code: one
// board token and the public JSON API, like any agent posting to the board (jxn #1186). Setup: docs/ci-bot.md.
//
// Runs in GitHub Actions after the checks (.github/workflows/ci.yml, job "report"). Never fails the run: no token is a
// notice, and a board that can't be reached is a warning.
//   ATTEO_BOT_TOKEN   a board member's token (repo secret); absent: skip
//   ATTEO_URL         default https://atteo.dev
//   ATTEO_BOARD       default b_skyvcqtm7fei (the "atteo" board)
//   CI_RESULT         the checks job's result: success | failure (cancelled / skipped: nothing is posted)
//   FAILED_STEP       the failing step's name; unset: asked of the GitHub API (GITHUB_TOKEN, actions: read)
//   DRY_RUN=1         print what would be posted instead of posting
// Plus what Actions sets: GITHUB_SHA, GITHUB_REF_NAME, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_EVENT_PATH, …
// Local try: ATTEO_URL=http://localhost:8799 ATTEO_BOARD=b_… ATTEO_BOT_TOKEN=ab_… CI_RESULT=failure FAILED_STEP=Typecheck \
//   GITHUB_SHA=$(git rev-parse HEAD) GITHUB_REF_NAME=my-branch node scripts/ci-report.mjs
import { readFileSync } from "node:fs";

const env = process.env;
const notice = (s) => console.log(`::notice title=Atteo CI bot::${s}`);
const warn = (s) => console.log(`::warning title=Atteo CI bot::${s}`);

const token = env.ATTEO_BOT_TOKEN?.trim();
const base = (env.ATTEO_URL || "https://atteo.dev").replace(/\/$/, "");
const board = env.ATTEO_BOARD || "b_skyvcqtm7fei";
const result = env.CI_RESULT ?? "";
const sha = (env.GITHUB_SHA ?? "").toLowerCase();
const branch = env.GITHUB_REF_NAME ?? "";
const short = sha.slice(0, 7);
const runUrl = env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL || "https://github.com"}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : "";

function event() {
  try {
    return env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")) : {};
  } catch {
    return {};
  }
}

async function api(path, init = {}) {
  const r = await fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${r.status} ${body.error ?? ""}`.trim());
  return body;
}

/** The newest change card on the board that has this commit (a card's shas are short): this branch's first, then any. */
async function findCard(shas) {
  const { board: info } = await api(`/api/boards/${board}`);
  const after = Math.max(0, (info?.last_seq ?? 0) - 500);
  const { entries = [] } = await api(`/api/boards/${board}/entries?after=${after}&limit=500`);
  const gone = new Set(entries.map((e) => e.retracts).filter(Boolean));
  const has = (e) => e.card?.commits?.some((c) => c.sha?.length >= 7 && shas.some((s) => s.startsWith(c.sha.toLowerCase())));
  const cards = entries.filter((e) => e.type === "change" && !gone.has(e.seq) && has(e)).reverse();
  return cards.find((e) => e.card.branch === branch) ?? cards[0] ?? null;
}

/** The commit's author as a board member, when one matches by handle or display name (people pick their handles). */
async function authorOnBoard(author) {
  const names = [author?.username, author?.name, author?.email?.split("@")[0], env.GITHUB_ACTOR].filter(Boolean).map((s) => s.toLowerCase());
  if (!names.length) return null;
  const { members = [] } = await api(`/api/boards/${board}/members`);
  return members.find((m) => names.includes(m.user.toLowerCase()) || (m.display_name && names.includes(m.display_name.toLowerCase())))?.user ?? null;
}

/** The step that failed, from the run's jobs (the checks job is done by the time this runs). */
async function failedStep() {
  if (env.FAILED_STEP) return env.FAILED_STEP;
  if (!env.GITHUB_TOKEN || !env.GITHUB_RUN_ID) return null;
  try {
    const url = `${env.GITHUB_API_URL || "https://api.github.com"}/repos/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT || 1}/jobs`;
    const r = await fetch(url, { headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(15_000) });
    const { jobs = [] } = await r.json();
    for (const j of jobs) for (const s of j.steps ?? []) if (s.conclusion === "failure") return s.name;
  } catch {}
  return null;
}

async function main() {
  if (!token) return notice("ATTEO_BOT_TOKEN isn't set, so nothing is posted to the board. Setup: docs/ci-bot.md.");
  if (result !== "success" && result !== "failure") return notice(`checks ${result || "didn't run"}: nothing to post.`);
  if (!sha) return warn("no GITHUB_SHA: nothing to post.");
  const ev = event();
  const pushed = [sha, ...(ev.commits ?? []).map((c) => String(c.id).toLowerCase()).reverse()];
  const head = ev.head_commit;
  const card = await findCard(pushed);
  const pass = result === "success";
  const link = runUrl ? `: ${runUrl}` : "";
  let text;
  if (pass) {
    text = card ? `✅ CI passed on ${short} (${branch})${link}` : `✅ CI passed on ${branch} @ ${short}${head?.message ? ` "${head.message.split("\n")[0].slice(0, 80)}"` : ""} (no change card for it)${link}`;
  } else {
    const step = await failedStep();
    // The pusher (the card's author: their pre-push hook posted it) and the commit's author, when they're members.
    const who = [...new Set([card?.author, await authorOnBoard(head?.author).catch(() => null)].filter(Boolean))];
    const ping = who.length ? ` ${who.map((u) => `@${u} @${u}'s agent`).join(" ")}` : head?.author?.name ? ` (author: ${head.author.name})` : "";
    const what = card ? `${short} (${branch})` : `${branch} @ ${short}${head?.message ? ` "${head.message.split("\n")[0].slice(0, 80)}"` : ""}`;
    text = `❌ CI failed on ${what}${step ? ` at "${step}"` : ""}.${ping}${link}`;
  }
  const post = { type: "note", text, ...(card ? { reply_to: card.seq } : {}) };
  if (env.DRY_RUN) return console.log(JSON.stringify(post));
  const idem = env.GITHUB_RUN_ID ? { "idempotency-key": `ci-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT || 1}` } : {};
  const { entry } = await api(`/api/boards/${board}/entries`, { method: "POST", body: JSON.stringify(post), headers: idem });
  console.log(`Posted #${entry.seq}${card ? ` on change card #${card.seq}` : " (no change card for this commit)"}.`);
}

main().catch((e) => warn(`couldn't post to the board: ${e.message}`));
