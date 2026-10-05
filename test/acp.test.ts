import { describe, expect, it } from "vitest";
import { AcpAgent, promptText, speaker, type AcpBoard, type AcpEntry } from "../cli/src/acp";

/** A board in memory: post() adds entries; after() returns what's new, waiting (up to wait seconds) when there's none. */
function fakeBoard(me = "jxn") {
  const entries: AcpEntry[] = [];
  const asked: { text: string; to: string | null; replyTo: number | null }[] = [];
  const withdrawn: number[] = [];
  let wake: (() => void) | null = null;
  const post = (e: Omit<AcpEntry, "seq">) => {
    entries.push({ ...e, seq: entries.length + 1 });
    wake?.();
    return entries.length;
  };
  const board: AcpBoard = {
    resolve: async (cwd) => {
      if (cwd === "/nowhere") throw Object.assign(new Error("No board for /nowhere."), { rpcCode: -32602 });
      return "b_test";
    },
    ask: async (_b, text, opts) => {
      asked.push({ text, ...opts });
      return post({ author: me, via: "agent", type: "question", text, reply_to: opts.replyTo });
    },
    after: (_b, after, waitSec, signal) =>
      new Promise((res, rej) => {
        const done = () => res({ entries: entries.filter((e) => e.seq > after), last: entries.length });
        if (entries.length > after) return done();
        wake = done;
        setTimeout(done, waitSec * 1000); // the server's long-poll gives up after wait seconds
        signal.addEventListener("abort", () => rej(new Error("aborted")));
      }),
    withdraw: async (_b, seq) => void withdrawn.push(seq),
    me: () => me,
  };
  return { board, entries, asked, withdrawn, post };
}

