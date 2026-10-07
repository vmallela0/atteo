/**
 * One HTTP byte range (RFC 9110 §14.1.2) of a `size`-byte body: `bytes=a-b`, `bytes=a-` or the last n with `bytes=-n`.
 * null for no header or one we don't serve (several ranges, other units), so the whole body goes out with a 200;
 * "bad" for a range that starts past the end (a 416).
 */
export function byteRange(header: string | null, size: number): { start: number; end: number } | null | "bad" {
  const m = header?.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") {
    const n = Number(m[2]);
    return n > 0 && size > 0 ? { start: Math.max(0, size - n), end: size - 1 } : "bad";
  }
  const start = Number(m[1]);
  if (start >= size) return "bad";
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  return end < start ? null : { start, end };
}
