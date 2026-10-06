// Absolute directory prefixes for a room's file writes (`charter.scope_paths`).
// The hosted charter stores them as advisory/exportable: they do not enforce a remote sandbox.
// Local Gateway compiles the same list, when opted in on that machine, to file_write allows
// (`gateway/src/policy.ts`). The lexical rules here match that policy (duplicates collapse; `..`
// is resolved; the filesystem is not touched). Who may set them for a room is still open.

export const SCOPE_PATHS_MAX = 32;
export const SCOPE_PATH_MAX = 4096;

function isAbs(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
}

/** Lexical normal form with forward slashes. `..` is resolved; this does not touch the filesystem. */
export function normalizeScopePath(p: string): string {
  // Backslashes are filename characters on POSIX, not directory boundaries.
  const slash = /^[A-Za-z]:[\\/]/.test(p) ? p.replace(/\\/g, "/") : p;
  const drive = /^([A-Za-z]:)(\/|$)/.exec(slash);
  const absolute = slash.startsWith("/") || !!drive;
  const body = drive ? slash.slice(drive[1].length) : slash;
  const out: string[] = [];
  for (const seg of body.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length) out.pop();
      continue;
    }
    out.push(seg);
  }
  if (drive) return `${drive[1].toUpperCase()}/${out.join("/").toLowerCase()}`;
  if (absolute) return `/${out.join("/")}`;
  return out.join("/");
}

function isFsRoot(p: string): boolean {
  return p === "/" || /^[A-Z]:\/$/.test(p);
}

function onePath(raw: string, where: string): string {
  const t = raw.trim();
  if (!t || t.includes("\0") || t.length > SCOPE_PATH_MAX) throw new Error(`${where} must be an absolute path.`);
  if (!isAbs(t)) throw new Error(`${where} must be an absolute path (for example /home/me/checkout).`);
  const norm = normalizeScopePath(t);
  if (!isAbs(norm) || isFsRoot(norm)) throw new Error(`${where} must be a directory below the filesystem root.`);
  return norm;
}

/**
 * A list of absolute directories, or one per line. Empty is valid (no directories).
 * Throws a user-facing Error when the value is not that list.
 */
export function parseScopePaths(v: unknown): string[] {
  let items: unknown[];
  if (v == null || v === "") return [];
  if (typeof v === "string") items = v.split(/\r?\n/);
  else if (Array.isArray(v)) items = v;
  else throw new Error("Write directories are a list of absolute paths, or one per line.");
  if (items.length > SCOPE_PATHS_MAX) throw new Error(`At most ${SCOPE_PATHS_MAX} write directories.`);
  const out: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item == null || item === "") continue;
    if (typeof item !== "string") throw new Error(`Write directory ${i + 1} must be an absolute path.`);
    if (!item.trim()) continue;
    const path = onePath(item, `Write directory ${i + 1}`);
    if (!out.includes(path)) out.push(path);
  }
  if (out.length > SCOPE_PATHS_MAX) throw new Error(`At most ${SCOPE_PATHS_MAX} write directories.`);
  return out;
}

/** Reads a stored list. Anything that is not a valid absolute directory is dropped. */
export function readScopePaths(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string" || !item.trim()) continue;
    try {
      const path = onePath(item, "Write directory");
      if (!out.includes(path)) out.push(path);
    } catch {
      continue;
    }
  }
  return out.slice(0, SCOPE_PATHS_MAX);
}
