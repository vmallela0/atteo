import { describe, expect, it } from "vitest";

// scripts/procgroups.sh (used by verify.sh, #3552): whatever a script starts in a group is gone once the script is,
// however it ends. Each tree mimics npx → wrangler → workerd: a leader, a child, and an orphaned grandchild that
// outlives its parent (the kind killing one pid used to leave behind).

const { spawn } = (await import("node:" + "child_process")) as { spawn: (cmd: string, args: string[], o: object) => any };
const { mkdtempSync, readFileSync, rmSync } = (await import("node:" + "fs")) as { mkdtempSync: (p: string) => string; readFileSync: (p: string, e: string) => string; rmSync: (p: string, o: object) => void };
const { tmpdir } = (await import("node:" + "os")) as { tmpdir: () => string };
const root = new URL("..", (import.meta as unknown as { url: string }).url).pathname;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs a script that starts two trees in groups, then ends `how`. The pids each tree started, and how long it took. */
async function run(how: "exit 0" | "exit 2" | "TERM", opts: { ignoreTerm?: boolean } = {}) {
  const dir = mkdtempSync(`${tmpdir()}/procgroups-`);
  const f = `${dir}/pids`;
  const trap = opts.ignoreTerm ? `trap "" TERM; ` : "";
  const tree = `${trap}echo $$ >> ${f}; sleep 600 & echo $! >> ${f}; ( sleep 600 & echo $! >> ${f} ) ; wait`;
  const script = `set -u
. scripts/procgroups.sh
trap 'stop_groups 1' EXIT; trap 'exit 130' INT; trap 'exit 143' TERM
in_group bash -c '${tree}'
in_group bash -c '${tree}'
until [ "$(wc -l < ${f} 2>/dev/null || echo 0)" -ge 6 ]; do sleep 0.05; done
echo ready
read -r _
${how === "TERM" ? "while :; do sleep 0.1; done" : how}`;
  const p = spawn("bash", ["-c", script], { cwd: root, stdio: ["pipe", "pipe", "inherit"] });
  const exited = new Promise<number | null>((r) => p.on("exit", (code: number | null) => r(code)));
  await new Promise<void>((r) => p.stdout.on("data", (d: unknown) => String(d).includes("ready") && r()));
  const pids = readFileSync(f, "utf8").trim().split("\n").map(Number);
  expect(pids.length).toBe(6);
  expect(pids.every(alive)).toBe(true);
  const t0 = Date.now();
  if (how === "TERM") p.kill("SIGTERM");
  else p.stdin.write("go\n");
  const code = await exited;
  const ms = Date.now() - t0;
  for (let i = 0; i < 20 && pids.some(alive); i++) await sleep(50); // orphans are reaped by init
  rmSync(dir, { recursive: true, force: true });
  return { pids, code, ms };
}

describe("verify.sh's process groups", () => {
  it("a normal exit stops every tree, grandchildren included", async () => {
    const r = await run("exit 0");
    expect(r.code).toBe(0);
    expect(r.pids.filter(alive)).toEqual([]);
  });
  it("so does a failed exit", async () => {
    const r = await run("exit 2");
    expect(r.code).toBe(2);
    expect(r.pids.filter(alive)).toEqual([]);
  });
  it("and TERM (or Ctrl-C) to the script", async () => {
    const r = await run("TERM");
    expect(r.code).toBe(143);
    expect(r.pids.filter(alive)).toEqual([]);
  });
  it("a tree that ignores TERM is killed once the grace period is over", async () => {
    const r = await run("exit 0", { ignoreTerm: true });
    expect(r.pids.filter(alive)).toEqual([]);
    expect(r.ms).toBeLessThan(4000);
  });
});
