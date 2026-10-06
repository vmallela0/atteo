import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(public ctx: unknown, public env: unknown) {}
  },
}));
vi.stubGlobal("WebSocketRequestResponsePair", class {});
import { Board, LIVE_CARD_MS } from "../src/board";
import type { Env } from "../src/types";

const { DatabaseSync } = await import("node:" + "sqlite");
const NOW = Date.UTC(2026, 9, 5);
const opts = { via: "agent", session: "as_one", session_name: "scout" };
let db: any;
let board: any;
let allowed: boolean;
let post: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  allowed = true;
  db = new DatabaseSync(":memory:");
  const sql = {
    exec(query: string, ...args: unknown[]) {
      if (!args.length && query.includes(";")) {
        db.exec(query.replace(/CREATE VIRTUAL TABLE IF NOT EXISTS search_idx USING fts5\([^;]*\);/, "CREATE TABLE IF NOT EXISTS search_idx (body TEXT, name TEXT, kind TEXT, ref TEXT);"));
        return { toArray: () => [], one: () => undefined };
      }
      const stmt = db.prepare(query);
      const returns = /^\s*(select|pragma|with|explain)\b/i.test(query) || /\breturning\b/i.test(query);
      const rows = returns ? stmt.all(...args) : (stmt.run(...args), []);
      return { toArray: () => rows, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
    },
  };
  board = new Board({ storage: { sql }, setWebSocketAutoResponse() {}, getWebSockets: () => [] } as unknown as DurableObjectState, {
    DB: { prepare: () => ({ bind: () => ({ first: async () => allowed ? { k: 1 } : null }) }) },
  } as unknown as Env);
  board.setMeta("id", "b_livetest");
  board.setMeta("title", "Live share");
  board.setMeta("created_by", "ada");
  board.setMeta("created_at", "1");
  post = vi.spyOn(board, "post").mockImplementation(async (_user: unknown, input: any) => {
    const r = db.prepare("INSERT INTO entries (ts, author, type, text, title) VALUES (?, 'ada', 'note', ?, ?) RETURNING seq").get(NOW, input.text, input.title);
    return { seq: r.seq };
  });
});
afterEach(() => { db.close(); vi.restoreAllMocks(); });
const finish = (seq: number, title = `Task ${seq}`, session = opts) => board.appendLiveTask("ada", session, { seq, title });
const card = () => db.prepare("SELECT * FROM entries ORDER BY seq LIMIT 1").get();

describe("live-share task completion cards", () => {
  it("requires a rule and a named agent session; updates one card in place", async () => {
    allowed = false;
    await finish(10);
    allowed = true;
    await finish(10, "person", { ...opts, via: "person" });
    await finish(10, "token only", { ...opts, session: "" });
    expect(post).not.toHaveBeenCalled();
    await finish(10);
    await finish(11);
    expect(post).toHaveBeenCalledTimes(1);
    expect(card().text).toBe("Live · ada/scout\n- #10 Task 10\n- #11 Task 11");
    expect(await board.liveSummaryLines()).toEqual([{ who: "ada/scout", line: "#11 Task 11" }]);
  });

  it("serializes concurrent completions into one card", async () => {
    await Promise.all([finish(10), finish(11), finish(10)]);
    expect(post).toHaveBeenCalledTimes(1);
    expect(card().text).toBe("Live · ada/scout\n- #10 Task 10\n- #11 Task 11");
  });

  it("keeps only 20 lines and never repeats a task after its line rolls off", async () => {
    for (let seq = 10; seq <= 30; seq++) await finish(seq);
    expect(card().text.split("\n")).toHaveLength(21);
    expect(card().text).not.toContain("#10 Task 10");
    const before = card().text;
    await finish(10);
    await finish(30);
    expect(card().text).toBe(before);
  });

  it("filters the full task title before truncating it, on both creation and updates", async () => {
    const token = ["ghp", "_", "Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Jh1Gf0Ed9Cb8A"].join("");
    const title = "x".repeat(140) + " " + token;
    await finish(10, title);
    expect(post).not.toHaveBeenCalled();
    await finish(11);
    await finish(12, title);
    expect(card().text).toBe("Live · ada/scout\n- #11 Task 11");
  });

  it("freezes on rule expiry or revoke even without another task completion", async () => {
    await finish(10);
    allowed = false;
    expect(await board.liveSummaryLines()).toEqual([]);
    expect(card().title).toContain("stopped");
    allowed = true;
    await finish(11);
    expect(card().text).not.toContain("#11");
  });

  it("freezes at eight hours and on explicit Stop", async () => {
    await finish(10);
    vi.mocked(Date.now).mockReturnValue(NOW + LIVE_CARD_MS);
    expect(await board.liveSummaryLines()).toEqual([]);
    expect(card().title).toContain("stopped");
    await finish(11);
    expect(card().text).not.toContain("#11");
    vi.mocked(Date.now).mockReturnValue(NOW);
    await finish(12, "Other session", { ...opts, session: "as_two" });
    expect(await board.freezeLiveCards("ada", "as_two")).toEqual({ frozen: 1 });
    await finish(13, "After Stop", { ...opts, session: "as_two" });
    expect(db.prepare("SELECT text FROM entries ORDER BY seq DESC LIMIT 1").get().text).not.toContain("#13");
  });

  it.each(["purged", "retained_at"])("does not restore a %s card through updates or Stop", async (column) => {
    await finish(10);
    db.prepare(`UPDATE entries SET text = '(removed)', ${column} = ?`).run(column === "purged" ? '{"by":"ada","via":"person"}' : NOW);
    await finish(11);
    await board.freezeLiveCards("ada", "as_one");
    expect(card().text).toBe("(removed)");
    expect(await board.liveSummaryLines()).toEqual([]);
    expect(db.prepare("SELECT lines FROM live_cards").get().lines).toBe("[]");
  });
});
