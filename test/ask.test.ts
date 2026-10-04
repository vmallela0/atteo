import { describe, expect, it } from "vitest";
import { askPage, askSuggestions } from "../src/ask";

const viewer = { name: "maya", email: "maya@example.com", display_name: null, admin: false };

describe("Ask (Everyday part 4)", () => {
  it("suggests from your own chats and friends, most active first; generic ones fill up to four", () => {
    const s = askSuggestions("maya", [
      { id: "b_1", title: "Field trip", kind: null },
      { id: "b_2", title: "maya ↔ sam", kind: "direct" },
      { id: "b_3", title: "Your agent", kind: "agent" },
      { id: "b_4", title: "Corner Studio", kind: null },
    ]).map((x) => x.text);
    expect(s).toEqual(["Find a time to talk with sam next week", "What did I miss in Field trip?", "What's still open in Corner Studio?", "What's waiting for me today?"]);
    const none = askSuggestions("maya", []).map((x) => x.text);
    expect(none.length).toBe(3);
    expect(none[0]).toBe("What's waiting for me today?");
  });

  it("renders the mic, Type instead and suggestions, escapes chat titles, and its script compiles", async () => {
    const res = askPage(viewer, [{ id: "b_1", title: "<b>Trip</b></script>", kind: null }], { assistant: "Jarvis", agentChat: "b_agent1" });
    const html = await res.text();
    expect(html).toContain('id="ask-mic"');
    expect(html).toContain("Type instead");
    expect(html).toContain("Jarvis · your assistant");
    expect(html).toContain("What did I miss in &lt;b&gt;Trip&lt;/b&gt;&lt;/script&gt;?");
    expect(html).not.toContain("<b>Trip</b>");
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    for (const s of scripts) expect(() => new Function(s)).not.toThrow();
    expect(scripts.join("\n")).toContain('let CHAT="b_agent1";const ME="maya"');
  });

  it("works before the agent chat exists (made on first use)", async () => {
    const html = await askPage(viewer, [], { assistant: null, agentChat: null }).text();
    expect(html).toContain("let CHAT=null");
    expect(html).toContain(">Your assistant<");
  });
});
