import { describe, expect, it } from "vitest";
import { d1Execute, sqliteBusy } from "./browser/lib/d1.mjs";

const fail = (stderr, message) => {
  const e = new Error(message ?? `Command failed: npx wrangler d1 execute agent-board --local --command "SELECT 1"\n${stderr}`);
  e.stderr = Buffer.from(stderr);
  return e;
};

describe("browser harness wrangler d1 execute", () => {
  it("runs the command once against the local database when it succeeds", async () => {
    let n = 0;
    let seen = "";
    const out = await d1Execute(`--command ${JSON.stringify("SELECT 1")}`, {
      cwd: "/tmp/repo",
      exec: (cmd, opts) => {
        n++;
        seen = cmd;
        expect(opts).toEqual({ cwd: "/tmp/repo", stdio: "pipe" });
        return Buffer.from('[{"results":[]}]');
      },
      sleep: async () => { throw new Error("should not wait"); },
    });
    expect(n).toBe(1);
    expect(out.toString()).toBe('[{"results":[]}]');
    expect(seen).toBe(`npx wrangler d1 execute agent-board --local --command ${JSON.stringify("SELECT 1")}`);
  });

  it("points at the server's --persist-to directory when PERSIST is given", async () => {
    let seen = "";
    await d1Execute(`--command ${JSON.stringify("SELECT 1")}`, { persist: "/tmp/st dir", exec: (cmd) => { seen = cmd; return Buffer.from("ok"); } });
    expect(seen).toBe(`npx wrangler d1 execute agent-board --local --persist-to "/tmp/st dir" --command ${JSON.stringify("SELECT 1")}`);
  });

  it("retries once when the Worker holds the database (SQLITE_BUSY)", async () => {
    let n = 0;
    let waited = 0;
    const out = await d1Execute("--command \"UPDATE agent_sessions SET last_seen = 1\"", {
      exec: () => {
        n++;
        if (n === 1) throw fail("✘ [ERROR] SQLITE_BUSY: database is locked\n");
        return Buffer.from("ok");
      },
      sleep: async (ms) => { waited = ms; },
    });
    expect(out.toString()).toBe("ok");
    expect(n).toBe(2);
    expect(waited).toBe(500);
  });

  it("still fails when SQLITE_BUSY happens on the retry", async () => {
    let n = 0;
    const second = fail("SQLITE_BUSY: database is locked\n");
    await expect(d1Execute("--command x", {
      exec: () => { n++; throw n === 1 ? fail("SQLITE_BUSY: database is locked\n") : second; },
      sleep: async () => {},
    })).rejects.toBe(second);
    expect(n).toBe(2);
  });

  it("does not hide a different error on the first attempt", async () => {
    let n = 0;
    const e = fail("no such table: agent_sessions\n");
    await expect(d1Execute("--command x", {
      exec: () => { n++; throw e; },
      sleep: async () => { throw new Error("should not wait"); },
    })).rejects.toBe(e);
    expect(n).toBe(1);
  });

  it("does not hide a different error that shows up on the retry", async () => {
    let n = 0;
    const second = fail("no such column: last_seen\n");
    await expect(d1Execute("--command x", {
      exec: () => { n++; throw n === 1 ? fail("SQLITE_BUSY: database is locked\n") : second; },
      sleep: async () => {},
    })).rejects.toBe(second);
    expect(n).toBe(2);
  });

  it("does not treat SQLITE_BUSY inside the command as a lock", () => {
    const e = fail("near \"x\": syntax error\n", "Command failed: npx wrangler d1 execute --local --command \"SELECT 'SQLITE_BUSY'\"\nnear \"x\": syntax error");
    expect(sqliteBusy(e)).toBe(false);
  });

  it("recognises SQLITE_BUSY on stderr even when the message only echoes the command", () => {
    const e = fail("SQLITE_BUSY: database is locked\n", "Command failed: npx wrangler d1 execute --local --command \"SELECT 1\"");
    expect(sqliteBusy(e)).toBe(true);
  });

  it("does not retry a plain database-is-locked message that is not SQLITE_BUSY", async () => {
    let n = 0;
    const e = fail("database is locked\n");
    await expect(d1Execute("--command x", {
      exec: () => { n++; throw e; },
      sleep: async () => { throw new Error("should not wait"); },
    })).rejects.toBe(e);
    expect(n).toBe(1);
  });
});
