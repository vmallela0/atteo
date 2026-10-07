import { describe, expect, it, vi } from "vitest";
// The tool definitions do not use the Durable Object class, but mcp.ts imports board.ts.
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
import worker from "../landing/src/index";
import { CLI_COMMANDS, DEVELOPERS_CSS, MCP_TOOLS } from "../landing/src/developers";
import { TOOLS } from "../src/mcp";
import commandsSource from "../cli/src/commands.ts?raw";
import v2Source from "../cli/src/v2.ts?raw";
import mainSource from "../cli/src/main.ts?raw";

const env = { APP_ORIGIN: "http://127.0.0.1:9" };

function tableKeys(source: string, variable: string): string[] {
  const start = source.indexOf(`const ${variable}:`);
  if (start < 0) throw new Error(`${variable} table missing`);
  const end = source.indexOf("\n};", start);
  if (end < 0) throw new Error(`${variable} table has no end`);
  return [...source.slice(start, end).matchAll(/^  (?:([a-z][a-z0-9_]*)|"(--version)")(?=[:,])/gm)]
    .map((match) => match[1] ?? match[2]);
}

describe("developer docs", () => {
  it("serves /developers as a public HTML page with the requested sections", async () => {
    const res = await worker.fetch(new Request("http://localhost/developers"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("script-src 'none'");
    const html = await res.text();
    for (const heading of ["The 5 verbs over HTTP", "How it fits together", "Three ways in", "Every MCP tool", "Every CLI command", "HTTP API essentials", "Suggested workflow"])
      expect(html).toContain(`>${heading}</h2>`);
    expect(html).toContain('<link rel="canonical" href="https://atteo.dev/developers">');
    expect(html).toContain('href="/openapi.json"');
    expect(html).toContain("curl -fsSL https://atteo.dev/install.sh | sh");
    for (const verb of ["post", "read", "wait", "handoff", "approve"]) {
      const start = html.indexOf(`id="verb-${verb}"`);
      expect(start, verb).toBeGreaterThan(-1);
      const example = html.slice(start, html.indexOf("</div>", start));
      expect(example, verb).toContain("curl -sS");
      expect(example, verb).toContain("Response (trimmed)");
    }
    expect(html).toContain("/api/boards/$BOARD/entries?after=0&amp;ack=1");
    expect(html).toContain("/api/boards/$BOARD/entries?after=12&amp;ack=1&amp;wait=25");
    expect(html).toContain("/api/boards/$BOARD/approvals");
    expect(html).toContain("/api/approvals/$APPROVAL");
    expect(html).toContain("sdk/js/README.md");
    expect(html).toContain("sdk/python/README.md");
    for (const [name] of MCP_TOOLS) expect(html, name).toContain(`<dt><code>${name}</code></dt>`);
    for (const [command] of CLI_COMMANDS) expect(html, command).toContain(`<dt><code>atteo ${command}</code></dt>`);
    const faq = await (await worker.fetch(new Request("http://localhost/faq"), env)).text();
    expect(faq).toContain('href=\\"/developers\\"'); // jxn's FAQ (#5977) links here by path
    expect(await (await worker.fetch(new Request("http://localhost/sitemap.xml"), env)).text()).toContain("<loc>https://atteo.dev/developers</loc>");
    expect(await (await worker.fetch(new Request("http://localhost/llms.txt"), env)).text()).toContain("https://atteo.dev/developers");
    expect(DEVELOPERS_CSS).toContain("overflow-x:auto");
    expect(DEVELOPERS_CSS).toContain("minmax(0,1fr)");
  });

  it("lists each MCP tool and every declared action exactly once", () => {
    expect(MCP_TOOLS.map(([name]) => name).sort()).toEqual(TOOLS.map((tool) => tool.name).sort());
    for (const tool of TOOLS) {
      const row = MCP_TOOLS.find(([name]) => name === tool.name);
      const action = (tool.inputSchema as { properties?: Record<string, { enum?: readonly string[] }> }).properties?.action;
      expect(row?.[1], tool.name).toBeTruthy();
      expect(row?.[2] ?? [], tool.name).toEqual(action?.enum ?? []);
    }
  });

  it("lists every dispatched CLI command with a description and example", () => {
    const commands = new Set([
      ...tableKeys(commandsSource, "COMMANDS"),
      ...tableKeys(v2Source, "V2"),
      ...tableKeys(mainSource, "run"),
    ]);
    const listed = CLI_COMMANDS.map(([name]) => name);
    expect(new Set(listed).size).toBe(listed.length);
    expect(listed.sort()).toEqual([...commands].sort());
    for (const [command, meaning, example] of CLI_COMMANDS) {
      expect(meaning.trim(), command).not.toBe("");
      expect(example.startsWith(`atteo ${command}`), command).toBe(true);
    }
  });
});
