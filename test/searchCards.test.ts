import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
vi.stubGlobal("WebSocketRequestResponsePair", class {});
import { Board } from "../src/board";
import { CARD_BUDGET, entryCard } from "../src/searchCards";
import type { Env } from "../src/types";

const { DatabaseSync } = (await import("node:" + "sqlite")) as { DatabaseSync: new (p: string) => any };
const databases: any[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const sql = { exec(query: string, ...args: unknown[]) {
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
  const meta = board as unknown as { setMeta(k: string, v: string): void };
  meta.setMeta("id", "b_test");
  meta.setMeta("title", "Dev board");
  const entry = (seq: number, text: string, o: { audience?: string; to?: string[]; author?: string; type?: string; ts?: number } = {}) => {
    db.prepare("INSERT INTO entries (seq, ts, author, type, text, audience, to_people) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(seq, o.ts ?? Date.UTC(2026, 9, 2) + seq, o.author ?? "vedu", o.type ?? "note", text, o.audience ?? null, o.to ? JSON.stringify(o.to) : null);
    db.prepare("INSERT INTO search_idx (body, name, kind, ref) VALUES (?, '', 'entry', ?)").run(text, String(seq));
  };
  return { board, entry };
}
const agent = { user: "jxn", person: false };
const long = (i: number) => `Checkout retry ${i}: ` + "the payment worker backs off and retries the charge after a timeout. ".repeat(12);
const seqs = (text: string) => [...text.matchAll(/^#(\d+) /gm)].map((m) => Number(m[1]));

describe("agents' search cards (vedu #4105)", () => {
  it("one short card per hit: head, title, one marked match; never the whole body", () => {
    const card = entryCard({ seq: 42, type: "decision", author: "jxn", via: "agent", ts: Date.UTC(2026, 9, 5, 14, 2), text: long(1) }, "backs off and «retries» the charge", 7.25);
    const lines = card.split("\n");
    expect(lines[0]).toBe("#42 decision · jxn's agent · 2026-10-05 14:02 · rel 7.3");
    expect(lines[1].length).toBeLessThanOrEqual(102);
    expect(lines[2]).toBe("  match: backs off and «retries» the charge");
    expect(lines).toHaveLength(3);
    expect(entryCard({ seq: 1, type: "note", author: "vedu", ts: 1, text: "we deploy checkout to staging" }, "we deploy «checkout» to …", 1).split("\n"))
      .toEqual(["#1 note · vedu · 1970-01-01 00:00 · rel 1.0", "  we deploy checkout to staging", "  match: we deploy «checkout» to …"]);
    expect(entryCard({ seq: 2, type: "note", author: "vedu", ts: 1, text: "Release notes\n" + long(2) }, "", undefined)).toBe("#2 note · vedu · 1970-01-01 00:00\n  Release notes");
  });

  it("stays under the cap however many hits, and paging resumes after the last card shown", async () => {
    const { board, entry } = fixture();
    for (let i = 1; i <= 60; i++) entry(i, long(i));
    const seen: number[] = [];
    let more: string | undefined;
    for (let page = 0; page < 40; page++) {
      const r = await board.searchCards("checkout retries", { limit: 20, more }, agent);
      expect(r.text.length).toBeLessThanOrEqual(CARD_BUDGET); // ≈ 500 tokens, more and get lines included
      seen.push(...seqs(r.text));
      if (!r.more) break;
      more = r.more;
    }
    expect(seen.length).toBe(60);
    expect(new Set(seen).size).toBe(60);
  });

  it("never shows an agent what it can't see: People only, someone else's Just mine", async () => {
    const { board, entry } = fixture();
    entry(1, "zebra plan for everyone");
    entry(2, "zebra plan only for people", { audience: "people", to: ["jxn", "vedu"] });
    entry(3, "zebra plan just for vedu", { audience: "own", to: ["vedu"] });
    entry(4, "zebra plan just for jxn", { audience: "own", to: ["jxn"] });
    const r = await board.searchCards("zebra", {}, agent);
    expect(seqs(r.text).sort()).toEqual([1, 4]);
    expect(r.text).not.toContain("only for people");
    expect(r.text).not.toContain("just for vedu");
  });

  it("filters by author, type and since", async () => {
    const { board, entry } = fixture();
    entry(1, "deploy window old", { ts: Date.UTC(2026, 8, 1) });
    entry(2, "deploy window new", { ts: Date.UTC(2026, 9, 3), type: "decision", author: "jxn" });
    const ids = async (o: Record<string, unknown>) => seqs((await board.searchCards("deploy window", o, agent)).text);
    expect(await ids({ since: Date.UTC(2026, 9, 1) })).toEqual([2]);
    expect(await ids({ type: "decision" })).toEqual([2]);
    expect(await ids({ author: "vedu" })).toEqual([1]);
  });
});
