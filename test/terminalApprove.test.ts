import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import type { Env } from "../src/types";
import { attachConfirms, completeConfirm, decideWithPin, failedPinState, numberChoices, pinState, pollConfirm, publicConfirm, removePin, setPin, startConfirm, TerminalApprovalError, CONFIRM_MS, CONFIRM_START_WINDOW_MS, PIN_WINDOW_MS } from "../src/terminalApprove";
import { getApproval, refOf } from "../src/approvals";
import { approvalCardHtml } from "../src/approvalCard";
import { approvalsPage } from "../src/approvalsPage";
import { mePage } from "../src/html";
import { hiddenPinPrompt, PIN_WARNING } from "../src/approvalPinCopy";

let mf: Miniflare;
let env: Env;
const user = "e2e-terminal-test";
const add = async (id: string, risk: string, client = "test", category: string | null = null, who = user) => env.DB.prepare(`INSERT INTO approvals (id, user, client, title, details, risk, status, created_at, expires_at, category) VALUES (?, ?, ?, ?, 'whole action', ?, 'pending', ?, ?, ?)`).bind(id, who, client, `Request ${id}`, risk, Date.now(), Date.now() + 300_000, category).run();

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: `export default { fetch() { return new Response("ok") } }`, d1Databases: { DB: "terminal-approval-test" } }));
  const DB = await mf.getD1Database("DB");
  env = { DB } as Env;
  await DB.exec(`CREATE TABLE approvals (id TEXT PRIMARY KEY, user TEXT, client TEXT, board_id TEXT, seq INTEGER, requested_by TEXT, title TEXT, details TEXT, tool TEXT, command TEXT, risk TEXT, status TEXT, created_at INTEGER, expires_at INTEGER, session TEXT, note TEXT, decided_at INTEGER, decided_via TEXT, category TEXT);
CREATE TABLE notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT, board_id TEXT, seq INTEGER, kind TEXT, actor TEXT, actor_via TEXT, entry_type TEXT, excerpt TEXT, created_at INTEGER, data TEXT, UNIQUE(user, board_id, seq));
CREATE TABLE approval_terminal_confirms (approval_id TEXT PRIMARY KEY, user TEXT, token TEXT, code TEXT, choices TEXT, decision TEXT, status TEXT, created_at INTEGER, expires_at INTEGER);
CREATE TABLE approval_confirm_starts (user TEXT, source TEXT, created_at INTEGER);
CREATE TABLE approval_pins (user TEXT PRIMARY KEY, salt TEXT, hash TEXT, attempts INTEGER DEFAULT 0, window_start INTEGER DEFAULT 0, locked_until INTEGER DEFAULT 0, lockouts INTEGER DEFAULT 0, disabled_at INTEGER, updated_at INTEGER);
CREATE TABLE approval_pin_daily (user TEXT PRIMARY KEY, day INTEGER, approvals INTEGER DEFAULT 0);`);
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
    const first = await startConfirm(env, user, id, "approve", "replace-session");
    expect(first.expires_at - Date.now()).toBeLessThanOrEqual(CONFIRM_MS);
    const second = await startConfirm(env, user, id, "reject", "replace-session");
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
    const first = await startConfirm(env, user, id, "approve", "wrong-session");
    const wrong = (await publicConfirm(env, user, id))!.choices.find(x => x !== first.code)!;
    expect(await completeConfirm(env, user, id, first.token, wrong)).toEqual({ status: "denied" });
    expect(await pollConfirm(env, user, id, first.token)).toEqual({ status: "denied" });
    expect((await getApproval(env, user, id))?.status).toBe("pending");
    const second = await startConfirm(env, user, id, "approve", "wrong-session");
    await expect(completeConfirm(env, user, id, first.token, first.code)).rejects.toThrow("replaced");
    expect((await completeConfirm(env, user, id, second.token, second.code)).approval?.status).toBe("approved");
    expect(await pollConfirm(env, user, id, second.token)).toEqual({ status: "approved" });
  });
  it("allows at most five starts per session or token in a rolling ten minutes, across approvals", async () => {
    await add("ap_limit_one", "low");
    await add("ap_limit_two", "low");
    let last = "";
    for (let i = 0; i < 5; i++) last = (await startConfirm(env, user, i % 2 ? "ap_limit_two" : "ap_limit_one", "approve", "token-one")).token;
    const count = async () => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE user = ? AND entry_type = 'terminal_confirm'`).bind(user).first<{ n: number }>())!.n;
    const before = await count();
    await expect(startConfirm(env, user, "ap_limit_two", "reject", "token-one")).rejects.toMatchObject({ status: 429 });
    expect(await count()).toBe(before);
    expect((await publicConfirm(env, user, "ap_limit_one"))?.token).toBe(last);
    expect((await startConfirm(env, user, "ap_limit_two", "approve", "token-two")).token).toBeTruthy();
    await env.DB.prepare(`UPDATE approval_confirm_starts SET created_at = ? WHERE rowid = (SELECT MIN(rowid) FROM approval_confirm_starts WHERE user = ? AND source = ?)`).bind(Date.now() - CONFIRM_START_WINDOW_MS - 1, user, "token-one").run();
    expect((await startConfirm(env, user, "ap_limit_one", "approve", "token-one")).token).toBeTruthy();
    await expect(startConfirm(env, user, "ap_limit_one", "approve", "token-one")).rejects.toMatchObject({ status: 429 });
  });
});

describe("approval PIN", () => {
  it("stores a salted slow hash, approves ordinary risk, and refuses high risk and host runs", async () => {
    await setPin(env, user, "1234567");
    const state = await env.DB.prepare(`SELECT salt, hash FROM approval_pins WHERE user = ?`).bind(user).first<{ salt: string; hash: string }>();
    expect(state?.hash).not.toContain("1234567");
    expect(state?.salt).toMatch(/^[a-f0-9]{32}$/);
    await add("ap_pin_low", "low", "test", "other");
    const decided = await decideWithPin(env, user, "ap_pin_low", "1234567");
    expect(decided.status).toBe("approved");
    expect((await getApproval(env, user, "ap_pin_low"))?.decided_via).toBe("approval_pin");
    expect((await getApproval(env, user, "ap_pin_low"))?.decision_label).toBe("approved with PIN from a terminal");
    expect(refOf(decided).decision_label).toBe("approved with PIN from a terminal");
    expect(approvalCardHtml(refOf(decided))).toContain("approved with PIN from a terminal");
    const approvedAlert = await env.DB.prepare(`SELECT excerpt, data FROM notifications WHERE user = ? AND entry_type = 'approval_pin_approved'`).bind(user).first<{ excerpt: string; data: string }>();
    expect(approvedAlert?.excerpt).toBe("Approved with PIN: Request ap_pin_low");
    expect(JSON.parse(approvedAlert!.data).push.title).toBe("Approved with PIN");
    const page = await approvalsPage({ name: user, email: "test@example.com", display_name: null, admin: false }, [], [decided], {}).text();
    expect(page).toContain("approved with PIN from a terminal");
    await add("ap_pin_high", "high");
    await expect(decideWithPin(env, user, "ap_pin_high", "1234567")).rejects.toMatchObject({ status: 403 });
    await add("ap_pin_host", "low", "atteo host");
    await expect(decideWithPin(env, user, "ap_pin_host", "1234567")).rejects.toMatchObject({ status: 403 });
    // Medium, uncategorized, Atteo-made PACT sends and every sensitive category need the web or phone.
    await add("ap_pin_medium", "medium", "test", "other");
    await expect(decideWithPin(env, user, "ap_pin_medium", "1234567")).rejects.toMatchObject({ status: 403 });
    await add("ap_pin_uncat", "low");
    await expect(decideWithPin(env, user, "ap_pin_uncat", "1234567")).rejects.toMatchObject({ status: 403 });
    await add("ap_pin_pact", "low", "test", "other");
    await env.DB.prepare(`UPDATE approvals SET tool = 'pact' WHERE id = 'ap_pin_pact'`).run();
    await expect(decideWithPin(env, user, "ap_pin_pact", "1234567")).rejects.toMatchObject({ status: 403 });
    expect((await getApproval(env, user, "ap_pin_pact"))?.status).toBe("pending");
    for (const category of ["deploy_production", "spending", "outbound_external", "delete_data", "push_main"]) {
      const id = `ap_pin_${category}`;
      await add(id, "low", "test", category);
      await expect(decideWithPin(env, user, id, "1234567")).rejects.toMatchObject({ status: 403 });
      expect((await getApproval(env, user, id))?.status).toBe("pending");
    }
  }, 30_000);
  it("warns the person at PIN setup and in the hidden terminal prompt", async () => {
    const warning = "Never give this PIN to an agent or paste it into a chat.";
    expect(PIN_WARNING).toBe(warning);
    const page = await mePage({ name: user, email: "test@example.com", display_name: null, admin: false }, [], [], undefined, false, [], null, [], [], null, null, { enabled: false, locked_until: 0, lockouts: 0 }).text();
    expect(page).toContain(warning);
    expect(hiddenPinPrompt()).toBe(`${warning}\nApproval PIN: `);
  });
  it("caps PIN approvals at 20 per UTC day across approvals and PIN resets", async () => {
    await setPin(env, user, "1234567");
    const day = Math.floor(Date.now() / 86_400_000) * 86_400_000;
    await env.DB.prepare(`INSERT INTO approval_pin_daily (user, day, approvals) VALUES (?, ?, 19) ON CONFLICT(user) DO UPDATE SET day=excluded.day, approvals=excluded.approvals`).bind(user, day).run();
    await add("ap_pin_twentieth", "low", "test", "other");
    await add("ap_pin_capped", "low", "test", "other");
    expect((await decideWithPin(env, user, "ap_pin_twentieth", "1234567")).status).toBe("approved");
    await setPin(env, user, "1234567");
    await expect(decideWithPin(env, user, "ap_pin_capped", "1234567")).rejects.toMatchObject({ status: 429, message: "PIN approvals are capped for today; approve on the web or phone." });
    await expect(decideWithPin(env, user, "ap_pin_capped", "7654321")).rejects.toMatchObject({ status: 429, message: "PIN approvals are capped for today; approve on the web or phone." });
    expect((await getApproval(env, user, "ap_pin_capped"))?.status).toBe("pending");
    expect((await env.DB.prepare(`SELECT approvals FROM approval_pin_daily WHERE user = ?`).bind(user).first<{ approvals: number }>())?.approvals).toBe(20);
    await removePin(env, user);
    await setPin(env, user, "1234567");
    await expect(decideWithPin(env, user, "ap_pin_capped", "1234567")).rejects.toMatchObject({ status: 429 });
    await env.DB.prepare(`UPDATE approval_pin_daily SET day = ? WHERE user = ?`).bind(day - 86_400_000, user).run();
    expect((await decideWithPin(env, user, "ap_pin_capped", "1234567")).status).toBe("approved");
    expect((await env.DB.prepare(`SELECT day, approvals FROM approval_pin_daily WHERE user = ?`).bind(user).first<{ day: number; approvals: number }>())).toEqual({ day, approvals: 1 });
  }, 30_000);
  it("allows only one of two simultaneous PIN approvals at the daily boundary", async () => {
    const who = `${user}-parallel`;
    await setPin(env, who, "1234567");
    const day = Math.floor(Date.now() / 86_400_000) * 86_400_000;
    await env.DB.prepare(`INSERT INTO approval_pin_daily (user, day, approvals) VALUES (?, ?, 19)`).bind(who, day).run();
    await add("ap_pin_parallel_a", "low", "test", "other", who);
    await add("ap_pin_parallel_b", "low", "test", "other", who);
    const results = await Promise.allSettled([decideWithPin(env, who, "ap_pin_parallel_a", "1234567"), decideWithPin(env, who, "ap_pin_parallel_b", "1234567")]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected").map(r => (r as PromiseRejectedResult).reason.status)).toEqual([429]);
    expect((await env.DB.prepare(`SELECT approvals FROM approval_pin_daily WHERE user = ?`).bind(who).first<{ approvals: number }>())?.approvals).toBe(20);
  }, 30_000);
  it("locks on five wrong tries per 15 minutes, disables after three lockouts, and alerts on each wrong try", async () => {
    await add("ap_pin_fail", "low", "test", "other");
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
