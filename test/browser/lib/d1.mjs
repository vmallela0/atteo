// Local D1 is one SQLite file. During a parallel browser run the Worker holds it, and `wrangler d1 execute` can fail
// once with SQLITE_BUSY. Retry that single error after a short pause. A second SQLITE_BUSY, and every other error,
// still fails the check. This does not retry the check's own assertions.
import { execSync } from "node:child_process";

const BUSY_WAIT_MS = 500;

const text = (v) => (v == null ? "" : Buffer.isBuffer(v) ? v.toString() : String(v));

// SQLITE_BUSY counts only in the failure text. The echoed command line can mention it without being a lock.
export function sqliteBusy(e) {
  if (/SQLITE_BUSY/.test(`${text(e?.stderr)}\n${text(e?.stdout)}`)) return true;
  const msg = text(e?.message ?? e);
  if (msg.startsWith("Command failed:")) return /SQLITE_BUSY/.test(msg.split("\n").slice(1).join("\n"));
  return /SQLITE_BUSY/.test(msg);
}

// PERSIST: the server's --persist-to directory. A server started with `wrangler dev --persist-to $D` keeps its D1 there,
// and without the same flag `d1 execute --local` reads an empty .wrangler ("no such table").
export async function d1Execute(args, { cwd, exec = execSync, sleep, waitMs = BUSY_WAIT_MS, persist = process.env.PERSIST } = {}) {
  const cmd = `npx wrangler d1 execute agent-board --local${persist ? ` --persist-to ${JSON.stringify(persist)}` : ""} ${args}`;
  const run = () => exec(cmd, { cwd, stdio: "pipe" });
  const pause = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  try {
    return run();
  } catch (e) {
    if (!sqliteBusy(e)) throw e;
    process.stderr.write("wrangler d1: SQLITE_BUSY; retrying once\n");
    await pause(waitMs);
    return run();
  }
}
