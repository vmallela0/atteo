// Search and grep for end-to-end encrypted boards, run where the plaintext is (docs/research/E2E-EVERYWHERE.md §4):
// the server can't index what it can't read. Pure, for the CLI (atteo search / grep / find decrypt on this machine and
// call these). The web board page does the same search in the browser (e2eweb.ts, window.e2eSearch); the two agree
// (test/e2eweb.test.mjs runs both on the same messages).

export interface LocalEntry {
  seq: number;
  ts: number;
  author: string;
  via: string | null;
  type: string;
  text: string;
}

export interface LocalHit {
  seq: number;
  ts: number;
  author: string;
  via: string | null;
  type: string;
  title: null;
  snippet: string; // the words around the first match, matches between « and » (the server's snippet marks)
}

const wordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}_]/u.test(c);

/** Where each word starts a word in the (lowercased) text, sorted; null when one of the words isn't there. */
function spans(low: string, words: string[]): [number, number][] | null {
  const out: [number, number][] = [];
  for (const w of words) {
    let n = 0;
    for (let p = low.indexOf(w); p >= 0; p = low.indexOf(w, p + 1))
      if (!wordChar(low[p - 1])) {
        out.push([p, p + w.length]);
        n++;
      }
    if (!n) return null;
  }
  return out.sort((a, b) => a[0] - b[0]);
}

function snippetOf(text: string, sp: [number, number][]): string {
  const at = sp.length ? sp[0][0] : 0;
  const from = Math.max(0, at - 60);
  const to = Math.min(text.length, at + 140);
  let s = "";
  let i = from;
  for (const [a, b] of sp) {
    if (b <= i || a >= to) continue;
    s += text.slice(i, Math.max(i, a)) + "«" + text.slice(Math.max(i, a), Math.min(b, to)) + "»";
    i = Math.min(b, to);
  }
  s += text.slice(i, to);
  return (from > 0 ? "… " : "") + s.replace(/\s+/g, " ").trim() + (to < text.length ? " …" : "");
}

/** Every word must start a word in the message (any case); best match first, then newest. At most 50. */
export function searchEntries(entries: Iterable<LocalEntry>, q: string, o: { from?: string | null; agent?: boolean | null; type?: string | null } = {}): LocalHit[] {
  const words = String(q || "").toLowerCase().split(/\s+/).filter(Boolean);
  const hits: { e: LocalEntry; sp: [number, number][] }[] = [];
  for (const e of entries) {
    if (o.from && e.author !== o.from) continue;
    if (o.agent != null && (e.via === "agent") !== !!o.agent) continue;
    if (o.type && e.type !== o.type) continue;
    const lower = e.text.toLowerCase();
    const low = lower.length === e.text.length ? lower : e.text;
    const sp = words.length ? spans(low, words) : [];
    if (!sp) continue;
    hits.push({ e, sp });
  }
  hits.sort((a, b) => b.sp.length - a.sp.length || b.e.seq - a.e.seq);
  return hits.slice(0, 50).map((h) => ({ seq: h.e.seq, ts: h.e.ts, author: h.e.author, via: h.e.via, type: h.e.type, title: null, snippet: snippetOf(h.e.text, h.sp) }));
}

export class LocalGrepError extends Error {}

/**
 * grep over decrypted messages: each matching line once per message, newest message first, as "#seq author: line".
 * A literal pattern by default (regex: true for a regular expression); case-insensitive unless caseSensitive.
 */
export function grepEntries(
  entries: Iterable<LocalEntry>,
  pattern: string,
  o: { regex?: boolean; caseSensitive?: boolean; author?: string | null; type?: string | null; sinceSeq?: number; sinceTs?: number; max?: number } = {},
): { seq: number; author: string; ts: number; line: number; text: string }[] {
  if (!pattern) throw new LocalGrepError("Give a pattern to look for.");
  let re: RegExp;
  try {
    re = new RegExp(o.regex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), o.caseSensitive ? "u" : "iu");
  } catch (e) {
    throw new LocalGrepError(`That isn't a valid regular expression: ${(e as Error).message}`);
  }
  const max = Math.max(1, Math.min(200, Math.trunc(o.max ?? 50)));
  const out: { seq: number; author: string; ts: number; line: number; text: string }[] = [];
  for (const e of [...entries].sort((a, b) => b.seq - a.seq)) {
    if (o.author && e.author !== o.author) continue;
    if (o.type && e.type !== o.type) continue;
    if (o.sinceSeq != null && e.seq < o.sinceSeq) continue;
    if (o.sinceTs != null && e.ts < o.sinceTs) continue;
    const seen = new Set<string>();
    e.text.split(/\r?\n/).forEach((l, i) => {
      const key = l.trim();
      if (out.length >= max || !re.test(l) || seen.has(key)) return;
      seen.add(key);
      out.push({ seq: e.seq, author: e.author, ts: e.ts, line: i + 1, text: l.length > 300 ? l.slice(0, 300) + "…" : l });
    });
    if (out.length >= max) break;
  }
  return out;
}
