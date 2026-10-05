import { describe, expect, it } from "vitest";
import { cleanDisplay, displayMap, looksLikeOtherHandle, personHtml, shownName } from "../src/names";

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
});
