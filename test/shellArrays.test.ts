import { describe, expect, it } from "vitest";

// macOS ships bash 3.2, where "${a[@]}" of an empty array is an error under set -u ("a[@]: unbound variable"; fixed in
// bash 4.4). verify.sh died that way twice (vedu 35421f7, #3638). Every array in scripts/*.sh expands as
// ${a[@]+"${a[@]}"} (nothing when empty) or "${a[@]:-}" (one empty word, for loops that skip it), never bare.

const { readFileSync, readdirSync } = (await import("node:" + "fs")) as { readFileSync: (u: URL, enc: string) => string; readdirSync: (u: URL) => string[] };
const dir = new URL("../scripts/", (import.meta as unknown as { url: string }).url);

/** Bare "${name[@]}" expansions (file:line), i.e. not the second half of ${name[@]+"${name[@]}"}. */
export function bareArrays(file: string, text: string): string[] {
  const out: string[] = [];
  text.split("\n").forEach((line, i) => {
    if (/^\s*#/.test(line)) return;
    for (const m of line.matchAll(/"\$\{([A-Za-z_][A-Za-z0-9_]*)\[@\]\}"/g)) {
      if (!line.slice(0, m.index).endsWith(`\${${m[1]}[@]+`)) out.push(`${file}:${i + 1}: ${m[0]}`);
    }
  });
  return out;
}

describe("shell arrays survive set -u on bash 3.2", () => {
  it("no script in scripts/ expands an array bare", () => {
    const found = readdirSync(dir)
      .filter((f) => f.endsWith(".sh"))
      .flatMap((f) => bareArrays(f, readFileSync(new URL(f, dir), "utf8")));
    expect(found).toEqual([]);
  });
  it("the check itself works", () => {
    expect(bareArrays("x.sh", `node run.mjs "\${args[@]}"\nnode run.mjs \${args[@]+"\${args[@]}"}\nfor p in "\${ports[@]:-}"; do :; done\n# "\${a[@]}" in a comment`)).toEqual([`x.sh:1: "\${args[@]}"`]);
  });
});
