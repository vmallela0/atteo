import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
import { approveAgentLogin, redeemAgentDevice } from "../src/agentLogins";
import { admitDevicePoll, decideDeviceLogin, pollDeviceLogin, startDeviceLogin } from "../src/device";
import * as limits from "../src/limits";
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
    _run: () => db.prepare(sql).run(...args),
  });
  const env = { DB: { prepare: (sql: string) => statement(sql), batch: async (items: any[]) => items.map((x) => { const r = x._run(); return { results: [], meta: { changes: r.changes } }; }) } } as unknown as Env;
  db.prepare(`INSERT INTO users (name, email, email_verified, first_seen, last_seen, plan) VALUES ('maya', 'maya@example.com', 1, 1, 1, 'free')`).run();
  return { db, env };
}

const request = (ip: string) => new Request("https://atteo.test/api/device/token", { method: "POST", headers: { "cf-connecting-ip": ip } });

beforeEach(() => limits.setOverrides({}, true));
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

describe("device redemption isolation", () => {
  it("redeems only unexpired CLI-kind requests and never crosses the CLI/browser-agent endpoints", async () => {
    const f = fixture();

    const agent = await startDeviceLogin(f.env, "https://atteo.test", "browser agent", null, { kind: "agent" });
    await approveAgentLogin(f.env, agent.user_code, "maya", { boards: null });
    expect(await pollDeviceLogin(f.env, agent.device_code)).toEqual({ status: "expired" });
    expect(f.db.prepare(`SELECT status FROM device_logins WHERE user_code = ?`).get(agent.user_code)).toEqual({ status: "approved" });
    expect(f.db.prepare(`SELECT COUNT(*) AS n FROM tokens`).get()).toEqual({ n: 0 });

    const cli = await startDeviceLogin(f.env, "https://atteo.test", "Atteo CLI");
    expect(await decideDeviceLogin(f.env, cli.user_code, "maya", true)).toBe("ok");
    expect(await redeemAgentDevice(f.env, cli.device_code)).toEqual({ status: "expired" });
    expect(f.db.prepare(`SELECT COUNT(*) AS n FROM agent_web_sessions`).get()).toEqual({ n: 0 });

    f.db.prepare(`UPDATE device_logins SET expires_at = 1 WHERE user_code = ?`).run(cli.user_code);
    expect(await pollDeviceLogin(f.env, cli.device_code)).toEqual({ status: "expired" });
    expect(f.db.prepare(`SELECT status FROM device_logins WHERE user_code = ?`).get(cli.user_code)).toEqual({ status: "approved" });
    expect(f.db.prepare(`SELECT COUNT(*) AS n FROM tokens`).get()).toEqual({ n: 0 });

    const live = await startDeviceLogin(f.env, "https://atteo.test", "Atteo CLI");
    expect(await decideDeviceLogin(f.env, live.user_code, "maya", true)).toBe("ok");
    expect((await pollDeviceLogin(f.env, live.device_code)).status).toBe("ok");
  });

  it("rate-limits by IP and exact device-code hash, enforcing the advertised poll interval before redemption", async () => {
    const f = fixture();
    const first = await admitDevicePoll(f.env, request("192.0.2.1"), "dc_same", 10_000);
    expect(first.ok).toBe(true);
    const fast = await admitDevicePoll(f.env, request("192.0.2.2"), "dc_same", 11_000);
    expect(fast).toEqual({ ok: false, retryAfter: 2 });
    expect((await admitDevicePoll(f.env, request("192.0.2.2"), "dc_same", 13_000)).ok).toBe(true);

    for (let i = 0; i < 20; i++) {
      expect((await admitDevicePoll(f.env, request("198.51.100.9"), `dc_${i}`, 20_000 + i)).ok).toBe(true);
    }
    const capped = await admitDevicePoll(f.env, request("198.51.100.9"), "dc_over", 20_100);
    expect(capped.ok).toBe(false);
    if (!capped.ok) expect(capped.retryAfter).toBeGreaterThan(0);
  });
});
