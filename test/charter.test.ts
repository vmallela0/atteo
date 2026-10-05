// Board charter: goal, data classes, retention, and a note for each member. The columns persist, and Board info shows them.

import { describe, expect, it } from "vitest";
import {
  applyCharter,
  charterAuditDetail,
  charterBinds,
  charterScanFields,
  charterView,
  emptyStored,
  parseCharterPatch,
  storedFromRow,
} from "../src/charter";
import { charterJs } from "../src/charterUi";
import { boardPage } from "../src/html";
import type { BoardInfo, Entry } from "../src/types";

const { DatabaseSync } = (await import("node:" + "sqlite")) as { DatabaseSync: new (p: string) => any };
const { readFileSync } = (await import("node:" + "fs")) as { readFileSync: (u: URL, enc: string) => string };
const migrationUrl = new URL("../migrations/0062_board_charter.sql", (import.meta as unknown as { url: string }).url);

const members = [
  { user: "ada", role: "owner" as const },
  { user: "grace", role: "contributor" as const },
];

describe("charter fields", () => {
  it("reads a write back: goal, data classes, retention, and member notes", () => {
    const patch = parseCharterPatch({
      goal: "  Ship checkout\nwithout storing cards  ",
      data_classes: "Internal, customer PII, internal",
      retention_days: "90",
      members: [
        { user: "ada", role: "owner", note: "  eng lead  " },
        { user: "grace", note: "" },
      ],
    });
    const stored = applyCharter(emptyStored(), patch, ["ada", "grace"]);
    expect(stored).toEqual({
      goal: "Ship checkout\nwithout storing cards",
      data_classes: ["internal", "customer-pii"],
      retention_days: 90,
      notes: { ada: "eng lead" },
    });
    const view = charterView(stored, members);
    expect(view.members).toEqual([
      { user: "ada", role: "owner", note: "eng lead" },
      { user: "grace", role: "contributor", note: null },
    ]);
    expect(charterAuditDetail(stored)).toContain("keep 90 days");
    expect(charterScanFields(stored, patch).goal).toContain("Ship checkout");
  });

  it("leaves out fields alone, clears retention, and drops a note for someone who left", () => {
    const current = applyCharter(
      emptyStored(),
      parseCharterPatch({ goal: "Ship checkout", data_classes: ["internal"], retention_days: 30, members: { ada: "eng lead", grace: "design" } }),
      ["ada", "grace"],
    );
    const next = applyCharter(current, parseCharterPatch({ retention_days: null }), ["ada"]);
    expect(next.goal).toBe("Ship checkout");
    expect(next.data_classes).toEqual(["internal"]);
    expect(next.retention_days).toBeNull();
    expect(next.notes).toEqual({ ada: "eng lead" });
    expect(() => applyCharter(current, parseCharterPatch({ members: [{ user: "eve", note: "guest" }] }), ["ada"])).toThrow(/isn't a member/);
  });

  it("refuses a goal, a label, a note, or a retention period that doesn't fit", () => {
    expect(() => parseCharterPatch({ goal: "x".repeat(501) })).toThrow(/500/);
    expect(() => parseCharterPatch({ data_classes: ["!!!"] })).toThrow(/letters, digits and hyphens/);
    expect(() => parseCharterPatch({ data_classes: Array.from({ length: 13 }, (_, i) => `c${i}`) })).toThrow(/12/);
    expect(() => parseCharterPatch({ members: { ada: "x".repeat(121) } })).toThrow(/120/);
    expect(() => parseCharterPatch({ retention_days: 3651 })).toThrow(/1–3650/);
    expect(parseCharterPatch({ retention_days: 0 }).retention_days).toBeNull();
    expect(parseCharterPatch({ retention_days: "" }).retention_days).toBeNull();
    expect(parseCharterPatch({}).goal).toBeUndefined();
  });

  it("persists the charter columns and reads them back", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE boards (id TEXT PRIMARY KEY, title TEXT NOT NULL, retention_days INTEGER)");
    db.exec(readFileSync(migrationUrl, "utf8"));
    db.prepare("INSERT INTO boards (id, title) VALUES (?, ?)").run("b_test", "Checkout");
    const stored = applyCharter(
      emptyStored(),
      parseCharterPatch({
        goal: "Ship checkout — 结账",
        data_classes: ["internal", "customer-pii"],
        retention_days: 90,
        members: { ada: "eng lead" },
      }),
      ["ada"],
    );
    const b = charterBinds(stored);
    db.prepare("UPDATE boards SET goal = ?, data_classes = ?, retention_days = ?, member_notes = ? WHERE id = ?").run(b.goal, b.data_classes, b.retention_days, b.member_notes, "b_test");
    const row = db.prepare("SELECT goal, data_classes, retention_days, member_notes FROM boards WHERE id = ?").get("b_test");
    expect(storedFromRow(row)).toEqual(stored);
    expect(charterView(storedFromRow(row), members.filter((m) => m.user === "ada")).members[0].note).toBe("eng lead");
  });
});

const info: BoardInfo = { id: "b_test1234", title: "Checkout", created_by: "ada", created_at: 0, entry_count: 0, last_seq: 0 };
const entries: Entry[] = [];
const ada = { name: "ada", email: "ada@example.com", display_name: null, admin: false };
const onBoard = [
  { user: "ada", display_name: null, last_seen: 0, role: "owner" as const },
  { user: "grace", display_name: null, last_seen: 0, role: "contributor" as const },
];

describe("charter on the board page", () => {
  it("shows the goal, data classes, retention, and member note, and owners can edit", async () => {
    const charter = charterView(
      applyCharter(emptyStored(), parseCharterPatch({ goal: "Ship checkout <safe>", data_classes: ["internal"], retention_days: 90, members: { ada: "eng lead" } }), ["ada", "grace"]),
      [
        { user: "ada", role: "owner" },
        { user: "grace", role: "contributor" },
      ],
    );
    const html = await boardPage(ada, [], info, onBoard, entries, [], undefined, undefined, [], { picture: null, kind: null, charter }).text();
    expect(html).toContain('id="charter-side"');
    expect(html).toContain("Ship checkout &lt;safe&gt;");
    expect(html).toContain(">internal<");
    expect(html).toContain("Keep messages 90 days");
    expect(html).toContain("eng lead");
    expect(html).toContain('id="ch-edit"');
    expect(html).toContain("/api/boards/'+BOARD+'/charter");
    for (const s of [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((s) => s.includes("charterRefresh"))) expect(() => new Function(s)).not.toThrow();
    expect(() => new Function(charterJs())).not.toThrow();

    const grace = await boardPage({ ...ada, name: "grace" }, [], info, onBoard, entries, [], undefined, undefined, [], { picture: null, kind: null, charter }).text();
    expect(grace).toContain("eng lead");
    expect(grace).not.toContain('id="ch-edit"');

    const archived = await boardPage(ada, [], { ...info, archived: true }, onBoard, entries, [], undefined, undefined, [], { picture: null, kind: null, charter }).text();
    expect(archived).toContain("Ship checkout &lt;safe&gt;");
    expect(archived).not.toContain('id="ch-edit"');

    const agent = await boardPage(ada, [], info, onBoard, entries, [], undefined, undefined, [], { picture: null, kind: "agent", charter }).text();
    expect(agent).not.toContain('id="charter-side"');
  });
});
