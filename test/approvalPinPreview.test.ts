import { describe, expect, it } from "vitest";
import { pinApprovalPreview } from "../src/approvalPinCopy";

describe("terminal PIN approval preview", () => {
  it("shows the approval fields and five safe detail lines", () => {
    const preview = pinApprovalPreview({ id: "ap_preview", user: "alice", risk: "low", title: "Ship\u001b[2J", details: "one\ntwo\nthree\nfour\nfive\nsix", tool: "Bash", command: "echo ok\nrm -rf x", requested_by: "scout", session: null, client: "test" });
    expect(preview).toContain('Asker: scout\'s agent\nTitle: Ship\\x1b[2J\nTool: Bash\nCommand: "echo ok\\nrm -rf x"\nRisk: low');
    expect(preview).toContain("Details:\n  one\n  two\n  three\n  four\n  five\n  …");
    expect(preview).not.toContain("six");
  });
});
