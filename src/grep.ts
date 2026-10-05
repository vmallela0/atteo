// grep for agents: exact matching lines across a board's messages (and files), or across all of a person's boards.
// The FTS index (search_idx) only picks candidates from the pattern's literal words; lines are then matched exactly here.
// Kept cheap on purpose: no whole-board scans (Durable Object rows read are a daily budget).

import * as registry from "./registry";
import type { Env, Viewer } from "./types";

export const GREP_MAX_PATTERN = 200;
export const GREP_DEFAULT_MAX = 50;
export const GREP_HARD_MAX = 200;
export const GREP_CANDIDATES = 500; // FTS candidates checked per board
export const GREP_RECENT = 2000; // entries scanned when the pattern has no literal word of 3+ characters
export const GREP_BOARDS = 50; // most recently active boards searched by a cross-board grep
export const GREP_CONCURRENCY = 6;
export const GREP_BUDGET = 4_000_000; // characters run through the matcher per board (the CPU time box)
export const LINE_WIDTH = 160;

export class GrepError extends Error {}

export interface Matcher {
  test(line: string): boolean;
  ranges(line: string): [number, number][];
  lineCap: number; // longer lines are only matched on their first lineCap characters
}

export interface Budget {
  left: number;
  hit: boolean;
}
export const newBudget = (n = GREP_BUDGET): Budget => ({ left: n, hit: false });

type Quant = { min: number; max: number; end: number };

/** The quantifier starting at src[k] (*, +, ?, {n}, {n,}, {n,m}, plus a lazy ?), or null. */
function quantAt(src: string, k: number): Quant | null {
  const c = src[k];
  let q: Quant | null = null;
  if (c === "*") q = { min: 0, max: Infinity, end: k + 1 };
  else if (c === "+") q = { min: 1, max: Infinity, end: k + 1 };
  else if (c === "?") q = { min: 0, max: 1, end: k + 1 };
  else if (c === "{") {
    const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(k));
    if (m) q = { min: +m[1], max: m[2] == null ? +m[1] : m[3] ? +m[3] : Infinity, end: k + m[0].length };
  }
  if (q && src[q.end] === "?") q.end++;
  return q;
}

/** Index just past the ] closing the class that opens at src[i]. */
function classEnd(src: string, i: number): number {
  let j = i + 1;
  if (src[j] === "^") j++;
  if (src[j] === "]") j++;
  for (; j < src.length; j++) {
    if (src[j] === "\\") j++;
    else if (src[j] === "]") return j + 1;
  }
  return src.length;
}

/** Index of the ) closing the group that opens at src[i] (or src.length). */
function groupEnd(src: string, i: number): number {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === "\\") j++;
    else if (c === "[") j = classEnd(src, j) - 1;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return j;
  }
  return src.length;
}

/** Splits on | at depth 0 (outside groups and classes). */
function topAlternatives(src: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let j = 0; j < src.length; j++) {
    const c = src[j];
    if (c === "\\") j++;
    else if (c === "[") j = classEnd(src, j) - 1;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "|" && depth === 0) {
      out.push(src.slice(from, j));
      from = j + 1;
    }
  }
  out.push(src.slice(from));
  return out;
}

/** Why a regex could take forever on a crafted line (nested repetition, ambiguous repeated alternation, backrefs), or null. */
export function regexProblem(src: string): string | null {
  if (/\\(?:[1-9]|k<)/.test(src)) return "Backreferences (\\1, \\k<name>) aren't supported.";
  const stack: { q: boolean; alt: boolean; start: number }[] = [{ q: false, alt: false, start: 0 }];
  let dotStars = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const top = stack[stack.length - 1];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "[") {
      i = classEnd(src, i) - 1;
      continue;
    }
    if (c === "(") {
      stack.push({ q: false, alt: false, start: i + 1 });
      const prefix = /^\?(?::|=|!|<=|<!|<[A-Za-z_]\w*>)/.exec(src.slice(i + 1)); // (?: (?= (?<name> … aren't quantifiers
      if (prefix) i += prefix[0].length;
      continue;
    }
    if (c === "|") {
      top.alt = true;
      continue;
    }
    if (c === ")") {
      if (stack.length === 1) continue; // unbalanced: the RegExp constructor says so
      const g = stack.pop()!;
      const q = quantAt(src, i + 1);
      const repeats = !!q && q.max > 1;
      if (repeats && g.q) return "That regex has nested repetition (like (a+)+); simplify it.";
      if (repeats && g.alt && !distinctAlternatives(src.slice(g.start, i))) return "A repeated group with alternatives that can overlap (like (a|ab)+); use a character class or simplify it.";
      if (g.q || q) stack[stack.length - 1].q = true;
      if (q) i = q.end - 1;
      continue;
    }
    const q = quantAt(src, i);
    if (q) {
      top.q = true;
      if (src[i - 1] === "." && q.max === Infinity) dotStars++;
      i = q.end - 1;
    }
  }
  if (dotStars > 3) return "At most 3 .* or .+ in one pattern.";
  return null;
}