function agent(to: string | null, b = fakeBoard(), waitSec = 30) {
  const sent: any[] = [];
  const a = new AcpAgent((m) => sent.push(m), b.board, { to, waitSec, version: "test", newId: () => "s1" });
  const call = async (id: number, method: string, params: Record<string, unknown> = {}) => {
    await a.handle({ jsonrpc: "2.0", id, method, params });
    return sent.find((m) => m.id === id);
  };
  return { a, sent, call, b };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("atteo acp (Agent Client Protocol v1)", () => {
  it("initialize answers protocol version 1, embedded context, no session/load", async () => {
    const { call } = agent("theo");
    const r = (await call(0, "initialize", { protocolVersion: 1, clientCapabilities: {} })).result;
    expect(r.protocolVersion).toBe(1);
    expect(r.agentCapabilities).toMatchObject({ loadSession: false, promptCapabilities: { embeddedContext: true, image: false } });
    expect(r.agentInfo).toMatchObject({ name: "atteo", title: "Atteo: theo's agent" });
    expect(r.authMethods).toEqual([]);
  });

  it("a prompt is a question to --to's agent; others' replies stream in; their answer ends the turn", async () => {
    const { a, sent, call, b } = agent("theo");
    expect((await call(1, "session/new", { cwd: "/repo", mcpServers: [] })).result).toEqual({ sessionId: "s1" });
    const turn = call(2, "session/prompt", { sessionId: "s1", prompt: [{ type: "text", text: "Which port does staging use?" }] });
    await tick();
    expect(b.asked[0]).toEqual({ text: "Which port does staging use?", to: "theo", replyTo: null });
    b.post({ author: "jxn", via: "person", type: "note", text: "my own note", reply_to: 1 }); // yours: never an answer
    b.post({ author: "ana", via: "agent", agent_name: "scout", type: "note", text: "I think 8443", reply_to: 1 });
    b.post({ author: "ana", via: "agent", type: "note", text: "unrelated", reply_to: null });
    await tick();
    expect(sent.some((m) => m.id === 2)).toBe(false); // still waiting for theo
    b.post({ author: "theo", via: "agent", type: "note", text: "8443, behind the VPN", reply_to: 1 });
    expect((await turn).result).toEqual({ stopReason: "end_turn" });
    const chunks = sent.filter((m) => m.params?.update?.sessionUpdate === "agent_message_chunk").map((m) => m.params.update.content.text);
    expect(chunks).toEqual(["ana's agent (scout):\n\nI think 8443\n\n", "theo's agent:\n\n8443, behind the VPN\n\n"]);
    const calls = sent.filter((m) => m.params?.update?.toolCallId === "ask-1").map((m) => m.params.update.status);
    expect(calls).toEqual(["in_progress", "completed"]);
    expect(sent.every((m) => m.jsonrpc === "2.0")).toBe(true);
    // The next prompt replies in the same thread.
    const next = call(3, "session/prompt", { sessionId: "s1", prompt: [{ type: "text", text: "And prod?" }] });
    await tick();
    expect(b.asked[1]).toEqual({ text: "And prod?", to: "theo", replyTo: 1 });
    b.post({ author: "theo", via: "agent", type: "note", text: "9443", reply_to: b.entries.length });
    expect((await next).result).toEqual({ stopReason: "end_turn" });
    void a;
  });

  it("without --to, the first answer from anyone ends the turn", async () => {
    const { call, b } = agent(null);
    await call(1, "session/new", { cwd: "/repo" });
    const turn = call(2, "session/prompt", { sessionId: "s1", prompt: [{ type: "text", text: "who owns billing?" }] });
    await tick();
    expect(b.asked[0].to).toBeNull();
    b.post({ author: "ana", via: "person", type: "note", text: "me", reply_to: 1 });
    expect((await turn).result).toEqual({ stopReason: "end_turn" });
  });

  it("session/cancel ends the turn as cancelled and withdraws a question nobody answered", async () => {
    const { a, call, b } = agent("theo");
    await call(1, "session/new", { cwd: "/repo" });
    const turn = call(2, "session/prompt", { sessionId: "s1", prompt: [{ type: "text", text: "hello?" }] });
    await tick();
    await a.handle({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s1" } });
    expect((await turn).result).toEqual({ stopReason: "cancelled" });
    expect(b.withdrawn).toEqual([1]);
    // The next prompt starts a new thread (the withdrawn one isn't its root).
    const next = call(3, "session/prompt", { sessionId: "s1", prompt: [{ type: "text", text: "again" }] });
    await tick();
    expect(b.asked[1].replyTo).toBeNull();
    b.post({ author: "theo", via: "agent", type: "note", text: "here", reply_to: 2 });
    await next;
  });

  it("a cancelled question someone already answered stays on the board", async () => {
    const { a, call, b } = agent("theo");
    await call(1, "session/new", { cwd: "/repo" });
    const turn = call(2, "session/prompt", { sessionId: "s1", prompt: [{ type: "text", text: "q" }] });
    await tick();
    b.post({ author: "ana", via: "agent", type: "note", text: "partial", reply_to: 1 });
    await tick();
    await a.handle({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s1" } });
    expect((await turn).result.stopReason).toBe("cancelled");
    expect(b.withdrawn).toEqual([]);
  });

  it("no answer within --wait: the turn ends and says where the question is", async () => {
    const { sent, call } = agent("theo", fakeBoard(), 1);
    await call(1, "session/new", { cwd: "/repo" });
    const r = await call(2, "session/prompt", { sessionId: "s1", prompt: [{ type: "text", text: "anyone?" }] });
    expect(r.result).toEqual({ stopReason: "end_turn" });
    expect(sent.filter((m) => m.params?.update?.sessionUpdate === "agent_message_chunk").at(-1).params.update.content.text).toContain("stays on the board as #1");
  }, 5000);

  it("errors: unknown method, unknown session, empty prompt, no board for the folder", async () => {
    const { call } = agent("theo");
    expect((await call(1, "session/load", { sessionId: "x" })).error.code).toBe(-32601);
    expect((await call(2, "session/prompt", { sessionId: "nope", prompt: [{ type: "text", text: "hi" }] })).error.message).toContain("No session nope");
    await call(3, "session/new", { cwd: "/repo" });
    expect((await call(4, "session/prompt", { sessionId: "s1", prompt: [{ type: "image", data: "…", mimeType: "image/png" }] })).error.code).toBe(-32602);
    const nb = await call(5, "session/new", { cwd: "/nowhere" });
    expect(nb.error).toEqual({ code: -32602, message: "No board for /nowhere." });
  });

  it("prompt content: text, embedded files fenced with their path, links by URI", () => {
    expect(
      promptText([
        { type: "text", text: "Is this right?" },
        { type: "resource", resource: { uri: "file:///repo/a.ts", mimeType: "text/plain", text: "const a = 1;\n" } },
        { type: "resource_link", uri: "file:///repo/b.ts", name: "b.ts" },
        { type: "image", data: "x", mimeType: "image/png" },
      ]),
    ).toBe("Is this right?\n\nfile:///repo/a.ts:\n```\nconst a = 1;\n```\n\n(b.ts: file:///repo/b.ts)");
    expect(promptText(null)).toBe("");
    expect(speaker({ seq: 1, author: "ana", via: "person", type: "note", text: "", reply_to: null })).toBe("ana");
  });
});
