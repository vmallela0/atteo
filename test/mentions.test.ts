import { describe, expect, it } from "vitest";
import { forAgent, forPerson, highlightMentions, mentionLabel, mentionsOwnAgent, parseMentions } from "../src/mentions";
import { entryHeader, formatSummary, computeSummary } from "../src/state";
import { cleanAgentName, handleLookalikes, skeleton } from "../src/agentName";
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

  it("@humans mentions every person on the board (not their agents, not the person posting)", () => {
    const got = parse("@humans standup in 5", "vedu", "person").mentions;
    expect(got.every((m) => !m.agent) && got.length === members.length - 1 && !got.some((m) => m.user === "vedu")).toBe(true);
    expect(highlightMentions("@humans hi", parse("@humans hi", "vedu", "person").mentions)).toContain('data-user="humans">@humans</span>');
  });

  it("@agents mentions every member's agent (not the posting agent itself)", () => {
    expect(parse("@agents please review", "vedu", "person").mentions).toEqual(members.map(agent));
    const fromAgent = parse("@agents ping", "vedu", "agent").mentions;
    expect(fromAgent.some((m) => m.user === "vedu")).toBe(false);
    expect(fromAgent.every((m) => m.agent)).toBe(true);
    expect(highlightMentions("@agents go", parse("@agents go", "vedu", "person").mentions)).toContain('data-user="agents">@agents</span>');
  });

  it("@all mentions every other person and their agent (never the author or their own agent), past the cap", () => {
    for (const via of ["person", "agent"] as const) {
      const got = parse("@all heads up.", "vedu", via).mentions;
      expect(got).toEqual(members.filter((m) => m !== "vedu").flatMap((m) => [person(m), agent(m)]));
    }
    expect(highlightMentions("@all. hi", parse("@all. hi", "vedu", "person").mentions)).toContain('<span class="mention" data-user="all">@all</span>.');
    expect(parseMentions("@all's agent", members, "vedu").mentions).toEqual([]);
    expect(parseMentions("@all hi", [...members, "all"], "vedu").mentions).toEqual([person("all")]); // a member named all
    const many = Array.from({ length: 30 }, (_, i) => `m${i}`);
    expect(parseMentions("@all go", many, "m0", "person").mentions).toHaveLength(58);
  });

  it("caps the number of mentions", () => {
    const many = Array.from({ length: 30 }, (_, i) => `m${i}`);
    expect(parseMentions(many.map((m) => "@" + m).join(" "), many).mentions).toHaveLength(20);
  });
});