/** A repeated group's alternatives are safe when each is plain text and no two start with the same character. */
function distinctAlternatives(inner: string): boolean {
  const body = inner.replace(/^\?(?::|<[A-Za-z_]\w*>)/, "");
  const alts = topAlternatives(body);
  const firsts = new Set<string>();
  for (const a of alts) {
    if (!/^[\p{L}\p{N} _-]+$/u.test(a)) return false;
    const f = a[0].toLowerCase();
    if (firsts.has(f)) return false;
    firsts.add(f);
  }
  return true;
}

/** Literal text every match of the regex must contain (runs of plain characters that aren't optional). */
export function regexLiterals(src: string): string[] {
  if (topAlternatives(src).length > 1) return [];
  const runs: string[] = [];
  let cur = "";
  const brk = () => {
    if (cur) runs.push(cur);
    cur = "";
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      const n = src[i + 1] ?? "";
      i += 2;
      if ((n === "p" || n === "P" || n === "u" || n === "k") && src[i] === "{") i = src.indexOf("}", i) + 1 || src.length;
      else if (n === "u") i += 4;
      else if (n === "x") i += 2;
      else if (n === "c") i += 1;
      brk(); // classes (\d \w \b …) and escaped punctuation alike end a word
      const q = quantAt(src, i);
      if (q) i = q.end;
      continue;
    }
    if (c === "[") {
      brk();
      i = classEnd(src, i);
      const q = quantAt(src, i);
      if (q) i = q.end;
      continue;
    }
    if (c === "(") {
      brk();
      const j = groupEnd(src, i);
      let inner = src.slice(i + 1, j);
      const look = /^\?(?:=|!|<=|<!)/.test(inner);
      inner = inner.replace(/^\?(?::|<[A-Za-z_]\w*>)/, "");
      const q = quantAt(src, j + 1);
      if (!look && (!q || q.min > 0)) runs.push(...regexLiterals(inner));
      i = q ? q.end : j + 1;
      continue;
    }
    const q = quantAt(src, i + 1);
    if (".^$|)*+?{".includes(c)) {
      brk();
      i = quantAt(src, i)?.end ?? i + 1;
      continue;
    }
    if (q) {
      if (q.min > 0) cur += c;
      brk();
      i = q.end;
      continue;
    }
    cur += c;
    i++;
  }
  brk();
  return runs;
}

/** The FTS5 query that prefilters candidates: up to 4 of the pattern's longest literal words (3+ characters), each as a
 *  prefix. null when there's no such word (the caller scans recent entries instead). */
export function grepFtsQuery(pattern: string, regex: boolean): string | null {
  const runs = regex ? regexLiterals(pattern) : [pattern];
  const words = [...new Set(runs.flatMap((r) => r.split(/[^\p{L}\p{N}]+/u)).filter((w) => w.length >= 3))];
  if (!words.length) return null;
  return words
    .sort((a, b) => b.length - a.length)
    .slice(0, 4)
    .map((w) => `"${w}"*`)
    .join(" AND ");
}

