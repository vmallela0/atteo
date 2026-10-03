import { describe, expect, it } from "vitest";
import { cleanAt, cleanDays, cleanSchedule, cleanTz, daysLabel, lastDue, nextDue, ScheduleError, scheduleLabel, SCHEDULE_LATE_MS, taskText, tickAction, wallClock, zonedTime, type ScheduleSpec } from "../src/schedules";

const LA = "America/Los_Angeles";
const iso = (t: number | null) => (t == null ? null : new Date(t).toISOString());
const spec = (over: Partial<ScheduleSpec> = {}): ScheduleSpec => ({ at: "09:00", tz: LA, days: cleanDays("weekdays"), ...over });

describe("schedules: validation", () => {
  it("normalizes the time, the zone and the days", () => {
    expect(cleanAt("9:05")).toBe("09:05");
    expect(cleanAt(" 23:59 ")).toBe("23:59");
    for (const bad of ["24:00", "9", "09:60", "nine", null, 900]) expect(() => cleanAt(bad)).toThrow(ScheduleError);
    expect(cleanTz("UTC")).toBe("UTC");
    expect(cleanTz("America/Los_Angeles")).toBe(LA);
    expect(() => cleanTz("Mars/Olympus")).toThrow(/Unknown time zone/);
    expect(() => cleanTz("")).toThrow(ScheduleError);
    expect(cleanDays(undefined)).toEqual(["sun", "mon", "tue", "wed", "thu", "fri", "sat"]);
    expect(cleanDays("weekdays")).toEqual(["mon", "tue", "wed", "thu", "fri"]);
    expect(cleanDays(["Friday", "mon", "WED", "tues"])).toEqual(["mon", "tue", "wed", "fri"]);
    expect(cleanDays("sat,sun")).toEqual(["sun", "sat"]);
    expect(() => cleanDays(["funday"])).toThrow(/isn't a day/);
    expect(() => cleanDays(["m"])).toThrow(ScheduleError);
  });
  it("checks title and body, with UTC and every day by default", () => {
    expect(cleanSchedule({ title: "  Stand   up ", at: "9:00" })).toEqual({ title: "Stand up", body: "", at: "09:00", tz: "UTC", days: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] });
    expect(() => cleanSchedule({ title: "", at: "09:00" })).toThrow(/title/);
    expect(() => cleanSchedule({ title: "x".repeat(121), at: "09:00" })).toThrow(/120/);
    expect(() => cleanSchedule({ title: "x", body: "y".repeat(2001), at: "09:00" })).toThrow(/2000/);
    expect(() => cleanSchedule({ title: "x", at: "09:00", body: 5 })).toThrow(/body/);
  });
  it("labels days and the whole schedule", () => {
    expect(daysLabel(cleanDays("daily"))).toBe("daily");
    expect(daysLabel(cleanDays("weekdays"))).toBe("weekdays");
    expect(daysLabel(cleanDays("weekends"))).toBe("weekends");
    expect(daysLabel(cleanDays("mon,wed,fri"))).toBe("Mon, Wed, Fri");
    expect(scheduleLabel(spec())).toBe("weekdays 09:00 America/Los_Angeles");
  });
});

