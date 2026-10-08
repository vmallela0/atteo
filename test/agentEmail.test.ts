import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_QUIET_MS, ALERT_BATCH_MS, connectedNotice, sendCountAlert } from "../src/agentEmail";
import { listInbox } from "../src/inbox";
import type { Env } from "../src/types";

const { DatabaseSync } = (await import("node:" + "sqlite")) as { DatabaseSync: new (p: string) => any };
const { readFileSync, readdirSync } = (await import("node:" + "fs")) as { readFileSync: (u: URL, enc: string) => string; readdirSync: (u: URL) => string[] };
const migrations = new URL("../migrations/", (import.meta as unknown as { url: string }).url);
const dbs: any[] = [];

function fixture() {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  for (const file of readdirSync(migrations).filter((x) => x.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(file, migrations), "utf8"));
  const statement = (sql: string, args: unknown[] = []): any => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => ({ results: [], meta: { changes: db.prepare(sql).run(...args).changes } }),
  });
  const env = { DB: { prepare: (sql: string) => statement(sql) }, RESEND_API_KEY: "test-key", RESEND_FROM: "Atteo <test@atteo.test>", PUBLIC_URL: "https://atteo.test" } as unknown as Env;
  db.prepare(`INSERT INTO users (name, email, email_verified, first_seen, last_seen, plan) VALUES ('maya', 'maya@example.com', 1, 1, 1, 'free')`).run();
  db.prepare(`INSERT INTO agent_logins (id, user, label, email_alerts, created_at) VALUES ('agl_1', 'maya', 'Instinct', 1, 1)`).run();
  return { db, env };
}

const mail = (db: any, at: number, excerpt = "PRIVATE BOARD WORDS") => db.prepare(`INSERT INTO notifications (user, board_id, seq, kind, actor, actor_via, entry_type, excerpt, created_at) VALUES ('maya', 'b_secret123', COALESCE((SELECT MAX(seq) + 1 FROM notifications WHERE user = 'maya' AND board_id = 'b_secret123'), 1), 'agent', 'theo', 'person', 'note', ?, ?)`).run(excerpt, at);

afterEach(() => { vi.unstubAllGlobals(); for (const db of dbs.splice(0)) db.close(); });

describe("browser-agent email", () => {
  it("sends only a count and /a link, and batches a person for ten minutes", async () => {
    const f = fixture(), now = 2_000_000;
    mail(f.db, now - 1_000); mail(f.db, now - 500, "OTHER SECRET WORDS");
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await sendCountAlert(f.env, "maya", now)).toBe(true);
    const sent = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    expect(sent).toMatchObject({ to: ["maya@example.com"], subject: "2 new for you on atteo", text: "2 new for you. Open https://atteo.test/a" });
    expect(JSON.stringify(sent)).not.toMatch(/PRIVATE|OTHER|secret123|theo/i);
    mail(f.db, now + 1_000);
    expect(await sendCountAlert(f.env, "maya", now + ALERT_BATCH_MS - 1)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await sendCountAlert(f.env, "maya", now + ALERT_BATCH_MS + 1)).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[1][1]!.body as string).subject).toBe("1 new for you on atteo");
  });

  it("sends nothing while an agent was active in two minutes or after this login opts out", async () => {
    const f = fixture(), now = 3_000_000;
    mail(f.db, now - 10);
    f.db.prepare(`INSERT INTO agent_web_sessions (id_hash, login_id, created_at, expires_at) VALUES ('hash', 'agl_1', 1, ?)`).run(now + 10_000);
    f.db.prepare(`UPDATE agent_logins SET last_used = ? WHERE id = 'agl_1'`).run(now - ACTIVE_QUIET_MS + 1);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await sendCountAlert(f.env, "maya", now)).toBe(false);
    f.db.prepare(`UPDATE agent_logins SET last_used = ?, email_alerts = 0 WHERE id = 'agl_1'`).run(now - ACTIVE_QUIET_MS - 1);
    expect(await sendCountAlert(f.env, "maya", now)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("writes the connection security notice and emails it only when that login opted in", async () => {
    const f = fixture();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await connectedNotice(f.env, "maya", { id: "agl_1", label: "Instinct", email_alerts: true }, "Paris, FR", 4_000_000);
    expect(f.db.prepare(`SELECT kind, excerpt FROM notifications WHERE entry_type = 'agent_connected'`).get()).toEqual({ kind: "people_only", excerpt: "A browser agent (Instinct) was connected from Paris, FR. Revoke it in Settings." });
    expect((await listInbox(f.env, "maya", 10, true))[0].url).toBe("/me#agent-sign-ins");
    const sent = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    expect(sent.text).toBe("A browser agent (Instinct) was connected from Paris, FR. Revoke it at https://atteo.test/me#agent-sign-ins.");
  });
});
