import { describe, expect, it } from "vitest";
import { approvalCardHtml, approvalLabel } from "../src/approvalCard";

const base = { id: "ap_x1", user: "jxn", title: "Clean the build", status: "pending", tool: "Bash", command: "rm -rf dist <old>", risk: "high", note: null, expires_at: Date.now() + 60_000 };

describe("approval card", () => {
  it("shows the exact command, escaped, with the tool and the risk", () => {
    const h = approvalCardHtml(base, true);
    expect(h).toContain("rm -rf dist &lt;old&gt;");
    expect(h).toContain(">Bash<");
    expect(h).toContain("High risk");
  });
  it("gives Approve / Deny to the person asked, hidden for everyone else", () => {
    expect(approvalCardHtml(base, true)).toMatch(/<span class="apc-acts">/);
    expect(approvalCardHtml(base, false)).toMatch(/<span class="apc-acts" hidden>/);
    expect(approvalLabel(base, true)).toBe("Waiting on you");
    expect(approvalLabel(base, false)).toBe("Waiting on jxn");
  });
  it("a decided or timed-out one has no buttons and says how it ended", () => {
    for (const [a, label] of [
      [{ ...base, status: "approved" }, "Approved"],
      [{ ...base, status: "rejected", note: "not today" }, "Denied"],
      [{ ...base, expires_at: Date.now() - 1 }, "Timed out, denied"],
    ] as const) {
      const h = approvalCardHtml(a, true);
      expect(h).not.toContain("data-apc-do");
      expect(h).toContain(label);
    }
    expect(approvalCardHtml({ ...base, status: "rejected", note: "not <today>" })).toContain("Note: not &lt;today&gt;");
  });
});

describe("approval entry in the conversation", () => {
  it("renders the card under the message, buttons hidden until the page knows who's looking", async () => {
    const { entryHtml } = await import("../src/html");
    const e = { seq: 7, ts: 1, author: "jxn", via: "agent", type: "approval", text: "Push the hotfix", to: null, mentions: [], reply_to: null, resolves: [], supersedes: null, retracts: null, artifact_name: null, artifact_size: null, approval: base };
    const h = entryHtml(e as never, "b_test1234");
    expect(h).toContain('data-apc="ap_x1"');
    expect(h).toContain('data-apc-user="jxn"');
    expect(h).toMatch(/<span class="apc-acts" hidden>/);
    expect(h).toContain("<p>Clean the build</p>"); // the card says where it stands; the message is just what's asked
    expect(entryHtml(e as never, "b_test1234", true, { retracted: true })).not.toContain("data-apc=");
  });
});