/** Checks and compiles a pattern (plain text, or a regex with regex: true). Throws GrepError with a readable reason. */
export function compileGrep(pattern: string, o: { regex?: boolean; caseSensitive?: boolean } = {}): Matcher {
  if (typeof pattern !== "string" || !pattern.trim()) throw new GrepError("Give a pattern to look for.");
  if (pattern.length > GREP_MAX_PATTERN) throw new GrepError(`The pattern is too long (max ${GREP_MAX_PATTERN} characters).`);
  if (o.regex) {
    const why = regexProblem(pattern);
    if (why) throw new GrepError(why);
  }
  const source = o.regex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const flags = o.caseSensitive ? "" : "i";
  let re: RegExp;
  try {
    re = new RegExp(source, flags + "u");
  } catch {
    try {
      re = new RegExp(source, flags);
    } catch (e) {
      throw new GrepError(`Not a valid regex: ${e instanceof Error ? e.message : e}`);
    }
  }
  const all = new RegExp(re.source, re.flags + "g");
  return {
    lineCap: o.regex ? 1000 : 2000,
    test: (line) => re.test(line),
    ranges(line) {
      const out: [number, number][] = [];
      all.lastIndex = 0;
      let m: RegExpExecArray | null;
      while (out.length < 8 && (m = all.exec(line))) {
        if (!m[0].length) {
          all.lastIndex++;
          continue;
        }
        out.push([m.index, m.index + m[0].length]);
      }
      return out;
    },
  };
}

/** One line for output: trimmed, cut to ~width around the first match with …, matches marked «like this». */
export function trimLine(line: string, ranges: [number, number][] = [], width = LINE_WIDTH): string {
  const lead = line.length - line.trimStart().length;
  const s = line.trim();
  const rs = ranges
    .map(([a, b]) => [Math.max(0, a - lead), Math.min(s.length, b - lead)] as [number, number])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let start = 0;
  let end = s.length;
  if (s.length > width) {
    const [a, b] = rs[0] ?? [0, 0];
    const len = Math.min(b - a, width);
    start = Math.max(0, Math.min(a - Math.floor((width - len) / 2), s.length - width));
    end = start + width;
  }
  let out = "";
  let pos = start;
  for (const [a, b] of rs) {
    const a2 = Math.max(a, start);
    const b2 = Math.min(b, end);
    if (b2 <= a2 || a2 < pos) continue;
    out += s.slice(pos, a2) + "«" + s.slice(a2, b2) + "»";
    pos = b2;
  }
  out += s.slice(pos, end);
  return (start > 0 ? "…" : "") + out + (end < s.length ? "…" : "");
}

/** Matching lines of a text (1-based line numbers), each with up to `context` lines either side joined by " ⏎ ". */
export function grepText(text: string, m: Matcher, o: { context?: number; max?: number; budget?: Budget } = {}): { line: number; text: string }[] {
  return scanGrepText(text, m, o).hits;
}

/** Resume within a source without repeating identical matching lines, including duplicates on earlier pages. */
export function scanGrepText(text: string, m: Matcher, o: { context?: number; max?: number; budget?: Budget; afterLine?: number } = {}): { hits: { line: number; text: string }[]; line: number; complete: boolean } {
  const out: { line: number; text: string }[] = [];
  const max = o.max ?? Infinity;
  const ctx = Math.max(0, Math.min(2, o.context ?? 0));
  const budget = o.budget ?? newBudget();
  if (max <= 0 || !text) return { hits: out, line: o.afterLine ?? 0, complete: !text };
  const lines = text.split(/\r?\n/);
  const cap = (l: string) => (l.length > m.lineCap ? l.slice(0, m.lineCap) : l);
  const seen = new Set<string>();
  let line = o.afterLine ?? 0;
  for (let i = 0; i < lines.length && out.length < max; i++) {
    const l = cap(lines[i]);
    if (i < (o.afterLine ?? 0)) { seen.add(l.trim()); continue; }
    budget.left -= l.length + 1;
    if (budget.left < 0) {
      budget.hit = true;
      break;
    }
    line = i + 1;
    if (!m.test(l)) continue;
    const key = l.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    const before = lines.slice(Math.max(0, i - ctx), i).map((x) => trimLine(cap(x)));
    const after = ctx ? lines.slice(i + 1, i + 1 + ctx).map((x) => trimLine(cap(x))) : [];
    out.push({ line: i + 1, text: [...before, trimLine(l, m.ranges(l)), ...after].join(" ⏎ ") });
  }
  return { hits: out, line, complete: line >= lines.length };
}

/** A board's title as a short handle for hit lines: "Atteo — dev board!" → "atteo-dev-board". */
export function shortTitle(title: string, id = ""): string {
  const s = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 16)
    .replace(/-+$/, "");
  return s || id.slice(-6) || "board";
}

