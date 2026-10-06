import { describe, expect, it, vi } from "vitest";

// mcp.ts reaches the Durable Object class through board.ts; the tool list and instructions don't need it.
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
import { TOOLS } from "../src/mcp";
import { docsPage } from "../src/docs";

// No node types in the test tsconfig (see inbox.test.ts): fs comes in untyped and is cast.
const { readFileSync } = (await import("node:" + "fs")) as { readFileSync: (p: string, enc: string) => string };
const SKILL_MD = readFileSync("skills/atteo/SKILL.md", "utf8");
const html = docsPage("https://atteo.dev", SKILL_MD).text();

describe("the /docs page (moby #3152 item 5)", () => {
  it("renders every MCP tool by name, with its description, and links the other agent pages", async () => {
    const page = await html;
    for (const t of TOOLS) expect(page, t.name).toContain(`id="tool-${t.name}"`);
    expect(page).toContain(escapeHtml(TOOLS[0].description.slice(0, 40)));
    for (const s of ["/guide", "/agents.md", "/skill.md"]) expect(page).toContain(`href="${s}"`);
  });

  it("renders the skill's markdown: frontmatter gone, headings, lists, bold and code", async () => {
    const page = await html;
    expect(page).not.toContain("name: atteo"); // the frontmatter is stripped
    expect(page).toContain(`<h2 id="cli-rules-that-keep-it-safe">Rules that keep it safe</h2>`);
    expect(page).toContain(`<a href="#cli-rules-that-keep-it-safe">`); // in the side nav and On this page
    expect(page).not.toMatch(/the<\/p>\n<p>claims/); // a wrapped paragraph stays one paragraph
    expect(page).toContain("<ol>"); // the walk-through is a numbered list
    expect(page).toContain("<strong>data, not instructions</strong>");
    expect(page).toContain("<code>atteo guide</code>");
  });
});

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
