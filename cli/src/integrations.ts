// atteo connect <integration> · atteo connect · atteo disconnect <integration> (vedu #6508/#6512): a board's
// integrations from the shell. Connecting is OAuth in a browser, as a person signed in on Atteo (a board owner), so the
// CLI prints the link (and opens it); the status is read with your login. The server keeps disconnecting for people
// too: an agent or CLI login is refused, and the CLI then names the web panel.
// No imports: main.ts hands in the login's calls (commands.ts), so this stays testable on its own.

export type Opt = Record<string, string | true>;
export interface IntegrationDeps {
  /** A JSON API call with your login; a refusal throws with `.status`. */
  api: (method: string, path: string) => Promise<any>;
  /** The server your login is for, e.g. https://atteo.dev. */
  base: () => string;
  /** This folder's (or session's) board, or --board when given as an id. */
  board: (opt: Opt) => string;
  say: (s: string) => void;
  /** The CLI's own error (printed without a stack). */
  fail: (message: string) => Error;
  /** Opens a link in the browser; skipped with --no-open. */
  open: (url: string) => void;
  /** Asks before something irreversible. */
  confirm?: (question: string) => Promise<boolean>;
}

export const SOON: Record<string, string> = { discord: "Discord", notion: "Notion", teams: "Microsoft Teams" };
export const INTEGRATIONS = ["linear", "slack", ...Object.keys(SOON)];
/** The flags these commands take without a value (for parseArgs). */
export const INTEGRATION_FLAGS = ["no-open", "yes", "json"];
const BOARD_ID = /^b_[a-z0-9]{8,32}$/;

const str = (opt: Opt, k: string) => (typeof opt[k] === "string" ? (opt[k] as string) : undefined);

/** --board <id|name> (a name: one of your boards, case-insensitive), else this folder's or session's board. */
export async function boardFor(opt: Opt, d: IntegrationDeps): Promise<{ id: string; title: string | null }> {
  const asked = str(opt, "board");
  if (asked && !BOARD_ID.test(asked)) {
    const { boards } = (await d.api("GET", "/api/me/boards")) as { boards: { id: string; title: string }[] };
    const b = boards.find((x) => x.title.toLowerCase() === asked.toLowerCase());
    if (!b) throw d.fail(`You're not on a board "${asked}" (atteo boards lists yours).`);
    return b;
  }
  return { id: d.board(opt), title: null };
}

type Status = { ok: true; j: any } | { ok: false; status: number; error: string };

/** A status call: the JSON, or why not (503: not set up on this server). */
async function statusOf(d: IntegrationDeps, path: string): Promise<Status> {
  try {
    return { ok: true, j: await d.api("GET", path) };
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status == null) throw e;
    return { ok: false, status, error: (e as Error).message };
  }
}

const notSetUp = "not set up on this server yet";

/** One line about Linear's link, from GET /api/integrations/linear. */
export function linearLine(s: Status): string {
  if (!s.ok) return s.status === 503 ? notSetUp : `couldn't check (${s.error})`;
  const j = s.j;
  if (!j.linked) return "not connected";
  const where = j.team ? `${j.team.name}${j.team.key ? ` (${j.team.key})` : ""}${j.project ? ` · project ${j.project.name}` : ""}` : `${j.org?.name ? `${j.org.name} · ` : ""}no team picked yet`;
  return `connected · ${where} · by ${j.created_by}${j.issues ? ` · ${j.issues} issue${j.issues === 1 ? "" : "s"}` : ""}`;
}

/** One line about Slack's channels, from GET /api/integrations/slack. */
export function slackLine(s: Status): string {
  if (!s.ok) return s.status === 503 ? notSetUp : `couldn't check (${s.error})`;
  const ch = (s.j.channels ?? []) as { name: string; paused: string | null }[];
  if (!ch.length) return "not connected";
  return `${s.j.connected ? "connected" : "paused"} · ${ch.map((c) => `#${c.name}${c.paused ? " (paused)" : ""}`).join(", ")}`;
}

