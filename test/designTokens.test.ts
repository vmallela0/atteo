// One design language (jxn #2706): every colour and font on the web comes from the token blocks in src/ui.ts (the
// palette, then the semantic layer: --you, --mention-*, --rail-*, --unread, --badge-*, --font-*). A literal colour or
// font anywhere else is how the old clay accents survived a re-skin, so this test fails on one.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** The CSS sources: [file, the template constant holding the CSS]. */
const SOURCES: [string, string][] = [
  ["src/ui.ts", "DARK"],
  ["src/ui.ts", "CSS"],
  ["src/talk.ts", "TALK_CSS"],
  ["src/forYou.ts", "FY_CSS"],
  ["src/guide.ts", "GUIDE_CSS"],
  ["src/ask.ts", "ASK_CSS"],
  ["src/status.ts", "STATUS_CSS"],
  ["src/mermaid.ts", "MERMAID_CSS"],
  ["src/codecolor.ts", "CODE_COLOR_CSS"],
];
/** Files whose HTML templates may carry inline style="…" attributes. */
const INLINE = ["src/ui.ts", "src/html.ts", "src/forYou.ts", "src/guide.ts", "src/ask.ts", "src/status.ts", "src/talk.ts"];

const LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/i;
/** Allowed literals outside the token blocks: black shadows and scrims, mask gradients (only alpha matters there), and
 *  the per-name avatar hue (hsl(var(--h) …), computed from a hash so it can't be a fixed token). */
function allowed(prop: string, value: string): boolean {
  if (/mask-image$/.test(prop)) return true;
  const rest = value
    .replace(/rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*[\d.]+\s*\)/g, "")
    .replace(/hsla?\(\s*var\(--h\)[^)]*\)/g, "");
  return !LITERAL.test(rest);
}
const fontOk = (value: string) => /^\s*(?:var\(--font-[a-z]+\)|inherit)\s*(?:!important)?\s*$/.test(value);

function cssOf(file: string, name: string): string {
  const src = readFileSync(file, "utf8");
  const m = src.match(new RegExp(`const ${name} = \`([\\s\\S]*?)\`;`));
  if (!m) throw new Error(`${name} not found in ${file}`);
  let css = m[1].replace(/\/\*[\s\S]*?\*\//g, "");
  for (let i = 0; i < 5; i++) css = css.replace(/\$\{[^{}]*\}/g, "X"); // template holes, innermost first
  return css;
}

/** Each declaration with the selector of the rule it sits in ("" for a bare declaration list such as DARK). */
function declarations(css: string): { selector: string; prop: string; value: string }[] {
  const out: { selector: string; prop: string; value: string }[] = [];
  const rule = /([^{}]*)\{([^{}]*)\}/g;
  const blocks: { selector: string; body: string }[] = [];
  let m: RegExpExecArray | null;
  let any = false;
  while ((m = rule.exec(css))) {
    any = true;
    blocks.push({ selector: m[1].trim(), body: m[2] });
  }
  if (!any) blocks.push({ selector: ":root", body: css }); // DARK: the dark palette's declarations
  for (const { selector, body } of blocks)
    for (const d of body.split(";")) {
      const i = d.indexOf(":");
      if (i < 0) continue;
      const prop = d.slice(0, i).trim().toLowerCase();
      if (!/^-{0,2}[a-z][a-z-]*$/.test(prop)) continue;
      out.push({ selector, prop, value: d.slice(i + 1).trim() });
    }
  return out;
}

/** A token block: custom properties set on :root (the palette, the dark palette, the semantic layer, font stacks). */
const isTokenBlock = (selector: string) => /(^|[\s,}])(?:html(?::lang\([^)]*\))?|:root)(?:\[[^\]]*\]|:not\([^)]*\))*\s*$/.test(selector.split("}").pop() ?? "");