describe("schedules: due times", () => {
  it("reads the wall clock in a zone", () => {
    expect(wallClock(Date.UTC(2026, 9, 5, 16, 0), LA)).toEqual({ y: 2026, m: 10, d: 5, h: 9, mi: 0, s: 0 }); // PDT, UTC-7
    expect(wallClock(Date.UTC(2026, 11, 1, 0, 30), "Asia/Kolkata")).toEqual({ y: 2026, m: 12, d: 1, h: 6, mi: 0, s: 0 });
  });
  it("weekdays 09:00 Los Angeles: skips the weekend, in local time", () => {
    // Fri 2026-10-02 10:00 PDT → next is Mon 2026-10-05 09:00 PDT (16:00Z); the last was Fri 09:00 PDT.
    const fri10 = Date.UTC(2026, 9, 2, 17, 0);
    expect(iso(nextDue(spec(), fri10))).toBe("2026-10-05T16:00:00.000Z");
    expect(iso(lastDue(spec(), fri10))).toBe("2026-10-02T16:00:00.000Z");
    // Sunday: the last one is still Friday's.
    expect(iso(lastDue(spec(), Date.UTC(2026, 9, 4, 20, 0)))).toBe("2026-10-02T16:00:00.000Z");
    // Exactly at the time: that's the last one, and the next is the next weekday.
    const mon9 = Date.UTC(2026, 9, 5, 16, 0);
    expect(lastDue(spec(), mon9)).toBe(mon9);
    expect(iso(nextDue(spec(), mon9))).toBe("2026-10-06T16:00:00.000Z");
  });
  it("a zone ahead of UTC: the local date decides the weekday", () => {
    // 08:00 Mon in Tokyo is 23:00Z Sunday.
    const s = spec({ tz: "Asia/Tokyo", at: "08:00" });
    expect(iso(nextDue(s, Date.UTC(2026, 9, 3, 12, 0)))).toBe("2026-10-04T23:00:00.000Z"); // Sat noon Z → Mon 08:00 JST
  });
  it("UTC, every day", () => {
    const s = spec({ tz: "UTC", days: cleanDays("daily"), at: "00:00" });
    expect(iso(nextDue(s, Date.UTC(2026, 0, 31, 23, 59)))).toBe("2026-02-01T00:00:00.000Z");
    expect(iso(lastDue(s, Date.UTC(2026, 0, 31, 23, 59)))).toBe("2026-01-31T00:00:00.000Z");
  });
  it("DST: the same local time across the change; a missing time moves forward; a repeated one fires once", () => {
    const daily = spec({ days: cleanDays("daily") });
    // 2026-03-08: Los Angeles springs forward at 02:00 (PST −8 → PDT −7).
    expect(iso(nextDue(daily, Date.UTC(2026, 2, 7, 18, 0)))).toBe("2026-03-08T16:00:00.000Z"); // 09:00 PDT
    expect(iso(nextDue(daily, Date.UTC(2026, 2, 6, 18, 0)))).toBe("2026-03-07T17:00:00.000Z"); // 09:00 PST
    // 02:30 doesn't exist that day: it fires at 03:30 PDT.
    expect(iso(zonedTime(2026, 3, 8, 2, 30, LA))).toBe("2026-03-08T10:30:00.000Z");
    // 2026-11-01: back at 02:00 (PDT → PST); 01:30 happens twice, the first (PDT) one counts.
    expect(iso(zonedTime(2026, 11, 1, 1, 30, LA))).toBe("2026-11-01T08:30:00.000Z");
    const half1 = spec({ days: cleanDays("daily"), at: "01:30" });
    expect(iso(nextDue(half1, Date.UTC(2026, 10, 1, 8, 30)))).toBe("2026-11-02T09:30:00.000Z"); // not the second 01:30
    // Europe moves on a different day.
    expect(iso(zonedTime(2026, 3, 29, 9, 0, "Europe/Berlin"))).toBe("2026-03-29T07:00:00.000Z");
    expect(iso(zonedTime(2026, 3, 28, 9, 0, "Europe/Berlin"))).toBe("2026-03-28T08:00:00.000Z");
  });
  it("no days: never due", () => {
    expect(nextDue(spec({ days: [] }), Date.now())).toBeNull();
    expect(lastDue(spec({ days: [] }), Date.now())).toBeNull();
  });
});

describe("schedules: the cron tick", () => {
  const s = spec();
  const mon9 = Date.UTC(2026, 9, 5, 16, 0);
  it("fires once per due time, however many 5-minute ticks see it", () => {
    let handled = mon9 - 3 * 86_400_000; // Friday's
    const fired: number[] = [];
    for (let t = mon9 - 15 * 60_000; t <= mon9 + 45 * 60_000; t += 5 * 60_000) {
      const a = tickAction(s, handled, t);
      if (a) {
        if (a.act === "fire") fired.push(t);
        handled = a.due;
      }
    }
    expect(fired).toEqual([mon9]); // the tick at 09:00 itself
    expect(handled).toBe(mon9);
  });
  it("a late tick still fires (within the grace), a much later one skips it", () => {
    expect(tickAction(s, 0, mon9 + SCHEDULE_LATE_MS)).toEqual({ act: "fire", due: mon9 });
    expect(tickAction(s, 0, mon9 + SCHEDULE_LATE_MS + 1)).toEqual({ act: "skip", due: mon9 });
    expect(tickAction(s, mon9, mon9 + 60_000)).toBeNull(); // already handled
    expect(tickAction(s, 0, mon9 - 1)?.due).toBe(mon9 - 3 * 86_400_000); // before it: Friday's (long ago: skip)
  });
  it("the task says where it came from", () => {
    const t = taskText({ ...s, id: "sc_abc", title: "Standup", body: "- [ ] yesterday\n- [ ] today", created_by: "vedu" });
    expect(t.split("\n")[0]).toBe("🔁 Standup");
    expect(t).toContain("- [ ] today");
    expect(t).toContain("board schedule sc_abc (weekdays 09:00 America/Los_Angeles), set by vedu");
  });
});
