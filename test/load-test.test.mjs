import { describe, expect, it } from "vitest";
import {
  PACK_TARGET_MS,
  adminKeyFromVars,
  assertLocalBase,
  formatPrdBlock,
  formatPrdLines,
  parseArgs,
  percentile,
  prdCheck,
  reportJson,
} from "../scripts/load-test.mjs";

describe("load-test helpers", () => {
  it("percentile is nearest-rank on a sorted list", () => {
    const t = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(t, 50)).toBe(60);
    expect(percentile(t, 95)).toBe(100);
    expect(percentile([], 95)).toBeNaN();
  });

  it("refuses a missing or remote BASE and keeps localhost", () => {
    expect(() => assertLocalBase()).toThrow(/set BASE/);
    expect(() => assertLocalBase("https://atteo.dev")).toThrow(/local servers only/);
    expect(() => assertLocalBase("https://agent-board.vedu-mallela.workers.dev")).toThrow(/local servers only/);
    expect(assertLocalBase("http://localhost:8801/")).toBe("http://localhost:8801");
    expect(assertLocalBase("http://127.0.0.1:8860")).toBe("http://127.0.0.1:8860");
  });

  it("reads ADMIN_KEY from the env or .dev.vars text, never inventing a blank", () => {
    expect(adminKeyFromVars({ ADMIN_KEY: "from-env" }, "ADMIN_KEY=from-file")).toBe("from-env");
    expect(adminKeyFromVars({}, "ADMIN_KEY=from-file\n")).toBe("from-file");
    expect(adminKeyFromVars({}, 'ADMIN_KEY="quoted"')).toBe("quoted");
    expect(adminKeyFromVars({}, "")).toBe("ci-admin-key");
  });

  it("SMOKE and --help / --out parse without touching a server", () => {
    expect(parseArgs(["--help"], {})).toEqual({ help: true });
    expect(parseArgs(["-h"], { BASE: "http://localhost:1" })).toEqual({ help: true });
    const smoke = parseArgs(["--smoke", "--out", "/tmp/r.json"], { BASE: "http://localhost:8801" });
    expect(smoke).toMatchObject({ help: false, n: 200, runs: 8, smoke: true, out: "/tmp/r.json", strict: false });
    expect(parseArgs([], { SMOKE: "1" })).toMatchObject({ n: 200, runs: 8, smoke: true });
    const full = parseArgs([], { BASE: "http://localhost:8801", N: "10000", RUNS: "20", STRICT: "1" });
    expect(full).toMatchObject({ n: 10000, runs: 20, smoke: false, strict: true });
  });

  it("PRD report highlights delivery and context-pack p95", () => {
    const check = prdCheck(265, 18, 10_000);
    expect(check.delivery.ok).toBe(true);
    expect(check.pack.ok).toBe(true);
    expect(check.pack.target).toBe(PACK_TARGET_MS);
    const lines = formatPrdLines(check);
    expect(lines[0]).toMatch(/^✓ entry delivery p95 265ms/);
    expect(lines[1]).toMatch(/^✓ context pack p95 18ms at 10000 entries/);
    expect(formatPrdBlock(check, { n: 10000, runs: 20 })).toContain("post → wait");
    const miss = prdCheck(800, 2500, 10_000);
    expect(miss.delivery.ok).toBe(false);
    expect(miss.pack.ok).toBe(false);
    expect(formatPrdLines(miss)[0]).toMatch(/^✗/);
    const json = reportJson({ n: 10000, runs: 20, base: "http://localhost:8860", smoke: false, seeded_s: 42, measurements: [{ name: "delivery: post → waiting agent", p50_ms: 260, p95_ms: 265 }], check });
    expect(json.prd.entry_delivery).toEqual({ p95_ms: 265, target_ms: 500, ok: true, settle_ms: 250 });
    expect(json.prd.context_pack).toEqual({ p95_ms: 18, target_ms: 2000, n: 10000, ok: true });
  });
});
