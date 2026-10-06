// atteo host / atteo run (docs/HOST.md; vedu #4805/#4807/#4815): bring your own machine to a board. Very dangerous:
// agents on the board can ask to run commands here. The owner types consent each time a host starts, approves every
// command (unless allowlisted exactly), and can stop it at once. Commands run only inside the shared folders, with no
// TTY, a timeout, and an environment without secret-looking variables; output is redacted before it leaves.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { cleanOutput, clampTimeout, HOST_PHRASE, insideShares, MAX_OUTPUT, SECRET_ENV } from "../../src/hostCore";
import { api, CliError, creds, currentBoard, optStr, say, server } from "./commands";

type Opt = Record<string, string | true>;

/** --share and --allow may repeat; everything else is the usual --key value. */
function hostArgs(args: string[]): { pos: string[]; opt: Opt; shares: string[]; allow: string[] } {
  const pos: string[] = [];
  const opt: Opt = {};
  const shares: string[] = [];
  const allow: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) {
      pos.push(a);
      continue;
    }
    const k = a.slice(2);
    if (k === "all" || k === "json" || k === "quiet" || k === "no-wait") {
      opt[k] = true;
      continue;
    }
    const v = args[++i];
    if (v === undefined) throw new CliError(`--${k} needs a value.`);
    if (k === "share") shares.push(v);
    else if (k === "allow") allow.push(v);
    else opt[k] = v;
  }
  return { pos, opt, shares, allow };
}

/** Root can't host: one approved command would own the machine. ATTEO_HOST_ASSUME_ROOT=1 only ever adds the refusal (tests). */
function refuseRoot() {
  if (process.getuid?.() === 0 || process.env.ATTEO_HOST_ASSUME_ROOT === "1") throw new CliError("atteo host refuses to run as root. Run it as your own user.");
}

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, (a) => (rl.close(), res(a))));
}

const WARNING = (board: string, shares: string[]) => `
  ⚠️  VERY DANGEROUS: atteo host lets agents on board ${board} ask to run shell commands on THIS machine, as you,
     in: ${shares.join(", ")}
     You approve every command (in the browser or the app) unless it's on your --allow list.
     Stop any time: Ctrl-C here, Stop on the board, or atteo host stop.
`;

/** Folders to share: real, existing directories; never / and never your home folder itself. */
function sharesFrom(list: string[]): string[] {
  const out = (list.length ? list : [process.cwd()]).map((s) => {
    let p: string;
    try {
      p = realpathSync(resolve(s));
    } catch {
      throw new CliError(`Can't share ${s}: no such folder.`);
    }
    if (!statSync(p).isDirectory()) throw new CliError(`Can't share ${s}: not a folder.`);
    if (p === "/") throw new CliError("Sharing / (the whole machine) isn't allowed. Share a project folder.");
    if (p === realpathSync(homedir())) throw new CliError("Sharing your whole home folder isn't allowed (keys and logins live there). Share a project folder.");
    return p;
  });
  return [...new Set(out)];
}

/** Runs one command: sh -c, no TTY, stdin closed, scrubbed environment, its own process group killed at the timeout. */
function execute(command: string, cwd: string, timeoutS: number): Promise<{ exit_code: number | null; output: string; timed_out: boolean }> {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!SECRET_ENV.test(k)) env[k] = v;
  return new Promise((done) => {
    let out = "";
    let timedOut = false;
    const child = spawn("/bin/sh", ["-c", command], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const take = (d: Buffer) => {
      if (out.length <= MAX_OUTPUT * 2) out += d.toString("utf8");
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const kill = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {}
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 2000).unref();
    }, timeoutS * 1000);
    child.on("error", (e) => {
      clearTimeout(timer);
      done({ exit_code: null, output: `Couldn't start: ${e.message}`, timed_out: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ exit_code: code, output: out, timed_out: timedOut });
    });
  });
}

/** The folder a run asked for, checked again here on real paths (a symlink inside a share can't lead out). */
function jailed(cwd: string, shares: string[]): string {
  let real: string;
  try {
    real = realpathSync(cwd);
  } catch {
    throw new Error(`${cwd} doesn't exist on this machine.`);
  }
  if (!insideShares(real, shares)) throw new Error(`${cwd} resolves to ${real}, outside the shared folders.`);
  return real;
}

