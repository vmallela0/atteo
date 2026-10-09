// The CLI's shared JSON state files (sessions.json, boards.json, the e2e cursors…): many agents and forks on one machine
// run atteo at once, and a plain read → change → writeFileSync lost entries. A process that read the file earlier wrote
// its stale copy back over newer ones, and a reader that caught a half-written file took it as {} and saved that. Now a
// change is made under a lockfile, on a fresh read, applying only that change, and the file is replaced whole (a temp
// file renamed over it), so no reader ever sees half of one. A file that doesn't parse is never saved over.
// Node fs only, no project imports: test/jsonState.test.mjs runs it as is, from many processes at once.

import { randomBytes } from "node:crypto";
import { closeSync, copyFileSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/** How long a change waits for the lock, and when a lock is taken to be left over by a process that died holding it. */
export const LOCK_WAIT_MS = 2000;
export const LOCK_STALE_MS = 10_000;

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); // sync: every caller is

type Read<T> = { ok: true; value: T } | { ok: false; missing: boolean };

/** The file as it is now. One that doesn't parse is read again a few times (an older CLI may be mid-write) first. */
function readNow<T>(file: string): Read<T> {
  for (let i = 0; ; i++) {
    try {
      return { ok: true, value: JSON.parse(readFileSync(file, "utf8")) };
    } catch (e) {
      if ((e as { code?: string }).code === "ENOENT") return { ok: false, missing: true };
      if (i >= 4) return { ok: false, missing: false };
      sleep(20);
    }
  }
}

/** The file's JSON, or `fallback` when it's missing or unreadable. For reading only: what's returned is never saved. */
export function readJson<T>(file: string, fallback: T): T {
  const r = readNow<T>(file);
  return r.ok ? r.value : fallback;
}

/** Replaces the file whole: written to a temp file next to it, flushed, then renamed over it. */
export function writeJson(file: string, value: unknown, o: { space?: number; mode?: number } = {}) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    const fd = openSync(temp, "wx", o.mode ?? 0o600);
    try {
      writeSync(fd, JSON.stringify(value, null, o.space));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, file);
  } catch (e) {
    rmSync(temp, { force: true });
    throw e;
  }
}

/** Runs `fn` holding `<file>.lock` (made with 'wx': one holder). A lock older than LOCK_STALE_MS is broken; after
 *  LOCK_WAIT_MS `fn` runs anyway (a fresh read and an atomic write are still safe enough) rather than failing the command. */
function withLock<R>(file: string, fn: () => R): R {
  const lock = `${file}.lock`;
  const until = Date.now() + LOCK_WAIT_MS;
  let held = false;
  while (!held) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      held = true;
      try {
        writeSync(fd, String(process.pid)); // for a person looking; staleness goes by the lock's age
      } catch {
      } finally {
        closeSync(fd);
      }
    } catch (e) {
      if ((e as { code?: string }).code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          // Renamed away first: only one process wins the rename, so two that saw it stale can't both take it.
          const away = `${lock}.${process.pid}.${randomBytes(4).toString("hex")}.stale`;
          renameSync(lock, away);
          rmSync(away, { force: true });
          continue;
        }
      } catch {
        continue; // gone meanwhile: try again at once
      }
      if (Date.now() >= until) {
        process.stderr.write(`atteo: ${lock} is still held after ${LOCK_WAIT_MS / 1000}s; saving without it.\n`);
        break;
      }
      sleep(10 + Math.floor(Math.random() * 16));
    }
  }
  try {
    return fn();
  } finally {
    if (held) rmSync(lock, { force: true });
  }
}

/** Changes the file: `change` gets it as it is now (`init` when missing), under its lock, and edits it in place or returns
 *  the new value. A file that doesn't parse is left as it is (copied to <file>.corrupt, one line on stderr) and
 *  this change isn't saved: never written over with {}. Returns what was saved, or null when nothing was. */
export function updateJson<T>(file: string, init: T, change: (cur: T) => T | void, o: { space?: number; mode?: number } = {}): T | null {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  return withLock(file, () => {
    const r = readNow<T>(file);
    if (!r.ok && !r.missing) {
      const copy = `${file}.corrupt`;
      try {
        copyFileSync(file, copy);
      } catch {}
      process.stderr.write(`atteo: ${file} isn't valid JSON; left as it is (a copy is in ${copy}) and this change wasn't saved. Fix or remove it.\n`);
      return null;
    }
    const cur = r.ok ? r.value : init;
    const next = change(cur) ?? cur;
    writeJson(file, next, o);
    return next;
  });
}
