import { describe, expect, it } from "vitest";
import { countReaction, recentReactions, RECENT_REACTIONS } from "../src/social";

// A D1 stand-in over node:sqlite (Node 22+) running the real migration, so the SQL under test is the SQL that ships.
// node: modules have no types in this project (no @types/node), hence the casts.
const { DatabaseSync } = (await import("node:" + "sqlite")) as { DatabaseSync: new (p: string) => any };
const { readFileSync } = (await import("node:" + "fs")) as { readFileSync: (u: URL, enc: string) => string };
function fakeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../migrations/0047_reaction_usage.sql", (import.meta as unknown as { url: string }).url), "utf8"));
  const stmt = (sql: string, args: unknown[] = []): any => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => (db.prepare(sql).run(...args), { results: [] }),
  });
  const d1 = { prepare: (sql: string) => stmt(sql), batch: async (list: any[]) => Promise.all(list.map((s) => s.run())) } as unknown as D1Database;
  return { d1, rows: (user: string) => db.prepare("SELECT day, emoji, n FROM reaction_usage WHERE user = ? ORDER BY day, emoji").all(user) as { day: string; emoji: string; n: number }[] };
}

const DAY = 86400_000;
const T0 = Date.UTC(2026, 9, 3, 12);

describe("recent_reactions", () => {
  it("is empty until the person reacts", async () => {
    const { d1 } = fakeD1();
    expect(await recentReactions(d1, "vedu", T0)).toEqual([]);
  });

  it("orders by use, ties by the most recent, and keeps 8", async () => {
    const { d1 } = fakeD1();
    const use = async (emoji: string, times: number, at: number) => {
      for (let i = 0; i < times; i++) await countReaction(d1, "vedu", emoji, true, at + i);
    };
    await use("🎉", 1, T0);
    await use("🚀", 3, T0 - 5 * DAY); // used most, on an older day: counts add up across days
    await use("🚀", 1, T0);
    await use("👍", 2, T0 + 10);
    await use("🙏", 2, T0 + 20); // ties with 👍, used later
    expect(await recentReactions(d1, "vedu", T0 + DAY)).toEqual(["🚀", "🙏", "👍", "🎉"]);
    for (const [i, e] of ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣"].entries()) await use(e, 1, T0 - DAY + i); // 6️⃣ the latest
    const top = await recentReactions(d1, "vedu", T0 + DAY);
    expect(top).toHaveLength(RECENT_REACTIONS);
    expect(top.slice(0, 5)).toEqual(["🚀", "🙏", "👍", "🎉", "6️⃣"]);
  });

  it("taking a reaction back the same day uncounts it", async () => {
    const { d1 } = fakeD1();
    await countReaction(d1, "vedu", "🔥", true, T0);
    await countReaction(d1, "vedu", "🔥", false, T0 + 1);
    await countReaction(d1, "vedu", "🔥", false, T0 + 2); // never below zero
    expect(await recentReactions(d1, "vedu", T0)).toEqual([]);
    await countReaction(d1, "vedu", "🔥", true, T0 + 3);
    expect(await recentReactions(d1, "vedu", T0)).toEqual(["🔥"]);
  });

  it("counts the last 90 days only, and drops older rows as it writes", async () => {
    const { d1, rows } = fakeD1();
    await countReaction(d1, "vedu", "🐢", true, T0);
    await countReaction(d1, "vedu", "🐢", true, T0 + 1);
    await countReaction(d1, "vedu", "👍", true, T0 + 60 * DAY);
    expect(await recentReactions(d1, "vedu", T0 + 89 * DAY)).toEqual(["🐢", "👍"]); // day 90 of the window
    expect(await recentReactions(d1, "vedu", T0 + 90 * DAY)).toEqual(["👍"]); // read: out of the window without a scan
    expect(rows("vedu").map((r) => r.emoji)).toContain("🐢");
    await countReaction(d1, "vedu", "👍", true, T0 + 90 * DAY);
    expect(rows("vedu").map((r) => r.emoji)).not.toContain("🐢"); // write: old days deleted
  });

  it("is per person", async () => {
    const { d1 } = fakeD1();
    await countReaction(d1, "vedu", "🚀", true, T0);
    await countReaction(d1, "jxn", "🐙", true, T0);
    expect(await recentReactions(d1, "vedu", T0)).toEqual(["🚀"]);
    expect(await recentReactions(d1, "jxn", T0)).toEqual(["🐙"]);
  });
});
