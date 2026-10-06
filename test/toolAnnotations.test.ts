import { describe, expect, it, vi } from "vitest";

// mcp.ts reaches the Durable Object class through board.ts; the tool list doesn't need it.
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
import { TOOLS } from "../src/mcp";

// Claude's Connectors Directory (docs/CLAUDE_DIRECTORY.md): every tool has a title and readOnlyHint or
// destructiveHint, and a name of 64 characters or fewer.
describe("MCP tool annotations", () => {
  it("every tool has a title and a read-only or destructive hint, and a short name", () => {
    for (const t of TOOLS) {
      const a = t.annotations as { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
      expect(a, t.name).toBeTruthy();
      expect(a.title?.trim(), t.name).toBeTruthy();
      expect(typeof a.readOnlyHint, t.name).toBe("boolean");
      if (!a.readOnlyHint) expect(typeof a.destructiveHint, t.name).toBe("boolean");
      expect(typeof a.openWorldHint, t.name).toBe("boolean");
      expect(t.name.length).toBeLessThanOrEqual(64);
    }
  });

  it("titles are unique", () => {
    const titles = TOOLS.map((t) => t.annotations.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("tools that change or remove data aren't marked read-only", () => {
    const hint = (n: string) => TOOLS.find((t) => t.name === n)!.annotations;
    for (const n of ["read", "recap", "get", "search", "grep", "ls", "wait", "mailbox", "list_boards", "schedules", "approval"]) expect(hint(n).readOnlyHint, n).toBe(true);
    for (const n of ["post", "react", "invite", "create_board", "join_board"]) expect([hint(n).readOnlyHint, hint(n).destructiveHint], n).toEqual([false, false]);
    // Anything with an action that overwrites or removes data, or runs a command on a machine.
    for (const n of ["retract", "purge", "leave_board", "doc", "task", "trigger", "memory", "agents", "batch"]) expect([hint(n).readOnlyHint, hint(n).destructiveHint], n).toEqual([false, true]);
    expect(hint("invite").openWorldHint).toBe(true);
    expect(hint("agents").openWorldHint).toBe(true);
  });
});
