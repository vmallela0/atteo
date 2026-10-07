// An image's type from its first bytes, and its pixel size from the same header bytes, or null when they don't say:
// PNG, JPEG, GIF and WebP only. Pure bytes in, so agent uploads — which send no dimensions, unlike the web — still
// get a size on the entry.

/** The image type from its first bytes, or null. */
export function sniffImage(b: Uint8Array): string | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return "image/gif";
  if (b.length >= 12 && String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") return "image/webp";
  return null;
}

/** A video's type from its bytes, or null: MP4/M4V and QuickTime (an ISO "ftyp" box with a video brand) and WebM (EBML
 *  whose doctype is webm). Audio-only and still-image brands (M4A, HEIC, AVIF) aren't videos. */
const VIDEO_BRANDS = new Set(["isom", "iso2", "iso3", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "M4V ", "M4VH", "M4VP", "dash", "mmp4", "MSNV", "3gp4", "3gp5", "3gp6", "3g2a", "f4v "]);
export function sniffVideo(b: Uint8Array): string | null {
  const text = (at: number, n: number) => String.fromCharCode(...b.slice(at, at + n));
  if (b.length >= 12 && text(4, 4) === "ftyp") {
    const brand = text(8, 4);
    if (brand === "qt  ") return "video/quicktime";
    if (VIDEO_BRANDS.has(brand)) return "video/mp4";
    return null;
  }
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 && text(4, 60).includes("webm")) return "video/webm";
  return null;
}

/** The image's pixel size from its header bytes (the type sniffImage found), or null.
 *  PNG's IHDR, GIF's screen size, JPEG's SOF marker and all three WebP chunk shapes (VP8, VP8L, VP8X). */
export function imageSize(image: string, b: Uint8Array): { w: number; h: number } | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const text = (at: number, n: number) => String.fromCharCode(...b.slice(at, at + n));
  if (image === "image/png") {
    if (b.length < 24) return null;
    return { w: v.getUint32(16), h: v.getUint32(20) };
  }
  if (image === "image/gif") {
    if (b.length < 10) return null;
    return { w: v.getUint16(6, true), h: v.getUint16(8, true) };
  }
  if (image === "image/webp") {
    // The first chunk's shape says where the size lives: VP8X canvas (3-byte edges), VP8L (14 bits each, minus 1),
    // or the lossy VP8 bitstream after its 0x9d 0x01 0x2a start code.
    if (b.length >= 30 && text(12, 4) === "VP8X") return { w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    if (b.length >= 30 && text(12, 4) === "VP8 " && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return { w: v.getUint16(26, true) & 0x3fff, h: v.getUint16(28, true) & 0x3fff };
    if (b.length >= 25 && text(12, 4) === "VP8L" && b[20] === 0x2f) {
      const bits = v.getUint32(21, true);
      return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
    }
    return null;
  }
  if (image === "image/jpeg") {
    // Walk the markers to the Start-Of-Frame: height then width, both after a one-byte precision.
    for (let i = 2; i + 9 <= b.length; ) {
      if (b[i] !== 0xff) {
        i++; // some encoders pad before the marker with fill bytes
        continue;
      }
      const marker = b[i + 1];
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { w: v.getUint16(i + 7), h: v.getUint16(i + 5) };
      i += marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) ? 2 : 2 + v.getUint16(i + 2);
    }
  }
  return null;
}
