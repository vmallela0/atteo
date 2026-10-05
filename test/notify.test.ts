import { describe, expect, it } from "vitest";
import { classify, DEFAULT_PREFS, fallbackTz, inQuiet, lastDigestAt, mergePrefs, needsYou, NotifyError, QUIET_SAME, type Level, type NotifyItem, type Quiet } from "../src/notify";
import { digestDue, withInterrupts, type InboxItem } from "../src/inbox";

const off: Quiet = { on: false, start: "22:00", end: "07:00", tz: "UTC" };
const at = (iso: string) => Date.parse(iso);
const noon = at("2026-10-05T12:00:00Z");

describe("notify: what needs you", () => {
  const cases: [NotifyItem, boolean][] = [
    [{ kind: "approval" }, true],
    [{ kind: "decision" }, true],
    [{ kind: "reply" }, true],
    [{ kind: "people_only" }, true],
    [{ kind: "friend_request" }, true],
    [{ kind: "contact_request" }, true],
    [{ kind: "mention" }, true],
    [{ kind: "mention", broadcast: true }, false], // @all / @humans
    [{ kind: "agent" }, false], // a post for your agent on a shared board
    [{ kind: "agent", direct: true }, true], // a DM
    [{ kind: "friend_accept" }, false],
    [{ kind: "contact_accept" }, false],
  ];
  for (const [item, want] of cases) it(`${item.kind}${item.broadcast ? " (broadcast)" : ""}${item.direct ? " (DM)" : ""} → ${want}`, () => expect(needsYou(item)).toBe(want));
});

describe("notify: classify by level", () => {
  const levels: Level[] = ["everything", "needs_me", "off"];
  const kinds: NotifyItem[] = [{ kind: "mention" }, { kind: "mention", broadcast: true }, { kind: "agent" }, { kind: "approval", risk: "low" }];
  const want: Record<Level, string[]> = {
    everything: ["now", "now", "now", "now"],
    needs_me: ["now", "digest", "digest", "now"],
    off: ["none", "none", "none", "none"],
  };
  for (const l of levels) it(l, () => expect(kinds.map((k) => classify(k, l, off, noon))).toEqual(want[l]));
  it("Mark as unread (your own marker) never interrupts, at any level", () => {
    for (const l of levels) expect(classify({ kind: "manual_unread" }, l, off, noon)).toBe("none");
  });
});

describe("notify: quiet hours", () => {
  const q: Quiet = { on: true, start: "22:00", end: "07:00", tz: "America/Los_Angeles" };
  it("overnight window, in the person's time zone", () => {
    expect(inQuiet(q, at("2026-10-06T06:00:00Z"))).toBe(true); // 23:00 PDT
    expect(inQuiet(q, at("2026-10-06T13:30:00Z"))).toBe(true); // 06:30 PDT
    expect(inQuiet(q, at("2026-10-06T14:00:00Z"))).toBe(false); // 07:00 PDT: end is exclusive
    expect(inQuiet(q, at("2026-10-06T05:00:00Z"))).toBe(true); // 22:00 PDT: start is inclusive
    expect(inQuiet(q, at("2026-10-06T19:00:00Z"))).toBe(false); // noon PDT
  });
  it("a same-day window; start == end (only an old row can have it) is no window at all", () => {
    expect(inQuiet({ ...q, start: "12:00", end: "14:00", tz: "UTC" }, at("2026-10-05T13:00:00Z"))).toBe(true);
    expect(inQuiet({ ...q, start: "12:00", end: "14:00", tz: "UTC" }, at("2026-10-05T15:00:00Z"))).toBe(false);
    expect(inQuiet({ ...q, start: "00:00", end: "00:00", tz: "UTC" }, noon)).toBe(false);
  });
  it("off means never quiet", () => expect(inQuiet({ ...q, on: false }, at("2026-10-06T06:00:00Z"))).toBe(false));
  it("follows DST: 23:00 local is quiet in both PDT and PST", () => {
    expect(inQuiet(q, at("2026-10-31T06:00:00Z"))).toBe(true); // 23:00 PDT
    expect(inQuiet(q, at("2026-11-02T07:00:00Z"))).toBe(true); // 23:00 PST (after the switch)
    expect(inQuiet(q, at("2026-11-02T06:00:00Z"))).toBe(true); // 22:00 PST
    expect(inQuiet(q, at("2026-11-02T05:30:00Z"))).toBe(false); // 21:30 PST
  });
  it("holds 'now' items for the digest, except urgent (high-risk) approvals; never changes digest or none", () => {
    const night = at("2026-10-06T06:00:00Z");
    expect(classify({ kind: "mention" }, "needs_me", q, night)).toBe("digest");
    expect(classify({ kind: "mention" }, "everything", q, night)).toBe("digest");
    expect(classify({ kind: "approval", risk: "medium" }, "needs_me", q, night)).toBe("digest");
    expect(classify({ kind: "approval", risk: "high" }, "needs_me", q, night)).toBe("now");
    expect(classify({ kind: "agent" }, "needs_me", q, night)).toBe("digest");
    expect(classify({ kind: "approval", risk: "high" }, "off", q, night)).toBe("none");
  });
});

