// Who sees a private entry (audience.ts): people-only (vedu #1264) and just mine (#1748). The board's every read goes
// through canSee / audienceOk, so these cover each viewer kind against each audience, in JS and in SQL.

import { describe, expect, it } from "vitest";
import { audienceNotice, audienceOk, canSee, forwardDestOk, forwardExcerptInEntry, keptOwnNotice, normalizeForwardExcerpt, OWN_DEFAULT_MS, ownByDefault, OWN_NOTICE, peopleNotice } from "../src/audience";
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

describe("normalizeForwardExcerpt", () => {
  it("strips markdown, links, blockquotes, list markers and collapses whitespace", () => {
    const entry = "> **Heads up**: see [the docs](https://x.test/p) and #12 for `port 8443`";
    expect(normalizeForwardExcerpt(entry)).toBe("Heads up: see the docs and #12 for port 8443");
    expect(normalizeForwardExcerpt("- one\n- two")).toBe("one two");
    expect(normalizeForwardExcerpt("1. first\n2. second")).toBe("first second");
  });
});

describe("forwardExcerptInEntry", () => {
  const rich = "> **Heads up**: see [the docs](https://x.test/p) and #12 for `port 8443`";

  describe("real board selections match", () => {
    it("markdown links, bold, blockquotes and code spans", () => {
      expect(forwardExcerptInEntry("Heads up: see the docs", rich)).toBe(true);
      expect(forwardExcerptInEntry("port 8443", rich)).toBe(true);
      expect(forwardExcerptInEntry("the docs", rich)).toBe(true);
    });

    it("italics with * and _", () => {
      const entry = "*emphasis* and _also_ here";
      expect(forwardExcerptInEntry("emphasis", entry)).toBe(true);
      expect(forwardExcerptInEntry("also", entry)).toBe(true);
      expect(forwardExcerptInEntry("emphasis and also", entry)).toBe(true);
    });

    it("ref chips stay as #N", () => {
      const entry = "Following up on #42: all set, and see #99 too.";
      expect(forwardExcerptInEntry("#42", entry)).toBe(true);
      expect(forwardExcerptInEntry("Following up on #42", entry)).toBe(true);
      expect(forwardExcerptInEntry("#42: all set", entry)).toBe(true);
    });

    it("CJK without spaces", () => {
      const entry = "这是中文测试没有空格";
      expect(forwardExcerptInEntry("中文测试", entry)).toBe(true);
      expect(forwardExcerptInEntry("这是中文", entry)).toBe(true);
    });

    it("emoji", () => {
      const entry = "Ship it 🚀 now 👍🏽";
      expect(forwardExcerptInEntry("🚀", entry)).toBe(true);
      expect(forwardExcerptInEntry("Ship it 🚀", entry)).toBe(true);
      expect(forwardExcerptInEntry("👍🏽", entry)).toBe(true);
    });

    it("NBSP", () => {
      const entry = "hello\u00A0world";
      expect(forwardExcerptInEntry("hello world", entry)).toBe(true);
    });

    it("CRLF", () => {
      const entry = "line one\r\nline two\r\nline three";
      expect(forwardExcerptInEntry("line one line two", entry)).toBe(true);
      expect(forwardExcerptInEntry("line two line three", entry)).toBe(true);
    });

    it("a 2,000-char excerpt", () => {
      const tail = "end marker";
      const pad = "x".repeat(2000 - tail.length);
      const entry = pad + tail;
      expect(entry.length).toBe(2000);
      expect(forwardExcerptInEntry(pad.slice(-500) + tail, entry)).toBe(true);
      expect(forwardExcerptInEntry(entry.slice(0, 2000), entry)).toBe(true);
    });

    it("list items selected without bullet markers", () => {
      const entry = "- item one\n- item two\n- item three";
      expect(forwardExcerptInEntry("item one", entry)).toBe(true);
      expect(forwardExcerptInEntry("item one item two", entry)).toBe(true);
      expect(forwardExcerptInEntry("item two item three", entry)).toBe(true);
    });

    it("angle-bracket autolinks", () => {
      const entry = "see <https://example.com/path> for more";
      expect(forwardExcerptInEntry("https://example.com/path", entry)).toBe(true);
    });

    it("fenced code blocks", () => {
      const entry = "run:\n```js\nconst x = 1;\n```\nafter";
      expect(forwardExcerptInEntry("const x = 1", entry)).toBe(true);
    });
  });

  describe("fabricated selections do not match", () => {
    it("words not in the message", () => {
      expect(forwardExcerptInEntry("fabricated words", rich)).toBe(false);
      expect(forwardExcerptInEntry("port 9999", rich)).toBe(false);
    });

    it("link URL when only the label is in the message", () => {
      expect(forwardExcerptInEntry("https://x.test/p", rich)).toBe(false);
    });

    it("ref chip title instead of #N", () => {
      const entry = "Following up on #42: all set.";
      expect(forwardExcerptInEntry("Ship on Friday", entry)).toBe(false);
      expect(forwardExcerptInEntry("#43", entry)).toBe(false);
    });

    it("wrong CJK", () => {
      const entry = "这是中文测试";
      expect(forwardExcerptInEntry("这是英文", entry)).toBe(false);
    });

    it("empty or whitespace-only", () => {
      expect(forwardExcerptInEntry("", rich)).toBe(false);
      expect(forwardExcerptInEntry("   \n\t  ", rich)).toBe(false);
    });

    it("list text that is not contiguous in the message", () => {
      const entry = "- alpha\nmiddle prose\n- beta";
      expect(forwardExcerptInEntry("alpha beta", entry)).toBe(false);
    });
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
