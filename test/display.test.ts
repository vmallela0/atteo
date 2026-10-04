import { describe, expect, it } from "vitest";
import { DISPLAY_DEFAULTS, mergeDisplay } from "../src/social";

describe("display.lang", () => {
  it("takes the top-5 languages (vedu #1776), French included", () => {
    for (const lang of ["en", "zh-Hans", "zh-Hant", "hi", "es", "fr", "ja", "ko", "auto"]) expect(mergeDisplay(DISPLAY_DEFAULTS, { lang }).lang).toBe(lang);
  });
  it("refuses one we don't have", () => {
    expect(() => mergeDisplay(DISPLAY_DEFAULTS, { lang: "ar" })).toThrow();
  });
});
