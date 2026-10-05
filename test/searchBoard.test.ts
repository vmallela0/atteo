import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
vi.stubGlobal("WebSocketRequestResponsePair", class {});
import { Board } from "../src/board";
import { GREP_CANDIDATES, GREP_RECENT, type BoardGrepCursor, type BoardGrepHit } from "../src/grep";
import type { Env } from "../src/types";

const { DatabaseSync } = (await import("node:" + "sqlite")) as { DatabaseSync: new (p: string) => any };
const databases: any[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const reads: { sql: string; args: unknown[] }[] = [];
  const sql = { exec(query: string, ...args: unknown[]) {
    reads.push({ sql: query, args });
    let rows: any[] = [];
    if (/CREATE TABLE IF NOT EXISTS meta/.test(query)) db.exec(query);
    else {
      const stmt = db.prepare(query);
      if (stmt.columns().length) rows = stmt.all(...args);
      else stmt.run(...args);
    }
    return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
  } };
  const board = new Board({ storage: { sql }, setWebSocketAutoResponse() {} } as unknown as DurableObjectState, {} as Env);
  const metadata = board as unknown as { setMeta(key: string, value: string): void };
  metadata.setMeta("id", "b_test");
  metadata.setMeta("title", "Dev board");
  const entry = (seq: number, text: string, audience: string | null = null, author = "vedu", type = "note") => {
    db.prepare("INSERT INTO entries (seq, ts, author, type, text, audience, to_people) VALUES (?, ?, ?, ?, ?, ?, ?)").run(seq, Date.UTC(2026, 9, 2), author, type, text, audience, audience ? '["vedu"]' : null);
    db.prepare("INSERT INTO search_idx (body, name, kind, ref) VALUES (?, '', 'entry', ?)").run(text, String(seq));
  };
  const doc = (name: string, content: string) => {
    db.prepare("INSERT INTO docs (name, version, content, updated_by, updated_at, created_by, created_at) VALUES (?, 1, ?, 'vedu', ?, 'vedu', ?)").run(name, content, Date.UTC(2026, 9, 3), Date.UTC(2026, 9, 3));
    db.prepare("INSERT INTO search_idx (body, name, kind, ref) VALUES (?, ?, 'doc', ?)").run(content, name, name);
  };
  return { board, db, entry, doc, reads };
}
async function pages(board: Board, pattern: string, opts: Parameters<Board["grepLines"]>[1] = {}) {
  const hits: BoardGrepHit[] = [];
  let more: BoardGrepCursor | undefined;
  for (let i = 0; i < 100; i++) {
    const r = await board.grepLines(pattern, { ...opts, more });
    hits.push(...r.hits);
    if (!r.more) return hits;
    more = r.more;
  }
  throw new Error("Continuation failed to finish");
}

describe("Board grep continuations", () => {
  it("resumes in a multiline entry and file, removing duplicate lines even across pages", async () => {
    const { board, entry, doc } = fixture();
    entry(1, "hit alpha\nhit alpha\nhit beta\nhit gamma");
    doc("PLAN.md", "hit file one\nhit file one\nhit file two");
    const hits = await pages(board, "hit", { max: 1, files: true });
    expect(hits.map((h) => h.text)).toEqual(["«hit» file one", "«hit» file two", "«hit» alpha", "«hit» beta", "«hit» gamma"]);
    expect(hits.every((h) => h.ts != null && h.line != null)).toBe(true);
    expect(hits.map((h) => h.line)).toEqual([1, 3, 1, 3, 4]);
  });
  it("resumes after the FTS candidate cap even when the first page contains no exact lines", async () => {
    const { board, entry } = fixture();
    entry(1, "hit phrase");
    for (let i = 2; i <= GREP_CANDIDATES + 2; i++) entry(i, "hit\nphrase");
    const first = await board.grepLines("hit phrase");
    expect(first.hits).toEqual([]);
    expect(first.capped).toBe(true);
    expect(first.more).toBeTruthy();
    const rest = await board.grepLines("hit phrase", { more: first.more! });
    expect(rest.hits.map((h) => h.seq)).toEqual([1]);
    expect(rest.more).toBeNull();
  });
  it("resumes beyond GREP_RECENT rather than silently hiding older matches", async () => {
    const { board, entry } = fixture();
    entry(1, "1234");
    for (let i = 2; i <= GREP_RECENT + 2; i++) entry(i, "no digits");
    const first = await board.grepLines("^\\d{4}$", { regex: true });
    expect(first.hits).toEqual([]);
    expect(first.fallback).toBe(true);
    expect(first.more).toBeTruthy();
    const rest = await board.grepLines("^\\d{4}$", { regex: true, more: first.more! });
    expect(rest.hits.map((h) => h.seq)).toEqual([1]);
    expect(rest.more).toBeNull();
  });
  it("uses current task bodies for both paths, once per task", async () => {
    const { board, db, entry } = fixture();
    entry(1, "hit old task", null, "vedu", "task");
    db.exec("INSERT INTO tasks (seq, title, body, updated_at) VALUES (1, 'hit live title', '1234', 1)");
    db.exec("INSERT INTO search_idx (body, name, kind, ref) VALUES ('hit live title\n1234', '', 'task', '1')");
    expect((await pages(board, "hit", { max: 1 })).map((h) => h.text)).toEqual(["«hit» live title"]);
    expect((await pages(board, "^\\d{4}$", { regex: true })).map((h) => h.text)).toEqual(["«1234»"]);
  });
  it("enforces visibility and filters on each continuation, including files", async () => {
    const { board, entry, doc } = fixture();
    entry(1, "hit public", null, "jxn");
    entry(2, "hit own", "own");
    entry(3, "hit people", "people");
    doc("PLAN.md", "hit document");
    expect((await pages(board, "hit", { max: 1, files: true, viewer: { user: "jxn", person: false } })).map((h) => h.text)).toEqual(["«hit» document", "«hit» public"]);
    expect((await pages(board, "hit", { max: 1, files: true, author: "vedu", viewer: { user: "vedu", person: false } })).map((h) => h.text)).toEqual(["«hit» own"]);
    expect((await pages(board, "hit", { max: 1, sinceSeq: 1, viewer: { user: "vedu", person: true } })).map((h) => h.seq)).toEqual([3, 2]);
  });
  it("resumes after a character budget stop without skipping the remaining source", async () => {
    const { board, entry } = fixture();
    entry(1, Array.from({ length: 4500 }, (_, i) => "x".repeat(999) + i).join("\n") + "\n1234");
    const first = await board.grepLines("^\\d{4}$", { regex: true });
    expect(first.budget).toBe(true);
    expect(first.more).toBeTruthy();
    const second = await board.grepLines("^\\d{4}$", { regex: true, more: first.more! });
    expect(second.hits.map((h) => h.text)).toEqual(["«1234»"]);
  });
  it("moves from the recent scan into files, in date order, and continues past the file cap", async () => {
    const { board, db, entry, doc } = fixture();
    entry(1, "1234");
    doc("old.md", "1234\n1234\n5678");
    doc("new.md", "9012");
    db.prepare("UPDATE docs SET updated_at = ? WHERE name = 'old.md'").run(Date.UTC(2026, 9, 4));
    const hits = await pages(board, "^\\d{4}$", { regex: true, files: true, max: 1 });
    expect(hits.map((h) => h.seq ?? h.file)).toEqual([1, "old.md", "old.md", "new.md"]);
    expect(hits.map((h) => h.text)).toEqual(["«1234»", "«1234»", "«5678»", "«9012»"]);
    for (let i = 0; i < 51; i++) doc(`other-${i}.md`, "no match");
    const first = await board.grepLines("^\\d{4}$", { regex: true, files: true, sinceSeq: 1 });
    expect(first.more?.mode).toBe("docs");
    expect((await pages(board, "^\\d{4}$", { regex: true, files: true, sinceSeq: 1 })).filter((h) => h.file)).toHaveLength(3);
  });
});

