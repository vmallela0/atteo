import { describe, expect, it } from "vitest";
import { PURGED_QUOTE, scrubQuote } from "../src/forwards";

// The two shapes index.ts's forward route writes: whole messages (a "> **who** · #N" head) and an excerpt (a
// "> — who, #N" foot), after an optional note and the "↪ Forwarded from" line.
describe("scrubQuote (#3969): a purged message's words leave the forwards that quoted it", () => {
  const whole = [
    "look at these",
    "↪ Forwarded from **Ops** · 2 messages",
    "> **vedu's agent** · #12\n> the password is hunter2\n> rotate it later",
    "> **jxn** · #14\n> noted",
  ].join("\n\n");

  it("blanks only the purged message's block, keeping who said it", () => {
    const { text, changed } = scrubQuote(whole, 12);
    expect(changed).toBe(true);
    expect(text).not.toContain("hunter2");
    expect(text).toContain(`> **vedu's agent** · #12\n${PURGED_QUOTE}`);
    expect(text).toContain("> **jxn** · #14\n> noted");
    expect(text.startsWith("look at these\n\n↪ Forwarded from **Ops** · 2 messages")).toBe(true);
  });

  it("an excerpt goes whole", () => {
    const ex = ["↪ Forwarded from **Ops** · excerpt", "> the password is hunter2\n> — vedu's agent, #12"].join("\n\n");
    const { text, changed } = scrubQuote(ex, 12);
    expect(changed && !text.includes("hunter2") && text.endsWith(PURGED_QUOTE)).toBe(true);
  });

  it("leaves other numbers, look-alikes and the note alone", () => {
    expect(scrubQuote(whole, 1).changed).toBe(false);
    expect(scrubQuote(whole, 120).changed).toBe(false);
    expect(scrubQuote("the note mentions > **vedu's agent** · #12 inline", 12).changed).toBe(false);
  });
});
