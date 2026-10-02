import { describe, expect, it } from "vitest";
import { forAgent, forPerson, highlightMentions, mentionLabel, mentionsOwnAgent, parseMentions } from "../src/mentions";
import { entryHeader, formatSummary, computeSummary } from "../src/state";
import { renderText } from "../src/ui";
import { firstLine, involved, mentionOptions, shortTitle, summaryHtml } from "../src/html";
import type { BoardInfo, Entry } from "../src/types";

const members = ["vedu", "jxn", "j.doe", "ops-bot"];
const parse = (text: string, author = "vedu", via: "agent" | "person" = "agent") => parseMentions(text, members, author, via);
const person = (user: string) => ({ user, agent: false });
const agent = (user: string) => ({ user, agent: true });

let seq = 0;
function e(partial: Partial<Entry>): Entry {
  seq += 1;
  return {
    seq: partial.seq ?? seq,
    ts: Date.UTC(2026, 9, 2, 10, 0, seq),
    author: "vedu",
    type: "note",
    text: `entry ${seq}`,
    to: null,
    reply_to: null,
    resolves: [],
    supersedes: null,
    retracts: null,
    artifact_name: null,
    artifact_size: null,
    ...partial,
  };
}
const info: BoardInfo = { id: "b_test1234", title: "Test", created_by: "vedu", created_at: 0, entry_count: 0, last_seq: 0 };

describe("parseMentions", () => {
  it("finds people and agents, in order, once each, case-insensitively", () => {
    expect(parse("@JXN can you ask @jxn's agent, and @jxn again?").mentions).toEqual([person("jxn"), agent("jxn")]);
    expect(parse("@ops-bot’s agent please rerun").mentions).toEqual([agent("ops-bot")]);
    expect(parse("@jxn's   agent").mentions).toEqual([agent("jxn")]);
  });

  it("'s alone is possessive, not the agent", () => {
    expect(parse("is this @jxn's idea?").mentions).toEqual([person("jxn")]);
  });

  it("drops trailing punctuation unless the full handle is a member", () => {
    expect(parse("thanks @jxn. and @jxn, and (@jxn) @jxn-").mentions).toEqual([person("jxn")]);
    expect(parse("cc @j.doe.").mentions).toEqual([person("j.doe")]);
  });

  it("ignores emails, paths and code", () => {
    expect(parse("mail jxn@jxn.com or see https://x.com/@jxn and a/@jxn").mentions).toEqual([]);
    expect(parse("run `@jxn` and\n```\n@jxn's agent\n```\nok").mentions).toEqual([]);
  });

  it("reports handles that aren't members", () => {
    const r = parse("@nobody and @jxn and @Nobody");
    expect(r.mentions).toEqual([person("jxn")]);
    expect(r.unknown).toEqual(["nobody"]);
  });

  it("self-mentions cross the person/agent line: you hand work to your agent, your agent gets your attention", () => {
    expect(parse("@vedu @vedu's agent", "vedu", "person").mentions).toEqual([agent("vedu")]);
    expect(parse("@vedu @vedu's agent", "vedu", "agent").mentions).toEqual([{ user: "vedu", agent: false }]);
  });

  it("@agents mentions every member's agent (not the posting agent itself)", () => {
    expect(parse("@agents please review", "vedu", "person").mentions).toEqual(members.map(agent));
    const fromAgent = parse("@agents ping", "vedu", "agent").mentions;
    expect(fromAgent.some((m) => m.user === "vedu")).toBe(false);
    expect(fromAgent.every((m) => m.agent)).toBe(true);
    expect(highlightMentions("@agents go", parse("@agents go", "vedu", "person").mentions)).toContain('data-user="agents">@agents</span>');
  });

  it("caps the number of mentions", () => {
    const many = Array.from({ length: 30 }, (_, i) => `m${i}`);
    expect(parseMentions(many.map((m) => "@" + m).join(" "), many).mentions).toHaveLength(20);
  });
});

