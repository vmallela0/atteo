import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import type { Env } from "../src/types";
import { attachConfirms, completeConfirm, decideWithPin, failedPinState, numberChoices, pinState, pollConfirm, publicConfirm, setPin, startConfirm, TerminalApprovalError, CONFIRM_MS, PIN_WINDOW_MS } from "../src/terminalApprove";
import { getApproval } from "../src/approvals";

let mf: Miniflare;
let env: Env;
const user = "e2e-terminal-test";
const add = async (id: string, risk: string, client = "test") => env.DB.prepare(`INSERT INTO approvals (id, user, client, title, details, risk, status, created_at, expires_at) VALUES (?, ?, ?, ?, 'whole action', ?, 'pending', ?, ?)`).bind(id, user, client, `Request ${id}`, risk, Date.now(), Date.now() + 300_000).run();

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: `export default { fetch() { return new Response("ok") } }`, d1Databases: { DB: "terminal-approval-test" } }));
  const DB = await mf.getD1Database("DB");
  env = { DB } as Env;
  await DB.exec(`CREATE TABLE approvals (id TEXT PRIMARY KEY, user TEXT, client TEXT, board_id TEXT, seq INTEGER, requested_by TEXT, title TEXT, details TEXT, tool TEXT, command TEXT, risk TEXT, status TEXT, created_at INTEGER, expires_at INTEGER, session TEXT, note TEXT, decided_at INTEGER, decided_via TEXT);
CREATE TABLE notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT, board_id TEXT, seq INTEGER, kind TEXT, actor TEXT, actor_via TEXT, entry_type TEXT, excerpt TEXT, created_at INTEGER, data TEXT, UNIQUE(user, board_id, seq));
CREATE TABLE approval_terminal_confirms (approval_id TEXT PRIMARY KEY, user TEXT, token TEXT, code TEXT, choices TEXT, decision TEXT, status TEXT, created_at INTEGER, expires_at INTEGER);
CREATE TABLE approval_pins (user TEXT PRIMARY KEY, salt TEXT, hash TEXT, attempts INTEGER DEFAULT 0, window_start INTEGER DEFAULT 0, locked_until INTEGER DEFAULT 0, lockouts INTEGER DEFAULT 0, disabled_at INTEGER, updated_at INTEGER);`);
});
afterAll(async () => { await mf?.dispose(); });

describe("terminal approval proof", () => {
  it("generates a four-digit code among three distinct choices", () => {
    for (let i = 0; i < 100; i++) {
      const { code, choices } = numberChoices();
      expect(code).toMatch(/^\d{4}$/);
      expect(choices).toHaveLength(3);
      expect(new Set(choices).size).toBe(3);
      expect(choices).toContain(code);
    }
  });
  it("expires after two minutes and only one confirm stays live", async () => {
    const id = "ap_replace";
    await add(id, "low");
    const first = await startConfirm(env, user, id, "approve");
    expect(first.expires_at - Date.now()).toBeLessThanOrEqual(CONFIRM_MS);
    const second = await startConfirm(env, user, id, "reject");
    expect(await pollConfirm(env, user, id, first.token)).toEqual({ status: "replaced" });
    expect((await publicConfirm(env, user, id))?.decision).toBe("reject");
    expect((await attachConfirms(env, user, [(await getApproval(env, user, id))!]))[0].terminal_confirm?.choices).toHaveLength(3);
    await env.DB.prepare(`UPDATE approval_terminal_confirms SET expires_at = ? WHERE approval_id = ?`).bind(Date.now() - 1, id).run();
    expect(await pollConfirm(env, user, id, second.token)).toEqual({ status: "expired" });
    expect(await publicConfirm(env, user, id)).toBeNull();
    await expect(completeConfirm(env, user, id, second.token, second.code)).rejects.toThrow("expired");
  });
  it("a wrong number cancels the confirm without deciding the approval; the right one decides", async () => {
    const id = "ap_wrong";
    await add(id, "medium");
    const first = await startConfirm(env, user, id, "approve");
    const wrong = (await publicConfirm(env, user, id))!.choices.find(x => x !== first.code)!;
    expect(await completeConfirm(env, user, id, first.token, wrong)).toEqual({ status: "denied" });
    expect(await pollConfirm(env, user, id, first.token)).toEqual({ status: "denied" });
    expect((await getApproval(env, user, id))?.status).toBe("pending");
    const second = await startConfirm(env, user, id, "approve");
    await expect(completeConfirm(env, user, id, first.token, first.code)).rejects.toThrow("replaced");
    expect((await completeConfirm(env, user, id, second.token, second.code)).approval?.status).toBe("approved");
    expect(await pollConfirm(env, user, id, second.token)).toEqual({ status: "approved" });
  });
});

describe("approval PIN", () => {
  it("stores a salted slow hash, approves ordinary risk, and refuses high risk and host runs", async () => {
    await setPin(env, user, "1234567");
    const state = await env.DB.prepare(`SELECT salt, hash FROM approval_pins WHERE user = ?`).bind(user).first<{ salt: string; hash: string }>();
    expect(state?.hash).not.toContain("1234567");
    expect(state?.salt).toMatch(/^[a-f0-9]{32}$/);
    await add("ap_pin_low", "low");
    expect((await decideWithPin(env, user, "ap_pin_low", "1234567")).status).toBe("approved");
    await add("ap_pin_high", "high");
    await expect(decideWithPin(env, user, "ap_pin_high", "1234567")).rejects.toMatchObject({ status: 403 });
    await add("ap_pin_host", "low", "atteo host");
    await expect(decideWithPin(env, user, "ap_pin_host", "1234567")).rejects.toMatchObject({ status: 403 });
  }, 30_000);
  it("locks on five wrong tries per 15 minutes, disables after three lockouts, and alerts on each wrong try", async () => {
    await add("ap_pin_fail", "low");
    for (let lock = 1; lock <= 3; lock++) {
      for (let n = 1; n <= 5; n++) {
        await expect(decideWithPin(env, user, "ap_pin_fail", "7654321")).rejects.toBeInstanceOf(TerminalApprovalError);
      }
      const state = await pinState(env, user);
      expect(state.lockouts).toBe(lock);
      expect(state.enabled).toBe(lock < 3);
      if (lock < 3) {
        await expect(decideWithPin(env, user, "ap_pin_fail", "1234567")).rejects.toMatchObject({ status: 429 });
        await env.DB.prepare(`UPDATE approval_pins SET locked_until = 0, window_start = ? WHERE user = ?`).bind(Date.now() - PIN_WINDOW_MS - 1, user).run();
      }
    }
    const alerts = await env.DB.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE user = ? AND entry_type = 'approval_pin_failed'`).bind(user).first<{ n: number }>();
    expect(alerts?.n).toBe(15);
    await expect(decideWithPin(env, user, "ap_pin_fail", "1234567")).rejects.toMatchObject({ status: 403 });
    await setPin(env, user, "999999");
    expect(await pinState(env, user)).toMatchObject({ enabled: true, lockouts: 0 });
  }, 60_000);
  it("resets the attempt window after fifteen minutes", () => {
    expect(failedPinState({ attempts: 4, window_start: 1, lockouts: 0 }, 1 + PIN_WINDOW_MS)).toMatchObject({ attempts: 1, lockouts: 0, locked_until: 0 });
  });
});
