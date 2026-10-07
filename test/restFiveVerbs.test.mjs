import { afterEach, describe, expect, it, vi } from "vitest";
import { Atteo } from "../sdk/js/atteo.mjs";

const seen = [];
afterEach(() => {
  vi.unstubAllGlobals();
  seen.length = 0;
});

describe("five verb JavaScript wrapper", () => {
  it("builds the post, read, wait, handoff, approval request and approval read requests", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      seen.push({ url, ...init });
      return new Response(JSON.stringify({ ok: true, entries: [], last: 12 }), { headers: { "content-type": "application/json" } });
    }));
    const api = new Atteo("test-token", "https://api.example/");
    const board = "b_test";
    await api.post(board, "Fix is ready", { reply_to: 7 });
    await api.read(board, 7);
    await api.wait(board, 12, 20);
    await api.handoff(board, "Ready to gate", { branch: "fix/checkout", sha: "a".repeat(40), base: "b".repeat(40), checks: "vitest passed" });
    await api.approve({ board, title: "Push release", details: "Push reviewed commit", category: "push_main" });
    await api.approve({ id: "ap_example" });
    await api.approve({ id: "ap_example", decision: "approve", note: "Reviewed" });

    expect(seen.map(({ method, url }) => [method, url])).toEqual([
      ["POST", "https://api.example/api/boards/b_test/entries"],
      ["GET", "https://api.example/api/boards/b_test/entries?after=7&ack=1"],
      ["GET", "https://api.example/api/boards/b_test/entries?after=12&ack=1&wait=20"],
      ["POST", "https://api.example/api/boards/b_test/entries"],
      ["POST", "https://api.example/api/boards/b_test/approvals"],
      ["GET", "https://api.example/api/approvals/ap_example"],
      ["POST", "https://api.example/api/approvals/ap_example/approve"],
    ]);
    for (const call of seen) expect(call.headers.authorization).toBe("Bearer test-token");
    expect(JSON.parse(seen[0].body)).toEqual({ type: "note", text: "Fix is ready", reply_to: 7 });
    expect(JSON.parse(seen[3].body)).toEqual({ type: "handoff", text: "Ready to gate", handoff: { branch: "fix/checkout", sha: "a".repeat(40), base: "b".repeat(40), checks: "vitest passed" } });
    expect(JSON.parse(seen[4].body)).toEqual({ title: "Push release", details: "Push reviewed commit", category: "push_main" });
    expect(JSON.parse(seen[6].body)).toEqual({ note: "Reviewed" });
    expect(seen[1].body).toBeUndefined();
  });

  it("surfaces HTTP errors with the status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Read new entries first" }), { status: 409 })));
    await expect(new Atteo("test-token").post("b_test", "hello")).rejects.toMatchObject({ message: "Read new entries first", status: 409 });
  });
});
