import { describe, expect, it } from "vitest";
import { imageSize, sniffImage } from "../src/imageSize";

const bytes = (arr: number[]) => Uint8Array.from(arr);
const chars = (s: string) => [...s].map((c) => c.charCodeAt(0));
const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

const png = bytes([...chars("\u0089PNG\r\n\u001a\n"), 0, 0, 0, 13, ...chars("IHDR"), 0, 0, 0, 3, 0, 0, 0, 2, 0, 0, 0]);
const gif = bytes([...chars("GIF89a"), 0x0a, 0x00, 0x14, 0x00]);
const jpeg = bytes([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...new Array(14).fill(0), 0xff, 0xc0, 0, 17, 8, 0, 120, 0, 160, ...new Array(10).fill(0)]);
const jpegFill = bytes([0xff, 0xd8, 0xff, 0xff, 0xc0, 0, 17, 8, 0, 120, 0, 160, 0, 0, 0, 0, 0, 0, 0, 0]);
const riff = (shape: string, rest: number[]) => bytes([...chars("RIFF"), 0, 0, 0, 0, ...chars("WEBP"), ...chars(shape), 0, 0, 0, 0, ...rest]);
const webpVp8x = riff("VP8X", [0, 0, 0, 0, 0x3f, 0x01, 0x00, 0xef, 0x00, 0x00]); // canvas 320×240
const webpVp8 = riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, 2, 0, 3, 0]); // 2×3
const webpVp8l = riff("VP8L", [0x2f, 0x04, 0x80, 0x01, 0x00]); // (4|6<<14)+1 bits: 5×7

describe("imageSize", () => {
  it("reads each type's size from its header bytes", () => {
    expect(sniffImage(png)).toBe("image/png");
    expect(imageSize("image/png", png)).toEqual({ w: 3, h: 2 });
    expect(imageSize("image/gif", gif)).toEqual({ w: 10, h: 20 });
    expect(imageSize("image/jpeg", jpeg)).toEqual({ w: 160, h: 120 });
    expect(imageSize("image/webp", webpVp8x)).toEqual({ w: 320, h: 240 });
    expect(imageSize("image/webp", webpVp8)).toEqual({ w: 2, h: 3 });
    expect(imageSize("image/webp", webpVp8l)).toEqual({ w: 5, h: 7 });
  });

  it("reads a real 1×1 PNG", () => {
    expect(imageSize("image/png", b64("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="))).toEqual({ w: 1, h: 1 });
  });

  it("walks a JPEG's markers to its SOF and skips fill bytes", () => {
    expect(imageSize("image/jpeg", jpegFill)).toEqual({ w: 160, h: 120 });
  });

  it("says nothing when the bytes don't say", () => {
    expect(imageSize("image/png", png.slice(0, 20))).toBe(null); // header cut short
    expect(imageSize("image/jpeg", bytes([0xff, 0xd8, 0xff, 0xda, 0, 2, 1, 2, 3]))).toBe(null); // no SOF before the end
    expect(imageSize("application/octet-stream", png)).toBe(null); // not an image
  });
});
