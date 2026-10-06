import { describe, expect, it } from "vitest";
import { E2E_JS } from "../src/e2eweb";
import { entryHtml, legalPage, logRow, mePage } from "../src/html";
import { maskForReader, maskOffensive, offensiveMaskSource } from "../src/offensive";
import type { Entry } from "../src/types";

const base = { seq: 4, ts: 0, reply_to: null, resolves: [] as number[], supersedes: null, retracts: null, artifact_name: null, artifact_size: null, type: "note" as const, to: null };
const read = (e: Partial<Entry> & { text: string; author: string; via?: string | null }, opts?: { viewer?: string; hideOffensive?: boolean }) =>
  entryHtml({ ...base, via: "person", ...e } as Entry, "b_test1234", true, opts);

describe("maskOffensive", () => {
  it("matches the iOS cases", () => {
    expect(maskOffensive("what the fuck is this")).toBe("what the f••• is this");
    expect(maskOffensive("SHIT happens")).toBe("S••• happens");
    expect(maskOffensive("Scunthorpe and shitake are fine")).toBe("Scunthorpe and shitake are fine");
    expect(maskOffensive("what the fuck", false)).toBe("what the fuck");
    expect(maskOffensive("all clean")).toBe("all clean");
  });

  it("prefers the longer word and keeps punctuation", () => {
    expect(maskOffensive("a motherfucker")).toBe("a m" + "•".repeat(11));
    expect(maskOffensive("two faggots")).toBe("two f" + "•".repeat(6));
    expect(maskOffensive("fuck!")).toBe("f•••!");
    expect(maskOffensive("shit, and bullshit")).toBe("s•••, and b" + "•".repeat(7));
  });

  it("leaves fenced code, inline code and http(s) URLs as written", () => {
    const fenced = "nope fuck\n```js\nconst fuck = 1\n```\nstill fuck";
    expect(maskOffensive(fenced)).toBe("nope f•••\n```js\nconst fuck = 1\n```\nstill f•••");
    expect(maskOffensive("call `fuck` then fuck")).toBe("call `fuck` then f•••");
    const url = "see https://example.com/fuck/path?q=shit and fuck";
    expect(maskOffensive(url)).toBe("see https://example.com/fuck/path?q=shit and f•••");
    expect(maskOffensive("```\nfuck\n```")).toBe("```\nfuck\n```");
    expect(maskOffensive("(https://example.com/fuck)")).toBe("(https://example.com/fuck)");
  });

  it("uses the same mask in the browser copy", () => {
    const js = new Function(`${offensiveMaskSource()}; return maskOffensive`)() as (s: string) => string;
    const samples = [
      "what the fuck is this",
      "SHIT happens",
      "Scunthorpe and shitake are fine",
      "a motherfucker and faggots",
      "nope fuck\n```js\nconst fuck = 1\n```\nstill fuck",
      "call `fuck` then fuck",
      "see https://example.com/fuck/path?q=shit and fuck",
      "all clean",
      "",
    ];
    for (const s of samples) expect(js(s)).toBe(maskOffensive(s));
    expect(E2E_JS).toContain("function maskOffensive");
    expect(E2E_JS).toContain("BC.hideOffensive");
    expect(() => new Function(E2E_JS)).not.toThrow();
  });
});

