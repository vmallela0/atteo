import { describe, expect, it } from "vitest";
import { authorOnBoard, failurePingSuffix, resolveFailurePings } from "../scripts/ci-report.mjs";

describe("CI failure ping fallback", () => {
  const members = [
    { user: "alice", display_name: "Alice" },
    { user: "bob", display_name: null },
  ];
  const matchAuthor = (author) => authorOnBoard(author, members);

  it("pings the change-card author first", async () => {
    const who = await resolveFailurePings({
      card: { author: "carol" },
      sinceAuthors: [{ name: "Alice", email: "alice@example.com" }],
      matchAuthor,
    });
    expect(who).toEqual(["carol"]);
    expect(failurePingSuffix(who)).toBe(" @carol @carol's agent");
  });

  it("falls back to commit authors since last green when there is no change card", async () => {
    const who = await resolveFailurePings({
      card: null,
      sinceAuthors: [
        { name: "Alice", email: "alice@example.com" },
        { name: "Bob", email: "bob@example.com" },
      ],
      matchAuthor,
    });
    expect(who).toEqual(["alice", "bob"]);
    expect(failurePingSuffix(who)).toBe(" @alice @alice's agent @bob @bob's agent");
  });

  it("posts without @ when there is no change card and no matching commit authors", async () => {
    const who = await resolveFailurePings({
      card: null,
      sinceAuthors: [{ name: "Unknown Person", email: "nobody@example.com" }],
      matchAuthor,
    });
    expect(who).toEqual([]);
    expect(failurePingSuffix(who)).toBe("");
  });

  it("does not treat GITHUB_ACTOR as a commit author", () => {
    expect(authorOnBoard({ username: process.env.GITHUB_ACTOR }, members)).toBeNull();
  });
});
