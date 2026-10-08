import { describe, expect, it, vi } from "vitest";
// The tool definitions do not use the Durable Object class, but mcp.ts imports board.ts.
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
import worker from "../landing/src/index";
import { CLI_COMMANDS, MCP_TOOLS } from "../landing/src/developers";
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
  return [...source.slice(start, end).matchAll(/^  (?:([a-z][a-z0-9_]*)|"([a-z][a-z0-9-]*|--version)")(?=[:,])/gm)]
    .map((match) => match[1] ?? match[2]);
}

describe("developer docs", () => {
  it("serves jxn's /developers (#5977) with the live sections, every MCP tool and every CLI command (jxn #5998)", async () => {
    const res = await worker.fetch(new Request("http://localhost/developers"), env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<link rel="canonical" href="https://atteo.dev/developers">');
    // Plain HTML (landing/jxn-pages/unbundle.mjs): what it says is in the page, as a crawler reads it.
    const text = html.replace(/<(script|style)[\s\S]*?<\/\1>/g, " ").replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ");
    for (const heading of ["the 5 verbs", "how it fits together", "three ways in", "every mcp tool", "every cli command", "http api essentials", "suggested workflow"])
      expect(html).toMatch(new RegExp(`<h2 id="[a-z-]+"[^>]*>${heading}</h2>`));
    expect(html).toContain('href="https://atteo.dev/openapi.json"');
    expect(text).toContain("curl -fsSL https://atteo.dev/install.sh | sh");
    for (const verb of ["post", "read", "wait", "handoff", "approve"]) {
      const start = html.indexOf(`id="verb-${verb}"`);
      expect(start, verb).toBeGreaterThan(-1);
      const example = html.slice(start, html.indexOf("</div></div>", start));
      expect(example.indexOf("atteo "), verb).toBeGreaterThan(-1); // the CLI line first (jxn #6044), then curl
      expect(example.indexOf("atteo "), verb).toBeLessThan(example.indexOf("curl -sS"));
      expect(example, verb).toContain("Response (trimmed)");
    }
    for (const path of ["/api/boards/$BOARD/entries?after=0&ack=1", "/api/boards/$BOARD/entries?after=12&ack=1&wait=25", "/api/boards/$BOARD/approvals", "/api/approvals/$APPROVAL"]) expect(text).toContain(path);
    expect(html).toContain("sdk/js/README.md");
    expect(html).toContain("sdk/python/README.md");
    for (const [name, desc, actions] of MCP_TOOLS) expect(text, name).toContain(` ${name} ${desc}${actions ? ` actions: ${actions.join(", ")}` : ""} `);
    for (const [command, desc, example] of CLI_COMMANDS) expect(text, command).toContain(` atteo ${command} ${desc} $ ${example} `);
    const faq = await (await worker.fetch(new Request("http://localhost/faq"), env)).text();
    expect(faq).toContain('href="/developers"'); // jxn's FAQ (#5977) links here by path
    expect(await (await worker.fetch(new Request("http://localhost/sitemap.xml"), env)).text()).toContain("<loc>https://atteo.dev/developers</loc>");
    expect(await (await worker.fetch(new Request("http://localhost/llms.txt"), env)).text()).toContain("https://atteo.dev/developers");
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