describe("addressing", () => {
  it("to and agent mentions are for the agent; person mentions are for the person", () => {
    expect(forAgent({ to: "jxn" }, "jxn")).toBe(true);
    expect(forAgent({ to: null, mentions: [agent("jxn")] }, "jxn")).toBe(true);
    expect(forAgent({ to: null, mentions: [person("jxn")] }, "jxn")).toBe(false);
    expect(forPerson({ to: null, mentions: [person("jxn")] }, "jxn")).toBe(true);
    expect(forPerson({ to: "jxn" }, "jxn")).toBe(false);
    expect(forAgent({ to: null }, "jxn")).toBe(false);
  });

  it("knows when a person handed something to their own agent", () => {
    expect(mentionsOwnAgent({ author: "jxn", mentions: [agent("jxn")] })).toBe(true);
    expect(mentionsOwnAgent({ author: "jxn", mentions: [agent("vedu")] })).toBe(false);
    expect(mentionsOwnAgent({ author: "jxn" })).toBe(false);
  });

  it("labels mentions for agents and for people", () => {
    expect(mentionLabel(agent("vedu"))).toBe("@vedu's agent");
    expect(mentionLabel(person("vedu"))).toBe("@vedu");
    expect(mentionLabel(agent("jxn"), "jxn")).toBe("you");
    expect(mentionLabel(person("jxn"), "jxn")).toBe("your user");
    expect(mentionLabel(agent("jxn"), "jxn", "person")).toBe("your agent");
    expect(mentionLabel(person("jxn"), "jxn", "person")).toBe("you");
  });
});

describe("rendering", () => {
  it("highlights stored mentions only, people and agents differently", () => {
    const html = renderText("@jxn and @jxn's agent, not @nobody.", [person("jxn"), agent("jxn")]);
    expect(html).toContain(`<span class="mention" data-user="jxn">@jxn</span> and`);
    expect(html).toContain(`<span class="mention agent" data-user="jxn">@jxn&#39;s agent</span>,`);
    expect(html).toContain("not @nobody.");
  });

  it("keeps punctuation outside the highlight and never touches links or code", () => {
    const html = renderText("thanks @jxn. https://x.com/?u=@jxn `@jxn`", [person("jxn")]);
    expect(html).toContain(`<span class="mention" data-user="jxn">@jxn</span>.`);
    expect(html).toContain(`<a href="https://x.com/?u=@jxn"`);
    expect(html).toContain("<code>@jxn</code>");
  });

  it("highlights mentions inside headings and list items too", () => {
    const html = renderText("# For @jxn\n- @jxn's agent rerun tests\n1. ask @jxn", [person("jxn"), agent("jxn")]);
    expect(html).toMatch(/<h3 class="md-h">For <span class="mention" data-user="jxn">@jxn<\/span><\/h3>/);
    expect(html).toContain(`<li><span class="mention agent" data-user="jxn">@jxn&#39;s agent</span> rerun tests</li>`);
    expect(html).toContain(`<li>ask <span class="mention" data-user="jxn">@jxn</span></li>`);
  });

  it("an agent mention in the text that wasn't stored stays plain", () => {
    expect(highlightMentions("@jxn&#39;s agent", [person("jxn")])).toBe("@jxn&#39;s agent");
  });

  it("stays escaped", () => {
    expect(renderText("@jxn<img src=x onerror=alert(1)>", [person("jxn")])).not.toContain("<img");
  });
});

describe("summaries", () => {
  const q1 = e({ seq: 1, type: "question", text: "@jxn's agent which port?" , mentions: [agent("jxn")] });
  const q2 = e({ seq: 2, type: "question", text: "@jxn can you approve?", mentions: [person("jxn")] });
  const q3 = e({ seq: 3, type: "question", text: "anyone?" });
  const t1 = e({ seq: 4, type: "task", author: "jxn", via: "person", text: "@jxn's agent run the tests", mentions: [agent("jxn")] });

  it("an agent sees what's for it, what's for its user, and the rest", () => {
    const text = formatSummary(info, [], computeSummary([q1, q2, q3, t1]), "jxn");
    const at = (s: string) => text.indexOf(s);
    expect(at("Questions waiting for YOU")).toBeLessThan(at("#1 "));
    expect(at("Questions for your user (jxn)")).toBeLessThan(at("#2 "));
    expect(at("Open questions:")).toBeLessThan(at("#3 "));
    expect(at("Tasks for YOU")).toBeLessThan(at("#4 "));
    expect(text).toMatch(/Open tasks:\n {2}none/);
  });

  it("entry headers name mentions; only other people's tasks carry the check-with-your-user note", () => {
    expect(entryHeader(q1, "jxn")).toContain("mentions you");
    expect(entryHeader(q2, "jxn")).toContain("mentions your user");
    expect(entryHeader(q2, "vedu")).toContain("mentions @jxn");
    const fromVedu = e({ type: "task", author: "vedu", mentions: [agent("jxn")] });
    expect(entryHeader(fromVedu, "jxn")).toContain("check with your user");
    expect(entryHeader(t1, "jxn")).not.toContain("check with your user");
  });

  it("the web shows what waits on you and what you handed to your agent", () => {
    const html = summaryHtml([q1, q2, q3, t1], "jxn", []);
    const waiting = html.slice(html.indexOf("Waiting on you"), html.indexOf("For your agent"));
    const agentBox = html.slice(html.indexOf("For your agent"), html.indexOf("Open questions"));
    expect(waiting).toContain("#2");
    expect(agentBox).toContain("#1");
    expect(agentBox).toContain("#4");
    expect(html.slice(html.indexOf("Open questions"))).toContain("#3");
  });

  it("autocomplete offers other people and agents, and your own agent but not yourself", () => {
    const opts = mentionOptions(["jxn", "vedu"], "jxn").map((o) => `${o.ins}|${o.k}`);
    expect(opts).toEqual(["vedu|person", "vedu's agent|agent", "jxn's agent|your agent", "agents|every agent"]);
  });
});

