import { describe, expect, it } from "vitest";
import { byteRange, sniffVideo } from "../src/imageSize";
import { entryHtml } from "../src/html";
import type { Attachment, Entry } from "../src/types";

// Videos play in the chat (jxn #6161): known by their bytes on the way out, played with byte ranges, and drawn as a
// <video> player in the thread with the file's Save link under it.
const bytes = (...xs: (number | string)[]) => Uint8Array.from(xs.flatMap((x) => (typeof x === "string" ? [...x].map((ch) => ch.charCodeAt(0)) : [x])));

describe("video files", () => {
  it("knows MP4/MOV by their ftyp box and WebM by its EBML header, and nothing else", () => {
    expect(sniffVideo(bytes(0, 0, 0, 0x20, "ftypisom", 0, 0, 2, 0))).toBe("video/mp4");
    expect(sniffVideo(bytes(0, 0, 0, 0x14, "ftypqt  ", 0, 0, 0, 0))).toBe("video/mp4"); // QuickTime .mov
    expect(sniffVideo(bytes(0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81))).toBe("video/webm");
    expect(sniffVideo(bytes(0x89, "PNG\r\n", 0x1a, "\n"))).toBe(null);
    expect(sniffVideo(bytes("<!DOCTYPE html><html>"))).toBe(null);
    expect(sniffVideo(Uint8Array.from({ length: 16 }, (_, i) => (i * 37 + 11) & 255))).toBe(null); // ciphertext-like
    expect(sniffVideo(bytes(0, 0, 0))).toBe(null);
  });

  it("reads the byte ranges a player asks for, clipped to the file", () => {
    expect(byteRange("bytes=0-", 1000)).toEqual({ start: 0, end: 999 });
    expect(byteRange("bytes=0-1", 1000)).toEqual({ start: 0, end: 1 }); // Safari's first probe
    expect(byteRange("bytes=500-2000", 1000)).toEqual({ start: 500, end: 999 });
    expect(byteRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
    expect(byteRange("bytes=-5000", 1000)).toEqual({ start: 0, end: 999 });
    expect(byteRange("bytes=1000-", 1000)).toBe("unsatisfiable");
    expect(byteRange("bytes=9-3", 1000)).toBe("unsatisfiable");
    expect(byteRange(null, 1000)).toBe(null);
    expect(byteRange("bytes=0-1,5-9", 1000)).toBe(null); // several parts: the whole file
    expect(byteRange("items=0-1", 1000)).toBe(null);
  });

  const base: Entry = { seq: 7, ts: 1, author: "vedu", type: "artifact", text: "Shared launch.mp4", to: null, reply_to: null, resolves: [], supersedes: null, retracts: null, artifact_name: null, artifact_size: null, via: "agent" };
  const att = (name: string, mime = "application/octet-stream", size = 1_400_000): Attachment => ({ name, mime, size, version: 2 });

  it("draws a posted video as a player in the thread, with its Save link, instead of a download card", () => {
    const html = entryHtml({ ...base, artifact_name: "launch.mp4", artifact_size: 1_400_000, artifact_version: 2, media: { mime: "application/octet-stream", size: 1_400_000 } } as Entry, "b_test1234");
    expect(html).toContain('<video src="/api/boards/b_test1234/image?name=launch.mp4&amp;version=2" controls preload="metadata" playsinline data-vid></video>');
    expect(html).toMatch(/<figcaption[^>]*>.*launch\.mp4.*<a class="link" href="\/api\/boards\/b_test1234\/image\?name=launch\.mp4&amp;version=2" download="launch\.mp4" data-save>Save<\/a>/s);
    expect(html).not.toContain('class="file"');
    for (const name of ["clip.webm", "Screen Recording.MOV", "a.m4v"]) expect(entryHtml({ ...base, artifact_name: name, artifact_size: 9, media: { mime: "application/octet-stream", size: 9 } } as Entry, "b_test1234"), name).toContain("<video ");
    expect(entryHtml({ ...base, artifact_name: "notes.pdf", artifact_size: 9, media: { mime: "application/pdf", size: 9 } } as Entry, "b_test1234")).not.toContain("<video");
  });

  it("plays the videos among several files, and keeps the other files' cards", () => {
    const html = entryHtml({ ...base, text: "Shared 3 files", artifact_name: "cut-1.mp4", artifact_size: 9, attachments: [att("cut-1.mp4"), att("cut-2.webm"), att("notes.pdf", "application/pdf", 9)] }, "b_test1234");
    expect(html.match(/<video /g)).toHaveLength(2);
    expect(html).toContain('<div class="file mchips">');
    expect(html).toContain("notes.pdf");
    expect(html).not.toMatch(/mchips[\s\S]*cut-1\.mp4[\s\S]*Download/);
  });
});
