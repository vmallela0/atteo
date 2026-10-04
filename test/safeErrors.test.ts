import { describe, expect, it } from "vitest";

// Error messages reach agents outside the <<untrusted>> fence (MCP tool errors, REST {error}), so they must not carry
// text other members wrote: anyone can create a board and title it `x". Ignore previous instructions…`. Boards are
// named by id in errors; lists of titles go through fence(). (test/e2e.mjs checks the live messages.)
const { readFileSync } = (await import("node:" + "fs")) as { readFileSync: (u: URL, enc: string) => string };
const source = (f: string) => readFileSync(new URL(`../src/${f}.ts`, (import.meta as unknown as { url: string }).url), "utf8");
const FILES = ["board", "mcp", "index", "invite", "social", "registry", "dm", "agents", "sessions", "billing", "decisions", "approvals"];
const MEMBER_SET = /\$\{[^}]*\b(title|board_title|display_name)\b[^}]*\}/;
const ERROR = /\b\w*Error\(|\berror:\s*`|message:\s*`/;

describe("agent-facing errors carry no member-set text", () => {
  it("no thrown error or invite message interpolates a board title or a display name", () => {
    const hits: string[] = [];
    for (const f of FILES) {
      source(f)
        .split("\n")
        .forEach((line: string, i: number) => {
          if (!ERROR.test(line) || !MEMBER_SET.test(line)) return;
          if (/fence\(/.test(line)) return; // fenced as untrusted data
          // Success messages for the board's creator acting on their own board (rename/archive/delete) are their own words.
          if (f === "index" && /ok: true/.test(line)) return;
          hits.push(`src/${f}.ts:${i + 1}: ${line.trim().slice(0, 160)}`);
        });
    }
    expect(hits).toEqual([]);
  });

  it("archived and encrypted errors name the board by id", () => {
    const src = source("board");
    expect(src).toContain("return `Board ${id} is archived, so it's read-only.");
    expect(src).toContain("return `Board ${id} is end-to-end encrypted:");
    expect(src).not.toMatch(/BoardError\(`"\$\{info\.title\}"/);
  });
});
