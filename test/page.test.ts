import { describe, expect, it } from "vitest";
import { boardPage, changeCardHtml, changeLink, refLinks } from "../src/html";
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

  it("regexes in the page script keep their escapes (a single \\s in the server template turns into a plain s)", async () => {
    const res = boardPage({ name: "jxn", email: "jxn@example.com", display_name: null, admin: false }, [], info, [{ user: "jxn", display_name: null, last_seen: 0 }], entries, []);
    const js = [...(await res.text()).matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");
    for (const re of ["/^#e\\d+$/", "(^|[^A-Za-z0-9_.@\\/-])@([A-Za-z0-9_.-]{0,32}(?:\\/[A-Za-z0-9_.-]{0,32})?)$/", "s\\s+agent\\b|\\/[A-Za-z0-9]", "/^(diff |index |\\+\\+\\+ |--- )/", "/^\\s*(?:[-*]|\\d+[.)])\\s+\\[( |x|X)\\]\\s+.+$/", "/\\x60\\x60\\x60[^\\n]*\\n?[\\s\\S]*?\\x60\\x60\\x60/g"]) expect(js).toContain(re);
    expect(js).not.toMatch(/\(\^\|s\)/); // "(^|s)" is what a lost \s looks like
  });

  it("every tab names a panel that exists, in the tabs' order of meaning (not the panels' order on the page)", async () => {
    const res = boardPage({ name: "jxn", email: "jxn@example.com", display_name: null, admin: false }, [], info, [{ user: "jxn", display_name: null, last_seen: 0 }], entries, []);
    const html = await res.text();
    const tabs = html.slice(html.indexOf('id="board-tabs"'), html.indexOf("</div>", html.indexOf('id="board-tabs"')));
    const controls = [...tabs.matchAll(/aria-controls="([^"]+)"/g)].map((m) => m[1]);
    expect(controls).toEqual(["panel-conv", "panel-log", "panel-docs", "panel-tasks"]);
    for (const id of controls) expect(html).toContain(`id="${id}"`);
  });

  it("favourite reactions sync through /api/app/prefs, except on a viewer's page, which keeps them in this browser (vedu #1166)", async () => {
    const page = async (role?: "viewer") =>
      (await boardPage({ name: "vedu", email: "vedu@example.com", display_name: null, admin: false }, [], info, [{ user: "jxn", display_name: null, last_seen: 0 }, { user: "vedu", display_name: null, last_seen: 0, role }], entries, []).text());
    const member = await page(),
      viewer = await page("viewer");
    expect(member).toContain("/api/app/prefs");
    expect(member).toContain("let RX_SYNC=true&&!!ME");
    expect(viewer).toContain("let RX_SYNC=false&&!!ME");
  });
});

describe("N: next thing that needs you (#1464)", () => {
  it("every app page has the key (not while typing, via the shell's guard) and lists it in the shortcuts", async () => {
    const html = await boardPage({ name: "jxn", email: "jxn@example.com", display_name: null, admin: false }, [], info, [{ user: "jxn", display_name: null, last_seen: 0 }], entries, []).text();
    expect(html).toContain("if(k==='n'&&!e.shiftKey){e.preventDefault();nextNeed();return}");
    expect(html).toContain("<dt><kbd>N</kbd></dt><dd>Next thing that needs you, on any board</dd>");
    expect(html).toContain("'/approvals#'+a.id");
  });
});