describe("agent names", () => {
  const named = [{ user: "vedu", agent_name: "Jarvis" }, { user: "jxn", agent_name: "Big Friday" }, { user: "j.doe" }, { user: "ops-bot", agent_name: "O'Neil" }];
  const p = (text: string, author = "jxn", via: "agent" | "person" = "person") => parseMentions(text, named, author, via);

  it('"@Jarvis" is that member\'s agent: any case, with spaces and apostrophes, in order', () => {
    expect(p("@Jarvis can you check").mentions).toEqual([agent("vedu")]);
    expect(p("thanks @jarvis.").mentions).toEqual([agent("vedu")]);
    expect(p("@big friday and @O’Neil").mentions).toEqual([agent("jxn"), agent("ops-bot")]);
    expect(p("@j.doe then @JARVIS then @vedu").mentions).toEqual([person("j.doe"), agent("vedu"), person("vedu")]);
    expect(p("@Jarvis").unknown).toEqual([]);
  });

  it("a quoted message's @names don't ping again (vedu #1022)", () => {
    expect(parse("> @jxn's agent rerun the tests\n> — vedu, #12\n\n@j.doe see this").mentions).toEqual([person("j.doe")]);
    expect(parse("> @jxn a plain quote").mentions).toEqual([person("jxn")]);
  });

  it("only whole names, never in code, and not someone else's name on another board", () => {
    expect(p("@Jarvisx hi").mentions).toEqual([]);
    expect(p("@Jarvisx hi").unknown).toEqual(["jarvisx"]);
    expect(p("`@Jarvis` and x@Jarvis").mentions).toEqual([]);
    expect(parseMentions("@Jarvis hi", ["vedu", "jxn"], "jxn").unknown).toEqual(["jarvis"]); // names unknown here
  });

  it("a member's own handle wins over an agent name", () => {
    const withJarvis = [...named, { user: "jarvis" }];
    expect(parseMentions("@Jarvis hi", withJarvis, "jxn", "person").mentions).toEqual([person("jarvis")]);
    expect(parseMentions("@Jarvis's agent hi", withJarvis, "jxn", "person").mentions).toEqual([agent("jarvis")]);
  });

  it("two agents with one name don't resolve: the owner form is needed", () => {
    const twice = [{ user: "vedu", agent_name: "Jarvis" }, { user: "jxn", agent_name: "jarvis" }, { user: "kim" }];
    const r = parseMentions("@Jarvis ping, and @vedu's agent", twice, "kim", "person");
    expect(r.mentions).toEqual([agent("vedu")]);
    expect(r.ambiguous).toEqual(["Jarvis"]);
    expect(r.unknown).toEqual([]);
  });

  it("agents see the name with its owner, only when set", () => {
    expect(entryHeader(e({ author: "vedu", via: "agent", agent_name: "Jarvis" }))).toContain("Jarvis (vedu's agent)");
    expect(entryHeader(e({ author: "vedu", via: "agent" }))).toMatch(/ vedu's agent/);
    expect(entryHeader(e({ author: "vedu", via: "person", agent_name: "Jarvis" }))).not.toContain("Jarvis");
  });

  it("your own agent by name counts from you, not from it", () => {
    expect(p("@Big Friday take this", "jxn", "person").mentions).toEqual([agent("jxn")]);
    expect(p("@Big Friday take this", "jxn", "agent").mentions).toEqual([]);
  });
});

describe("cleanAgentName", () => {
  it("trims and clears", () => {
    expect(cleanAgentName("  Jarvis   Two ")).toBe("Jarvis Two");
    expect(cleanAgentName("O’Neil")).toBe("O'Neil");
    expect(cleanAgentName("")).toBeNull();
    expect(cleanAgentName(null)).toBeNull();
    expect(cleanAgentName("Jörg")).toBe("Jörg");
  });

  it("refuses long names, odd characters, owner claims and reserved words", () => {
    expect(() => cleanAgentName("x".repeat(25))).toThrow(/at most 24/);
    expect(() => cleanAgentName("Jar@vis")).toThrow(/letters, numbers/);
    expect(() => cleanAgentName(42)).toThrow(/text/);
    for (const n of ["vedu's agent", "Vedu’s Agent", "my friend's  agent too"]) expect(() => cleanAgentName(n), n).toThrow(/'s agent/);
    for (const n of ["all", "Everyone", "ATTEO", "you", "agents", "humans", "Every One", "аll"]) expect(() => cleanAgentName(n), n).toThrow(/reserved/);
  });

  it("sees through look-alike letters", () => {
    expect(skeleton("jхn")).toBe("jxn"); // Cyrillic х
    expect(skeleton("ВЕДУ")).not.toBe("vedu"); // not every Cyrillic capital: В, Д aren't mapped
    expect(skeleton("ｖｅｄｕ")).toBe("vedu"); // fullwidth (NFKC)
    expect(skeleton("vėdu")).toBe("vedu"); // accents
    expect(handleLookalikes("jхn")).toContain("jxn");
    expect(handleLookalikes("J Xn")).toEqual(expect.arrayContaining(["jxn", "j.xn", "j_xn", "j-xn"]));
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
    expect(opts).toEqual(["vedu|person", "vedu's agent|agent", "jxn's agent|your agent", "agents|every agent", "humans|every person", "all|everyone and their agents"]);
  });

  it("a person's agents are grouped under them: their agent, then each of their sessions", () => {
    const opts = mentionOptions(["jxn", "vedu"], "jxn", [{ user: "vedu", name: "scout", client: "Codex" }, { user: "vedu", name: "grok", client: "Grok" }]);
    expect(opts.map((o) => `${o.ins}|${o.sub ? "sub" : "top"}`)).toEqual(["vedu|top", "vedu's agent|sub", "vedu/scout|sub", "vedu/grok|sub", "jxn's agent|top", "agents|top", "humans|top", "all|top"]);
    expect(opts[1].k).toBe("all their agents");
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
