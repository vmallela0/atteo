import { describe, expect, it } from "vitest";
import { homePage, mePage } from "../src/html";
import { assistantCard, assistantWelcomePage, grokBotMessage } from "../src/welcome";

const viewer = { name: "maya", email: "maya@example.com", display_name: null, admin: false };
const scriptsOf = (html: string) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
// What a person reads: tags, scripts, the link itself and the Grok Bot message (pasted to a bot, not read) left out.
const visible = (html: string) =>
  html
    .replace(/<script>[\s\S]*?<\/script>/g, "")
    .replace(/<style>[\s\S]*?<\/style>/g, "")
    .replace(/<pre hidden data-ev-alt>[\s\S]*?<\/pre>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/https?:\/\/\S+/g, "");

describe("Bring your assistant (/welcome)", () => {
  it("its scripts compile and the copy stays in plain words", async () => {
    const html = await assistantWelcomePage(viewer, [], "https://atteo.dev", []).text();
    for (const s of scriptsOf(html)) expect(() => new Function(s)).not.toThrow();
    const main = visible(html.slice(html.indexOf('<div class="ev">'), html.indexOf('<dialog class="palette"'))); // the page, not the app shell
    expect(main).toContain("Bring your assistant");
    expect(main).not.toMatch(/\bMCP\b|OAuth|\btoken\b|\bagents?\b/i);
  });

  it("real flows open a sheet with the link to copy; Muse and Atteo's assistant are coming soon with no action", async () => {
    const html = await assistantWelcomePage(viewer, [], "https://atteo.dev", []).text();
    for (const id of ["grok", "chatgpt", "claude"]) {
      expect(html).toContain(`data-open="ev-${id}"`);
      expect(html).toContain(`<dialog class="ev-sheet" id="ev-${id}"`);
    }
    expect(html.match(/data-ev-link>https:\/\/atteo\.dev\/mcp</g)?.length).toBe(3);
    for (const id of ["muse", "atteo"]) {
      const at = html.indexOf(`data-ev-tile="${id}"`);
      const row = html.slice(at, html.indexOf("Coming soon</span></div>", at) + 24);
      expect(row).toContain("Coming soon");
      expect(row).not.toMatch(/<button|<a /);
    }
    expect(html).toContain('href="/#connect"');
  });

  it("marks connected providers and escapes client names", async () => {
    const html = await assistantWelcomePage(viewer, [], "https://atteo.dev", ["Claude", "<img src=x>"]).text();
    expect(html).toContain("Connected now: Claude, &lt;img src=x&gt;");
    expect(html).not.toContain("<img src=x>");
    expect(html.slice(html.indexOf('data-ev-tile="claude"'), html.indexOf('data-ev-tile="muse"'))).toContain("Connected");
    expect(html.slice(html.indexOf('data-ev-tile="grok"'), html.indexOf('data-ev-tile="chatgpt"'))).not.toContain("Connected");
  });

  it("the Grok Bot message carries the link, and the Connect dialog uses the same message", async () => {
    expect(grokBotMessage("https://x.test/mcp")).toContain("URL https://x.test/mcp and sign in");
    const html = await homePage(viewer, [], [], [], { connected: false, onThisBoard: false }, undefined, true).text();
    for (const s of scriptsOf(html)) expect(() => new Function(s)).not.toThrow();
    expect(html).toContain("Routine that runs every 10 minutes");
    expect(html).toContain('id="ev-banner"');
    expect(await homePage(viewer, [], [], []).text()).not.toContain('id="ev-banner"');
  });

  it("Account shows the assistant card: names with Change, or a way to bring one", async () => {
    expect(assistantCard(["Grok", "Grok"])).toMatch(/Grok<\/div>[\s\S]*Change/);
    expect(assistantCard([])).toContain("Bring your assistant");
    const html = await mePage(viewer, [], [], undefined, false, [], null, ["Claude"]).text();
    for (const s of scriptsOf(html)) expect(() => new Function(s)).not.toThrow();
    expect(html).toContain('id="ev-acct"');
  });
});