describe("the web renderer", () => {
  const opts = { viewer: "maya", hideOffensive: true };

  it("masks someone else's message and leaves the stored entry alone", () => {
    const e = { ...base, author: "theo", via: "person" as const, text: "what the fuck is this" };
    const html = entryHtml(e as Entry, "b_test1234", true, opts);
    expect(e.text).toBe("what the fuck is this");
    expect(html).toContain("what the f••• is this");
    expect(html).not.toContain("fuck");
    expect(html).toContain('data-title="what the f••• is…"');
  });

  it("leaves your own person post raw and masks your agent's", () => {
    expect(read({ author: "maya", text: "what the fuck" }, opts)).toContain("what the fuck");
    const agent = read({ author: "maya", via: "agent", text: "what the fuck" }, opts);
    expect(agent).toContain("f•••");
    expect(agent).not.toContain("fuck");
    expect(agent).toContain("by-agent");
  });

  it("does nothing until the preference is on for a reader", () => {
    const text = "what the fuck";
    expect(read({ author: "theo", text }, { viewer: "maya" })).toContain(text);
    expect(read({ author: "theo", text }, { viewer: "maya", hideOffensive: false })).toContain(text);
    expect(read({ author: "theo", text }, { hideOffensive: true })).toContain(text);
  });

  it("keeps a code fence and a URL intact in the HTML", () => {
    const html = read({ author: "theo", text: "nope fuck\n```js\nconst fuck = 1\n```\nsee https://example.com/fuck/path and fuck" }, opts);
    expect(html).toContain("<code>const fuck = 1");
    expect(html).toContain('href="https://example.com/fuck/path"');
    expect(html).toContain("nope f•••");
    expect(html).toContain("and f•••");
    expect(html).toContain(">https://example.com/fuck/path</a>");
    const outside = html.replace(/<code>[\s\S]*?<\/code>/g, "").replace(/https?:\/\/[^\s<"]+/g, "");
    expect(outside).not.toContain("fuck");
    expect(outside).toContain("f•••");
  });

  it("masks a log line and an approval title, and leaves the command verbatim", () => {
    const row = logRow({ ...base, author: "theo", via: "person", text: "what the fuck" } as Entry, undefined, undefined, undefined, "maya");
    expect(row).toContain("f•••");
    expect(row).not.toContain("fuck");
    const html = entryHtml(
      {
        ...base,
        author: "theo",
        via: "agent",
        text: "waiting",
        approval: { id: "ap1", user: "maya", status: "pending", command: "echo fuck", note: "this is fuck", title: "fuck please" },
      } as Entry,
      "b_test1234",
      true,
      opts,
    );
    expect(html).toContain("echo fuck");
    expect(html).toContain("f••• please");
    expect(html).toContain("this is f•••");
    expect(html).not.toContain("this is fuck");
  });

  it("masks for a reader the way the app does", () => {
    expect(maskForReader("fuck", { author: "theo", via: "person" }, "maya")).toBe("f•••");
    expect(maskForReader("fuck", { author: "maya", via: "person" }, "maya")).toBe("fuck");
    expect(maskForReader("fuck", { author: "maya", via: "agent" }, "maya")).toBe("f•••");
    expect(maskForReader("fuck", { author: "theo", via: "person" }, "maya", false)).toBe("fuck");
    expect(maskForReader("fuck", { author: "theo", via: "person" }, null)).toBe("fuck");
  });
});

describe("Account → Safety and privacy", () => {
  const viewer = { name: "maya", email: "maya@example.com", display_name: null, admin: false };
  it("offers the toggle, on unless the person turned it off", async () => {
    const on = await mePage(viewer, [], []).text();
    expect(on).toContain('id="safety"');
    expect(on).toContain("Hide offensive words");
    expect(on).toContain('id="hide-offensive"');
    expect(on).toMatch(/id="hide-offensive"[^>]*checked/);
    expect(on).toContain("hide_offensive");
    const off = await mePage(viewer, [], [], undefined, false, [], { display_name: null, bio: null, listed: false, rules: {}, display: { hide_offensive: false } }).text();
    expect(off).toContain('id="hide-offensive"');
    expect(off).not.toMatch(/id="hide-offensive"[^>]*checked/);
    const agent = await mePage({ ...viewer, via: "agent" }, [], []).text();
    expect(agent).not.toContain('id="hide-offensive"');
  });
});

describe("terms", () => {
  it("names the filter on the web and in the app", async () => {
    const html = await legalPage("terms").text();
    expect(html).toContain("Last updated October 6, 2026");
    expect(html).toContain("Account → Safety and privacy");
    expect(html).toContain("Settings → Safety and privacy");
    expect(html).toContain("what was written stays as sent");
  });
});
