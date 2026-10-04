import { describe, expect, it } from "vitest";
import { approveLabel, chatLabel, detailLines, firstName, forYouPage, greetingFor, plainTitle, summaryLine, whoLabel } from "../src/forYou";
import type { Approval } from "../src/approvals";

const viewer = { name: "maya", email: "maya@example.com", display_name: "Maya Chen", admin: false };

describe("For you words", () => {
  it("greets by the time of day", () => {
    expect(greetingFor(7)).toBe("Good morning");
    expect(greetingFor(11)).toBe("Good morning");
    expect(greetingFor(12)).toBe("Good afternoon");
    expect(greetingFor(17)).toBe("Good afternoon");
    expect(greetingFor(18)).toBe("Good evening");
    expect(greetingFor(2)).toBe("Good evening");
  });
  it("greets by first name, else the handle", () => {
    expect(firstName(viewer)).toBe("Maya");
    expect(firstName({ name: "sam", display_name: null })).toBe("sam");
    expect(firstName({ name: "sam", display_name: "  " })).toBe("sam");
  });
  it("counts what needs you and what your assistant did", () => {
    expect(summaryLine(3, 5)).toBe("3 things need you. Your assistant did 5 more.");
    expect(summaryLine(1, 1)).toBe("1 thing needs you. Your assistant did 1 more.");
    expect(summaryLine(2, 0)).toBe("2 things need you.");
    expect(summaryLine(0, 0)).toBe("You're all caught up.");
    expect(summaryLine(0, 1)).toBe("You're all caught up. Your assistant did 1 thing for you today.");
  });
  it("names people, assistants and chats in plain words", () => {
    expect(whoLabel("sam", "agent", "maya")).toBe("Sam's assistant");
    expect(whoLabel("maya", "agent", "maya")).toBe("Your assistant");
    expect(whoLabel("priya", "person", "maya")).toBe("Priya");
    expect(chatLabel({ title: "Your agent", kind: "agent" }, "maya")).toBe("Your assistant");
    expect(chatLabel({ title: "maya ↔ sam", kind: "direct" }, "maya")).toBe("Sam");
    expect(chatLabel({ title: "Family", kind: null }, "maya")).toBe("Family");
    expect(chatLabel(null, "maya")).toBe("a chat");
  });
  it("turns a post into one plain sentence", () => {
    expect(plainTitle("@maya can you cover the 2pm call?")).toBe("Can you cover the 2pm call?");
    expect(plainTitle("@maya's agent, @sam: dinner?\nmore")).toBe("Dinner?");
    expect(plainTitle("@maya's assistant, @sam’s assistant: lunch?")).toBe("Lunch?"); // Everyday's word (#1527)
    expect(plainTitle("## **Saturday** dinner?")).toBe("Saturday dinner?");
    expect(plainTitle("", "A question for you")).toBe("A question for you");
    expect(plainTitle("x".repeat(300)).length).toBe(160);
  });
  it("names the amount on Approve, and splits detail lines", () => {
    expect(approveLabel("Pay $42 to Lisa for the field trip?")).toBe("Approve $42");
    expect(approveLabel("Deploy staging")).toBe("Approve");
    expect(detailLines("Museum $30 + lunch $12, Fri Oct 10\nFrom: Visa ··4821\n\nthird\nfourth")).toEqual([{ text: "Museum $30 + lunch $12, Fri Oct 10" }, { label: "From", text: "Visa ··4821" }, { text: "third" }]);
    expect(detailLines("")).toEqual([]);
  });
});

describe("For you page", () => {
  const ap: Approval = {
    id: "ap_x1",
    user: "maya",
    client: null,
    board_id: "b_fam00001",
    seq: 4,
    requested_by: "sam",
    title: "Pay $42 to <b>Lisa</b>?",
    details: "From: Visa </script>",
    tool: null,
    command: null,
    risk: "medium",
    session: null,
    status: "pending",
    state: "pending",
    note: null,
    created_at: 1,
    decided_at: null,
    expires_at: 9e15,
  };
  const side = [{ id: "b_fam00001", title: "Family <i>", kind: null }, { id: "b_self0001", title: "Your agent", kind: "agent" }];
  const boards = [
    {
      board: { id: "b_fam00001", title: "Family <i>", encrypted: false },
      decisions: [{ seq: 5, title: "Tacos on <Saturday>", author: "sam", via: "person", ts: 5 }],
      questions: [{ seq: 6, title: "@maya pick up Ava?", author: "priya", via: "person", ts: 6 }],
      done: [{ seq: 7, title: "Booked the dentist", kind: "task" as const, ts: Date.now() }],
    },
  ];

  it("renders every section, escaped, and its script compiles", async () => {
    const html = await forYouPage(viewer, side, { approvals: [ap], boards, mentions: [] }).text();
    expect(html).toContain("Needs your OK");
    expect(html).toContain("Approve $42");
    expect(html).toContain("Pay $42 to &lt;b&gt;Lisa&lt;/b&gt;?");
    expect(html).toContain("Visa &lt;/script&gt;");
    expect(html).toContain("Family &lt;i&gt;");
    expect(html).toContain("Tacos on &lt;Saturday&gt;");
    expect(html).toContain("Pick up Ava?");
    expect(html).toContain("Booked the dentist");
    expect(html).toContain("3 things need you. Your assistant did 1 more.");
    expect(html).toContain('data-fy-vote="agree"');
    expect(html).toContain('href="/b/b_self0001"');
    expect(html).not.toContain("<b>Lisa</b>");
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const s of scripts) expect(() => new Function(s)).not.toThrow();
  });

  it("says nothing needs you when nothing does", async () => {
    const html = await forYouPage(viewer, [], { approvals: [], boards: [], mentions: [] }).text();
    expect(html).toContain("Nothing needs you right now");
    expect(html).not.toContain('id="fy-ok"');
    expect(html).toMatch(/id="fy-empty"(?! hidden)/);
  });
});
