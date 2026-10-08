// The hot D1 queries must use an index, never scan a big table: a scan per call is what ran prod into the Free plan's
// 5M rows-read/day cap (#1495/#1516). Every migration runs into node:sqlite (Node 22+), and each query below is the
// exact string the code sends (exported constants), so a query or an index can't drift without this failing.

import { describe, expect, it } from "vitest";
import { AGENTS_ON_BOARD_SQL, BOARD_ACCESS_SQL, BOARDS_FOR_USER_SQL, TAPE_PRUNE_SQL, TAPE_READ_SQL, TAPE_TOP_SQL } from "../src/registry";
import { LIVE_SESSIONS_SQL, SESSIONS_ON_BOARD_SQL, USER_SESSIONS_SQL } from "../src/sessions";
import { PRUNE_READ_SQL, listInboxSql, unreadCountSql } from "../src/inbox";
import { PRUNE_USAGE_DAILY_SQL } from "../src/usage";
import { LEASE_GET_SQL, NEWER_MAIL_SQL, PRUNE_MAIL_SQL, UNDELIVERED_DIRECT_SQL, UNDELIVERED_SQL } from "../src/mailbox";
import { TOKEN_SQL } from "../src/auth";
import { ACCOUNT_LOG_SQL, PRUNE_ACCOUNT_LOG_SQL } from "../src/accountlog";
import { PRUNE_OAUTH_CLIENTS_SQL } from "../src/oauth";
import { BUMP_SQL, REQUESTS_TODAY_SQL, SHED_GET_SQL, SHED_SET_SQL } from "../src/limits";
import { ALERT_ONCE_SQL, CAP_CLEAR_SQL, CAP_GET_SQL, CAP_SET_SQL } from "../src/costGuard";
import { MACHINE_PRUNE_SQL, MACHINE_UPSERT_SQL } from "../src/machines";
import { PRUNE_DEVICE_LOGINS_SQL } from "../src/device";

const { DatabaseSync } = (await import("node:" + "sqlite")) as { DatabaseSync: new (p: string) => any };
const { readFileSync, readdirSync } = (await import("node:" + "fs")) as { readFileSync: (u: URL, enc: string) => string; readdirSync: (u: URL) => string[] };

const dir = new URL("../migrations/", (import.meta as unknown as { url: string }).url);
const db = new DatabaseSync(":memory:");
for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(f, dir), "utf8"));

const plan = (sql: string): string[] => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((r: { detail: string }) => r.detail);

const HOT: Record<string, string> = {
  "live agent sessions (board lists)": LIVE_SESSIONS_SQL,
  "a person's agent sessions": USER_SESSIONS_SQL,
  "agent sessions on a board": SESSIONS_ON_BOARD_SQL,
  "mcp_sessions by board": AGENTS_ON_BOARD_SQL,
  "members by user (your boards)": BOARDS_FOR_USER_SQL,
  "notifications unread count (person)": unreadCountSql(true),
  "notifications unread count (agent)": unreadCountSql(false),
  "notifications read prune": PRUNE_READ_SQL,
  "mailbox acked prune": PRUNE_MAIL_SQL,
  "usage_daily prune": PRUNE_USAGE_DAILY_SQL,
  "mailbox: undelivered mail": UNDELIVERED_SQL,
  "mailbox: undelivered DMs (standby peek)": UNDELIVERED_DIRECT_SQL,
  "mailbox: drain lease": LEASE_GET_SQL,
  "mailbox: newer mail (peek/held waits)": NEWER_MAIL_SQL,
  "inbox list (person)": listInboxSql(true),
  "inbox list (agent)": listInboxSql(false),
  "cost guard: cap read": CAP_GET_SQL,
  "cost guard: cap set": CAP_SET_SQL,
  "cost guard: cap clear": CAP_CLEAR_SQL,
  "cost guard: alert once": ALERT_ONCE_SQL,
  "tape read": TAPE_READ_SQL,
  "tape newest": TAPE_TOP_SQL,
  "tape prune": TAPE_PRUNE_SQL,
  "token lookup": TOKEN_SQL,
  "account log (a person, newest first)": ACCOUNT_LOG_SQL,
  "account log prune": PRUNE_ACCOUNT_LOG_SQL,
  "unused oauth clients prune": PRUNE_OAUTH_CLIENTS_SQL,
  "usage counter flush": BUMP_SQL,
  "shed level read": SHED_GET_SQL,
  "shed level write": SHED_SET_SQL,
  "requests today (cron)": REQUESTS_TODAY_SQL,
  "machines report": MACHINE_UPSERT_SQL,
  "machines prune (a person's labels)": MACHINE_PRUNE_SQL,
  "device login expired cleanup": PRUNE_DEVICE_LOGINS_SQL,
  "board access (every board request: deleted, member, role)": BOARD_ACCESS_SQL,
};

describe("hot queries use an index", () => {
  for (const [name, sql] of Object.entries(HOT)) {
    it(name, () => {
      const steps = plan(sql);
      // "SCAN x" (even "USING INDEX"/"USING COVERING INDEX") reads every row; SEARCH reads only the matching ones.
      const scans = steps.filter((d) => /^SCAN\b/.test(d) && !/^SCAN CONSTANT ROW/.test(d));
      expect(scans, `${name}:\n${steps.join("\n")}`).toEqual([]);
    });
  }

  it("the inbox list walks notifications newest first instead of sorting all of a person's (#4340)", () => {
    for (const person of [true, false]) {
      const steps = plan(listInboxSql(person));
      expect(steps.some((d) => /TEMP B-TREE FOR ORDER BY/.test(d)), steps.join("\n")).toBe(false);
      expect(steps.some((d) => /notifications_user_created/.test(d)), steps.join("\n")).toBe(true);
    }
  });

  it("pending invitations by address use the lower(email) index (#4340)", () => {
    const steps = plan(`SELECT id FROM invites WHERE lower(email) = lower(?) AND accepted_at IS NULL`);
    expect(steps.some((d) => /invites_email_lower/.test(d)), steps.join("\n")).toBe(true);
  });

  it("expired device-login cleanup searches device_logins_expires_at", () => {
    const steps = plan(PRUNE_DEVICE_LOGINS_SQL);
    expect(steps.some((d) => /SEARCH device_logins USING INDEX device_logins_expires_at/.test(d)), steps.join("\n")).toBe(true);
    expect(steps.filter((d) => /^SCAN\b/.test(d) && !/^SCAN CONSTANT ROW/.test(d)), steps.join("\n")).toEqual([]);
  });

  it("catches a scan when there's no index (the check itself works)", () => {
    expect(plan(`SELECT * FROM notifications WHERE excerpt = ?`).some((d) => /^SCAN\b/.test(d))).toBe(true);
  });
});
