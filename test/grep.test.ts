import { describe, expect, it } from "vitest";
import { compileGrep, GrepError, grepFtsQuery, grepText, hitLine, newBudget, parseSince, regexLiterals, regexProblem, shortTitle, trimLine } from "../src/grep";

describe("literal extraction (FTS prefilter)", () => {
  it("plain patterns use their 3+ char words as prefixes, longest first", () => {
    expect(grepFtsQuery("checkout.js:42", false)).toBe('"checkout"*');
    expect(grepFtsQuery("fix the login_page bug", false)).toBe('"login"* AND "page"* AND "fix"* AND "the"*');
    expect(grepFtsQuery("a b ==", false)).toBeNull();
  });
  it("regex: only required literal runs", () => {
    expect(regexLiterals("foo\\d+bar")).toEqual(["foo", "bar"]);
    expect(regexLiterals("colou?r")).toEqual(["colo", "r"]);
    expect(regexLiterals("deploy(ed|ing)?")).toEqual(["deploy"]);
    expect(regexLiterals("(?:retry)+ limit")).toEqual(["retry", " limit"]);
    expect(regexLiterals("foo|bar")).toEqual([]);
    expect(regexLiterals("[abc]+xyz\\.js$")).toEqual(["xyz", "js"]);
    expect(regexLiterals("\\p{Letter}+ok")).toEqual(["ok"]);
    expect(regexLiterals("(?!secret)token")).toEqual(["token"]);
    expect(grepFtsQuery("^\\s*TODO\\b.*fix", true)).toBe('"TODO"* AND "fix"*');
    expect(grepFtsQuery("a.b|c", true)).toBeNull();
    expect(grepFtsQuery("\\d{3}-\\d{4}", true)).toBeNull();
  });
});

describe("regex guard", () => {
  it("rejects nested repetition, overlapping repeated alternatives, backrefs, too many .*", () => {
    for (const p of ["(a+)+", "((a+))+", "(?:a*)*", "(a|ab)+", "(\\d|x)*", "(a)\\1", "(?<n>a)\\k<n>", ".*a.*b.*c.*d", "(x+){2}"]) expect(regexProblem(p), p).not.toBeNull();
  });
  it("accepts ordinary patterns", () => {
    for (const p of ["foo\\d+bar", "(?:foo|bar)+", "(deploy|ship)ed", "^\\s*TODO\\b", "a.*b.*c", "(ab)+", "(?=x)y", "colou?r", "x{2,5}"]) expect(regexProblem(p), p).toBeNull();
  });
  it("compileGrep throws GrepError with a reason", () => {
    expect(() => compileGrep("(a+)+", { regex: true })).toThrow(GrepError);
    expect(() => compileGrep("x".repeat(201))).toThrow(/too long/);
    expect(() => compileGrep("   ")).toThrow(GrepError);
    expect(() => compileGrep("(oops", { regex: true })).toThrow(/Not a valid regex/);
    expect(compileGrep("(a+)+").test("x (a+)+ y")).toBe(true); // plain text is literal
  });
  it("case sensitivity", () => {
    expect(compileGrep("Deploy").test("deploy now")).toBe(true);
    expect(compileGrep("Deploy", { caseSensitive: true }).test("deploy now")).toBe(false);
  });
});

describe("line extraction and trimming", () => {
  it("marks every match and trims whitespace", () => {
    const m = compileGrep("cat");
    expect(trimLine("   the cat and the Cat  ", m.ranges("   the cat and the Cat  "))).toBe("the «cat» and the «Cat»");
  });
  it("cuts long lines to ~160 chars around the match", () => {
    const line = "a".repeat(500) + " NEEDLE " + "b".repeat(500);
    const m = compileGrep("needle");
    const t = trimLine(line, m.ranges(line));
    expect(t.startsWith("…") && t.endsWith("…")).toBe(true);
    expect(t).toContain("«NEEDLE»");
    expect(t.length).toBeLessThanOrEqual(160 + 4);
    const head = trimLine("NEEDLE " + "z".repeat(400), m.ranges("NEEDLE " + "z".repeat(400)));
    expect(head.startsWith("«NEEDLE»") && head.endsWith("…")).toBe(true);
  });
  it("one hit per matching line, with context joined by ⏎", () => {
    const text = "one\ntwo match\nthree\nfour\nfive match";
    const m = compileGrep("match");
    expect(grepText(text, m)).toEqual([
      { line: 2, text: "two «match»" },
      { line: 5, text: "five «match»" },
    ]);
    expect(grepText(text, m, { context: 1 })[0].text).toBe("one ⏎ two «match» ⏎ three");
    expect(grepText(text, m, { context: 2, max: 1 })).toHaveLength(1);
    expect(grepText(text, m, { context: 9 })[1].text).toBe("three ⏎ four ⏎ five «match»");
  });
  it("regex anchors work per line", () => {
    const m = compileGrep("^\\s*TODO\\b", { regex: true });
    expect(grepText("x TODO no\n  TODO: yes\nTODOS no", m).map((h) => h.line)).toEqual([2]);
  });
  it("the work budget stops a scan", () => {
    const b = newBudget(50);
    const hits = grepText(Array(100).fill("hit line").join("\n"), compileGrep("hit"), { budget: b });
    expect(b.hit).toBe(true);
    expect(hits.length).toBeLessThan(10);
  });
});

describe("helpers", () => {
  it("short titles", () => {
    expect(shortTitle("Atteo — dev board!")).toBe("atteo-dev-board");
    expect(shortTitle("A very long board title indeed")).toBe("a-very-long-boar");
    expect(shortTitle("🔥", "b_abc123xyz")).toBe("123xyz");
  });
  it("since is a seq or a date", () => {
    expect(parseSince("120")).toEqual({ sinceSeq: 120 });
    expect(parseSince("2026-10-01")).toEqual({ sinceTs: Date.parse("2026-10-01") });
    expect(parseSince(undefined)).toEqual({});
    expect(() => parseSince("yesterday-ish")).toThrow(GrepError);
  });
  it("hit lines", () => {
    expect(hitLine({ board: "b_1", title: "dev", seq: 12, author: "vedu", text: "the «x»" })).toBe("dev#12 vedu: the «x»");
    expect(hitLine({ board: "b_1", title: "dev", file: "PLAN.md", line: 3, text: "«x»" })).toBe("dev/PLAN.md:3: «x»");
  });
});
