// Agents' search answers as cards (vedu #4105, after Leviathan's shape): one small card per hit and a hard cap on the
// whole answer, so an agent gets the few records that answer the question, not a dump. The full entry is `get`.

/** The whole answer stays under this many characters (≈ 500 tokens at ~4 characters a token). */
export const CARD_BUDGET = 2000;
/** Hits asked for by default; the budget, not this, is what bounds the answer. */
export const CARD_LIMIT = 5;
export const CARD_MAX_LIMIT = 20;
const TITLE_WIDTH = 100;
const MATCH_WIDTH = 160;

export interface CardEntry { seq: number; type: string; author: string; via?: string | null; ts: number; title?: string | null; text: string }
export interface CardFile { name: string; version: number; author?: string; ts?: number; snippet: string }

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const cut = (s: string, width: number) => (s.length > width ? s.slice(0, width - 1).trimEnd() + "…" : s);
const when = (ts?: number) => (ts ? new Date(ts).toISOString().slice(0, 16).replace("T", " ") : "—");

/** A matched snippet, cut to `width` around its first «mark» so the hit stays in view. */
function snippetLine(snippet: string, width: number): string {
  const s = oneLine(snippet);
  if (s.length <= width) return s;
  const at = Math.max(0, s.indexOf("«"));
  const start = Math.max(0, Math.min(at - Math.floor(width / 3), s.length - width));
  let out = s.slice(start, start + width);
  // Keep the marks paired after the cut.
  if ((out.match(/«/g)?.length ?? 0) > (out.match(/»/g)?.length ?? 0)) out += "»";
  return (start > 0 ? "…" : "") + out + (start + width < s.length ? "…" : "");
}

/**
 * One entry, at most three short lines: "#seq type · author · date · rel", its title (or first line), and one
 * matched snippet with the query marked «like this».
 */
export function entryCard(e: CardEntry, snippet: string, rel?: number): string {
  const head = `#${e.seq} ${e.type} · ${e.via === "agent" ? `${e.author}'s agent` : e.author} · ${when(e.ts)}${rel != null && Number.isFinite(rel) ? ` · rel ${rel.toFixed(1)}` : ""}`;
  const title = cut(oneLine(e.title || e.text.split("\n").find((l) => l.trim()) || e.text), TITLE_WIDTH);
  const snip = snippet ? oneLine(snippet) : "";
  return [head, `  ${title}`, ...(snip.includes("«") ? [`  match: ${snippetLine(snip, MATCH_WIDTH)}`] : [])].join("\n");
}

export function fileCard(f: CardFile): string {
  return `${f.name} v${f.version} · ${f.author ?? "—"} · ${when(f.ts)}\n  match: ${snippetLine(f.snippet, MATCH_WIDTH)}`;
}

/** How many of `cards` fit in `budget` characters after `used` (each card plus its newline); at least one. */
export function cardsThatFit(cards: string[], used: number, budget = CARD_BUDGET): number {
  let n = 0;
  for (const c of cards) {
    if (n > 0 && used + c.length + 1 > budget) break;
    used += c.length + 1;
    n++;
  }
  return n;
}

/** The answer: entries first (best match first), then files while there's room, then how to go on. */
export function cardsAnswer(entries: string[], files: string[], more: string | null, budget = CARD_BUDGET): string {
  const lines: string[] = [];
  if (entries.length) lines.push(`Entries, best match first (${entries.length}):`, ...entries);
  const used = lines.join("\n").length;
  const room = files.length ? cardsThatFit(files, used + 180, budget) : 0;
  if (room && (!entries.length || used + 180 + files.slice(0, room).join("\n").length <= budget)) {
    lines.push("Files (latest version; read with doc):", ...files.slice(0, room));
  }
  if (more) lines.push(`more: ${more}`);
  if (entries.length) lines.push("Full entry: get <seq>.");
  return lines.join("\n");
}
