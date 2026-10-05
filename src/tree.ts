// A board as a read-only tree (GAPS P0 #5's mount): state.md, files/, log/. Shared by MCP `ls`,
// GET /api/boards/:id/ls, and the atteo CLI. Nothing here moves a read position.

import { flagNote, flagOf } from "./screen";

export type TreePath =
  | { kind: "root" }
  | { kind: "state" }
  | { kind: "files" }
  | { kind: "file"; name: string; version: number | null }
  | { kind: "log" }
  | { kind: "entry"; seq: number };

export const TREE_HELP = "The tree: state.md (the summary), files/ (each file's current version; name@vN an older one), log/ (one N.md per entry).";

/** "files/PLAN.md@v2", "/log/12.md", "log/12", "./state.md", "files/" … */
export function parseTreePath(raw: string | undefined): TreePath {
  const p = (raw ?? "").trim().replace(/^\.?\/+/, "").replace(/^\.$/, "");
  const dir = p.replace(/\/+$/, "");
  if (!dir) return { kind: "root" };
  if (dir === "state.md") return { kind: "state" };
  if (dir === "files") return { kind: "files" };
  if (dir === "log") return { kind: "log" };
  const file = dir.match(/^files\/(.+?)(?:@v(\d+))?$/);
  if (file) return { kind: "file", name: file[1], version: file[2] ? Number(file[2]) : null };
  const entry = dir.match(/^log\/#?(\d+)(?:\.md)?$/);
  if (entry && Number(entry[1]) > 0) return { kind: "entry", seq: Number(entry[1]) };
  throw new Error(`No such path: ${raw}. ${TREE_HELP}`);
}

export const treePathOf = (t: TreePath): string =>
  t.kind === "root" ? "/" : t.kind === "state" ? "state.md" : t.kind === "files" ? "files/" : t.kind === "log" ? "log/" : t.kind === "file" ? `files/${t.name}${t.version != null ? `@v${t.version}` : ""}` : `log/${t.seq}.md`;

const when = (ts: number) => new Date(ts).toISOString().slice(0, 16).replace("T", " ");
const bytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} kB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const who = (by: string, via: string | null | undefined) => (via === "agent" ? `${by}'s agent` : by);

export interface FileMeta {
  name: string;
  version: number;
  size: number;
  updated_by: string;
  updated_at: number;
  via: string | null;
  mime?: string | null;
}

/** One file in ls files/: its name, or with -l its version, size, who changed it last and when. */
export function fileLine(d: FileMeta, long: boolean, version = false): string {
  const name = version ? `${d.name}@v${d.version}` : d.name;
  return long ? `${name}  v${d.version}  ${bytes(d.size)}  ${who(d.updated_by, d.via)}  ${when(d.updated_at)}` : name;
}

export interface LogEntry {
  seq: number;
  ts: number;
  author: string;
  via?: string | null;
  type: string;
  title?: string | null;
  text: string;
  ai_flag?: string | null;
  artifact_name?: string | null;
}

/** One entry in ls log/: N.md, or with -l its type, author, time and first line (⚠ when flagged). */
export function entryLine(e: LogEntry, long: boolean): string {
  if (!long) return `${e.seq}.md`;
  const first = (e.title || e.text.split("\n").find((l) => l.trim()) || (e.artifact_name ? `📎 ${e.artifact_name}` : "")).replace(/\s+/g, " ").trim();
  const f = flagOf(e.text, e.ai_flag);
  return `${e.seq}.md  ${e.type}  ${who(e.author, e.via)}  ${when(e.ts)}  ${first.length > 80 ? first.slice(0, 79) + "…" : first}${f ? `  ⚠ ${flagNote(f)}` : ""}`;
}
