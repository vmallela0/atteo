import { describe, expect, it } from "vitest";
import { byteRange } from "../src/byteRange";
import { entryHtml } from "../src/html";
import { sniffImage, sniffVideo } from "../src/imageSize";
import type { Attachment, Entry } from "../src/types";

const chars = (s: string) => [...s].map((c) => c.charCodeAt(0));
const ftyp = (brand: string) => Uint8Array.from([0, 0, 0, 24, ...chars("ftyp"), ...chars(brand), 0, 0, 0, 0, ...chars("isom")]);

describe("sniffVideo (jxn #6161)", () => {
  it("knows MP4, QuickTime and WebM by their bytes", () => {
    expect(sniffVideo(ftyp("isom"))).toBe("video/mp4");
    expect(sniffVideo(ftyp("mp42"))).toBe("video/mp4");
    expect(sniffVideo(ftyp("qt  "))).toBe("video/quicktime");
    expect(sniffVideo(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84, ...chars("webm")]))).toBe("video/webm");
  });

  it("isn't fooled by audio, still images, Matroska or text", () => {
    expect(sniffVideo(ftyp("M4A "))).toBeNull();
    expect(sniffVideo(ftyp("heic"))).toBeNull();
    expect(sniffVideo(ftyp("avif"))).toBeNull();
    expect(sniffVideo(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, ...chars("matroska")]))).toBeNull();
    expect(sniffVideo(Uint8Array.from(chars("<html><script>alert(1)</script>")))).toBeNull();
    expect(sniffImage(ftyp("isom"))).toBeNull();
  });
});

describe("byteRange", () => {
  it("answers one range, an open-ended one and a suffix", () => {
    expect(byteRange("bytes=0-1", 10)).toEqual({ start: 0, end: 1 });
    expect(byteRange("bytes=4-", 10)).toEqual({ start: 4, end: 9 });
    expect(byteRange("bytes=2-99", 10)).toEqual({ start: 2, end: 9 });
    expect(byteRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
    expect(byteRange("bytes=-30", 10)).toEqual({ start: 0, end: 9 });
  });

  it("serves the whole body for no or unsupported ranges, and refuses one past the end", () => {
    expect(byteRange(null, 10)).toBeNull();
    expect(byteRange("bytes=0-1,4-5", 10)).toBeNull();
    expect(byteRange("items=0-1", 10)).toBeNull();
    expect(byteRange("bytes=5-3", 10)).toBeNull();
    expect(byteRange("bytes=-", 10)).toBeNull();
    expect(byteRange("bytes=10-", 10)).toBe("bad");
    expect(byteRange("bytes=-0", 10)).toBe("bad");
  });
});

describe("a video in the chat plays in the page", () => {
  const base: Entry = { seq: 7, ts: 1, author: "jxn", type: "artifact", text: "launch cut", to: null, reply_to: null, resolves: [], supersedes: null, retracts: null, artifact_name: null, artifact_size: null, via: "person" };
  const att = (name: string, mime: string, size = 900): Attachment => ({ name, mime, size, version: 1 });

  it("one video: a player with the browser's controls, plus Save, no download card", () => {
    const html = entryHtml({ ...base, artifact_name: "cut6.mp4", artifact_version: 1, artifact_size: 900, media: { mime: "video/mp4", w: null, h: null, size: 900 } } as Entry, "b_test1234");
    expect(html).toContain('<video src="/api/boards/b_test1234/image?name=cut6.mp4&amp;version=1" controls preload="metadata" playsinline');
    expect(html).toContain('download="cut6.mp4" data-save>Save</a>');
    expect(html).not.toContain('class="file');
  });

  it("several files: videos play, pictures stay in the grid, the rest are chips", () => {
    const html = entryHtml({ ...base, text: "Shared 3 files", artifact_name: "a.mp4", artifact_size: 900, attachments: [att("a.mp4", "video/webm"), att("b.png", "image/png"), att("c.zip", "application/octet-stream")] }, "b_test1234");
    expect(html.match(/<video /g)).toHaveLength(1);
    expect(html).toContain('class="mgrid g1"');
    expect(html).toContain('download="c.zip" data-save>Download</a>');
  });
});