async function start(args: string[]) {
  refuseRoot();
  const { opt, shares: asked, allow } = hostArgs(args);
  const bad = Object.keys(opt).filter((k) => !["board", "name", "server", "quiet"].includes(k));
  if (bad.length) throw new CliError(`atteo host doesn't take ${bad.map((k) => "--" + k).join(", ")}. Options: --share DIR (repeat) --allow "<exact command>" (repeat) --name N --board B. Consent is always typed in your browser.`);
  const board = currentBoard(opt);
  const shares = sharesFrom(asked);
  // Consent is the person's, every start, and never from an agent: it happens in their browser (only a person's login
  // can mint the code there), and the code is typed into this terminal. No flag skips it; a pipe can't feed it.
  if (!process.stdin.isTTY) throw new CliError("atteo host only starts in an interactive terminal: you confirm it in your browser and type the code here.");
  say(WARNING(board, shares));
  const machine = "m_" + randomBytes(12).toString("base64url");
  const c = creds();
  say(`  To allow it, open this link (signed in as ${c.user}), type "${HOST_PHRASE}" there, and copy the code:\n\n    ${server(c, opt)}/host/consent?board=${board}&machine=${machine}\n`);
  const code = (await ask("  Code: ")).trim();
  if (!code) throw new CliError("Not attached: no code.");
  const name = optStr(opt, "name") ?? hostname().replace(/\.local$/, "");
  const { host } = await api(opt, "POST", `/api/boards/${board}/hosts`, { code, machine, name, shares, allow });
  say(`Attached ${host.name} (${host.id}) to ${board}. Waiting for approved commands… (Ctrl-C to stop)`);
  let stopping = false;
  const stopNow = async () => {
    if (stopping) process.exit(0);
    stopping = true;
    say("\nStopping…");
    await api(opt, "POST", `/api/boards/${board}/hosts/${host.id}/stop`).catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void stopNow());
  process.on("SIGTERM", () => void stopNow());
  let misses = 0;
  for (;;) {
    let got: { stop?: string; run?: { id: string; command: string; cwd: string; timeout_s: number; requested_by: string } | null };
    try {
      got = await api(opt, "GET", `/api/boards/${board}/hosts/${host.id}/next?wait=25`);
      misses = 0;
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 403 || status === 404 || status === 401) throw new CliError(`Stopped: ${(e as Error).message}`);
      if (++misses > 20) throw new CliError(`Stopped: the board stopped answering (${(e as Error).message}).`);
      await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * misses)));
      continue;
    }
    if (got.stop) {
      say(`Stopped: ${got.stop}.`);
      return;
    }
    const run = got.run;
    if (!run) continue;
    say(`▶ ${run.requested_by}: ${run.command}  (in ${run.cwd})`);
    let result: { exit_code: number | null; output: string; timed_out: boolean; error?: string };
    try {
      const cwd = jailed(run.cwd, shares);
      refuseRoot();
      result = await execute(run.command, cwd, clampTimeout(run.timeout_s));
    } catch (e) {
      result = { exit_code: null, output: "", timed_out: false, error: e instanceof Error ? e.message : String(e) };
    }
    const out = cleanOutput(result.output);
    say(result.error ? `  ✗ not run: ${result.error}` : result.timed_out ? `  ✗ stopped after ${run.timeout_s}s` : `  exit ${result.exit_code}`);
    await api(opt, "POST", `/api/boards/${board}/hosts/${host.id}/runs/${run.id}/result`, { ...result, output: out.text }).catch((e) => say(`  couldn't report the result: ${(e as Error).message}`));
  }
}

async function list(args: string[]) {
  const { opt } = hostArgs(args);
  const board = currentBoard(opt);
  const { hosts } = await api(opt, "GET", `/api/boards/${board}/hosts`);
  if (opt.json === true) return say(JSON.stringify(hosts, null, 2));
  if (!hosts.length) return say(`No machines attached to ${board}.`);
  for (const h of hosts) say(`${h.online ? "●" : "○"} ${h.name} (${h.id}) · ${h.owner}'s machine · ${h.stopped_at ? `stopped by ${h.stopped_by}` : h.online ? "online" : "offline"} · shares ${h.shares.join(", ")}`);
}

