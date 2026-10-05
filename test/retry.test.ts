import { describe, expect, it } from "vitest";
import { BAD_MESSAGE_ID, badMessageId, isRetriable, messageId, retryingReads, withRetry } from "../src/retry";

describe("retry", () => {
  it("knows which board errors are safe to retry", () => {
    expect(isRetriable(new Error("Durable Object reset because its code was updated."))).toBe(true);
    expect(isRetriable(new Error("Network connection lost."))).toBe(true);
    expect(isRetriable(new Error('"x" is archived, so it\'s read-only.'))).toBe(false);
  });
  it("retries transient errors, then succeeds", async () => {
    let n = 0;
    const v = await withRetry(async () => (++n < 3 ? Promise.reject(new Error("Network connection lost.")) : "ok"), [1, 1, 1]);
    expect(v).toBe("ok");
    expect(n).toBe(3);
  });
  it("doesn't retry real errors", async () => {
    let n = 0;
    await expect(withRetry(async () => (++n, Promise.reject(new Error("type must be one of"))), [1, 1])).rejects.toThrow("type must be");
    expect(n).toBe(1);
  });
  it("takes a sender's message id, makes one when none is sent, and refuses a malformed one (SPEC.md §17)", () => {
    expect(messageId("abc12345-xyz")).toBe("abc12345-xyz");
    expect(messageId(" abc12345-xyz ")).toBe("abc12345-xyz");
    expect(messageId(null)).toMatch(/^[0-9a-f-]{36}$/);
    expect(messageId("")).toMatch(/^[0-9a-f-]{36}$/);
    // Replaced, a malformed id meant the sender's retry posted twice; now it's refused, with what a good one looks like.
    for (const bad of ["bad id with spaces", "short", "x".repeat(101), "émoji-123456"]) {
      expect(badMessageId(bad)).toBe(BAD_MESSAGE_ID);
      expect(() => messageId(bad)).toThrow(BAD_MESSAGE_ID);
    }
    expect(badMessageId(null)).toBeNull();
    expect(badMessageId("0b7c6a2e-5d1f-4a7e-9c3b-1e2f3a4b5c6d")).toBeNull(); // the web's crypto.randomUUID()
    expect(badMessageId(`${Date.now()}-${Math.random().toString(36).slice(2)}`)).toBeNull(); // its fallback
  });
});

describe("retryingReads", () => {
  const fakeDb = (fails: number) => {
    let calls = 0;
    const stmt = (sql: string) => ({
      sql,
      bind: (..._a: unknown[]) => stmt(sql),
      first: async () => {
        calls++;
        if (calls <= fails) throw new Error("D1_ERROR: Network connection lost.");
        return { ok: sql };
      },
      run: async () => {
        calls++;
        if (calls <= fails) throw new Error("D1_ERROR: Network connection lost.");
        return { ok: true };
      },
    });
    const db = { prepare: (sql: string) => stmt(sql), batch: async (s: unknown[]) => s, calls: () => calls };
    return db;
  };
  it("retries a read through a dropped connection", async () => {
    const db = fakeDb(2);
    const r = await (retryingReads(db as unknown as D1Database).prepare("SELECT 1").bind(1).first() as Promise<unknown>);
    expect(r).toEqual({ ok: "SELECT 1" });
    expect(db.calls()).toBe(3);
  });
  it("doesn't retry writes (they may have committed)", async () => {
    const db = fakeDb(1);
    await expect(retryingReads(db as unknown as D1Database).prepare("UPDATE x SET y = 1").run()).rejects.toThrow("Network connection lost");
    expect(db.calls()).toBe(1);
  });
  it("hands batch() the real statements", async () => {
    const db = fakeDb(0);
    const wrapped = retryingReads(db as unknown as D1Database);
    const s = wrapped.prepare("SELECT 2");
    const out = (await wrapped.batch([s])) as unknown as { sql: string }[];
    expect(out[0].sql).toBe("SELECT 2");
    expect(out[0]).not.toBe(s);
  });
});
