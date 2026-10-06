import { describe, expect, it } from "vitest";
import { PALETTE_JS, PALETTE_CSS, PALETTE_JS_SRC, PALETTE_CSS_SRC } from "../src/palette";
import { appPage, APP_CSS, SHELL_PAGE_JS } from "../src/ui";
import { tr, type Lang } from "../src/i18n";

const viewer = { name: "sam", via: "person" as const, email: "sam@example.com", display_name: null, admin: false };

describe("lazy command palette", () => {
  it("ships valid client code separately from page markup, shell behavior and base CSS", async () => {
    expect(() => new Function(PALETTE_JS)).not.toThrow();
    expect(() => new Function(SHELL_PAGE_JS)).not.toThrow();
    const html = await appPage("Home", { viewer, boards: [], active: "boards", crumbs: "Home", body: "Hello" }).text();
    expect(html).not.toContain('id="palette"');
    expect(html).not.toContain(PALETTE_JS_SRC);
    expect(APP_CSS).not.toContain("dialog.palette");
    expect(PALETTE_CSS).toContain("dialog.palette");
    expect(SHELL_PAGE_JS).toContain(PALETTE_JS_SRC);
    expect(SHELL_PAGE_JS).toContain(PALETTE_CSS_SRC);
    expect(PALETTE_JS).not.toMatch(/<style|\sstyle=|\son(?:click|keydown)=/);
  });

  it("reuses joined board/DM data and only offers Ops to operators", async () => {
    const opts = { viewer, boards: [{ id: "b_joined", title: "Joined" }, { id: "b_dm", title: "sam ↔ lee", kind: "direct", peer_name: "Lee" }], active: "boards", crumbs: "Home", body: "Hello" };
    const html = await appPage("Home", opts).text();
    const items = JSON.parse(html.match(/window.PALETTE=(.*?);/)![1]);
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Joined", href: "/b/b_joined" }),
      expect.objectContaining({ label: "Lee (direct)", href: "/b/b_dm" }),
      expect.objectContaining({ label: "Settings", href: "/me" }),
    ]));
    expect(items.some((i: { href: string }) => i.href === "/_ops")).toBe(false);
    const admin = await appPage("Home", { ...opts, viewer: { ...viewer, admin: true } }).text();
    expect(JSON.parse(admin.match(/window.PALETTE=(.*?);/)![1])).toContainEqual({ label: "Ops", hint: "G O", href: "/_ops" });
  });

  it("translates the added labels in every supported non-English language", () => {
    for (const lang of ["es", "fr", "de", "pt", "ja", "ko", "zh-Hans", "zh-Hant", "hi", "bn", "ar", "ru", "id", "tr"] as Lang[])
      for (const label of ["Settings", "Ops", "No matches", "Type to search"])
        expect(tr(lang, label), `${lang}: ${label}`).not.toBe(label);
  });
});
