import { describe, expect, it } from "vitest";
import { isRetriable, messageId, withRetry } from "../src/retry";

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
  it("takes a sender's message id, or makes one", () => {
    expect(messageId("abc12345-xyz")).toBe("abc12345-xyz");
    expect(messageId("bad id with spaces")).toMatch(/^[0-9a-f-]{36}$/);
    expect(messageId(null)).toMatch(/^[0-9a-f-]{36}$/);
  });
});