describe("notify: digest slots", () => {
  it("the latest slot that passed, in the person's time zone", () => {
    const p = { ...DEFAULT_PREFS, quiet: { ...off, tz: "Europe/Berlin" } };
    expect(lastDigestAt(p, at("2026-10-05T12:30:00Z"))).toBe(at("2026-10-05T11:00:00Z")); // 14:30 CEST → the 13:00 slot
    expect(lastDigestAt(p, at("2026-10-05T06:00:00Z"))).toBe(at("2026-10-04T16:00:00Z")); // 08:00 → yesterday 18:00
  });
  it("skips slots inside quiet hours", () => {
    const p = { quiet: { on: true, start: "08:00", end: "10:00", tz: "UTC" }, digest: ["09:00", "13:00"] };
    expect(lastDigestAt(p, at("2026-10-05T09:30:00Z"))).toBe(at("2026-10-04T13:00:00Z"));
    expect(lastDigestAt(p, at("2026-10-05T13:30:00Z"))).toBe(at("2026-10-05T13:00:00Z"));
  });
  it("across DST, each slot is local time", () => {
    const p = { ...DEFAULT_PREFS, quiet: { ...off, tz: "America/New_York" } };
    expect(lastDigestAt(p, at("2026-11-02T15:00:00Z"))).toBe(at("2026-11-02T14:00:00Z")); // 10:00 EST → 09:00 EST
    expect(lastDigestAt(p, at("2026-10-30T14:00:00Z"))).toBe(at("2026-10-30T13:00:00Z")); // 10:00 EDT → 09:00 EDT
  });
});

describe("notify: settings input", () => {
  it("merges partial updates and keeps the rest", () => {
    const p = mergePrefs(DEFAULT_PREFS, { quiet: { on: true, tz: "Europe/Berlin" } });
    expect(p.quiet).toEqual({ on: true, start: "22:00", end: "07:00", tz: "Europe/Berlin" });
    expect(mergePrefs(p, { digest: ["18:00", "9:05", "18:00"] }).digest).toEqual(["09:05", "18:00"]);
  });
  it("refuses bad values", () => {
    for (const bad of [null, [], { quiet: "x" }, { quiet: { on: "yes" } }, { quiet: { start: "25:00" } }, { quiet: { tz: "Mars/Base" } }, { quiet: { color: 1 } }, { digest: [] }, { digest: ["9am"] }, { digest: Array(7).fill("09:00") }, { theme: "dark" }])
      expect(() => mergePrefs(DEFAULT_PREFS, bad), JSON.stringify(bad)).toThrow(NotifyError);
  });
  it("refuses quiet hours that start and end at the same time, however it gets there", () => {
    expect(() => mergePrefs(DEFAULT_PREFS, { quiet: { start: "07:00" } })).toThrow(QUIET_SAME); // end is 07:00 already
    expect(() => mergePrefs(DEFAULT_PREFS, { quiet: { on: true, start: "09:30", end: "9:30" } })).toThrow(QUIET_SAME);
    expect(() => mergePrefs({ ...DEFAULT_PREFS, quiet: { ...DEFAULT_PREFS.quiet, start: "08:00", end: "08:00" } }, { quiet: { on: true } })).toThrow(QUIET_SAME);
    expect(mergePrefs(DEFAULT_PREFS, { quiet: { start: "07:00", end: "08:00" } }).quiet).toMatchObject({ start: "07:00", end: "08:00" });
    expect(mergePrefs({ ...DEFAULT_PREFS, quiet: { ...DEFAULT_PREFS.quiet, start: "08:00", end: "08:00" } }, { digest: ["10:00"] }).digest).toEqual(["10:00"]); // a digest change alone is fine
  });
  it("a client time zone falls back to UTC when unknown", () => {
    expect(fallbackTz("Europe/Paris")).toBe("Europe/Paris");
    expect(fallbackTz("Nowhere/Land")).toBe("UTC");
    expect(fallbackTz(null)).toBe("UTC");
  });
});

