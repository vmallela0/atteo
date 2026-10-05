// The board as a read-only mount (GAPS P0 #5): list state.md / files/ / log/ without moving a read
// position. MCP `ls` and GET /api/boards/:id/ls share this; they call the same board methods the CLI
// already uses (docs, doc-history, page, snapshot). Reading contents is still read / get / doc.

import { entryLine, fileLine, parseTreePath, TREE_HELP, treePathOf, type FileMeta, type LogEntry, type TreePath } from "./tree";
import type { Entry, Viewer } from "./types";

export const LS_LIMIT = 50;
export const LS_MAX = 500;

export class LsError extends Error {}

export interface LsResult {
  board: string;
  path: string;
  items: unknown[];
  text: string;
  more?: string;
  untrusted: boolean;
}

export type LsDoc = {
  name: string;
  version: number;
  size: number;
  updated_by: string;
  updated_at: number;
  via: string | null;
  mime?: string | null;
};

export type LsDocVersion = {
  version: number;
  author?: string;
  ts?: number;
  via?: string | null;
  size?: number;
};

export type LsStub = {
  info(): { id: string; encrypted?: boolean } | Promise<{ id: string; encrypted?: boolean }>;
  docs(): Promise<LsDoc[]>;
  docHistory(name: string): Promise<LsDocVersion[]>;
  page(before: number | null, limit?: number, viewer?: Viewer | null): Promise<Entry[]>;
  snapshot(afterSeq?: number, opts?: { latest?: number }, viewer?: Viewer | null): Promise<{ entries: Entry[] }>;
};

export function parseLsLimit(raw: unknown): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : typeof raw === "string" && /^-?\d+$/.test(raw.trim()) ? parseInt(raw, 10) : NaN;
  if (!Number.isInteger(n)) return LS_LIMIT;
  return Math.min(LS_MAX, Math.max(1, n));
}

export function parseLsSince(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) throw new LsError("since is an entry number: the listing starts after it.");
  return Number(s);
}

export function parseLsLong(raw: unknown): boolean {
  return raw === true || raw === "true" || raw === "1" || raw === 1;
}

function asLogEntry(e: Entry): LogEntry {
  return {
    seq: e.seq,
    ts: e.ts,
    author: e.author,
    via: e.via ?? null,
    type: e.type,
    title: e.title ?? null,
    text: e.text,
    ai_flag: e.ai_flag ?? null,
    artifact_name: e.artifact_name ?? null,
  };
}

function versionMeta(cur: FileMeta, v: LsDocVersion): FileMeta {
  return {
    ...cur,
    version: v.version,
    size: v.size ?? (v.version === cur.version ? cur.size : 0),
    updated_by: v.author ?? cur.updated_by,
    updated_at: v.ts ?? cur.updated_at,
    via: v.via ?? cur.via,
  };
}

/** List one path of the mount. Encrypted boards are refused (the server can't decrypt them). */
export async function listMount(stub: LsStub, opts: { path?: string; long?: unknown; since?: unknown; limit?: unknown }, viewer: Viewer | null): Promise<LsResult> {
  let at: TreePath;
  try {
    at = parseTreePath(typeof opts.path === "string" ? opts.path : undefined);
  } catch (e) {
    throw new LsError(e instanceof Error ? e.message : String(e));
  }
  const info = await stub.info();
  if (info.encrypted) throw new LsError("This board is end-to-end encrypted, and ls doesn't decrypt: use read and doc.");
  const long = parseLsLong(opts.long);
  const board = info.id;
  const path = treePathOf(at);

  if (at.kind === "root") {
    const items = [
      { path: "state.md", type: "file" },
      { path: "files/", type: "dir" },
      { path: "log/", type: "dir" },
    ];
    return { board, path: "/", items, text: `${items.map((i) => i.path).join("\n")}\n(${TREE_HELP})`, untrusted: false };
  }
  if (at.kind === "state") {
    return { board, path: "state.md", items: [{ path: "state.md", type: "file" }], text: "state.md", untrusted: false };
  }
  if (at.kind === "files" || at.kind === "file") {
    const docs = await stub.docs();
    if (at.kind === "files") {
      return {
        board,
        path: "files/",
        items: docs,
        text: docs.length ? docs.map((d) => fileLine(d, long)).join("\n") : "(no files yet)",
        untrusted: docs.length > 0,
      };
    }
    const cur = docs.find((d) => d.name === at.name);
    if (!cur) throw new LsError(`No file named "${at.name}" on this board (ls files/).`);
    const versions = (await stub.docHistory(at.name))
      .map((v) => versionMeta(cur, v))
      .filter((v) => at.version == null || v.version === at.version)
      .sort((x, y) => y.version - x.version);
    return {
      board,
      path,
      items: versions,
      text: versions.length ? versions.map((v) => fileLine(v, long, true)).join("\n") : `(no versions of "${at.name}")`,
      untrusted: versions.length > 0,
    };
  }

  const limit = parseLsLimit(opts.limit);
  const since = parseLsSince(opts.since);
  let after: number;
  if (at.kind === "entry") after = at.seq - 1;
  else if (since != null) after = since;
  else {
    const newest = (await stub.page(null, 1, viewer))[0]?.seq ?? 0;
    after = Math.max(0, newest - limit);
  }
  const snap = await stub.snapshot(after, {}, viewer);
  let list = snap.entries.map(asLogEntry);
  if (at.kind === "entry") {
    list = list.filter((e) => e.seq === at.seq);
    if (!list.length) throw new LsError(`There's no entry #${at.seq} you can see on this board.`);
  } else {
    list = list.slice(0, limit);
    if (since == null) list = [...list].reverse();
  }
  const items = list.map((e) => ({ path: `log/${e.seq}.md`, seq: e.seq, ts: e.ts, author: e.author, via: e.via ?? null, type: e.type, title: e.title ?? null }));
  if (!list.length) {
    return { board, path, items, text: since != null ? `(nothing after #${since})` : "(no entries yet)", untrusted: false };
  }
  const more = at.kind === "log" && since == null && after > 0 ? `\n(older: ls {path: "log/", since: ${Math.max(0, after - limit)}, limit: ${limit}})` : undefined;
  return { board, path, items, text: list.map((e) => entryLine(e, long)).join("\n"), more, untrusted: true };
}
