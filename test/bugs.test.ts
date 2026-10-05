// Bug-report endpoint's pure parts (src/bugs.ts): the form parse with its caps, the report text, the rate-limit keys.
// The route itself (POST /api/bugs) runs against a server (test/e2e.mjs).

import { describe, expect, it } from "vitest";
import {
  BUG_CONTEXT_MAX,
  BUG_NOTE_MAX,
  BUG_PICTURES_MAX,
  BUG_SCREENSHOT_MAX,
  bugLimitKeys,
  bugReportText,
  parseBugForm,
} from "../src/bugs";

const png = (bytes = 100): File => new File([new Uint8Array(bytes)], "shot.png", { type: "image/png" });

const formOf = (parts: Record<string, string | File | null>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(parts)) if (v !== null) f.append(k, v);
  const body = new Request("https://atteo.dev/api/bugs", { method: "POST", body: f });
  return body;
};

describe("bug reports", () => {
  it("takes several pictures (the web attaches them, jxn #4116): in order, at most 4, 2 MB together", async () => {
    const many = (n: number, size = 100) => { const f = new FormData(); f.append("note", "the dialog breaks"); for (let i = 0; i < n; i++) f.append("screenshot", new File([new Uint8Array(size)], `p${i}.jpg`, { type: "image/jpeg" })); return new Request("https://atteo.dev/api/bugs", { method: "POST", body: f }); };
    const r = await parseBugForm(many(3));
    expect(r.screenshots?.length).toBe(3);
    expect(r.screenshot).toBe(r.screenshots?.[0]);
    expect(r.screenshots?.map((x) => x.name)).toEqual([expect.stringMatching(/-1\.jpg$/), expect.stringMatching(/-2\.jpg$/), expect.stringMatching(/-3\.jpg$/)]);
    await expect(parseBugForm(many(BUG_PICTURES_MAX + 1))).rejects.toThrow(/At most 4 pictures/);
    await expect(parseBugForm(many(3, 700_000))).rejects.toThrow(/too large together/);
    expect((await parseBugForm(formOf({ note: "no pictures" }))).screenshots).toEqual([]);
  });

  it("parses note, path, context and the screenshot file", async () => {
    const r = await parseBugForm(formOf({ note: "the send button vanished", path: "/b/b_1", context: JSON.stringify({ app_version: "1.2", device: "iPhone", os: "iOS 19", board: "b_1", extra: "dropped" }), screenshot: png() }));
    expect(r.note).toBe("the send button vanished");
    expect(r.path).toBe("/b/b_1");
    expect(r.context).toEqual({ app_version: "1.2", device: "iPhone", os: "iOS 19", board: "b_1" });
    expect(r.screenshot?.mime).toBe("image/png");
    expect(r.screenshot?.name).toMatch(/bug-\d+\.png$/);
  });

  it("demands a note, caps it, and caps the context blob", async () => {
    await expect(parseBugForm(formOf({}))).rejects.toThrow(/say what went wrong/i);
    await expect(parseBugForm(formOf({ note: "  " }))).rejects.toThrow(/say what went wrong/i);
    await expect(parseBugForm(formOf({ note: "x".repeat(BUG_NOTE_MAX + 1) }))).rejects.toThrow(/under 2000/);
    await expect(parseBugForm(formOf({ note: "ok", context: "x".repeat(BUG_CONTEXT_MAX + 1) }))).rejects.toThrow(/context/i);
    await expect(parseBugForm(formOf({ note: "ok", context: "{not json" }))).rejects.toThrow(/context part must be JSON/i);
  });

  it("caps the screenshot and only takes PNG or JPEG", async () => {
    await expect(parseBugForm(formOf({ note: "ok", screenshot: new File([new Uint8Array(10)], "x.gif", { type: "image/gif" }) }))).rejects.toThrow(/PNG or a JPEG/i);
    await expect(parseBugForm(formOf({ note: "ok", screenshot: new File([new Uint8Array(BUG_SCREENSHOT_MAX + 1)], "big.png", { type: "image/png" }) }))).rejects.toThrow(/too large/i);
    const r = await parseBugForm(formOf({ note: "ok", screenshot: new File([new Uint8Array(10)], "shot.jpg", { type: "image/jpeg" }) }));
    expect(r.screenshot?.mime).toBe("image/jpeg");
    expect(r.screenshot?.name).toMatch(/\.jpg$/);
  });

  it("takes a data-URL screenshot part too (the web's fallback), still capped", async () => {
    // a 1x1 red PNG
    const data =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const r = await parseBugForm(formOf({ note: "ok", screenshot: data }));
    expect(r.screenshot?.mime).toBe("image/png");
    await expect(parseBugForm(formOf({ note: "ok", screenshot: "data:image/webp;base64,AAAA" }))).rejects.toThrow(/PNG or JPEG/i);
    await expect(parseBugForm(formOf({ note: "ok", screenshot: "data:image/png;base64,!!!" }))).rejects.toThrow();
  });

  it("builds the report text: note first, then the facts it knows", () => {
    const t = bugReportText(
      { note: "it hangs on send", path: "/b/b_9", context: { app_version: "3.4", device: "NexiGo", os: "macOS 16", board: "b_9" }, screenshot: null },
      "vedu",
    );
    expect(t).toContain("🐞 it hangs on send");
    expect(t).toContain("Reported by vedu · on /b/b_9");
    expect(t).toContain("App: 3.4");
    expect(t).toContain("Device: NexiGo · macOS 16");
    expect(t).toContain("Board: b_9");
    const bare = bugReportText({ note: "n", path: "", context: {}, screenshot: null }, "someone (signed out)");
    expect(bare).toBe("🐞 n\n\nReported by someone (signed out)");
  });

  it("limits signed-in reporters per person and signed-out ones strictly per IP", () => {
    expect(bugLimitKeys("jxn", "1.2.3.4")).toEqual([{ key: "bugs:u:jxn", limit: 5 }]);
    expect(bugLimitKeys(null, "1.2.3.4")).toEqual([{ key: "bugs:ip:1.2.3.4", limit: 3 }]);
  });
});
