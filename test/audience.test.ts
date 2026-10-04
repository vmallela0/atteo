// Who sees a private entry (audience.ts): people-only (vedu #1264) and just mine (#1748). The board's every read goes
// through canSee / audienceOk, so these cover each viewer kind against each audience, in JS and in SQL.

import { describe, expect, it } from "vitest";
import { audienceNotice, audienceOk, canSee, forwardDestOk, OWN_NOTICE, peopleNotice } from "../src/audience";
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

describe("forwardDestOk", () => {
  it("allows everyone's messages anywhere; refuses just-mine; people-only only when the destination is exactly its people", () => {
    expect(forwardDestOk(everyone, ["vedu", "jxn", "sam"])).toEqual({ ok: true });
    expect(forwardDestOk(own, ["vedu"])).toEqual({ ok: false, reason: "just-mine" });
    expect(forwardDestOk(people, ["vedu", "jxn"])).toEqual({ ok: true, people: ["jxn", "vedu"] });
    expect(forwardDestOk(people, ["vedu"])).toEqual({ ok: false, reason: "people" });
    expect(forwardDestOk(people, ["vedu", "jxn", "sam"])).toEqual({ ok: false, reason: "people" });
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