async function stopCmd(args: string[]) {
  const { pos, opt } = hostArgs(args);
  const board = currentBoard(opt);
  const target = opt.all === true ? "all" : pos[0];
  if (!target) throw new CliError("Which host? atteo host stop <id or name>, or --all (yours; the board's owner stops anyone's).");
  let id = target;
  if (target !== "all" && !target.startsWith("h_")) {
    const { hosts } = await api(opt, "GET", `/api/boards/${board}/hosts`);
    const h = hosts.find((x: { name: string; stopped_at: number | null }) => x.name === target && !x.stopped_at);
    if (!h) throw new CliError(`No running host named ${target} on ${board}.`);
    id = h.id;
  }
  const { stopped } = await api(opt, "POST", `/api/boards/${board}/hosts/${id}/stop`);
  say(stopped.length ? `Stopped ${stopped.map((h: { name: string }) => h.name).join(", ")}.` : "Nothing was running.");
}

/** atteo host [--share DIR]... · atteo host list · atteo host stop <id|name>|--all */
export async function hostCmd(args: string[]) {
  if (args[0] === "list") return list(args.slice(1));
  if (args[0] === "stop") return stopCmd(args.slice(1));
  if (args[0] === "start") return start(args.slice(1));
  return start(args);
}

/** atteo run <host> "<command>" [--cwd DIR] [--timeout S] [--no-wait]: ask a board's machine to run something. */
export async function runCmd(args: string[]) {
  const { pos, opt } = hostArgs(args);
  const board = currentBoard(opt);
  const [target, ...rest] = pos;
  const command = rest.join(" ");
  if (!target || !command) throw new CliError('Usage: atteo run <host> "<command>" [--cwd DIR] [--timeout SECONDS] [--no-wait]');
  const { hosts } = await api(opt, "GET", `/api/boards/${board}/hosts`);
  const h = hosts.find((x: { id: string; name: string; stopped_at: number | null }) => (x.id === target || x.name === target) && !x.stopped_at);
  if (!h) throw new CliError(`No running host "${target}" on ${board}. atteo host list shows them.`);
  const { run } = await api(opt, "POST", `/api/boards/${board}/hosts/${h.id}/runs`, { command, cwd: optStr(opt, "cwd"), timeout_s: optStr(opt, "timeout") ? Number(optStr(opt, "timeout")) : undefined });
  say(run.status === "approved" ? `Queued on ${h.name} (allowlisted): ${run.id}` : `Asked ${h.owner} to approve running it on ${h.name}: ${run.id}`);
  if (opt["no-wait"] === true) return;
  const until = Date.now() + (Number(optStr(opt, "wait")) || 600) * 1000;
  let last = run.status;
  while (Date.now() < until) {
    const { run: r } = await api(opt, "GET", `/api/boards/${board}/hosts/${h.id}/runs/${run.id}?wait=25`);
    if (r.status !== last) {
      last = r.status;
      if (r.status === "approved") say(`Approved; waiting for ${h.name}…`);
      if (r.status === "running") say("Running…");
    }
    if (["done", "failed", "rejected", "expired", "stopped"].includes(r.status)) {
      if (r.status === "rejected") throw new CliError(`Denied by ${h.owner}${r.note ? `: "${r.note}"` : ""}.`);
      if (r.status === "expired") throw new CliError("Denied: no decision in time.");
      if (r.status === "stopped") throw new CliError(`${h.name} was stopped.`);
      if (r.output) say(r.output);
      if (r.note && r.status === "failed" && r.exit_code == null && !r.timed_out) throw new CliError(`Not run: ${r.note}`);
      if (r.timed_out) throw new CliError(`Stopped after ${r.timeout_s}s (timeout).`);
      say(`exit ${r.exit_code}`);
      if (r.exit_code) process.exitCode = Math.min(125, r.exit_code);
      return;
    }
  }
  say(`Still ${last} (${run.id}). The result will be on the board when it finishes.`);
}
