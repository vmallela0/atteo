import { describe, expect, it } from "vitest";
import { GUIDE_TR } from "../src/guide.i18n";
import { boardPage, entryHtml } from "../src/html";
import { fence, neutralize } from "../src/screen";
import { formatEntry } from "../src/state";
import type { BoardInfo, Entry } from "../src/types";
import { renderText } from "../src/ui";
import { esc } from "../src/util";

// Explicit bidi formatting: embeddings, overrides, isolates, and their pops.
// U+202E and U+202D reverse the characters after them; the rest of the set can reorder
// the text around them, including someone else's name. Marks (LRM U+200E, RLM U+200F, ALM U+061C) are not in it.
const FORMAT = /[\u202A-\u202E\u2066-\u2069]/;
const RLO = "\u202E";
const LRO = "\u202D";
const CONTROLS = "\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069";
const base = { reply_to: null, resolves: [] as number[], supersedes: null, retracts: null, artifact_name: null, artifact_size: null };

describe("bidi overrides", () => {
  it("does not let an override reverse a message or a name on the web, and Arabic still reads", () => {
    const html = renderText(`hello ${RLO}vedu`);
    expect(html).not.toMatch(FORMAT);
    expect(html).toContain("hello vedu");

    const page = entryHtml(
      { ...base, seq: 12, ts: 0, author: "alice", via: "agent", type: "note", text: `pay ${LRO}bob`, to: "bob", agent_name: `Jarvis${RLO}` },
      "b_test1234",
    );
    expect(page).not.toMatch(FORMAT);
    expect(page).toContain("Jarvis");
    expect(page).toContain("alice&#39;s agent");
    expect(page).toContain("→ bob");
    expect(page).toContain("pay bob");

    expect(esc(`Maya${CONTROLS} Chen`)).toBe("Maya Chen");
    expect(renderText("مرحبا بالعالم")).toContain("مرحبا بالعالم");
    expect(renderText("שלום vedu")).toContain("שלום vedu");
    // A right-to-left mark places a Latin word inside Arabic; it does not reverse letters, so it stays.
    expect(esc("مرحبا\u200F @vedu")).toBe("مرحبا\u200F @vedu");
    const guide = GUIDE_TR.ar["Type @ and pick a name. @name reaches the person and @name's agent their agent; @agents reaches every agent, @humans every person, @all everyone."];
    expect(guide).toMatch(/\u200F/);
    expect(esc(guide)).toMatch(/\u200F/);
    expect(esc(guide)).toContain("@name");
    expect(esc(guide)).not.toMatch(FORMAT);
  });

  it("does not let an override reverse names in the plain text an agent reads", () => {
    const e: Entry = { ...base, seq: 12, ts: 0, author: "alice", via: "agent", type: "note", text: `see ${RLO}bob`, to: "bob", agent_name: `Jarvis${CONTROLS}` };
    const out = fence(formatEntry(e), "abc123");
    expect(out).not.toMatch(FORMAT);
    expect(out).toContain("Jarvis");
    expect(out).toContain("alice's agent");
    expect(out).toContain("see bob");
    expect(neutralize(`alice ${RLO}bob`)).toBe("alice bob");
    expect(out).toContain("<<end untrusted abc123>>");
  });

  it("the page script strips the same controls when it draws a name or a message", async () => {
    const info: BoardInfo = { id: "b_test1234", title: "Checkout", created_by: "jxn", created_at: 0, entry_count: 0, last_seq: 0 };
    const html = await boardPage(
      { name: "jxn", email: "jxn@example.com", display_name: null, admin: false },
      [],
      info,
      [{ user: "jxn", display_name: null, last_seen: 0 }],
      [],
      [],
    ).text();
    const start = html.indexOf("function bidi(s)");
    const end = html.indexOf("function esc(s)");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const bidi = new Function(`${html.slice(start, end)} return bidi;`)() as (s: string) => string;
    expect(bidi(`a${CONTROLS}b`)).toBe("ab");
    expect(bidi("مرحبا\u200F @vedu")).toBe("مرحبا\u200F @vedu");
    expect(bidi("שלום")).toBe("שלום");
  });
});
