// JSON export of the append-only board access audit (grants, invites, joins, removals, links, and the
// other access events already written to `audit`). Token issuance and sign-ins are account-scoped and
// are not in this log. The Activity list stays a short newest-first view; this is the full download.

/** One page. A board's access history is small; the cursor (`after`) covers a log that outgrows a page. */
export const AUDIT_EXPORT_LIMIT = 5000;

/** Oldest first (append order). Bound: board id, last id already returned, page size + 1. */
export const AUDIT_EXPORT_SQL = `SELECT id, actor, action, target, detail, ts FROM audit WHERE board_id = ? AND id > ? ORDER BY id ASC LIMIT ?`;

export interface AuditExportRow {
  id: number;
  actor: string;
  action: string;
  target: string | null;
  detail: string | null;
  ts: number;
}

export interface AuditExportDocument {
  board_id: string;
  kind: "access_audit";
  exported_at: string;
  order: "append";
  after_id: number;
  count: number;
  truncated: boolean;
  next_after_id?: number;
  audit: AuditExportRow[];
}

/** `after` query: omit or empty starts at the beginning. Anything else must be a whole audit id. */
export function parseAuditAfter(raw: string | null): number {
  if (raw == null || raw === "") return 0;
  if (!/^[0-9]+$/.test(raw)) throw new Error("after must be an audit id (a whole number).");
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) throw new Error("after must be an audit id (a whole number).");
  return n;
}

/**
 * `rows` is one fetch in append order, queried with LIMIT pageSize + 1.
 * One extra row means this page is full and another exists.
 */
export function auditExportDocument(
  boardId: string,
  rows: AuditExportRow[],
  opts: { exportedAt: number; afterId: number; pageSize: number },
): AuditExportDocument {
  const truncated = rows.length > opts.pageSize;
  const audit = truncated ? rows.slice(0, opts.pageSize) : rows;
  const doc: AuditExportDocument = {
    board_id: boardId,
    kind: "access_audit",
    exported_at: new Date(opts.exportedAt).toISOString(),
    order: "append",
    after_id: opts.afterId,
    count: audit.length,
    truncated,
    audit,
  };
  if (truncated && audit.length) doc.next_after_id = audit[audit.length - 1].id;
  return doc;
}

export function auditExportFilename(boardId: string, exportedAt: number): string {
  return `atteo-audit-${boardId}-${new Date(exportedAt).toISOString().slice(0, 10)}.json`;
}

export function auditExportHeaders(boardId: string, exportedAt: number): Record<string, string> {
  return {
    "content-disposition": `attachment; filename="${auditExportFilename(boardId, exportedAt)}"`,
    "cache-control": "no-store",
  };
}