/** since: a seq ("120") or a date/time (ISO, e.g. 2026-10-01 or 2026-10-01T09:00Z). */
export function parseSince(v: unknown): { sinceSeq?: number; sinceTs?: number } {
  if (v == null || v === "") return {};
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return { sinceSeq: parseInt(s, 10) };
  const t = Date.parse(s);
  if (!Number.isFinite(t)) throw new GrepError(`since must be a message number or a date (ISO), not "${s.slice(0, 40)}".`);
  return { sinceTs: t };
}

// ---------- running a grep (the Worker side: one board, or all of a person's boards) ----------

export interface GrepOptions {
  regex?: boolean;
  caseSensitive?: boolean;
  author?: string;
  type?: string;
  since?: string | number;
  context?: number;
  max?: number;
  files?: boolean;
  more?: string;
}

/** What one board returns (Board.grepLines). */
export interface BoardGrepHit {
  seq?: number;
  author?: string;
  file?: string;
  line?: number;
  text: string;
  ts?: number;
  /** Internal continuation after this hit, so a fan-out can keep only the hits it needs. */
  after?: BoardGrepCursor;
}
export interface BoardGrepCursor { mode: "fts" | "entries" | "docs"; before: number; line: number; ts?: number }
export interface BoardGrepResult {
  title: string;
  hits: BoardGrepHit[];
  encrypted: boolean;
  fallback: boolean; // no literal word: GREP_RECENT entries scanned per page
  capped: boolean; // more FTS candidates than GREP_CANDIDATES in this page
  budget: boolean; // the time box ran out
  more?: BoardGrepCursor | null;
}
export interface BoardGrepOpts {
  regex?: boolean;
  caseSensitive?: boolean;
  author?: string;
  type?: string;
  sinceSeq?: number;
  sinceTs?: number;
  context?: number;
  max?: number;
  files?: boolean;
  viewer?: Viewer | null; // who's asking: private entries only for those who may see them (absent: none)
  more?: BoardGrepCursor;
}

export interface GrepHit extends BoardGrepHit {
  board: string;
  title: string; // the short title used in the line
}
export interface GrepOutput {
  text: string; // exactly what an agent sees: a count line, then one line per hit
  count: number;
  boards: number; // boards searched
  encrypted_skipped: number;
  notes: string[];
  hits: GrepHit[];
  compact: string;
  more: string | null;
}

/** Cursors are positions, never authorization. Callers still check membership and visibility on every page. */
export function cursorKey(value: unknown): string {
  const s = JSON.stringify(value);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}
