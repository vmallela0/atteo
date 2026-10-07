import { describe, expect, it } from "vitest";
import { requestContent } from "../src/approvals";

describe("approval content shared by MCP and REST", () => {
  let encrypted = true, archived = false, epoch = 3, rotate = false;
  const env = { DB: { prepare: (sql: string) => ({ bind: () => ({
    first: async () => sql.includes("SELECT encrypted, archived_at") ? { encrypted: Number(encrypted), archived_at: archived ? 1 : null } : { rotate_needed: Number(rotate) },
    all: async () => ({ results: sql.includes("FROM board_epochs") ? [{ epoch }] : [] }),
  }) }) } } as never;
  const board = "b_example123";
  const sealed = JSON.stringify({ v: 2, epoch: 3, iv: "cipher-iv", ct: "cipher-title" });
  const sealed_details = JSON.stringify({ v: 1, recipients: [{ kid: "mine" }], iv: "private-iv", ct: "private-details" });

  it("refuses plaintext on encrypted boards and accepts current-epoch envelopes without storing clear fields", async () => {
    await expect(requestContent(env, "alice", board, { title: "secret", details: "private" })).rejects.toThrow("sealed and sealed_details");
    const content = await requestContent(env, "alice", board, { title: "Encrypted approval request", sealed, sealed_details });
    expect(content).toEqual({ title: "🔒 Encrypted approval request", details: sealed_details, command: null, sealed });
    await expect(requestContent(env, "alice", board, { title: "secret", sealed, sealed_details })).rejects.toThrow("only as sealed");
    await expect(requestContent(env, "alice", board, { sealed, sealed_details, command: "secret" })).rejects.toThrow("only as sealed");
  });

  it("checks the epoch, rotation, and the person's details envelope", async () => {
    await expect(requestContent(env, "alice", board, { sealed: JSON.stringify({ v: 2, epoch: 2 }), sealed_details })).rejects.toThrow("epoch 3");
    epoch = 0;
    await expect(requestContent(env, "alice", board, { sealed: JSON.stringify({ v: 2, epoch: 0, iv: "iv", ct: "ct" }), sealed_details })).rejects.toThrow("epoch 0");
    epoch = 3;
    rotate = true;
    await expect(requestContent(env, "alice", board, { sealed, sealed_details })).rejects.toThrow("after opening the next one");
    rotate = false;
    await expect(requestContent(env, "alice", board, { sealed: JSON.stringify({ v: 2, epoch: 3 }), sealed_details })).rejects.toThrow("v2 envelope");
    await expect(requestContent(env, "alice", board, { sealed })).rejects.toThrow("With sealed");
    await expect(requestContent(env, "alice", board, { sealed, sealed_details: JSON.stringify({ v: 1, recipients: [] }) })).rejects.toThrow("v1 envelope");
    await expect(requestContent(env, "alice", board, { sealed, sealed_details: "x".repeat(20_001) })).rejects.toThrow("20,000");
  });

  it("refuses sealed on plain boards and requests on archived boards", async () => {
    encrypted = false;
    await expect(requestContent(env, "alice", board, { sealed, sealed_details })).rejects.toThrow("only with an end-to-end encrypted board");
    expect(await requestContent(env, "alice", board, { title: "Push", details: "the reviewed commit" })).toMatchObject({ title: "Push", details: "the reviewed commit", sealed: undefined });
    archived = true;
    await expect(requestContent(env, "alice", board, { title: "Push", details: "the reviewed commit" })).rejects.toThrow("archived");
  });
});
