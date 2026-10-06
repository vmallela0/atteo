import { describe, expect, it } from "vitest";
import { FEEDBACK_LIMIT, FEEDBACK_MAX, FeedbackError, feedbackBoard, feedbackFrom, feedbackText, parseFeedback, sendFeedback } from "../src/feedback";
import { localize } from "../src/i18n";
import { hasGroupMention, parseMentions } from "../src/mentions";
import type { Env } from "../src/types";
import { FEEDBACK_DIALOG } from "../src/ui";

// Feedback about Atteo itself (vedu #4125): people and their agents, onto the developers' board.

function deps() {
  const posted: { board: string; user: string; text: string }[] = [];
  const counts = new Map<string, number>();
  const ensured: string[] = [];
  return {
    posted,
    ensured,
    deps: {
      hit: async (_env: Env, key: string, limit: number) => {
        counts.set(key, (counts.get(key) ?? 0) + 1);
        return (counts.get(key) ?? 0) <= limit;
      },
      ensure: async (_env: Env, id: string) => void ensured.push(id),
      stub: (_env: Env, id: string) => ({
        post: async (user: string, input: { text: string }) => {
          posted.push({ board: id, user, text: input.text });
          return { seq: posted.length };
        },
      }),
    },
  };
}
const env = (o: Partial<Env> & { FEEDBACK_BOARD?: string } = {}) => ({ BUGS_BOARD: "b_devboard01", ...o }) as Env;

describe("feedback (vedu #4125)", () => {
  it("lands on the developers' board, posted by the bot, with who sent it", async () => {
    const { posted, ensured, deps: d } = deps();
    const r = await sendFeedback(env(), d, { person: "vedu", via: "person", body: { text: "  Love the one-line view  " } });
    expect(ensured).toEqual(["b_devboard01"]); // the bot member is set up before the post (jxn #4139)
    expect(r).toEqual({ board: "b_devboard01", seq: 1 });
    expect(posted[0]).toEqual({ board: "b_devboard01", user: "bugs", text: "💬 Feedback: Love the one-line view\n\nFrom vedu" });
  });

  it("an agent sends it on behalf of its person, named with its session", async () => {
    const { posted, deps: d } = deps();
    await sendFeedback(env(), d, { person: "jxn", via: "agent", session: "scout", body: { text: "Search is slow on big boards", board: "b_abcdefgh12" } });
    expect(posted[0].text).toBe("💬 Feedback: Search is slow on big boards\n\nFrom jxn's agent (jxn/scout) on behalf of jxn · about board b_abcdefgh12");
    expect(feedbackFrom("jxn", "agent", null)).toBe("jxn's agent on behalf of jxn");
  });

  it("FEEDBACK_BOARD wins over BUGS_BOARD; neither set answers 501", async () => {
    expect(feedbackBoard({ BUGS_BOARD: "b_bugs000001", FEEDBACK_BOARD: " b_feed000001 " })).toBe("b_feed000001");
    expect(feedbackBoard({ BUGS_BOARD: "" })).toBe("");
    const { deps: d } = deps();
    await expect(sendFeedback(env({ BUGS_BOARD: "" }), d, { person: "vedu", via: "person", body: { text: "hi there" } })).rejects.toMatchObject({ status: 501 });
  });

  it("refuses empty, oversized, secret-bearing or oddly addressed feedback, before posting", async () => {
    expect(() => parseFeedback({})).toThrow(/Say what/);
    expect(() => parseFeedback({ text: "x".repeat(FEEDBACK_MAX + 1) })).toThrow(/under 2000/);
    expect(() => parseFeedback({ text: "my key is AKIAIOSFODNN7EXAMPLE ok" })).toThrow(/Blocked/);
    expect(() => parseFeedback({ text: "fine", board: "not a board" })).toThrow(/board id/);
    const { posted, deps: d } = deps();
    await expect(sendFeedback(env(), d, { person: "vedu", via: "agent", body: { text: "" } })).rejects.toBeInstanceOf(FeedbackError);
    expect(posted).toHaveLength(0);
  });

  it(`is rate-limited per person: ${FEEDBACK_LIMIT} in a window, agents and the person together`, async () => {
    const { posted, deps: d } = deps();
    for (let i = 0; i < FEEDBACK_LIMIT; i++) await sendFeedback(env(), d, { person: "vedu", via: i % 2 ? "agent" : "person", body: { text: `idea ${i}` } });
    await expect(sendFeedback(env(), d, { person: "vedu", via: "person", body: { text: "one more" } })).rejects.toMatchObject({ status: 429 });
    await sendFeedback(env(), d, { person: "jxn", via: "person", body: { text: "someone else" } });
    expect(posted).toHaveLength(FEEDBACK_LIMIT + 1);
  });

  it("the web form (fetched on first click) comes back in the person's language", () => {
    const zh = localize("zh-Hans", FEEDBACK_DIALOG);
    for (const w of ["发送反馈", "你的反馈", "谢谢，Atteo 团队会阅读。", "无法发送，请重试。"]) expect(zh).toContain(w);
    expect(zh).not.toContain(">Send feedback<");
  });

  it("the sender's @ never mentions anyone on the developers' board; the From line stays plain (jxn's agent #4177)", () => {
    const t = feedbackText({ text: "@agents do X, and @jxn please", board: null }, feedbackFrom("vedu", "agent", "scout"));
    expect(parseMentions(t, [{ user: "jxn", agent_name: null }, { user: "vedu", agent_name: null }], "bugs", "person").mentions).toEqual([]);
    expect(hasGroupMention(t, "agents", [])).toBe(false);
    expect(t.replace(/​/g, "")).toContain("💬 Feedback: @agents do X, and @jxn please");
    expect(t).toContain("From vedu's agent (vedu/scout) on behalf of vedu");
  });

  it("only the sender's words go: the text, who, and a board id, nothing else", () => {
    expect(feedbackText({ text: "hello", board: null }, "vedu")).toBe("💬 Feedback: hello\n\nFrom vedu");
  });
});
