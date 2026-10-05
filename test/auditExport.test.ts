import { describe, expect, it } from "vitest";
import { AUDIT_EXPORT_SQL, auditExportDocument, auditExportFilename, auditExportHeaders, forAgents, maskEmail, parseAuditAfter, type AuditExportRow } from "../src/auditExport";

const { DatabaseSync } = (await import("node:" + "sqlite")) as { DatabaseSync: new (p: string) => { exec(sql: string): void; prepare(sql: string): { all(...p: unknown[]): AuditExportRow[]; run(...p: unknown[]): void } } };
const { readFileSync, readdirSync } = (await import("node:" + "fs")) as { readFileSync: (u: URL, enc: string) => string; readdirSync: (u: URL) => string[] };

const dir = new URL("../migrations/", (import.meta as unknown as { url: string }).url);
const db = new DatabaseSync(":memory:");
for (const f of readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(f, dir), "utf8"));

const insert = db.prepare(`INSERT INTO audit (board_id, actor, action, target, detail, ts) VALUES (?, ?, ?, ?, ?, ?)`);
function add(board: string, actor: string, action: string, target: string | null, detail: string | null, ts: number) {
  insert.run(board, actor, action, target, detail, ts);
}

add("b_one", "ada", "invited", "beau@example.com", "viewer", 300);
add("b_one", "beau", "joined", "beau", "via invite link (viewer, 30d)", 200);
add("b_one", "ada", "removed", "beau", null, 100);
add("b_other", "cy", "joined", "cy", null, 50);

const page = (board: string, after: number, pageSize: number) =>
  auditExportDocument(board, db.prepare(AUDIT_EXPORT_SQL).all(board, after, pageSize + 1), {
    exportedAt: Date.UTC(2026, 9, 5, 7, 46, 0),
    afterId: after,
    pageSize,
  });

describe("access audit export", () => {
  it("uses the (board_id, id) index", () => {
    const steps = db.prepare(`EXPLAIN QUERY PLAN ${AUDIT_EXPORT_SQL}`).all() as unknown as { detail: string }[];
    const scans = steps.map((s) => s.detail).filter((d) => /^SCAN\b/.test(d));
    expect(scans, steps.map((s) => s.detail).join("\n")).toEqual([]);
  });

  it("returns one board in append order, with a file name and download headers", () => {
    const doc = page("b_one", 0, 5000);
    expect(doc.kind).toBe("access_audit");
    expect(doc.order).toBe("append");
    expect(doc.board_id).toBe("b_one");
    expect(doc.after_id).toBe(0);
    expect(doc.truncated).toBe(false);
    expect(doc.next_after_id).toBeUndefined();
    expect(doc.count).toBe(3);
    expect(doc.audit.map((a) => a.action)).toEqual(["invited", "joined", "removed"]);
    expect(doc.audit.map((a) => a.id)).toEqual([1, 2, 3]);
    expect(doc.audit[0]).toMatchObject({ actor: "ada", target: "beau@example.com", detail: "viewer", ts: 300 });
    expect(doc.exported_at).toBe("2026-10-05T07:46:00.000Z");
    expect(auditExportFilename("b_one", Date.UTC(2026, 9, 5))).toBe("atteo-audit-b_one-2026-10-05.json");
    expect(auditExportHeaders("b_one", Date.UTC(2026, 9, 5))).toEqual({
      "content-disposition": 'attachment; filename="atteo-audit-b_one-2026-10-05.json"',
      "cache-control": "no-store",
    });
  });

  it("leaves other boards out, and an empty board exports an empty log", () => {
    expect(page("b_other", 0, 5000).audit.map((a) => a.actor)).toEqual(["cy"]);
    const empty = page("b_none", 0, 5000);
    expect(empty.count).toBe(0);
    expect(empty.audit).toEqual([]);
    expect(empty.truncated).toBe(false);
    expect(empty.next_after_id).toBeUndefined();
  });

  it("pages with after, and marks a full page truncated", () => {
    const first = page("b_one", 0, 2);
    expect(first.truncated).toBe(true);
    expect(first.count).toBe(2);
    expect(first.next_after_id).toBe(first.audit[1].id);
    const rest = page("b_one", first.next_after_id!, 2);
    expect(rest.after_id).toBe(2);
    expect(rest.truncated).toBe(false);
    expect(rest.audit.map((a) => a.id)).toEqual([3]);
    expect(page("b_one", 0, 3).truncated).toBe(false);
  });

  it("accepts a whole-number cursor and rejects anything else", () => {
    expect(parseAuditAfter(null)).toBe(0);
    expect(parseAuditAfter("")).toBe(0);
    expect(parseAuditAfter("0")).toBe(0);
    expect(parseAuditAfter("42")).toBe(42);
    for (const bad of ["-1", "1.5", "1e2", "nope", " 1", "1 "]) expect(() => parseAuditAfter(bad)).toThrow(/audit id/);
  });
});

describe("the audit as an agent sees it (#3437)", () => {
  it("masks an email address to its first letter and domain, anywhere in the text", () => {
    expect(maskEmail("jane.doe+x@example.co.uk")).toBe("j…@example.co.uk");
    expect(maskEmail("invited jo@ex.com and al@ex.org")).toBe("invited j…@ex.com and a…@ex.org");
    expect(maskEmail("vedu")).toBe("vedu");
    expect(maskEmail(null)).toBeNull();
  });
  it("masks target and detail and keeps every other field and the row count", () => {
    const rows = [
      { id: 1, actor: "ann", action: "invited", target: "bob@example.com", detail: "viewer", ts: 1 },
      { id: 2, actor: "bob", action: "joined", target: "bob", detail: "accepted ann's invitation", ts: 2 },
    ];
    const out = forAgents(rows);
    expect(out).toEqual([{ ...rows[0], target: "b…@example.com" }, rows[1]]);
    expect(rows[0].target).toBe("bob@example.com"); // the people's copy is untouched
  });
});
