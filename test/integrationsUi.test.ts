import { describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
import { integrationsSection } from "../src/html";

// Board info → Integrations (vedu #6508): what each person sees before Linear's status loads.
const T = (s: string) => s;
const base = { id: "b_board12345", encrypted: false, archived: false, readOnly: false, isOwner: true, hidden: false, slack: true, slackChannels: [] as string[] };

describe("board info → Integrations", () => {
  it("lists Linear, Slack and the ones coming soon; an owner may connect", () => {
    const h = integrationsSection(T, base);
    expect(h).toContain('id="acc-integrations"');
    expect(h).toContain('data-can="1"');
    expect(h).toContain('id="int-linear"');
    expect(h).toContain(`href="/slack/connect?board=b_board12345">Connect Slack</a>`);
    for (const n of ["Discord", "Notion", "Microsoft Teams"]) expect(h).toMatch(new RegExp(`aria-disabled="true" data-soon><div class="grow"><div class="small int-name">${n}</div><div class="xs muted int-st">Coming soon`));
    expect(h).not.toContain("data-slack-connect"); // the ⋯ menu's button keeps that hook to itself
    expect(h).not.toMatch(/\son[a-z]+=/); // CSP: no inline handlers
  });
  it("a contributor or viewer sees status only", () => {
    for (const who of [{ isOwner: false }, { isOwner: false, readOnly: true }]) {
      const h = integrationsSection(T, { ...base, ...who, slackChannels: ["eng"] });
      expect(h).toContain('data-can=""');
      expect(h).not.toContain("/slack/connect");
      expect(h).toContain('Connected · <span class="mono">#eng</span>');
    }
  });
  it("says what isn't set up or possible, and isn't there on a DM or Your agent", () => {
    expect(integrationsSection(T, { ...base, slack: false })).toContain("Not set up on this server yet");
    const e2e = integrationsSection(T, { ...base, encrypted: true });
    expect(e2e).toContain('data-block="Not available on end-to-end encrypted boards"');
    expect(e2e).toContain('data-can=""');
    expect(e2e).not.toContain("/slack/connect");
    expect(integrationsSection(T, { ...base, archived: true })).toContain('data-can=""');
    expect(integrationsSection(T, { ...base, hidden: true })).toBe("");
  });
});