describe("one design language: colours and fonts come from tokens (jxn #2706)", () => {
  it("no colour literal or stray font outside the token blocks, in any stylesheet", () => {
    const bad: string[] = [];
    for (const [file, name] of SOURCES)
      for (const { selector, prop, value } of declarations(cssOf(file, name))) {
        if (prop.startsWith("--")) {
          if (LITERAL.test(value) && !isTokenBlock(selector) && !allowed(prop, value)) bad.push(`${file} ${name}: ${selector} { ${prop}: ${value} } (a colour token set outside :root)`);
          continue;
        }
        if (prop === "font-family" && !fontOk(value)) bad.push(`${file} ${name}: ${selector} { font-family: ${value} }`);
        if (LITERAL.test(value) && !allowed(prop, value)) bad.push(`${file} ${name}: ${selector} { ${prop}: ${value} }`);
      }
    expect(bad, `use a token from src/ui.ts (semantic layer) instead:\n${bad.join("\n")}`).toEqual([]);
  });

  it("no colour literal or font in an inline style attribute", () => {
    const bad: string[] = [];
    for (const file of INLINE) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/style="([^"]*)"/g)) {
        const style = m[1].replace(/\$\{[^{}]*\}/g, "X");
        for (const d of style.split(";")) {
          const i = d.indexOf(":");
          if (i < 0) continue;
          const prop = d.slice(0, i).trim().toLowerCase(), value = d.slice(i + 1).trim();
          if (prop === "font-family" && !fontOk(value)) bad.push(`${file}: style="${m[1]}"`);
          if (!prop.startsWith("--") && LITERAL.test(value) && !allowed(prop, value)) bad.push(`${file}: style="${m[1]}"`);
        }
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("the semantic layer exists and points at the palette (you is cherry; mentions and links are ink)", () => {
    const css = cssOf("src/ui.ts", "CSS");
    for (const t of ["--you", "--you-soft", "--mention-fg", "--mention-bg", "--mention-you-bg", "--rail-mark", "--rail-you", "--unread", "--badge-bg", "--badge-fg", "--voice", "--font-ui", "--font-head", "--font-mono"])
      expect(css, t).toMatch(new RegExp(`${t}:`));
    expect(css).toMatch(/--you:var\(--cherry\)/);
    expect(css).toMatch(/--mention-fg:var\(--ink\)/);
    expect(readFileSync("src/ui.ts", "utf8")).not.toMatch(/--atteo/);
  });
});

describe("the app too (jxn #2706): colours and fonts come from ios/AgentSoup/Sources/Theme.swift", () => {
  it("no colour or font literal in the app's sources outside Theme.swift", () => {
    const dir = "ios/AgentSoup/Sources";
    // SyntaxHighlight's palette is the app's mirror of codecolor.ts's --sx-* token block, values passed as pair(0x…).
    const banned = /Color\(red:|UIColor\(red:|Color\(hex|UIColor\(hex|"#[0-9A-Fa-f]{6}"|\.custom\(|Font\.custom|UIFont\(name:|rgb\(0x/;
    const bad: string[] = [];
    const files = readdirSync(dir).filter((f) => f.endsWith(".swift") && f !== "Theme.swift");
    expect(files.length).toBeGreaterThan(20);
    for (const f of files)
      readFileSync(`${dir}/${f}`, "utf8").split("\n").forEach((line, i) => {
        if (!line.trim().startsWith("//") && banned.test(line)) bad.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    expect(bad, `use a Theme token (Theme.swift) instead:\n${bad.join("\n")}`).toEqual([]);
  });
  it("the app's semantic layer mirrors the web's roles, and Atteo's old terracotta is gone", () => {
    const theme = readFileSync("ios/AgentSoup/Sources/Theme.swift", "utf8");
    for (const t of ["you", "youSoft", "mentionText", "mentionBox", "mentionYouBox", "unread", "voice"]) expect(theme, t).toMatch(new RegExp(`static let ${t} =`));
    expect(theme).not.toMatch(/static let atteo\b|0xA34A2B|0xF0A78E/);
  });
});
