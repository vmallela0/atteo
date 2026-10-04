// Who sees a private entry (audience.ts): people-only (vedu #1264) and just mine (#1748). The board's every read goes
// through canSee / audienceOk, so these cover each viewer kind against each audience, in JS and in SQL.

import { describe, expect, it } from "vitest";
import { audienceNotice, audienceOk, canSee, keptOwnNotice, OWN_DEFAULT_MS, ownByDefault, OWN_NOTICE, peopleNotice } from "../src/audience";
import type { Entry, Viewer } from "../src/types";

const { DatabaseSync } = (await import("node:" + "sqlite")) as { DatabaseSync: new (p: string) => any };

const person = (user: string): Viewer => ({ user, person: true });
const agent = (user: string): Viewer => ({ user, person: false });

const everyone = {};
const own = { audience: "own" as const, to_people: ["vedu"] }; // vedu's lane
const people = { audience: "people" as const, to_people: ["vedu", "jxn"] }; // vedu → jxn, people only

// [viewer label, viewer, sees everyone's, sees vedu's own lane, sees the vedu+jxn people-only one]
const CASES: [string, Viewer | null, boolean, boolean, boolean][] = [
  ["vedu (the person)", person("vedu"), true, true, true],
  ["vedu's agent", agent("vedu"), true, true, false],
  ["jxn (another person)", person("jxn"), true, false, true],
  ["jxn's agent", agent("jxn"), true, false, false],
  ["sam (outsider person)", person("sam"), true, false, false],
  ["sam's agent", agent("sam"), true, false, false],
  ["nobody said (ops / no viewer)", null, true, false, false],
];

describe("canSee", () => {
  for (const [label, v, e, o, p] of CASES) {
    it(label, () => {
      expect(canSee(everyone, v)).toBe(e);
      expect(canSee(own, v)).toBe(o);
      expect(canSee(people, v)).toBe(p);
    });
  }
  it("an own entry is never for someone else's agent, even one named in it by mistake", () => {
    expect(canSee({ audience: "own", to_people: ["vedu"] }, agent("vedua"))).toBe(false);
    expect(canSee({ audience: "own", to_people: [] }, agent("vedu"))).toBe(false);
  });
});

describe("audienceOk (the same rule in SQL)", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE entries (seq INTEGER PRIMARY KEY, audience TEXT, to_people TEXT)");
  db.exec(`INSERT INTO entries VALUES (1, NULL, NULL), (2, 'own', '["vedu"]'), (3, 'people', '["vedu","jxn"]'), (4, 'own', '["jxn"]')`);
  const seen = (v: Viewer | null, alias = "") => {
    const ok = audienceOk(v, alias);
    const from = alias ? `entries ${alias.slice(0, -1)}` : "entries";
    return db.prepare(`SELECT ${alias}seq AS seq FROM ${from} WHERE ${ok.sql} ORDER BY ${alias}seq`).all(...ok.args).map((r: { seq: number }) => r.seq);
  };
  it("matches canSee for every viewer", () => {
    for (const [label, v] of CASES) {
      const rows: (Pick<Entry, "audience" | "to_people"> & { seq: number })[] = [{ seq: 1, audience: undefined }, { seq: 2, ...own }, { seq: 3, ...people }, { seq: 4, audience: "own", to_people: ["jxn"] }];
      expect(seen(v), label).toEqual(rows.filter((r) => canSee(r, v)).map((r) => r.seq));
    }
  });
  it("concretely: the owner's agent gets its lane, not the people-only one; another agent gets neither", () => {
    expect(seen(agent("vedu"))).toEqual([1, 2]);
    expect(seen(person("vedu"))).toEqual([1, 2, 3]);
    expect(seen(agent("jxn"))).toEqual([1, 4]);
    expect(seen(person("jxn"))).toEqual([1, 3, 4]);
    expect(seen(agent("sam"))).toEqual([1]);
    expect(seen(null)).toEqual([1]);
  });
  it("works with a table alias", () => {
    expect(seen(agent("vedu"), "e.")).toEqual([1, 2]);
  });
});

describe("notices", () => {
  it("says who can see it", () => {
    expect(audienceNotice(own, "vedu")).toBe(OWN_NOTICE);
    expect(audienceNotice(people, "vedu")).toBe(peopleNotice("vedu", ["vedu", "jxn"]));
    expect(peopleNotice("vedu", ["vedu", "jxn"])).toBe("Only you and jxn can see this. Agents can't.");
    expect(audienceNotice({}, "vedu")).toBeNull();
  });
});

describe("ownByDefault: an agent's top-level post right after its person's Just mine message stays in the lane", () => {
  const now = 1_000_000_000;
  type R = Parameters<typeof ownByDefault>[1][number];
  const e = (seq: number, over: Partial<R> = {}): R => ({ seq, ts: now - 60_000, author: "jxn", via: "person", to: null, mentions: [], ...over });
  const lane = (seq: number, over: Partial<R> = {}) => e(seq, { author: "vedu", via: "person", audience: "own", ...over });

  it("keeps it when the last thing the agent read is its person's own message", () => {
    expect(ownByDefault("vedu", [lane(5), e(4)], 5, now)).toBe("vedu");
  });
  it("keeps it when that message came as mail, not read yet (a dispatcher's fork)", () => {
    expect(ownByDefault("vedu", [lane(5), e(4)], 3, now)).toBe("vedu");
  });
  it("skips what the agent hasn't got: a newer public post it hasn't read doesn't count", () => {
    expect(ownByDefault("vedu", [e(6), lane(5)], 5, now)).toBe("vedu");
  });
  it("doesn't when something public came after it, read or addressed to the agent", () => {
    expect(ownByDefault("vedu", [e(6), lane(5)], 6, now)).toBeNull();
    expect(ownByDefault("vedu", [e(6, { to: "vedu" }), lane(5)], 5, now)).toBeNull();
    expect(ownByDefault("vedu", [e(6, { mentions: [{ user: "vedu", agent: true }] }), lane(5)], 5, now)).toBeNull();
  });
  it("only after ten minutes' quiet does it post publicly again", () => {
    expect(ownByDefault("vedu", [lane(5, { ts: now - OWN_DEFAULT_MS - 1 })], 5, now)).toBeNull();
    expect(ownByDefault("vedu", [lane(5, { ts: now - OWN_DEFAULT_MS + 1000 })], 5, now)).toBe("vedu");
  });
  it("only its own person's own message: not another lane, not an agent's, not one for another of its sessions", () => {
    expect(ownByDefault("vedu", [lane(5, { author: "jxn" })], 5, now)).toBeNull();
    expect(ownByDefault("vedu", [lane(5, { via: "agent" })], 5, now)).toBeNull();
    expect(ownByDefault("vedu", [e(5, { author: "vedu" })], 5, now)).toBeNull(); // the person's public post
    const forScout = lane(5, { mentions: [{ user: "vedu", agent: true, session: "scout" }] });
    expect(ownByDefault("vedu", [forScout], 4, now, "builder")).toBeNull();
    expect(ownByDefault("vedu", [forScout], 4, now, "scout")).toBe("vedu");
  });
  it("nothing recent: public", () => {
    expect(ownByDefault("vedu", [], 0, now)).toBeNull();
  });
  it("says so, with the way out", () => {
    expect(keptOwnNotice("vedu")).toBe("Kept in Just mine (your last message from vedu was private); pass own: false to post publicly.");
  });
});
