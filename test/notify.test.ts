import { describe, expect, it } from "vitest";
import { classify, DEFAULT_PREFS, fallbackTz, inQuiet, lastDigestAt, mergePrefs, needsYou, NotifyError, type Level, type NotifyItem, type Quiet } from "../src/notify";
import { withInterrupts, type InboxItem } from "../src/inbox";

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

  it("a reminder coming back needs you, whatever it was; off and quiet hours still hold", () => {
    expect(needsYou({ kind: "reminder" })).toBe(true);
    expect(needsYou({ kind: "mention", broadcast: true, reminded: true })).toBe(true);
    expect(needsYou({ kind: "agent", reminded: true })).toBe(true);
    expect(classify({ kind: "mention", broadcast: true, reminded: true }, "needs_me", off, noon)).toBe("now");
    expect(classify({ kind: "agent", reminded: true }, "off", off, noon)).toBe("none");
    expect(classify({ kind: "reminder" }, "needs_me", { on: true, start: "11:00", end: "13:00", tz: "UTC" }, noon)).toBe("digest");
  });
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
  it("a same-day window, and start == end is all day", () => {
    expect(inQuiet({ ...q, start: "12:00", end: "14:00", tz: "UTC" }, at("2026-10-05T13:00:00Z"))).toBe(true);
    expect(inQuiet({ ...q, start: "12:00", end: "14:00", tz: "UTC" }, at("2026-10-05T15:00:00Z"))).toBe(false);
    expect(inQuiet({ ...q, start: "00:00", end: "00:00", tz: "UTC" }, noon)).toBe(true);
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
  it("a client time zone falls back to UTC when unknown", () => {
    expect(fallbackTz("Europe/Paris")).toBe("Europe/Paris");
    expect(fallbackTz("Nowhere/Land")).toBe("UTC");
    expect(fallbackTz(null)).toBe("UTC");
  });
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
