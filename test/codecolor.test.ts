import { describe, expect, it } from "vitest";
import { CODE_COLOR_JS, CODE_COLOR_SCRIPT, CODE_COLOR_SRC, CODE_TOKENIZER } from "../src/codecolor";
import { renderText } from "../src/ui";

type Tok = [string, string];
const hlTokens = new Function(`${CODE_TOKENIZER};return hlTokens`)() as (code: string, lang: string) => Tok[] | null;
const of = (code: string, lang: string) => {
  const t = hlTokens(code, lang);
  if (!t) throw new Error(`no tokens for ${lang}`);
  expect(t.map((x) => x[1]).join("")).toBe(code); // the tokens cover the code exactly, nothing added or lost
  return t;
};
const has = (t: Tok[], cls: string, text: string) => t.some(([c, s]) => c === cls && s.trim() === text);

describe("code colours", () => {
  it("the page script and the served tokenizer parse; the tokenizer's URL is versioned", () => {
    expect(() => new Function(CODE_COLOR_JS)).not.toThrow();
    expect(() => new Function(CODE_COLOR_SCRIPT)).not.toThrow();
    expect(CODE_COLOR_SRC).toMatch(/^\/code-colors\.js\?v=[0-9a-z]+$/);
    expect(CODE_COLOR_JS).not.toContain("HL_LANGS"); // pages carry only the loader, not the tokenizer
  });

  it("TypeScript: keywords, strings, comments, numbers, calls and types", () => {
    const t = of('// note\nexport function f<T>(ms = 250): Promise<T> { const s = `a ${ms}`; return setTimeout(() => g("x\\"y"), ms) /* end */ }', "ts");
    for (const [c, s] of [["c", "// note"], ["k", "export"], ["k", "function"], ["n", "250"], ["t", "Promise"], ["k", "const"], ["s", "`a ${ms}`"], ["f", "setTimeout"], ["s", '"x\\"y"'], ["c", "/* end */"]] as const)
      expect(has(t, c, s), `${c} ${s}`).toBe(true);
  });

  it("Python: triple and prefixed strings, decorators, literals", () => {
    const t = of('@cache\ndef top(n: int = 5):\n    """Doc."""\n    return f"{n}" if True else None  # why', "python");
    for (const [c, s] of [["m", "@cache"], ["k", "def"], ["f", "top"], ["s", '"""Doc."""'], ["s", 'f"{n}"'], ["n", "True"], ["n", "None"], ["c", "# why"]] as const) expect(has(t, c, s), `${c} ${s}`).toBe(true);
  });

  it("SQL keywords in any case, JSON keys, shell variables, HTML tags, diff lines", () => {
    expect(has(of("select a from t where x = 'y' -- c", "sql"), "k", "select")).toBe(true);
    expect(has(of("SELECT COUNT(*) FROM t", "sqlite"), "k", "FROM")).toBe(true);
    const j = of('{"a": "b", "n": -1.5, "ok": true}', "json");
    expect(has(j, "p", '"a"') && has(j, "s", '"b"') && has(j, "n", "-1.5") && has(j, "n", "true")).toBe(true);
    const sh = of('echo "$HOME" ${X} # done', "bash");
    expect(has(sh, "k", "echo") && has(sh, "m", "${X}") && has(sh, "c", "# done")).toBe(true);
    const h = of('<a href="x">hi</a>', "html");
    expect(has(h, "g", "<a") && has(h, "p", "href") && has(h, "s", '"x"') && has(h, "", "hi")).toBe(true);
    const d = of("@@ -1 +1 @@\n-old\n+new\n same", "diff");
    expect(has(d, "m", "@@ -1 +1 @@") && has(d, "d", "-old") && has(d, "i", "+new") && has(d, "", "same")).toBe(true);
  });

  it("an unknown or missing language stays plain", () => {
    for (const lang of ["", "code", "mermaid", "brainfuck"]) expect(hlTokens("x = 1", lang)).toBeNull();
  });

  it("unclosed strings and comments don't swallow other lines or lose text", () => {
    of("const a = 'it's\nlet b = 2 /* open", "js");
    of('x = "open\ny = 1\n"""never closed', "py");
    of("<div class=\"a", "html");
    of("", "ts");
  });

  it("a hostile block can't make a rule backtrack for long (opus-d #2028), and odd language names are just unknown", () => {
    const N = 20000;
    const worst: [string, string][] = [["css", "-a"], ["css", "a:"], ["toml", "a."], ["yaml", "a."], ["rust", "#["], ["sh", "${"], ["js", '\\"'], ["py", "\\'"], ["sql", "'\\"], ["json", '"\\']];
    for (const [lang, unit] of worst) {
      const code = unit.repeat(N / unit.length), t = performance.now();
      of(code, lang);
      expect(performance.now() - t, `${lang} ${JSON.stringify(unit)}`).toBeLessThan(200); // ~450ms before the bounds
    }
    for (const lang of ["__proto__", "constructor", "toString", "hasOwnProperty"]) expect(hlTokens("x", lang)).toBeNull();
  });

  it("the server still sends plain text: colours are added on the page", () => {
    const html = renderText("```ts\nconst a = 1\n```");
    expect(html).toContain("<code>const a = 1</code>");
    expect(html).not.toContain("sx-");
  });
});