describe("Board ranked search", () => {
  it("transports compact agent hits without their full entry bodies", async () => {
    const { board, entry } = fixture();
    entry(1, "checkout " + "detail ".repeat(1000));
    const agent = await board.searchLines("checkout");
    expect(agent.count).toBe(1);
    expect(agent.text).toContain("#1 · vedu · 10-02 · «checkout»");
    expect(JSON.stringify(agent).length).toBeLessThan(500);
    const full = await board.rankedSearch("checkout");
    expect(full.entries[0].entry.text.length).toBeGreaterThan(6000);
  });
  it("returns one compact line per hit while preserving entries and snippets; pages have no gaps", async () => {
    const { board, entry, reads } = fixture();
    for (let i = 1; i <= 55; i++) entry(i, `checkout result ${i}\nextra body detail`);
    reads.length = 0;
    const seen: number[] = [];
    let more: string | undefined;
    for (let i = 0; i < 10; i++) {
      const r = await board.rankedSearch("checkout", { limit: 7, more });
      expect(r.entries.length).toBeLessThanOrEqual(7);
      expect(r.compact.split("\n").filter((l) => l.startsWith("#"))).toHaveLength(r.entries.length);
      if (r.entries.length) expect(r.compact).toMatch(/#\d+ · vedu · 10-02 · .*«checkout»/);
      for (const hit of r.entries) { seen.push(hit.entry.seq); expect(hit.entry.text).toContain("extra body detail"); }
      if (!r.more) break;
      more = r.more;
    }
    expect(seen).toHaveLength(55);
    expect(new Set(seen).size).toBe(55);
    expect(reads.filter((r) => /SELECT seq, ts, author, type, text, edited_at/.test(r.sql)).every((r) => r.args.length <= 7)).toBe(true);
  });
  it("continues through more than 500 filtered candidates, and rejects changed queries/viewers", async () => {
    const { board, entry } = fixture();
    for (let i = 1; i <= 510; i++) entry(i, "checkout", null, i === 510 ? "jxn" : "vedu");
    const first = await board.rankedSearch("checkout", { author: "jxn" });
    expect(first.entries).toEqual([]);
    expect(first.more).toBeTruthy();
    const second = await board.rankedSearch("checkout", { author: "jxn", more: first.more! });
    expect(second.entries.map((h) => h.entry.seq)).toEqual([510]);
    await expect(board.rankedSearch("deploy", { author: "jxn", more: first.more! })).rejects.toThrow(/cursor/);
    await expect(board.rankedSearch("checkout", { author: "jxn", more: first.more! }, { user: "jxn", person: false })).rejects.toThrow(/cursor/);
  });
  it("doesn't duplicate task and entry index rows or reveal private entries", async () => {
    const { board, db, entry } = fixture();
    entry(1, "checkout task", null, "vedu", "task");
    entry(2, "checkout own", "own");
    entry(3, "checkout people", "people");
    db.exec("INSERT INTO tasks (seq, title, body, updated_at) VALUES (1, 'checkout task live', '', 1)");
    db.exec("INSERT INTO search_idx (body, name, kind, ref) VALUES ('checkout task live', '', 'task', '1')");
    const r = await board.rankedSearch("checkout", {}, { user: "vedu", person: false });
    expect(r.entries.map((h) => h.entry.seq).sort()).toEqual([1, 2]);
    expect(r.entries.find((h) => h.entry.seq === 1)!.snippet).toContain("live");
  });
});
