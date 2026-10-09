// The CLI's shared state files (sessions.json and the like) under many agents at once: every change survives, no reader
// sees half a file, and a file that doesn't parse is never saved over with {}. (An .mjs file: the Workers tsconfig has no
// Node types, and cli/src/jsonState.ts uses Node.)
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readJson, updateJson } from "../cli/src/jsonState.ts";
import { loadMap, updateMap } from "../cli/src/session.ts";

const WORKER = new URL("./jsonState.worker.mjs", import.meta.url).pathname;
let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atteo-jsonstate-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(args) {
  return new Promise((resolve, reject) => {
    // The worker imports the .ts as is: Node strips the types (the flag for a Node 22 older than 22.18).
    const p = spawn(process.execPath, ["--experimental-strip-types", WORKER, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`worker exited ${code}: ${err}`))));
  });
}

/** 20 processes, each adding its own key and changing it `rounds` times, all started at once; plus one reader. */
async function race(mode, rounds) {
  const file = join(dir, "sessions.json"), go = join(dir, "go");
  const workers = Array.from({ length: 20 }, (_, i) => run([mode, file, go, `k${i}`, String(rounds)]));
  const reader = run(["reader", file, go]);
  await new Promise((r) => setTimeout(r, 300)); // every process up and waiting
  writeFileSync(go, "");
  await Promise.all(workers);
  writeFileSync(`${go}.done`, "");
  return { map: JSON.parse(readFileSync(file, "utf8")), torn: Number(await reader) };
}

describe("shared JSON state under concurrent CLI processes", () => {
  it("20 processes adding a key each, 10 changes apiece: all 20 survive, at their last value, and no read sees half a file", async () => {
    const { map, torn } = await race("locked", 10);
    expect(Object.keys(map).sort()).toEqual(Array.from({ length: 20 }, (_, i) => `k${i}`).sort());
    for (const v of Object.values(map)) expect(v.n).toBe(10);
    expect(torn).toBe(0);
    expect(existsSync(join(dir, "sessions.json.lock"))).toBe(false);
  }, 30_000);

  it("a file being half-written while it's read is never saved over: the change is skipped", async () => {
    const file = join(dir, "sessions.json"), go = join(dir, "go");
    writeFileSync(go, "");
    const writer = run(["scribble", file, go]);
    while (!existsSync(file)) await new Promise((r) => setTimeout(r, 5));
    try {
      expect(updateJson(file, {}, (m) => void (m["u|3:c"] = { id: "as_3" }))).toBeNull();
    } finally {
      writeFileSync(`${go}.done`, "");
      await writer;
    }
    expect(readFileSync(file, "utf8")).toMatch(/^\{"k\d+": \{"id": "as_$/); // still the writer's, never {} or ours
    expect(existsSync(`${file}.corrupt`)).toBe(false);
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it("a file that stays unparseable (same bytes through the re-reads) is copied aside and started again, never left stuck", () => {
    const file = join(dir, "sessions.json");
    const half = '{\n  "u|1:a": { "id": "as_1", "name": "a", "boards": [] },\n  "u|2:b": { "id": "as_';
    writeFileSync(file, half);
    expect(readJson(file, {})).toEqual({}); // read as nothing, in memory only
    expect(updateJson(file, {}, (m) => void (m["u|3:c"] = { id: "as_3" }))).toEqual({ "u|3:c": { id: "as_3" } });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ "u|3:c": { id: "as_3" } });
    expect(readFileSync(`${file}.corrupt`, "utf8")).toBe(half);
    expect(updateJson(file, {}, (m) => void (m["u|4:d"] = { id: "as_4" }))).toEqual({ "u|3:c": { id: "as_3" }, "u|4:d": { id: "as_4" } });
    expect(readFileSync(`${file}.corrupt`, "utf8")).toBe(half); // kept
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it("a lock left by a process that died is broken after 10s; a fresh one is waited on", () => {
    const file = join(dir, "state.json"), lock = `${file}.lock`;
    writeFileSync(lock, "99999");
    const old = (Date.now() - 20_000) / 1000;
    utimesSync(lock, old, old);
    expect(updateJson(file, {}, (m) => void (m.a = 1))).toEqual({ a: 1 });
    expect(existsSync(lock)).toBe(false);
    writeFileSync(lock, "99999"); // fresh: held by someone live; waited on for ~2s, then saved anyway
    const t = Date.now();
    expect(updateJson(file, {}, (m) => void (m.b = 2))).toEqual({ a: 1, b: 2 });
    expect(Date.now() - t).toBeGreaterThanOrEqual(1900);
    expect(readFileSync(lock, "utf8")).toBe("99999"); // someone else's: not removed
  });
});

describe("sessions.json (session.ts)", () => {
  const saved = process.env.XDG_CONFIG_HOME;
  beforeEach(() => (process.env.XDG_CONFIG_HOME = dir));
  afterEach(() => (saved === undefined ? delete process.env.XDG_CONFIG_HOME : (process.env.XDG_CONFIG_HOME = saved)));

  it("a change applies to the file as it is now, not to a copy loaded earlier", () => {
    updateMap((m) => void (m["u|1:a"] = { id: "as_a", name: "a", boards: [] }));
    const early = loadMap(); // this agent loads, then another agent saves its session…
    updateMap((m) => void (m["u|2:b"] = { id: "as_b", name: "b", boards: [] }));
    updateMap((m) => void (m["u|3:c"] = { ...early["u|1:a"], id: "as_c" })); // …and this one's save keeps it
    expect(Object.keys(loadMap()).sort()).toEqual(["u|1:a", "u|2:b", "u|3:c"]);
    updateMap((m) => void delete m["u|2:b"]);
    expect(Object.keys(loadMap()).sort()).toEqual(["u|1:a", "u|3:c"]);
    expect(JSON.parse(readFileSync(join(dir, "agent-board", "sessions.json"), "utf8"))["u|3:c"].id).toBe("as_c");
  });
});
