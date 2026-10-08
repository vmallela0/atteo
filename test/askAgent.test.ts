// "Ask" (jxn #6339): who a question is for, in the words people use, and which post answers it.
import { describe, expect, it } from "vitest";
import { answerIn, copiesOf, parseTarget, pickAgent } from "../src/askAgent";
import type { Entry } from "../src/types";

describe("parseTarget", () => {
  it("your own agents: my grok, me/grok, your own name", () => {
    expect(parseTarget("my grok", "jxn")).toEqual({ own: true, users: ["jxn"], agent: "grok" });
    expect(parseTarget("My Claude Code", "jxn")).toEqual({ own: true, users: ["jxn"], agent: "claude code" });
    expect(parseTarget("me/grok", "jxn")).toEqual({ own: true, users: ["jxn"], agent: "grok" });
    expect(parseTarget("@jxn/grok", "jxn")).toEqual({ own: true, users: ["jxn"], agent: "grok" });
    expect(parseTarget("jxn's grok", "jxn")).toEqual({ own: true, users: ["jxn"], agent: "grok" });
  });
  it("someone else's: jxn/muse, jxn's muse (any apostrophe), jxns muse, their agent at large", () => {
    expect(parseTarget("jxn/muse", "vedu")).toEqual({ own: false, users: ["jxn"], agent: "muse" });
    expect(parseTarget("jxn's muse", "vedu")).toEqual({ own: false, users: ["jxn"], agent: "muse" });
    expect(parseTarget("jxn’s muse", "vedu")).toEqual({ own: false, users: ["jxn"], agent: "muse" });
    expect(parseTarget("jxns muse", "vedu")).toEqual({ own: false, users: ["jxns", "jxn"], agent: "muse" });
    expect(parseTarget("jxn's agent", "vedu")).toEqual({ own: false, users: ["jxn"], agent: null });
    expect(parseTarget("@jxn", "vedu")).toEqual({ own: false, users: ["jxn"], agent: null });
  });
  it("all of your own agents, like texting yourself (jxn #6431)", () => {
    const all = { own: true, users: ["jxn"], agent: null, all: true };
    for (const w of ["my agents", "all my agents", "All", "everyone", "me", "myself", "my agent", "jxn", "@jxn", "jxn's agents"]) expect(parseTarget(w, "jxn"), w).toEqual(all);
    expect(parseTarget("vedu's agents", "jxn")).toEqual({ own: false, users: ["vedu"], agent: null }); // theirs at large, not all of them
    expect(parseTarget("my grok", "jxn")).toEqual({ own: true, users: ["jxn"], agent: "grok" });
  });
  it("nothing to go on", () => {
    expect(parseTarget("", "jxn")).toBeNull();
    expect(parseTarget("  ", "jxn")).toBeNull();
    expect(parseTarget("!!", "jxn")).toBeNull();
  });
});

describe("pickAgent", () => {
  const s = (name: string, client: string | null, state: "live" | "idle" | "gone" = "live", kind: "main" | "fork" = "main") =>
    ({ id: `as_${name}xxxxxxxxxxxx`, user: "jxn", name, client, model: null, boards: [], created_at: 0, last_seen: 0, ended_at: null, status: null, scope: "full", kind, active: true, state }) as never;
  // Most recently active first, as sessions.list returns them.
  const list = [s("alt-lead", "Claude Code"), s("muse", "Muse"), s("grok-2", "Grok", "idle"), s("alt-1", "Claude Code"), s("old", "Grok", "gone"), s("scratch", "Grok", "live", "fork")];
  it("by session name first, then by client (the most recent one)", () => {
    expect(pickAgent(list, "muse")?.name).toBe("muse");
    expect(pickAgent(list, "alt-1")?.name).toBe("alt-1");
    expect(pickAgent(list, "claude code")?.name).toBe("alt-lead");
    expect(pickAgent(list, "grok")?.name).toBe("grok-2");
  });
  it("forks and sessions gone for the day aren't asked", () => {
    expect(pickAgent(list, "old")).toBeNull();
    expect(pickAgent(list, "scratch")).toBeNull();
    expect(pickAgent(list, "codex")).toBeNull();
  });
});

describe("answerIn", () => {
  const e = (seq: number, author: string, via: "agent" | "person", reply_to: number | null = null, resolves: number[] = []) => ({ seq, author, via, reply_to, resolves, text: `#${seq}` }) as unknown as Entry;
  it("the agent's reply to the question, or what resolves it", () => {
    expect(answerIn([e(11, "vedu", "agent", 3), e(12, "jxn", "agent", 10)], { seq: 10, user: "jxn", own: false })?.seq).toBe(12);
    expect(answerIn([e(12, "jxn", "agent", null, [10])], { seq: 10, user: "jxn", own: true })?.seq).toBe(12);
  });
  it("not the person themselves, and not before the question", () => {
    expect(answerIn([e(9, "jxn", "agent", null), e(11, "jxn", "person", 10)], { seq: 10, user: "jxn", own: false })).toBeNull();
  });
  it("on a direct board their agent's next post is the answer; on your own agent chat only a reply is (other agents of yours talk there too)", () => {
    expect(answerIn([e(11, "jxn", "agent", null)], { seq: 10, user: "jxn", own: false })?.seq).toBe(11);
    expect(answerIn([e(11, "jxn", "agent", null)], { seq: 10, user: "jxn", own: true })).toBeNull();
  });
});

describe("copiesOf (all my agents, jxn #6431)", () => {
  const q = (seq: number, text: string, session: string | null, author = "jxn", type = "question") =>
    ({ seq, ts: seq, author, via: "agent", type, text, mentions: session ? [{ user: "jxn", agent: true, session }] : [], reply_to: null, resolves: [] }) as unknown as Entry;
  it("finds each agent's copy of the same words, from the first one on", () => {
    const entries = [q(4, "@jxn/lead standup?", "lead"), q(5, "@jxn/grok standup?", "grok"), q(6, "@jxn/muse something else", "muse"), q(7, "@jxn/muse standup?", "muse", "vedu"), q(8, "@jxn/muse standup?", "muse")];
    expect(copiesOf(entries, "jxn", 4)).toEqual([{ agent: "lead", seq: 4 }, { agent: "grok", seq: 5 }, { agent: "muse", seq: 8 }]);
  });
  it("nothing when that entry isn't one of your questions to an agent", () => {
    expect(copiesOf([q(4, "@jxn/lead hi", "lead", "vedu")], "jxn", 4)).toEqual([]);
    expect(copiesOf([q(4, "hi", null)], "jxn", 4)).toEqual([]);
    expect(copiesOf([q(4, "@jxn/lead hi", null)], "jxn", 4)).toEqual([]); // named in text only, not routed
  });
});
