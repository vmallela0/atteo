// Pasted rich text shown as text (vedu #5225). Safari and macOS apps put copied text on the pasteboard as RTF or flat
// RTFD, and older composers posted that as a file named "rich text with attachments -RTFD- data" (-2, -3…). Those
// render as a quoted "Pasted text" block instead of a file card. This turns the RTF inside them into plain text: never
// HTML, no styles, no pictures, just the words with their paragraph breaks.

import { stripBidiControls } from "./util";

/** A file that's pasted rich text, by its pasteboard-type name, an .rtf/.rtfd name, or an RTF type. */
export function isRichTextAttachment(name: string | null | undefined, mime?: string | null): boolean {
  const n = (name ?? "").trim();
  if (/-RTFD?-\s*data(?:[-\s]\d+)?$/i.test(n) || /\.rtfd?$/i.test(n)) return true;
  return /^(?:text\/rtf|application\/rtf|com\.apple\.flat-rtfd|com\.apple\.rtfd?|public\.rtf)$/i.test((mime ?? "").split(";")[0].trim());
}

/** Bytes as one char per byte (latin1), so offsets match and nothing is lost before the RTF decodes its own escapes. */
function bytesToLatin1(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return s;
}

/** The RTF document in a file: the file itself, or the RTF stream inside a flat RTFD. null when there's none. */
export function extractRtf(bytes: Uint8Array, max = 4 << 20): string | null {
  const s = bytesToLatin1(bytes.length > max ? bytes.subarray(0, max) : bytes);
  const start = s.indexOf("{\\rtf");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") {
      // \binN: N raw bytes follow, which may hold braces.
      const bin = /^\\bin(-?\d+) ?/.exec(s.slice(i, i + 16));
      if (bin) i += bin[0].length - 1 + Math.max(0, parseInt(bin[1], 10));
      else i++;
    } else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return s.slice(start, i + 1);
  }
  return s.slice(start); // cut short: keep what's there
}

// Windows-1252's 0x80–0x9F (the rest of the byte range is Latin-1).
const CP1252 = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ";
const cp1252 = (b: number) => (b >= 0x80 && b <= 0x9f ? CP1252[b - 0x80] : String.fromCharCode(b));

// Groups that hold no text to show: tables, metadata, pictures and the objects RTFD attachments sit in.
const SKIP = new Set([
  "fonttbl", "colortbl", "expandedcolortbl", "stylesheet", "listtable", "listoverridetable", "info", "pict", "object",
  "header", "headerl", "headerr", "headerf", "footer", "footerl", "footerr", "footerf", "footnote", "fldinst", "themedata",
  "colorschememapping", "latentstyles", "datastore", "xmlnstbl", "rsidtbl", "generator", "mmathPr", "filetbl", "revtbl",
]);
const SYM: Record<string, string> = {
  par: "\n", line: "\n", sect: "\n\n", page: "\n\n", row: "\n", cell: "\t", tab: "\t", emdash: "—", endash: "–", bullet: "•",
  lquote: "‘", rquote: "’", ldblquote: "“", rdblquote: "”", emspace: " ", enspace: " ", qmspace: " ",
};

/** Plain text from RTF: control words and table/picture groups dropped, \'hh and \uN decoded, paragraphs kept. */
export function rtfToText(rtf: string, maxChars = 64 * 1024): string {
  let out = "";
  // skip: inside a group with no text; uc: how many fallback chars follow a \uN; parent marks the group to drop
  // around an RTFD attachment (its {\NeXTGraphic …} group is followed by a placeholder char).
  type G = { skip: boolean; uc: number };
  const stack: G[] = [];
  let g: G = { skip: false, uc: 1 };
  let fallback = 0; // fallback chars still to drop after a \uN
  const emit = (t: string) => {
    if (fallback > 0) {
      fallback--;
      return;
    }
    if (!g.skip) out += t;
  };
  const n = rtf.length;
  for (let i = 0; i < n && out.length < maxChars; i++) {
    const c = rtf[i];
    if (c === "{") {
      stack.push(g);
      g = { ...g };
      fallback = 0;
    } else if (c === "}") {
      g = stack.pop() ?? { skip: false, uc: 1 };
      fallback = 0;
    } else if (c === "\\") {
      const d = rtf[i + 1];
      if (d === undefined) break;
      if (d === "\\" || d === "{" || d === "}") {
        emit(d);
        i++;
      } else if (d === "'") {
        const b = parseInt(rtf.slice(i + 2, i + 4), 16);
        if (!Number.isNaN(b)) emit(cp1252(b));
        i += 3;
      } else if (d === "*") {
        g.skip = true; // an optional destination this reader doesn't know
        i++;
      } else if (d === "\n" || d === "\r") {
        emit("\n"); // "\" at a line end is a paragraph (how Cocoa writes them)
        i++;
      } else if (d === "~") {
        emit(" ");
        i++;
      } else if (d === "_") {
        emit("-");
        i++;
      } else if (/[a-zA-Z]/.test(d)) {
        const m = /^([a-zA-Z]{1,32})(-?\d{1,10})? ?/.exec(rtf.slice(i + 1, i + 48))!;
        i += m[0].length;
        const word = m[1];
        const arg = m[2] !== undefined ? parseInt(m[2], 10) : null;
        if (word === "u" && arg !== null) {
          if (!g.skip) out += String.fromCharCode(arg < 0 ? arg + 65536 : arg & 0xffff);
          fallback = g.uc;
        } else if (word === "uc" && arg !== null) g.uc = Math.max(0, Math.min(arg, 8));
        else if (word === "bin" && arg !== null) i += Math.max(0, arg);
        else if (SKIP.has(word)) g.skip = true;
        else if (word === "NeXTGraphic") {
          // {{\NeXTGraphic name \width… }¬}: drop this group and the one around it with its placeholder.
          g.skip = true;
          if (stack.length) stack[stack.length - 1].skip = true;
        } else if (SYM[word] !== undefined) emit(SYM[word]);
        else if (fallback > 0) fallback--; // any other control word counts as one fallback char
      } else i++; // another control symbol (\- \| \: …): nothing to show
    } else if (c === "\r" || c === "\n") {
      // raw line breaks in RTF are formatting, not text
    } else emit(cp1252(c.charCodeAt(0)));
  }
  return tidy(out).slice(0, maxChars);
}

/** Lines without trailing blanks, at most one empty line between paragraphs, no object placeholders, and none of the
 *  hidden formatting esc() strips (bidi embeddings/overrides/isolates, zero-width space, word joiner, BOM) nor other
 *  control characters: an RTF's \uN can spell any of them, and they could reorder or hide what an agent or person reads. */
function tidy(s: string): string {
  return stripBidiControls(s)
    .replace(/[\uFFFC\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The text of a rich-text file's bytes, or null when they hold no RTF (an encrypted board's ciphertext, say). */
export function richTextOf(bytes: Uint8Array): string | null {
  const rtf = extractRtf(bytes);
  return rtf === null ? null : rtfToText(rtf);
}
