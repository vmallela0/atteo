import { describe, expect, it } from "vitest";
import { branchName, closes, fullSha, handoffLine, handoffText, HandoffError, parseReady, parseResult, queueLine, type HandoffReady } from "../src/handoff";
import { compactLine, entryHeader } from "../src/state";
import type { Entry } from "../src/types";

const SHA = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
const BASE = "19e9138aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ready = { branch: "pr34-fix", sha: SHA, base: BASE, checks: "vitest 470, e2e 183" };

const entry = (over: Partial<Entry>): Entry => ({
  seq: 12, ts: Date.parse("2026-10-04T21:00:00Z"), author: "vedu", type: "handoff", text: "Ready to gate: pr34-fix", to: null, mentions: [],
  reply_to: null, resolves: [], supersedes: null, retracts: null, via: "agent", client: "claude", artifact_name: null, artifact_size: null,
  artifact_version: null, media: null, title: null, card: null, ai_flag: null, ...over,
});

describe("handoff: a new one (ready to gate)", () => {
  it("keeps branch, full shas (lowercased), checks and an optional lgtm; it starts open", () => {
    expect(parseReady({ ...ready, sha: SHA.toUpperCase(), lgtm: "#2341" })).toEqual({ ...ready, lgtm: 2341, state: "open" });
    expect(parseReady(JSON.stringify(ready))).toEqual({ ...ready, lgtm: null, state: "open" }); // JSON text, as some clients send
    expect(parseReady({ ...ready, checks: ["vitest 470", "e2e 183", 5] }).checks).toBe("vitest 470, e2e 183");
    expect(parseReady({ ...ready, checks: "  vitest\n 470  " }).checks).toBe("vitest 470");
  });

  it("refuses short or non-hex shas, bad branch names, missing or long checks, and a bad lgtm", () => {
    for (const bad of [
      { ...ready, sha: "1a2b3c4" },
      { ...ready, sha: "z".repeat(40) },
      { ...ready, base: undefined },
      { ...ready, branch: "" },
      { ...ready, checks: "" },
      { ...ready, checks: "x".repeat(301) },
      { ...ready, lgtm: 0 },
      { ...ready, lgtm: "abc" },
      [ready],
      "not json",
      { ...ready, state: "landed" }, // a close is a reply, not a new handoff
    ]) expect(() => parseReady(bad), JSON.stringify(bad)).toThrow(HandoffError);
    expect(fullSha("a".repeat(64), "sha")).toBe("a".repeat(64)); // sha256 repositories
  });

  it("branch names follow git's rules", () => {
    for (const ok of ["main", "pr34-fix", "cursor/handoff-type-3395", "v1.2_x"]) expect(branchName(ok)).toBe(ok);
    for (const bad of ["-x", "/x", "x/", ".x", "x.", "a..b", "a//b", "a/.b", "x.lock", "a b", "a~1", "a^", "a:b", "a\\b", "@{u}", "x".repeat(121)]) {
      expect(() => branchName(bad), bad).toThrow(HandoffError);
    }
  });
});

describe("handoff: the lander's reply", () => {
  it("landed needs the full sha on main; failed needs nothing (the text says why)", () => {
    expect(parseResult({ state: "landed", sha: SHA }, 12)).toEqual({ of: 12, state: "landed", sha: SHA });
    expect(parseResult({ state: "failed" }, 12)).toEqual({ of: 12, state: "failed", sha: null });
    expect(() => parseResult({ state: "landed" }, 12)).toThrow(HandoffError);
    expect(() => parseResult({ state: "merged", sha: SHA }, 12)).toThrow(HandoffError);
  });

  it("closes() tells a reply from a new handoff", () => {
    expect(closes({ state: "failed" })).toBe(true);
    expect(closes(JSON.stringify({ state: "landed", sha: SHA }))).toBe(true);
    expect(closes(ready)).toBe(false);
    expect(closes("nonsense")).toBe(false);
  });
});

describe("handoff lines", () => {
  const open: HandoffReady = { ...ready, lgtm: 2341, state: "open" };
  it("one line each, short shas in reads, full shas in the queue", () => {
    expect(handoffLine(open)).toBe("ready to gate: pr34-fix @1a2b3c4 on 19e9138 · checks: vitest 470, e2e 183 · LGTM #2341");
    expect(handoffLine({ ...open, state: "landed", landed_sha: "fedcba9" + "0".repeat(33), closed_seq: 15 })).toContain("· landed as fedcba9 (#15)");
    expect(handoffLine({ ...open, state: "failed", closed_seq: 16 })).toContain("· failed (#16)");
    expect(handoffLine({ of: 12, state: "landed", sha: SHA })).toBe("landed #12 as 1a2b3c4");
    expect(handoffLine({ of: 12, state: "failed", sha: null })).toBe("failed #12");
    const q = queueLine(entry({ handoff: open }), "", Date.parse("2026-10-04T21:05:00Z"));
    expect(q).toBe(`#12 pr34-fix ${SHA} on ${BASE} · checks: vitest 470, e2e 183 · LGTM #2341 · vedu · 5m ago`);
    expect(handoffText(open)).toBe("pr34-fix\nvitest 470, e2e 183");
  });

  it("reads show it in the entry's header and in compact lines", () => {
    const e = entry({ handoff: open });
    expect(entryHeader(e)).toContain("ready to gate: pr34-fix @1a2b3c4");
    expect(compactLine(e)).toContain("ready to gate: pr34-fix @1a2b3c4");
    expect(entryHeader(entry({ seq: 13, reply_to: 12, handoff: { of: 12, state: "landed", sha: SHA } }))).toContain("landed #12 as 1a2b3c4");
  });
});