export function encodeCursor(key: string, position: unknown): string {
  return btoa(JSON.stringify([1, key, position])).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function decodeCursor(key: string, token: string): unknown {
  try {
    if (token.length > 65536 || !/^[A-Za-z0-9_-]+$/.test(token)) throw new Error();
    const [version, gotKey, position] = JSON.parse(atob(token.replace(/-/g, "+").replace(/_/g, "/")));
    if (version !== 1 || gotKey !== key) throw new Error();
    return position;
  } catch { throw new GrepError("Invalid more cursor for this query."); }
}
export function isBoardGrepCursor(value: unknown): value is BoardGrepCursor {
  const c = value as BoardGrepCursor | null;
  return !!c && ["fts", "entries", "docs"].includes(c.mode) && Number.isSafeInteger(c.before) && c.before > 0 && Number.isSafeInteger(c.line) && c.line >= 0 && (c.mode !== "docs" || (Number.isSafeInteger(c.ts) && c.ts! >= 0));
}

/** Compact agent presentation; keep hitLine and the API's text field for existing callers. */
export function compactHitLine(h: Pick<GrepHit, "seq" | "author" | "file" | "line" | "ts" | "text">, board = ""): string {
  const ref = h.file != null ? `${h.file}:${h.line}` : `#${h.seq}`;
  const date = h.ts != null ? new Date(h.ts).toISOString().slice(5, 10) : "—";
  return `${board ? board + " " : ""}${ref} · ${h.author ?? "—"} · ${date} · ${h.text.replace(/\s+/g, " ").trim()}`;
}

export function hitLine(h: GrepHit): string {
  return h.file != null ? `${h.title}/${h.file}:${h.line}: ${h.text}` : `${h.title}#${h.seq} ${h.author}: ${h.text}`;
}

/** Runs a grep on one board (boardId; membership already checked) or on all the user's boards (boardId null).
 *  `viewer`: who's asking (an agent, or a person on the web), for which private entries they may see. */
export async function runGrep(env: Env, user: string, pattern: string, opts: GrepOptions, boardId: string | null, viewer: Viewer | null): Promise<GrepOutput> {
  compileGrep(pattern, opts); // a bad pattern fails here, before any board is asked
  const max = Math.max(1, Math.min(GREP_HARD_MAX, Math.trunc(Number(opts.max)) || GREP_DEFAULT_MAX));
  const bo: BoardGrepOpts = {
    regex: !!opts.regex,
    caseSensitive: !!opts.caseSensitive,
    author: opts.author || undefined,
    type: opts.type || undefined,
    context: Math.max(0, Math.min(2, Math.trunc(Number(opts.context)) || 0)),
    files: !!opts.files,
    ...parseSince(opts.since),
    viewer,
  };
  const stub = (id: string) => env.BOARD.get(env.BOARD.idFromName(id));
  const notes: string[] = [];
  const key = cursorKey(["grep", user, boardId, pattern, bo]);
  type Pending = { id: string; more?: BoardGrepCursor };
  const encodeMore = (boards: Pending[]) => encodeCursor(key, boards.map((b) => [b.id, b.more ? [b.more.mode === "fts" ? 0 : b.more.mode === "entries" ? 1 : 2, b.more.before, b.more.line, ...(b.more.ts != null ? [b.more.ts] : [])] : null]));
  let pending: Pending[] | undefined;
  if (opts.more) {
    const value = decodeCursor(key, opts.more);
    if (!Array.isArray(value)) throw new GrepError("Invalid more cursor.");
    pending = value.map((b) => {
      if (!Array.isArray(b) || b.length !== 2 || typeof b[0] !== "string") throw new GrepError("Invalid more cursor.");
      const c = b[1];
      if (c == null) return { id: b[0] };
      const more = Array.isArray(c) ? { mode: ["fts", "entries", "docs"][c[0]], before: c[1], line: c[2], ts: c[3] } : null;
      if (!isBoardGrepCursor(more)) throw new GrepError("Invalid more cursor.");
      return { id: b[0], more };
    });
    if (new Set(pending!.map((b) => b.id)).size !== pending!.length) throw new GrepError("Invalid more cursor.");
    if (boardId && (pending!.length !== 1 || pending![0].id !== boardId)) throw new GrepError("Invalid more cursor.");
  }
  const cleanHit = (h: BoardGrepHit, id: string, title: string): GrepHit => {
    const { after, ...hit } = h;
    return { ...hit, board: id, title };
  };
  const boardNotes = (r: BoardGrepResult, cross = false) => {
    if (r.fallback) notes.push(`no 3+ char literal: newest ${GREP_RECENT.toLocaleString("en-US")} entries${cross ? " per board" : ""} only (this page)`);
    if (r.capped) notes.push(`newest ${GREP_CANDIDATES} candidates${cross ? " per board" : ""} only (this page)`);
    if (r.budget) notes.push("time box hit");
  };
  if (boardId) {
    const r = await stub(boardId).grepLines(pattern, { ...bo, max, more: pending?.[0].more });
    const title = shortTitle(r.title, boardId);
    if (r.encrypted) {
      const text = `0 hits in ${title} (end-to-end encrypted: the server can't read it)`;
      return { text, compact: text, more: null, count: 0, boards: 0, encrypted_skipped: 1, notes: ["encrypted"], hits: [] };
    }
    const hits = r.hits.map((h) => cleanHit(h, boardId, title));
    boardNotes(r);
    if (hits.length >= max) notes.push(`stopped at max ${max}`);
    const more = r.more ? encodeMore([{ id: boardId, more: r.more }]) : null;
    return output(hits, `in ${title}`, 1, 0, notes, more, false);
  }

  const all = await registry.grepBoards(env, user); // recheck current membership on every continuation
  const readable = all.filter((b) => !b.encrypted);
  const encrypted = all.length - readable.length;
  const byId = new Map(readable.map((b) => [b.id, b]));
  const remaining: Pending[] = (pending ?? readable.map((b) => ({ id: b.id }))).filter((b) => byId.has(b.id));
  const boards = remaining.slice(0, GREP_BOARDS);
  const queue: Pending[] = [...boards];
  const pageSize = Math.max(1, Math.ceil(max / Math.min(GREP_CONCURRENCY, boards.length || 1)));
  if (remaining.length > boards.length) notes.push(`${boards.length} most active of ${remaining.length} boards`);
  const shorts = readable.map((b) => shortTitle(b.title, b.id));
  const dup = new Set(shorts.filter((s, i) => shorts.indexOf(s) !== i));
  const titleFor = (id: string) => {
    const short = shortTitle(byId.get(id)!.title, id);
    return dup.has(short) ? `${short}~${id.slice(-3)}` : short;
  };
  const hits: GrepHit[] = [];
  const seen = new Set<string>();
  const resume = new Map(remaining.map((b) => [b.id, b]));
  let next = 0;
  let searched = 0;
  const searchedIds = new Set<string>();
  let failed = 0;
  let stopped = false;
  let finish!: () => void;
  const enough = new Promise<void>((resolve) => { finish = resolve; });
  // Completion order lets a fast board fill the result without waiting for an unrelated slow board.
  // In-flight RPCs cannot be cancelled; they are handled, but never mutate a response after it is returned.
  const worker = async () => {
    while (!stopped && next < queue.length && hits.length < max) {
      const board = queue[next++];
      try {
        const limit = Math.min(pageSize, max - hits.length);
        const r = await stub(board.id).grepLines(pattern, { ...bo, max: limit, more: board.more });
        if (stopped) return;
        if (!searchedIds.has(board.id)) { searchedIds.add(board.id); searched++; }
        boardNotes(r, true);
        let consumed = 0;
        for (const h of r.hits) {
          if (hits.length >= max) break;
          consumed++;
          const identity = JSON.stringify([board.id, h.seq, h.file, h.text]);
          if (seen.has(identity)) continue;
          seen.add(identity);
          hits.push(cleanHit(h, board.id, titleFor(board.id)));
        }
        const position = consumed < r.hits.length ? r.hits[consumed - 1]?.after : r.more;
        if (position) resume.set(board.id, { id: board.id, more: position });
        else if (consumed === r.hits.length) resume.delete(board.id);
        // Older Board RPC implementations without per-hit cursors are retried from their previous position.
        if (hits.length >= max) { stopped = true; finish(); return; }
        // Refill a productive board before launching more boards, so slow boards cannot hold up a full page.
        // Scan/budget caps stay bounded to one page; only a hit limit gets refilled here.
        if (r.more && r.hits.length >= limit) queue.splice(next, 0, { id: board.id, more: r.more });
      } catch {
        if (!stopped) failed++;
      }
    }
  };
  const workers = Promise.all(Array.from({ length: Math.min(GREP_CONCURRENCY, boards.length) }, worker));
  await Promise.race([workers, enough]);
  stopped = true;
  if (failed) notes.push(`${failed} board${failed === 1 ? "" : "s"} failed`);
  if (hits.length >= max) notes.push(`stopped at max ${max}${searched < boards.length ? `, ${boards.length - searched} boards not searched` : ""}`);
  if (encrypted) notes.unshift(`${encrypted} encrypted skipped`);
  const more = resume.size ? encodeMore([...resume.values()]) : null;
  return output(hits, `in ${searched} board${searched === 1 ? "" : "s"}`, searched, encrypted, [...new Set(notes)], more, true);
}

function output(hits: GrepHit[], where: string, boards: number, encrypted: number, notes: string[], more: string | null, cross: boolean): GrepOutput {
  const head = `${hits.length} hit${hits.length === 1 ? "" : "s"} ${where}${notes.length ? ` (${notes.join("; ")})` : ""}`;
  const tail = more ? [`more: ${more}`] : [];
  return {
    text: [head, ...hits.map(hitLine), ...tail].join("\n"),
    compact: [head, ...hits.map((h) => compactHitLine(h, cross ? h.title : "")), ...tail].join("\n"),
    more, count: hits.length, boards, encrypted_skipped: encrypted, notes, hits,
  };
}
