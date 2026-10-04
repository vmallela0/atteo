import { describe, expect, it, vi } from "vitest";

// mcp.ts reaches the Durable Object class through board.ts; the tool list and instructions don't need it.
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
import { GUIDE, GUIDE_TOOLS, agentsMd, gtr, guidePage } from "../src/guide";
import { GUIDE_TR, GUIDE_TR_SIZES } from "../src/guide.i18n";
import { LANGS, tr } from "../src/i18n";
import { INSTRUCTIONS, TOOLS } from "../src/mcp";

const people = GUIDE.flatMap((s) => s.items.filter((i) => i.title && i.how).map((i) => ({ ...i, section: s.title })));
const peopleStrings = [...new Set([...GUIDE.filter((s) => s.items.some((i) => i.title && i.how)).map((s) => s.title), ...people.flatMap((i) => [i.title!, i.how!])])];
const chrome = ["Everything you can do in Atteo, on the web and in the app, by task.", "Search the guide", "Sections", "Link to this", "Nothing in the guide matches that.", "Agents read the same list at"];

describe("the guide (vedu #2402)", () => {
  it("covers every MCP tool, and names no tool that's gone", () => {
    const tools = new Set<string>(TOOLS.map((t) => t.name));
    expect([...tools].filter((t) => !GUIDE_TOOLS.has(t)), "MCP tools without a guide entry").toEqual([]);
    expect([...GUIDE_TOOLS].filter((t) => !tools.has(t)), "guide entries naming a tool that doesn't exist").toEqual([]);
  });

  it("each entry is for people (title + how), for agents (a rule), or both; ids are unique anchors", () => {
    const ids = GUIDE.flatMap((s) => [s.id, ...s.items.map((i) => i.id)]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of GUIDE)
      for (const i of s.items) {
        expect(/^[a-z][a-z-]*$/.test(i.id), i.id).toBe(true);
        expect(!!i.title === !!i.how, `${i.id}: title and how go together`).toBe(true);
        expect(!!(i.how || i.agent), `${i.id}: says something to someone`).toBe(true);
        if (i.tools?.length) expect(i.agent, `${i.id}: a tool needs its rule`).toBeTruthy();
      }
  });

  it("every people string is translated in every interface language, keeping @handles, emoji and arrows", () => {
    expect(Object.values(GUIDE_TR_SIZES).every((n) => n === GUIDE_TR_SIZES.keys)).toBe(true);
    for (const lang of LANGS.filter((l) => l !== "en")) {
      expect(GUIDE_TR[lang], lang).toBeTruthy();
      for (const s of [...peopleStrings, ...chrome]) {
        expect(s in GUIDE_TR[lang], `${lang} lacks: ${s}`).toBe(true);
        const t = gtr(lang, s);
        expect(t.trim(), `${lang}: ${s}`).not.toBe("");
        for (const tok of s.match(/[🤔✅🔁⚠→⌘]|@(?:agents|humans|all)\b/gu) ?? []) expect(t, `${lang}: ${s}`).toContain(tok);
      }
    }
    // The sidebar's two strings live in the interface tables (i18n.test.ts keeps every table's keys the same).
    for (const s of ["Guide", "What Atteo can do"]) expect(tr("zh-Hans", s)).not.toBe(s);
  });

  it("/guide: sections with anchors, a filter, the agents link; signed out it's public and in the reader's language", async () => {
    const res = guidePage("ja", null, [], "https://atteo.dev");
    const html = await res.text();
    expect(res.headers.get("content-language")).toBe("ja");
    expect(html).toContain('<html lang="ja">');
    expect(html).toContain('id="gd-q"');
    for (const s of GUIDE.filter((x) => x.items.some((i) => i.how))) expect(html).toContain(`id="${s.id}"`);
    for (const i of people) expect(html).toContain(`id="${i.id}"`);
    expect(html).toContain(gtr("ja", "People only"));
    expect(html).toContain("https://atteo.dev/agents.md");
    expect(html).not.toContain("batch runs several calls"); // agent-only entries stay off the people's page
    for (const s of [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])) expect(() => new Function(s)).not.toThrow();
    // Signed in: the app's page, with the Guide link current in the sidebar.
    const viewer = { name: "jxn", email: "jxn@example.com", display_name: null, admin: false, lang: "es" as const };
    const signed = await guidePage("es", viewer, [], "https://atteo.dev").text();
    expect(signed).toMatch(/href="\/guide" aria-current="page"/);
    expect(signed).toContain("Guía");
    expect(signed).toContain(gtr("es", "Approvals"));
  });

  it("/agents.md: every tool and rule, compact; the MCP instructions point to it in one line", () => {
    const md = agentsMd("https://atteo.dev");
    for (const t of TOOLS.map((x) => x.name)) expect(md, t).toContain(`\`${t}\``);
    expect(md).toContain("<<untrusted");
    expect(md).toContain("https://atteo.dev/guide");
    expect(md.length).toBeLessThan(12_000); // agent-first: one page, read when needed
    expect(INSTRUCTIONS.split("\n").filter((l) => l.includes("/agents.md")).length).toBe(1);
  });
});
