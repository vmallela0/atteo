import { describe, expect, it } from "vitest";
import { DISPLAY_DEFAULTS, mergeDisplay } from "../src/social";

describe("display.lang", () => {
  it("takes the top-5 languages (vedu #1776), French included", () => {
    for (const lang of ["en", "zh-Hans", "zh-Hant", "hi", "es", "fr", "ja", "ko", "auto"]) expect(mergeDisplay(DISPLAY_DEFAULTS, { lang }).lang).toBe(lang);
  });
  it("refuses one we don't have", () => {
    expect(() => mergeDisplay(DISPLAY_DEFAULTS, { lang: "it" })).toThrow(); // Arabic is in since #2335; Italian isn't
  });
});

describe("display.replies", () => {
  it("replies in the chat by default, or only in their threads (vedu #2360)", () => {
    expect(DISPLAY_DEFAULTS.replies).toBe("chat");
    expect(mergeDisplay(DISPLAY_DEFAULTS, { replies: "thread" }).replies).toBe("thread");
    expect(() => mergeDisplay(DISPLAY_DEFAULTS, { replies: "hidden" })).toThrow();
  });
});

describe("display.voice_turns", () => {
  it("voice chat waits for a long pause by default; quick and tap are the other choices (vedu #2460)", () => {
    expect(DISPLAY_DEFAULTS.voice_turns).toBe("pause");
    expect(mergeDisplay(DISPLAY_DEFAULTS, { voice_turns: "tap" }).voice_turns).toBe("tap");
    expect(mergeDisplay(DISPLAY_DEFAULTS, { voice_turns: "quick" }).voice_turns).toBe("quick");
    expect(() => mergeDisplay(DISPLAY_DEFAULTS, { voice_turns: "called" })).toThrow();
  });
});