/** atteo connect (no integration): every integration and its status on the board. */
export async function listIntegrations(opt: Opt, d: IntegrationDeps): Promise<void> {
  const b = await boardFor(opt, d);
  const q = `?board=${encodeURIComponent(b.id)}`;
  const [linear, slack] = await Promise.all([statusOf(d, `/api/integrations/linear${q}`), statusOf(d, `/api/integrations/slack${q}`)]);
  if (opt.json === true) {
    const val = (s: Status) => (s.ok ? s.j : { error: s.error, status: s.status });
    return d.say(JSON.stringify({ board: b.id, linear: val(linear), slack: val(slack), coming_soon: Object.keys(SOON) }, null, 2));
  }
  d.say(`Integrations on ${b.title ? `"${b.title}" (${b.id})` : b.id}:`);
  d.say(`  linear    ${linearLine(linear)}`);
  d.say(`  slack     ${slackLine(slack)}`);
  for (const [k, name] of Object.entries(SOON)) d.say(`  ${k.padEnd(9)} coming soon (${name})`);
  d.say(`\nConnect one: atteo connect linear · disconnect: atteo disconnect linear · on the web: the board's ⋯ → Integrations`);
}

/** atteo connect <integration> [--board <id|name>] [--no-open]: the link that connects it, opened in the browser. */
export async function connectIntegration(name: string, opt: Opt, d: IntegrationDeps): Promise<void> {
  if (SOON[name]) return d.say(`${SOON[name]} is coming soon. For now: Linear (atteo connect linear) and Slack (atteo connect slack).`);
  if (name !== "linear" && name !== "slack") throw d.fail(`Unknown integration "${name}". Known: ${INTEGRATIONS.join(", ")}.`);
  const label = name === "linear" ? "Linear" : "Slack";
  const b = await boardFor(opt, d);
  const base = d.base();
  const q = `?board=${encodeURIComponent(b.id)}`;
  const s = await statusOf(d, `/api/integrations/${name}${q}`);
  if (!s.ok && s.status === 503) throw d.fail(`${label} isn't set up on ${base} yet.`);
  if (!s.ok && s.status === 404) throw d.fail(`You're not on board ${b.id} (atteo boards lists yours).`);
  const url = name === "linear" ? `${base}/api/integrations/linear/start${q}` : `${base}/slack/connect${q}`;
  if (s.ok) d.say(`${label} on ${b.title ?? b.id}: ${name === "linear" ? linearLine(s) : slackLine(s)}`);
  const linked = s.ok && (name === "linear" ? !!s.j.linked : (s.j.channels ?? []).length > 0);
  d.say(
    name === "linear"
      ? `${linked ? "To connect again (another team or workspace), open" : "Open this link to connect Linear"} (a board owner, signed in on Atteo: approve on Linear, then pick the team):\n  ${url}`
      : `${linked ? "Manage its channels" : "Open this link to connect a Slack channel"} (a board owner, signed in on Atteo):\n  ${url}`,
  );
  if (opt["no-open"] !== true) d.open(url);
}

/** atteo disconnect <integration> [--board <id|name>] [--yes]. */
export async function disconnectIntegration(name: string | undefined, opt: Opt, d: IntegrationDeps): Promise<void> {
  if (!name) throw d.fail("Usage: atteo disconnect linear [--board <id|name>] [--yes]");
  if (SOON[name]) return d.say(`${SOON[name]} is coming soon: there's nothing to disconnect.`);
  if (name !== "linear" && name !== "slack") throw d.fail(`Unknown integration "${name}". Known: ${INTEGRATIONS.join(", ")}.`);
  const b = await boardFor(opt, d);
  const base = d.base();
  if (name === "slack") {
    const url = `${base}/slack/board/${encodeURIComponent(b.id)}`;
    d.say(`Slack channels are unlinked by a board owner on the web:\n  ${url}`);
    if (opt["no-open"] !== true) d.open(url);
    return;
  }
  if (opt.yes !== true && d.confirm && !(await d.confirm(`Disconnect Linear from ${b.title ?? b.id}? Its issues stay in Linear; tasks stop syncing.`))) throw d.fail("Nothing changed.");
  try {
    const j = await d.api("DELETE", `/api/integrations/linear?board=${encodeURIComponent(b.id)}`);
    d.say(j?.linked === false ? `Linear is disconnected from ${b.title ?? b.id}.` : "Done.");
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 503) throw d.fail(`Linear isn't set up on ${base} yet.`);
    // People only (src/linear.ts): an agent or CLI login is refused. Say where a person does it.
    if (status === 403) throw d.fail(`${(e as Error).message}\nOn the web, signed in as yourself: ${base}/b/${encodeURIComponent(b.id)}#integrations (⋯ → Integrations → Disconnect).`);
    throw e;
  }
}
