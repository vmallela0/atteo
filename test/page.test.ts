import { describe, expect, it } from "vitest";
import { boardPage, changeCardHtml } from "../src/html";
import type { BoardInfo, Entry } from "../src/types";

const info: BoardInfo = { id: "b_test1234", title: "Checkout </script> bug", created_by: "jxn", created_at: 0, entry_count: 3, last_seq: 3 };
const base = { reply_to: null, resolves: [] as number[], supersedes: null, retracts: null, artifact_name: null, artifact_size: null };
const entries: Entry[] = [
  { ...base, seq: 1, ts: 1, author: "vedu", type: "note", text: "hi @jxn", to: null, mentions: [{ user: "jxn", agent: false }], via: "agent" },
  { ...base, seq: 2, ts: 2, author: "jxn", type: "artifact", text: "log", to: null, artifact_name: "trace.log", artifact_size: 20, artifact_version: 2 },
  {
    ...base,
    seq: 3,
    ts: 3,
    author: "vedu",
    type: "change",
    text: "Guard empty carts",
    to: "jxn",
    card: {
      repo: "vmallela0/agent-soup",
      branch: "fix/<empty>-cart",
      base: "main",
      pr_url: "https://github.com/vmallela0/agent-soup/pull/7",
      ci: "passing",
      commits: [{ sha: "abc1234", title: "Guard <b>empty</b> carts" }],
      files: [{ path: "src/checkout.ts", added: 12, removed: 3 }],
    },
  },
];

describe("board page", () => {
  it("its inline script compiles (catches escapes the server template mangles, like \\n or \\+)", async () => {
    const res = boardPage({ name: "jxn", email: "jxn@example.com", display_name: null, admin: false }, [], info, [{ user: "jxn", display_name: null, last_seen: 0 }, { user: "vedu", display_name: null, last_seen: 0 }], entries, []);
    const html = await res.text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const s of scripts) expect(() => new Function(s)).not.toThrow();
    expect(html).not.toContain("Checkout </script> bug\"");
  });

  it("every tab names a panel that exists, in the tabs' order of meaning (not the panels' order on the page)", async () => {
    const res = boardPage({ name: "jxn", email: "jxn@example.com", display_name: null, admin: false }, [], info, [{ user: "jxn", display_name: null, last_seen: 0 }], entries, []);
    const html = await res.text();
    const tabs = html.slice(html.indexOf('id="board-tabs"'), html.indexOf("</div>", html.indexOf('id="board-tabs"')));
    const controls = [...tabs.matchAll(/aria-controls="([^"]+)"/g)].map((m) => m[1]);
    expect(controls).toEqual(["panel-conv", "panel-log", "panel-docs", "panel-tasks"]);
    for (const id of controls) expect(html).toContain(`id="${id}"`);
  });
});

describe("change card", () => {
  const card = entries[2].card!;
  const html = changeCardHtml(3, card);

  it("shows branch → base, CI, a PR link, commits and files with +/− bars", () => {
    expect(html).toContain(`<span class="chg-br mono">fix/&lt;empty&gt;-cart</span><span class="faint">→</span><span class="chg-br mono">main</span>`);
    expect(html).toContain(`<span class="ci ci-passing"><span class="dot"></span>CI passing</span>`);
    expect(html).toContain(`href="https://github.com/vmallela0/agent-soup/pull/7" target="_blank" rel="noopener noreferrer">PR #7 ↗</a>`);
    expect(html).toContain(`<code class="sha">abc1234</code><span class="truncate">Guard &lt;b&gt;empty&lt;/b&gt; carts</span>`);
    expect(html).toContain(`1 file changed <span class="add">+12</span> <span class="del">−3</span>`);
    expect(html).toContain(`<span class="bar" aria-hidden="true"><i class="a"></i><i class="a"></i><i class="a"></i><i class="a"></i><i class="d"></i></span>`);
  });

  it("has a footer for reviews, the diff and review buttons", () => {
    expect(html).toContain(`data-reviews="3"`);
    expect(html).toContain(`data-diff="3"`);
    expect(html).toContain(`data-review="approve" data-seq="3"`);
    expect(html).toContain(`data-review="request_changes" data-seq="3"`);
  });

  it("collapses long lists and greys out small changes", () => {
    const many = changeCardHtml(4, { ...card, ci: "none", pr_url: null, files: Array.from({ length: 10 }, (_, i) => ({ path: `f${i}.ts`, added: 1, removed: 0 })) });
    expect(many).toContain(`<details><summary>4 more files</summary>`);
    expect(many).not.toContain("ci-");
    expect(many).toContain(`<span class="bar" aria-hidden="true"><i class="a"></i><i></i><i></i><i></i><i></i></span>`);
  });
});

describe("post titles", () => {
  it("cleanTitle keeps one short line", async () => {
    const { cleanTitle } = await import("../src/util");
    expect(cleanTitle("  Fix   empty-cart\ncrash ")).toBe("Fix empty-cart crash");
    expect(cleanTitle("one two three four five six seven eight nine ten")).toBe("one two three four five six seven eight");
    expect(cleanTitle("")).toBeNull();
    expect(cleanTitle(42)).toBeNull();
    expect((cleanTitle("x".repeat(80)) ?? "").length).toBeLessThanOrEqual(60);
  });
});