describe("checklists", () => {
  it("render as numbered checkboxes (read-only until a task card enables them); code blocks don't count", async () => {
    const { renderText } = await import("../src/ui");
    const html = renderText("Plan\n\n- [ ] one\n- [x] **two**\n- plain\n\n```\n- [ ] code\n```\n\n1. [X] three");
    expect(html.match(/<li class="ck/g)?.length).toBe(3);
    expect(html).toContain('<li class="ck" data-ck="0"><input type="checkbox" disabled><span>one</span></li>');
    expect(html).toContain('<li class="ck done" data-ck="1"><input type="checkbox" disabled checked><span><strong>two</strong></span></li>');
    expect(html).toContain('<li class="ck done" data-ck="2">');
    expect(html).toContain("<li>plain</li>");
    expect(html).toContain("- [ ] code");
  });
});

describe("change card", () => {
  const card = entries[2].card!;
  const html = changeCardHtml(3, card);

  it("shows branch → base, CI, a PR link, commits and files with +/− bars", () => {
    expect(html).toContain(`<span class="chg-br mono">fix/&lt;empty&gt;-cart</span><span class="faint">→</span><span class="chg-br mono">main</span>`);
    expect(html).toContain(`<span class="ci ci-passing"><span class="dot"></span>CI passing</span>`);
    expect(html).toContain(`href="https://github.com/vmallela0/agent-soup/pull/7" target="_blank" rel="noopener noreferrer">PR #7 ↗</a>`);
    expect(html).toContain(`<a class="sha" href="https://github.com/vmallela0/agent-soup/commit/abc1234" target="_blank" rel="noopener noreferrer"><code>abc1234</code></a><span class="truncate">Guard &lt;b&gt;empty&lt;/b&gt; carts</span>`);
    expect(html).toContain(`1 file changed <span class="add">+12</span> <span class="del">−3</span>`);
    expect(html).toContain(`<span class="bar" aria-hidden="true"><i class="a"></i><i class="a"></i><i class="a"></i><i class="a"></i><i class="d"></i></span>`);
  });

  it("has a footer for reviews and the diff, without review buttons (jxn #470)", () => {
    expect(html).toContain(`data-reviews="3"`);
    expect(html).toContain(`data-diff="3"`);
    expect(html).not.toContain(`data-review=`);
  });

  it("collapses long lists and greys out small changes", () => {
    const many = changeCardHtml(4, { ...card, ci: "none", pr_url: null, files: Array.from({ length: 10 }, (_, i) => ({ path: `f${i}.ts`, added: 1, removed: 0 })) });
    expect(many).toContain(`<details><summary>4 more files</summary>`);
    expect(many).not.toContain("ci-");
    expect(many).toContain(`<span class="bar" aria-hidden="true"><i class="a"></i><i></i><i></i><i></i><i></i></span>`);
  });
});

describe("change card links (vedu #1097)", () => {
  const base = { branch: "main", base: null, ci: "none" as const, files: [], diff: null };
  it("goes to the PR when there is one", () => {
    expect(changeLink({ ...base, repo: "a/b", pr_url: "https://github.com/a/b/pull/9", commits: [{ sha: "abc1234", title: "x" }] })).toBe("https://github.com/a/b/pull/9");
  });
  it("else to the commit, or the range of commits (newest first)", () => {
    expect(changeLink({ ...base, repo: "vmallela0/agent-soup", pr_url: null, commits: [{ sha: "abc1234", title: "x" }] })).toBe("https://github.com/vmallela0/agent-soup/commit/abc1234");
    expect(changeLink({ ...base, repo: "git@github.com:a/b.git", pr_url: null, commits: [{ sha: "ccc3333", title: "new" }, { sha: "aaa1111", title: "old" }] })).toBe("https://github.com/a/b/compare/aaa1111%5E...ccc3333");
  });
  it("is null without a GitHub repo or commits", () => {
    expect(changeLink({ ...base, repo: null, pr_url: null, commits: [{ sha: "abc1234", title: "x" }] })).toBeNull();
    expect(changeLink({ ...base, repo: "https://gitlab.com/a/b", pr_url: null, commits: [{ sha: "abc1234", title: "x" }] })).toBeNull();
    expect(changeLink({ ...base, repo: "a/b", pr_url: null, commits: [] })).toBeNull();
  });
  it("makes the card and its shas links", () => {
    const html = changeCardHtml(5, { ...base, repo: "a/b", pr_url: null, commits: [{ sha: "abc1234", title: "x" }] });
    expect(html).toContain(`class="chg chg-go" data-change="5" data-href="https://github.com/a/b/commit/abc1234"`);
    expect(html).toContain(`<a class="sha" href="https://github.com/a/b/commit/abc1234" target="_blank" rel="noopener noreferrer"><code>abc1234</code></a>`);
    expect(html).toContain(`>Commit on GitHub ↗</a>`);
  });
});

describe("replies in the conversation (jxn #1351)", () => {
  it("only the Reply button starts a reply; a reply's own article (data-reply = its parent) doesn't", async () => {
    const html = await boardPage({ name: "jxn", email: "jxn@example.com", display_name: null, admin: false }, [], info, [{ user: "jxn", display_name: null, last_seen: 0 }], entries, []).text();
    expect(html).toContain("e.target.closest('button[data-reply]')");
    expect(html).not.toContain("e.target.closest('[data-reply]')");
    expect(html).toContain(".ro button[data-reply]");
    expect(html).not.toContain(".ro [data-reply]");
  });
});

describe("markdown tables", () => {
  it("renders a header row, alignment and body rows; a lone | line stays text", async () => {
    const { renderText } = await import("../src/ui");
    const html = renderText("Status\n\n| | Change | When |\n|---|---|--:|\n| `28ce59c` | **emoji** | 36 min |\n| `967ab7f` | receipts | 42 min |");
    expect(html).toContain('<div class="md-tw"><table class="md-t"><thead><tr><th></th><th>Change</th><th style="text-align:right">When</th></tr></thead>');
    expect(html).toContain("<td><code>28ce59c</code></td><td><strong>emoji</strong></td>");
    expect(html.match(/<tr>/g)?.length).toBe(3);
    expect(renderText("a | b |")).not.toContain("<table");
    expect(renderText("| just a pipe line |")).not.toContain("<table");
  });
});

describe("charts (vedu #1246, spec #1247)", () => {
  it("draws a ```chart block as an SVG with its data, and falls back to code when it can't", async () => {
    const { renderText } = await import("../src/ui");
    const bar = renderText('Signups\n\n```chart\n{"type":"bar","title":"Signups","x":["Mon","Tue","Wed"],"series":[{"name":"web","values":[12,19,7]},{"name":"app","values":[4,6,9]}]}\n```');
    expect(bar).toContain('<figure class="ch"><figcaption class="ch-t">Signups</figcaption><svg class="ch-svg ch-wide"');
    expect(bar.match(/<rect class="ch-s/g)?.length).toBe(12); // drawn wide and narrow
    expect(bar).toContain('<div class="ch-legend">');
    expect(bar).toContain("<summary>Data</summary>");
    const pie = renderText('```chart\n{"type":"pie","x":["a","b"],"series":[{"name":"n","values":[3,1]}]}\n```');
    expect(pie.match(/<path class="ch-s/g)?.length).toBe(2);
    expect(pie).toContain("<b>75%</b>");
    const line = renderText('```chart\n{"type":"line","x":["1","2","3"],"series":[{"name":"p95","values":[120,90,80]}],"unit":"ms"}\n```');
    expect(line).toContain('<polyline class="ch-l ch-s0"');
    const bad = renderText("```chart\nnot json\n```");
    expect(bad).toContain("<pre><code>not json</code></pre>");
    expect(bad).toContain("couldn't be drawn");
    expect(renderText("```js\nlet a = 1\n```")).toContain("<pre><code>let a = 1</code></pre>");
    const xss = renderText('```chart\n{"title":"<img src=x onerror=alert(1)>","x":["<b>"],"series":[{"name":"<s>","values":[1]}]}\n```');
    expect(xss).not.toContain("<img");
    expect(xss).not.toContain("<b>");
  });
});

describe("mermaid diagrams (vedu #1246, #1247)", () => {
  it("sends a ```mermaid block as its code block, marked for the page to draw, with the text escaped", async () => {
    const { renderText, page } = await import("../src/ui");
    const { MERMAID_SRC, MERMAID_SRI } = await import("../src/mermaid");
    const html = renderText('Flow\n\n```mermaid\nflowchart TD\n  A["<img src=x onerror=alert(1)>"] --> B</script>\n```');
    expect(html).toContain('<div class="mmd"><div class="code-b"><div class="code-h"><span class="mono">mermaid</span>');
    expect(html).toContain("<pre><code>flowchart TD\n  A[&quot;&lt;img src=x onerror=alert(1)&gt;&quot;] --&gt; B&lt;/script&gt;</code></pre>");
    expect(html).not.toContain("<img");
    expect(renderText("```js\nlet a = 1\n```")).not.toContain('class="mmd"');
    // Pinned, with an integrity hash, strict, and nothing loaded up front: the page only names the URL inside its script.
    expect(MERMAID_SRC).toMatch(/^https:\/\/cdn\.jsdelivr\.net\/npm\/mermaid@\d+\.\d+\.\d+\/dist\/mermaid\.min\.js$/);
    expect(MERMAID_SRI).toMatch(/^sha384-[A-Za-z0-9+/]{64}$/);
    const doc = await page("t", html).text();
    expect(doc).toContain("securityLevel:'strict'");
    expect(doc).toContain("s.integrity=SRI");
    expect(doc).not.toMatch(/<script[^>]+src=[^>]*mermaid/);
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

describe("refLinks", () => {
  it('links "#N" in text, but not the "#39" inside an escaped apostrophe', () => {
    const out = refLinks("it&amp;#39;s in #12, not &#39;#7&#39;");
    expect(out).toContain('data-ref="12"');
    expect(out).not.toContain('data-ref="39"');
    expect(out).toContain('data-ref="7"'); // a quoted '#7' still links
  });
});

describe("status card (#1289)", () => {
  it("sends a ```status block as its snapshot text, escaped and marked for the board page to make live", async () => {
    const { renderText } = await import("../src/ui");
    const html = renderText("```status\nWhere things stand\n\nRunning\n- #3 <img src=x onerror=alert(1)> (jxn's agent)\n```");
    expect(html).toContain('<figure class="st" data-status><figcaption class="st-t">Where things stand</figcaption><pre class="st-snap"><code>Where things stand');
    expect(html).toContain("- #3 &lt;img src=x onerror=alert(1)&gt; (jxn&#39;s agent)");
    expect(html).not.toContain("<img");
    // The board page offers /status and carries the live-card script, with its escapes intact.
    const page = await boardPage({ name: "jxn", email: "jxn@example.com", display_name: null, admin: false }, [], info, [{ user: "jxn", display_name: null, last_seen: 0 }], entries, []).text();
    expect(page).toContain("['status','The last 3 commits and the task queue, as a live card']");
    expect(page).toContain("if(!/^\\/status\\s*$/i.test(ta.value)||!window.ST)return;");
    expect(page).toContain("window.ST=(()=>");
    expect(page).toContain("location.pathname.match(/^\\/b\\/([^/?#]+)/)");
    expect(page).toContain("L.join('\\n').replace(/```/g,\"'''\")");
  });
});
