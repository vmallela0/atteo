// Agent search payload, and the trigram index versus scanning the newest 2,000 entries.
// The scan/trigram numbers come from SQLite's FTS5 (python3's sqlite). Node's built-in sqlite is compiled without FTS5;
// Cloudflare's board database has it. The probe skips the timing half where FTS5 trigram isn't available.

import { describe, expect, it } from "vitest";
import { agentSearchLine, formatEntry } from "../src/state";
import type { Entry } from "../src/types";

function entry(text: string): Entry {
  return {
    seq: 41,
    ts: Date.UTC(2026, 9, 5, 5, 40),
    author: "vedu",
    via: "agent",
    agent_name: "Moby",
    client: "claude · Cursor",
    type: "note",
    text,
    to: null,
    reply_to: null,
    resolves: [],
    supersedes: null,
    retracts: null,
    artifact_name: null,
    artifact_size: null,
  };
}

describe("agent search lines", () => {
  it("is one line with #n, author and date, and much shorter than the old 300-character entry", () => {
    const e = entry(`${"checkout ".repeat(80)}the rest of a long note that an agent used to receive in full`);
    const fat = formatEntry(e, 300);
    const lean = agentSearchLine(e, "please «checkout» the path");
    expect(lean).toBe("#41 note · Moby (vedu's agent) · 2026-10-05 05:40Z: please «checkout» the path");
    expect(lean.split("\n")).toHaveLength(1);
    expect(fat.length).toBeGreaterThan(300);
    expect(lean.length).toBeLessThan(fat.length / 3);
  });
});

const { spawnSync } = await import("node:" + "child_process");
const probe = spawnSync(
  "python3",
  ["-c", "import sqlite3; sqlite3.connect(':memory:').execute(\"create virtual table g using fts5(x, tokenize='trigram case_sensitive 0')\")"],
  { encoding: "utf8" },
);

describe.skipIf(probe.status !== 0)("trigram index versus a 2,000-entry scan", () => {
  it("finds a substring outside the recent window, and reads far fewer rows", () => {
    const script = `
import json, sqlite3, time, random
db = sqlite3.connect(":memory:")
db.execute("CREATE VIRTUAL TABLE search_idx USING fts5(body, kind UNINDEXED, ref UNINDEXED, tokenize='unicode61 remove_diacritics 2')")
db.execute("CREATE VIRTUAL TABLE search_gram USING fts5(body, kind UNINDEXED, ref UNINDEXED, tokenize='trigram case_sensitive 0')")
db.execute("CREATE TABLE entries (seq INTEGER PRIMARY KEY, text TEXT)")
rng = random.Random(1)
N = 4000
rows = []
for i in range(1, N + 1):
    if i == 50:
        text = "please checkout the billing path before friday"
    else:
        text = "lorem ipsum note %d about %s" % (i, " ".join(rng.choice(["alpha", "beta", "gamma", "delta", "widget", "queue"]) for _ in range(40)))
    rows.append((i, text))
db.executemany("INSERT INTO entries VALUES (?, ?)", rows)
for seq, text in rows:
    db.execute("INSERT INTO search_idx (body, kind, ref) VALUES (?, 'entry', ?)", (text, str(seq)))
    db.execute("INSERT INTO search_gram (body, kind, ref) VALUES (?, 'entry', ?)", (text, str(seq)))

def bench(sql, args, n=11):
    db.execute(sql, args).fetchall()
    times = []
    got = []
    for _ in range(n):
        t = time.perf_counter()
        got = db.execute(sql, args).fetchall()
        times.append((time.perf_counter() - t) * 1000)
    times.sort()
    return {"n": len(got), "ms": times[len(times) // 2], "refs": [r[0] for r in got[:5]]}

word = bench("SELECT ref FROM search_idx WHERE search_idx MATCH ? LIMIT 50", ('"eckout"*',))
gram = bench("SELECT ref FROM search_gram WHERE search_gram MATCH ? LIMIT 50", ('"eckout"',))
scan = bench("SELECT seq, text FROM entries WHERE seq > ? ORDER BY seq DESC LIMIT ?", (N - 2000, 2000))
hits = [seq for seq, text in db.execute("SELECT seq, text FROM entries WHERE seq > ? ORDER BY seq DESC LIMIT 2000", (N - 2000,)) if "eckout" in text.lower()]
print(json.dumps({"word": word, "gram": gram, "scan_rows": scan["n"], "scan_ms": scan["ms"], "scan_hits": hits, "old_in_window": 50 > N - 2000}))
`;
    const r = spawnSync("python3", ["-c", script], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr || r.stdout);
    const j = JSON.parse(r.stdout) as {
      word: { n: number };
      gram: { n: number; ms: number; refs: string[] };
      scan_rows: number;
      scan_ms: number;
      scan_hits: number[];
      old_in_window: boolean;
    };
    expect(j.word.n).toBe(0); // word-prefix FTS misses a match inside "checkout"
    expect(j.gram.n).toBe(1);
    expect(j.gram.refs).toEqual(["50"]);
    expect(j.old_in_window).toBe(false);
    expect(j.scan_hits).toEqual([]); // the newest 2,000 entries do not contain it
    expect(j.scan_rows).toBe(2000);
    expect(j.gram.n).toBeLessThan(j.scan_rows / 100);
    expect(j.gram.ms).toBeLessThan(j.scan_ms);
  });
});
