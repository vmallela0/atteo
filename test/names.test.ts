import { describe, expect, it } from "vitest";
import { cleanDisplay, displayMap, looksLikeOtherHandle, personHtml, shownName } from "../src/names";
import { cleanAgentName } from "../src/agentName";
import { cleanBoardTitle, stripInvisible } from "../src/util";

describe("one sanitizer for every name (review follow-up): tag characters, bidi controls and other invisible formatting", () => {
  const TAGS = "\u{E0001}\u{E0020}\u{E0069}\u{E0067}\u{E006E}\u{E006F}\u{E0072}\u{E0065}\u{E007F}"; // hidden ASCII "ignore"
  const BIDI = "‪‫‬‭‮⁦⁧⁨⁩";
  it("stripInvisible drops tags (U+E0000–E007F), bidi embeddings, overrides and isolates, and other format characters", () => {
    expect(stripInvisible(`Ve${TAGS}du`)).toBe("Vedu");
    expect(stripInvisible(`a${BIDI}b`)).toBe("ab");
    expect(stripInvisible("a​‌‍‎‏⁠⁤﻿­͏؜᠎￹￻\u{1D173}\u{E0100}️b")).toBe("ab");
    expect(stripInvisible("Ünïcödé 名前 مرحبا")).toBe("Ünïcödé 名前 مرحبا"); // visible text is untouched
  });
  it("covers Default_Ignorable_Code_Point and Cc, plus shorthand and hieroglyph format controls", () => {
    expect(stripInvisible("a\u{1BCA0}\u{1BCA1}\u{1BCA2}\u{1BCA3}b")).toBe("ab");
    expect(stripInvisible("a\u{13430}\u{13438}\u{1343F}b")).toBe("ab");
    expect(stripInvisible("a\u{E0FFF}\u{E01EF}\u0085\u2800\uFFFBb")).toBe("ab");
  });
  it("ZWJ and VS15/VS16 stay only where they build an emoji", () => {
    expect(stripInvisible("pay\u200Dpal")).toBe("paypal");
    expect(stripInvisible("pay\uFE0Fpal\uFE0E")).toBe("paypal");
    expect(stripInvisible("\u200D\uFE0Fx")).toBe("x");
    for (const e of ["👩‍💻", "❤️", "❤️‍🔥", "👩🏽‍💻", "🏳️‍🌈", "☺︎"]) expect(stripInvisible(e)).toBe(e);
    expect(stripInvisible("👩‍‍💻")).toBe("👩‍💻"); // one ZWJ, not a pile
    expect(cleanDisplay("Ve\u200Ddu 👩‍💻")).toBe("Vedu 👩‍💻");
  });
  it("display_name", () => {
    expect(cleanDisplay(`Vee${TAGS} ${BIDI}Dee`)).toBe("Vee Dee");
    expect(cleanDisplay(`${TAGS}${BIDI}`)).toBeNull();
  });
  it("agent_name: stripped before it's checked, so a tag or variation selector can't ride along as a 'mark'", () => {
    expect(cleanAgentName(`Jar${TAGS}vis`)).toBe("Jarvis");
    expect(cleanAgentName("Jarvis\u{E0101}️")).toBe("Jarvis");
    expect(cleanAgentName(`⁧Jarvis⁩`)).toBe("Jarvis");
    expect(cleanAgentName(`${TAGS}${BIDI}`)).toBeNull();
  });
  it("board titles: the same, but emoji stay whole (ZWJ and VS16 kept)", () => {
    expect(cleanBoardTitle(`Launch${TAGS} ${BIDI}plan`)).toBe("Launch plan");
    expect(cleanBoardTitle("👩‍💻 Dev ❤️")).toBe("👩‍💻 Dev ❤️");
    expect(cleanBoardTitle(`  ${TAGS}‮ `)).toBe("");
    expect(cleanBoardTitle("two\nlines")).toBe("two lines");
  });
});

describe("display names (jxn #4369)", () => {
  it("drops invisible and direction-flipping characters, and blank names fall back to the handle", () => {
    expect(cleanDisplay("Vee‮​ Dee⁦")).toBe("Vee Dee");
    expect(cleanDisplay("​ ‏")).toBeNull();
    expect(shownName("vd", "  ")).toBe("vd");
    expect(shownName("vd", "Vee")).toBe("Vee");
  });
  it("escapes the name, isolates it and puts the @handle on hover", () => {
    expect(personHtml("vd", "<b>Vee</b>")).toBe('<bdi class="pn" title="@vd">&lt;b&gt;Vee&lt;/b&gt;</bdi>');
    expect(personHtml("vd", null)).toBe("vd");
  });
  it("a name that passes for someone else carries the real handle", () => {
    expect(looksLikeOtherHandle("evil", "jxn", ["jxn", "evil"])).toBe(true);
    expect(looksLikeOtherHandle("evil", "@anyone")).toBe(true);
    expect(looksLikeOtherHandle("vmallela", "Vedu", ["jxn"])).toBe(false);
    expect(looksLikeOtherHandle("jxn", "JXN", ["jxn"])).toBe(false);
    expect(personHtml("evil", "jxn", ["jxn"])).toContain('<span class="pn-h">@evil</span>');
  });
  it("the page's map keeps only names that differ from the handle", () => {
    expect(displayMap([{ user: "a", display_name: "Ann" }, { user: "b", display_name: "b" }, { user: "c", display_name: null }])).toEqual({ a: "Ann" });
  });

  it("can't be dodged (#4429): invisible tails, stacked marks, look-alikes, fullwidth, an agent's label", () => {
    expect(cleanDisplay("\u2800")).toBeNull(); // braille blank
    expect(cleanDisplay("ved\u{E0041}u")).toBe("vedu"); // a tag character
    expect([...(cleanDisplay("a\u0301\u0301\u0301\u0301\u0301") ?? "")].length).toBe(3); // at most two marks a letter
    const known = ["vedu", "jxn"];
    expect(looksLikeOtherHandle("mallory", "v\u0435du", known)).toBe(true); // Cyrillic е
    expect(looksLikeOtherHandle("mallory", "ｖｅｄｕ", known)).toBe(true); // fullwidth
    expect(looksLikeOtherHandle("mallory", "＠someone", known)).toBe(true);
    expect(looksLikeOtherHandle("mallory", "vedu's agent", known)).toBe(true);
    expect(looksLikeOtherHandle("mallory", "Vedu’s Assistant", known)).toBe(true);
    expect(looksLikeOtherHandle("vedu", "Vedu", known)).toBe(false); // your own handle is fine
    expect(looksLikeOtherHandle("vmallela", "Vedu M", known)).toBe(false);
    expect(personHtml("mallory", "vеdu's agent", known)).toContain('<span class="pn-h">@mallory</span>');
  });
});
