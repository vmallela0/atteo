// The app's code colours must match the web's token for token (jxn #2015). This runs the web's tokenizer
// (src/codecolor.ts, hlTokens) over samples in every language plus seeded random snippets full of quotes, comments
// and brackets, and writes ios/AtteoTests/CodeColorFixtures.swift, which SyntaxHighlightTests compares against.
// Usage: node ios/qa/codecolor-fixtures.mjs [path/to/codecolor.ts]   (default: src/codecolor.ts)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const src = readFileSync(process.argv[2] || join(root, "src/codecolor.ts"), "utf8");
const body = src.split("export const CODE_TOKENIZER = String.raw`")[1].split("\n`;")[0];
const hlTokens = new Function(`${body};return hlTokens`)();

const langs = ["ts", "json", "python", "bash", "go", "rust", "swift", "java", "c", "php", "ruby", "sql", "yaml", "toml", "css", "html", "diff"];
const samples = {
  ts: '// note\nexport function f<T>(ms = 250): Promise<T> { const s = `a ${ms}`; return setTimeout(() => g("x\\"y"), ms) /* end */ }\n@Component({a: 1.5e3}) class Board extends Base {}',
  json: '{"a": "b", "n": -1.5, "ok": true, "x": null, "k"\t: [1, 2e3]} // c',
  python: '@cache\ndef top(n: int = 5):\n    """Doc."""\n    return f"{n}" if True else None  # why\nx = rb\'\\d\' + u"q" + Fr"""m\nl"""',
  bash: '#!/usr/bin/env bash\necho "$HOME" ${X} $1 $@ # done\nfor f in *.log; do cat "$f" | grep -c x#y; done',
  go: 'package main\n// Serve it\nfunc (s *Server) Serve(port int) error {\n\treturn fmt.Errorf(`raw %d`, 0x1F, \'c\')\n}',
  rust: '#[derive(Debug)]\nfn main<\'a>(x: &\'a str) -> Option<u8> {\n    let c = \'z\'; println!("{}", c); let b = b"x"; // done\n}',
  swift: '@MainActor struct Box<T>: View {\n    let p95 = samples.sorted()[Int(Double(n) * 0.95)] // p95\n    #if DEBUG\n    func go() async throws -> String { "a\\"b" + """\n    x\n    """ }\n}',
  java: '@Override\npublic static void main(String[] args) { int n = 42; System.out.println("hi" + \'c\'); } /* x */\nfun kotlin(val x: Int) = when (x) { 1 -> "a" else -> null }',
  c: '#include <stdio.h>\n  #define N 10\nint main(void) { char *s = "x\\n"; return printf("%d", N) + sizeof(int); } // c\nclass Foo : public Bar { nullptr };',
  php: '<?php\n$x = array(1, 2); # hash\nfunction f($a) { return $a . "s" . \'q\'; } // done\necho TRUE;',
  ruby: 'class Foo < Bar\n  attr_reader :name\n  def initialize(n)\n    @name = n; @@count += 1 # c\n    puts "hi #{n}", :sym, 3.14\n  end\nend',
  sql: "SELECT id, COUNT(*) AS n FROM \"entries\" -- recent\nwhere board = 'it''s' and ts > 1700000000 /* ms */\nORDER BY n DESC;",
  yaml: "# deploy\nname: atteo\non:\n  push:\n    branches: [main]\njobs:\n  - run: \"npm test\"   # quick\n    retries: 3\n    enabled: true\nbase: &b\n  x: *b\n---\nurl: http://x#y",
  toml: '# c\n[package]\nname = "atteo"\nversion.major = 1\n  ; ini comment\n[deps.serde]\nfeatures = ["derive"]\nok = true\ns = """multi\nline"""',
  css: "/* card */\n.card > a:hover, #main { color: #fff; margin: -4px 0.5em; background: var(--bg) !important; --x: url(a.png) }\n@media (max-width: 600px) { h1 { font-size: 120%; } }\na:b{c:d}",
  html: '<!DOCTYPE html>\n<!-- nav -->\n<a href="/x" class=\'y\' disabled data-x = "1">Go &amp; see f(x)</a>\n<?xml version="1.0"?><svg:rect x="1"/><br/>',
  diff: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n same\n---\n+",
};
const nasty = ['"\\', "'", "`", '"""', "/*", "<", "<a", "${", "$", "#", "@", "'a", "0x", "1e", ".", "-", "&", "<![CDATA[", "key:", "- ", "\u0301é",
  '"a\\\nb"', "x = 'it's\nlet b = 2 /* open", '<div class="a', "", "a.b.c = 1", "-a-b: c;", "--x: 1;",
  "x".repeat(70) + ": 1", "a.".repeat(40) + "b = 1", '"' + "y".repeat(1100) + '"', "#[" + "z".repeat(210) + "]"];

// Seeded random snippets of the characters the rules care about.
let seed = 2015;
const rand = (n) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
const pieces = ['"', "'", "`", "\\", "/", "*", "#", "-", "@", "$", ":", ";", "{", "}", "(", ")", "<", ">", "!", "=", "[", "]", "&", ".", "%", "\n", " ", "\t",
  "a", "Ab", "x1", "_", "1", "2.5", "e", "+", "if", "def", "true", "null", "SELECT", "fn", "let", "--", "//", "/*", "*/", '"""', "<a ", "</b>", "<!--", "-->",
  "${x}", "@@", "Foo(", "key: ", "k = ", "#fff", "0x1F"];
const random = [];
for (let r = 0; r < 70; r++) {
  let t = "";
  const len = rand(40);
  for (let k = 0; k < len; k++) t += pieces[rand(pieces.length)];
  random.push(t);
}

const cases = [];
for (const lang of langs) {
  for (const code of [samples[lang], ...nasty, ...random]) {
    const toks = hlTokens(code, lang);
    if (toks.map((t) => t[1]).join("") !== code) throw new Error(`web tokens don't cover the code (${lang})`);
    // Plain stretches merged, empty ones dropped: what the app's runs describe.
    const out = [];
    for (const [c, t] of toks) {
      if (!t) continue;
      if (!c && out.length && !out[out.length - 1][0]) out[out.length - 1][1] += t;
      else out.push([c, t]);
    }
    cases.push({ l: lang, c: code, t: out });
  }
}
const b64 = Buffer.from(JSON.stringify(cases)).toString("base64");
const swift = `// Generated by ios/qa/codecolor-fixtures.mjs from the web's tokenizer (src/codecolor.ts): don't edit by hand.
// ${cases.length} cases: [{l: language, c: code, t: [[class, text], …]}] as base64 JSON.

enum CodeColorFixtures {
    static let base64 = "${b64}"
}
`;
writeFileSync(join(root, "ios/AtteoTests/CodeColorFixtures.swift"), swift);
console.log(`${cases.length} cases`);
