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

describe("keyboard approvals (#1426)", () => {
  it("the card script compiles and keys only the focused or picked card; the card shows the hint for its person", async () => {
    const { approvalJs, approvalCardHtml } = await import("../src/approvalCard");
    const js = approvalJs("jxn");
    expect(() => new Function(js)).not.toThrow();
    expect(js).toContain("#thread .entry.sel .apc.st-pending, .apc.kbd-sel");
    expect(js).toContain("input,textarea,select,[contenteditable]");
    const html = approvalCardHtml({ id: "ap_x", user: "jxn", status: "pending", risk: "high", command: "rm -rf build" }, true);
    expect(html).toContain('class="apc-kbd');
    expect(html).toContain("High risk");
  });
  it("the Approvals page script compiles, says the keys, and makes each waiting request focusable", async () => {
    const { approvalsPage } = await import("../src/approvalsPage");
    const a = { id: "ap_y", user: "jxn", status: "pending", title: "Deploy", risk: "high", created_at: 1, expires_at: Date.now() + 60000 } as unknown as Parameters<typeof approvalsPage>[2][number];
    const html = await approvalsPage({ name: "jxn", email: "j@example.com", display_name: null, admin: false }, [], [a], {}).text();
    expect(html).toContain('class="xs faint ap-keys"');
    expect(html).toContain('id="ap_y" tabindex="0"');
    for (const s of [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])) expect(() => new Function(s)).not.toThrow();
  });
});
