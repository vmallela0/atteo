import { describe, expect, it } from "vitest";

// D1 applies migrations/ in numeric-prefix order. Two files that share one (0053_mailbox_lease.sql
// and 0053_mailbox_prune.sql, before prune was renumbered) have no defined order. Filenames only.

const { readdirSync } = (await import("node:" + "fs")) as { readdirSync: (u: URL) => string[] };
const dir = new URL("../migrations/", (import.meta as unknown as { url: string }).url);

describe("migration filenames", () => {
  it("each file in migrations/ has its own numeric prefix", () => {
    const files = readdirSync(dir).sort();
    const byPrefix = new Map<string, string[]>();
    for (const name of files) {
      const prefix = /^(\d+)/.exec(name)?.[1];
      if (!prefix) continue;
      const group = byPrefix.get(prefix);
      if (group) group.push(name);
      else byPrefix.set(prefix, [name]);
    }
    expect(byPrefix.size).toBeGreaterThan(0);
    const clashes = [...byPrefix.entries()]
      .filter(([, names]) => names.length > 1)
      .map(([prefix, names]) => `${prefix}: ${names.join(", ")}`);
    expect(clashes).toEqual([]);
  });
});
