import { describe, expect, it, vi } from "vitest";

// mcp.ts reaches the Durable Object class through board.ts; the tool list and instructions don't need it.
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
import { GUIDE, GUIDE_TOOLS, agentsMd, gtr, guidePage } from "../src/guide";
import { GUIDE_TR, GUIDE_TR_SIZES } from "../src/guide.i18n";
import { LANGS, dirOf, tr } from "../src/i18n";
import { INSTRUCTIONS, TOOLS } from "../src/mcp";

const people = GUIDE.flatMap((s) => s.items.filter((i) => i.title && i.how).map((i) => ({ ...i, section: s.title })));
const peopleStrings = [...new Set([...GUIDE.filter((s) => s.items.some((i) => i.title && i.how)).map((s) => s.title), ...people.flatMap((i) => [i.title!, i.how!])])];
const chrome = ["Everything you can do in Atteo, on the web and in the app, by task.", "Search the guide", "Sections", "Link to this", "Nothing in the guide matches that.", "Agents read the same list at", "Contents", "Previous", "Next", "Docs", "FAQ", "Support", "Open Atteo"];

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
        // A right-to-left table points menu paths the reading way (← for →), as the interface tables do.
        for (const tok of s.match(/[🤔✅🔁⚠→⌘]|@(?:agents|humans|all)\b/gu) ?? []) expect(t, `${lang}: ${s}`).toContain(tok === "→" && dirOf(lang) === "rtl" ? "←" : tok);
      }
    }
    // The sidebar's two strings live in the interface tables (i18n.test.ts keeps every table's keys the same).
    for (const s of ["Guide", "What Atteo can do"]) expect(tr("zh-Hans", s)).not.toBe(s);
  });

  it("/guide in Arabic is right to left, its code and link stay left to right (#2335)", async () => {
    const html = await guidePage("ar", false, "https://atteo.dev").text();
    expect(html).toMatch(/<html lang="ar" dir="rtl">/);
    expect(html).toContain("<code>atteo guide</code>");
    expect(await guidePage("fr", false, "https://atteo.dev").text()).not.toContain('dir="rtl"');
  });

  it("/guide: sections with anchors, a filter, the agents link; signed out it's public and in the reader's language", async () => {
    const res = guidePage("ja", false, "https://atteo.dev");
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
    expect(html).toContain('href="/auth/login"'); // signed out: Sign in in the top bar
    // Signed in (board #5110): the same public page, Guide current in the top bar, and a way back into the app.
    const signed = await guidePage("es", true, "https://atteo.dev").text();
    expect(signed).toMatch(/href="\/guide" aria-current="page">Guía</);
    expect(signed).toContain(`<a class="st-pill" href="/">${gtr("es", "Open Atteo")}</a>`);
    expect(signed).not.toContain('href="/auth/login"');
    // Every section has Previous / Next to its neighbours, and the side nav links every entry.
    const ids = GUIDE.filter((x) => x.items.some((i) => i.how)).map((x) => x.id);
    expect(signed).toContain(`<a class="next" href="#${ids[1]}">`);
    expect(signed).toContain(`<a class="prev" href="#${ids[ids.length - 2]}">`);
    for (const i of people) expect(signed).toContain(`<li><a href="#${i.id}">`);
  });

  it("/agents.md: every tool and rule, compact; the MCP instructions point to it in one line", () => {
    const md = agentsMd("https://atteo.dev");
    for (const t of TOOLS.map((x) => x.name)) expect(md, t).toContain(`\`${t}\``);
    expect(md).toContain("<<untrusted");
    expect(md).toContain("https://atteo.dev/guide");
    expect(md.length).toBeLessThan(12_000); // agent-first: one page, read when needed
    expect(INSTRUCTIONS.split("\n").filter((l) => l.includes("/agents.md")).length).toBe(1);
  });

  it("/agents.md teaches the read-only and SDK ways in, each with its rule (alt-c #3900)", () => {
    const md = agentsMd("https://atteo.dev");
    const line = (cmd: string) => md.split("\n").find((l) => l.includes(cmd)) ?? "";
    expect(line("atteo export")).toContain("never moves your read position");
    expect(line("atteo ls")).toMatch(/atteo cat.*neither moves your read position/);
    expect(line("atteo purge")).toContain("always rotate it");
    expect(line("atteo publish")).toMatch(/preview.*--yes.*OKs it/);
    expect(line("task get N")).toContain("before you edit");
    expect(line("agents profile")).toContain("your user's call");
    expect(line("--json")).toMatch(/not fenced.*data/);
    expect(line("atteo acp")).toContain("fenced");
    expect(line("entries?after=N&ack=1")).toMatch(/only with ack=1 \(the SDKs' entries\(\) sends it\); export, ls and cat never do/);
    expect(line("sdk/python/atteo.py")).toMatch(/export and ls \(never move your read position\), purge \(still rotate\), publish \(a preview until yes\)/);
  });
});