describe("one-line summaries", () => {
  it("firstLine skips code, headings and list markers", () => {
    expect(firstLine("\n\n```\ncode\n```\n# Title here\nmore")).toBe("Title here");
    expect(firstLine("- first item\n- second")).toBe("first item");
    expect(firstLine("Assignment: **the social layer**\n\n**Scope**\n1. Profiles")).toBe("Assignment: **the social layer**");
  });

  it("sidebar items: who's involved as avatars, a 3–4 word title, the full text on hover", () => {
    const t = e({ seq: 9, type: "task", author: "vedu", via: "agent", to: "jxn", text: "Rerun the flaky checkout test\n\nThen post the log.", mentions: [{ user: "sam", agent: false }] });
    const html = summaryHtml([t], "jxn", []);
    expect(html).toContain(`<span class="one">Rerun the flaky checkout…</span><span class="n">#9</span>`);
    expect(html).toContain(`title="vedu&#39;s agent → jxn: Rerun the flaky checkout test Then post the log."`);
    expect(involved(t).map((x) => `${x.user}${x.agent ? "/agent" : ""}`)).toEqual(["vedu/agent", "jxn/agent", "sam"]);
    expect((html.match(/class="av sm/g) ?? []).length).toBe(3);
  });

  it("short titles: the author's own title, else the first few words with mentions left out", () => {
    expect(shortTitle({ text: "long text", title: "Fix empty carts", artifact_name: null })).toBe("Fix empty carts");
    expect(shortTitle({ text: "@jxn's agent: Assignment for the social layer (backlog: friends)", artifact_name: null })).toBe("Assignment for the social…");
    expect(shortTitle({ text: "Ship it.", artifact_name: null })).toBe("Ship it");
    expect(shortTitle({ text: "@vedu", artifact_name: null })).toBe("#entry");
  });
});

describe("the sidebar summary", () => {
  it("leaves files to the Files tab and shows only sections with something in them", () => {
    const f = e({ seq: 12, type: "artifact", text: "Trace", artifact_name: "trace.log", artifact_size: 20, artifact_version: 2 });
    const html = summaryHtml([f], "jxn", []);
    expect(html).not.toContain("data-open-file");
    expect(html).not.toContain("Open questions");
    expect(html).toContain("Nothing open.");
    const q = e({ seq: 13, type: "question", text: "Which port?" });
    expect(summaryHtml([q], "jxn", [])).toContain("Open questions");
    expect(summaryHtml([q], "jxn", [])).not.toContain("Nothing open.");
  });
});

describe("mentioning one agent session", () => {
  it("@user/name is that person's agent, naming one of their sessions", () => {
    const { mentions } = parseMentions("@vedu/scout run the tests, and @jxn please review", ["vedu", "jxn"], "sam", "agent");
    expect(mentions).toEqual([{ user: "vedu", agent: true, session: "scout" }, { user: "jxn", agent: false }]);
  });
  it("a session can hand work to another session of the same person", () => {
    expect(parseMentions("@jxn/claude take the UI", ["jxn"], "jxn", "agent").mentions).toEqual([{ user: "jxn", agent: true, session: "claude" }]);
  });
  it("paths and emails are still not mentions", () => {
    expect(parseMentions("see https://x.dev/@vedu/scout and a@vedu/scout", ["vedu"]).mentions).toEqual([]);
  });
  it("is labelled by its session", () => {
    expect(mentionLabel({ user: "vedu", agent: true, session: "scout" }, "jxn")).toBe("@vedu/scout");
    expect(mentionLabel({ user: "jxn", agent: true, session: "scout" }, "jxn")).toBe('your session "scout"');
    expect(highlightMentions("@vedu/scout go", [{ user: "vedu", agent: true, session: "scout" }])).toBe('<span class="mention agent" data-user="vedu">@vedu/scout</span> go');
  });
});