describe("notify: the digest that's due (#2668)", () => {
  // A fake D1: returns the rows whose created_at is inside the bound window, as the real query does.
  const env = (rows: Record<string, unknown>[]) => {
    const seen: unknown[][] = [];
    return {
      seen,
      env: { DB: { prepare: () => ({ bind: (...a: unknown[]) => { seen.push(a); return { all: async () => ({ results: rows.filter((r) => (r.created_at as number) > (a[1] as number) && (r.created_at as number) <= (a[2] as number)) }) }; } }) } } as never,
    };
  };
  const row = (id: number, kind: string, created_at: number, board = "b_a", title = "Alpha", data: string | null = null) => ({ id, board_id: board, board_title: title, board_kind: null, seq: id, kind, actor: "maya", actor_via: "agent", entry_type: "note", excerpt: "x", created_at, read_at: null, data });
  const prefs = { ...DEFAULT_PREFS, quiet: { ...off, tz: "UTC" } }; // slots 09:00, 13:00, 18:00 UTC
  const due = at("2026-10-05T13:00:00Z"), prev = at("2026-10-05T09:00:00Z");
  it("counts every digest item since the slot before, not one per poll, and not the ones that interrupted", async () => {
    const rows = [1, 2, 3, 4, 5].map((i) => row(i, "agent", prev + i * 60_000)) // five posts for your agent in five minutes
      .concat([row(6, "mention", prev + 10 * 60_000, "b_b", "Beta")]) // a direct @you after them: interrupted, not in the digest
      .concat([row(7, "agent", prev + 11 * 60_000, "b_b", "Beta")])
      .concat([row(8, "agent", prev - 60_000)]); // before the previous slot: an earlier digest's
    const { env: e, seen } = env(rows);
    const d = await digestDue(e, "vedu", {}, prefs, due);
    expect(d).toEqual({ n: 6, boards: ["Alpha", "Beta"] });
    expect(seen[0].slice(1, 3)).toEqual([prev, due]); // the window: (previous slot, this slot]
  });
  it("uses each item's board level, and quiet hours as they were when it arrived", async () => {
    const q = { ...prefs, quiet: { on: true, start: "10:00", end: "11:00", tz: "UTC" } };
    const rows = [row(1, "mention", at("2026-10-05T10:30:00Z")), row(2, "mention", at("2026-10-05T11:30:00Z")), row(3, "agent", at("2026-10-05T12:00:00Z"), "b_loud"), row(4, "agent", at("2026-10-05T12:10:00Z"), "b_off")];
    const d = await digestDue(env(rows).env, "vedu", { b_loud: "everything", b_off: "off" }, q, due);
    expect(d?.n).toBe(1); // only the mention that arrived in quiet hours; the 11:30 one interrupted, loud ones interrupted, off ones never
  });
  it("nothing due yet: null", async () => expect(await digestDue(env([]).env, "vedu", {}, prefs, null)).toBeNull());
});

describe("notify: inbox items", () => {
  const base = { id: 1, board_title: "B", seq: 1, actor: "maya", actor_via: "person", entry_type: "note", excerpt: "x", created_at: 0, read_at: null } as const;
  it("uses each board's level, the approval's board, and the DM flag", () => {
    const items: InboxItem[] = [
      { ...base, board_id: "b_loud", kind: "agent" },
      { ...base, board_id: "b_quiet", kind: "mention" },
      { ...base, board_id: "b_x", kind: "mention", broadcast: true },
      { ...base, board_id: "b_dm", kind: "agent", board_kind: "direct" },
      { ...base, board_id: "", kind: "approval", push: { kind: "approval_needed", title: "t", body: "b", url: "/", approval: "a", board: "b_quiet", risk: "low" } },
      { ...base, board_id: "", kind: "friend_accept" },
    ];
    expect(withInterrupts(items, { b_loud: "everything", b_quiet: "off" }, DEFAULT_PREFS, noon).map((i) => i.interrupt)).toEqual(["now", "none", "digest", "now", "none", "digest"]);
  });
});
