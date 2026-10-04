// Optional structured data on an entry: a JSON object stored beside the text and returned unchanged.
// Agents attach machine-readable fields here instead of stuffing them into the message.
// Throws plain Error (not BoardError) so this stays free of the board module and its Workers runtime.

/**
 * A JSON object, a few levels deep. An interface (not `Record<string, unknown>`) so it can cross the
 * board's RPC boundary: `unknown` is not serializable, and a recursive JSON type makes the checker
 * give up. Deeper objects still store and return; this is only the type the stub is checked against.
 */
type JsonPrim = string | number | boolean | null;
export interface EntryDataLeaf {
  [key: string]: JsonPrim | JsonPrim[];
}
export interface EntryDataLevel {
  [key: string]: JsonPrim | JsonPrim[] | EntryDataLeaf | EntryDataLeaf[];
}
export interface EntryData {
  [key: string]: JsonPrim | JsonPrim[] | EntryDataLevel | EntryDataLevel[];
}

/** UTF-8 bytes of the stored JSON. Big enough for a structured result, not a file (those are artifacts). */
export const MAX_ENTRY_DATA = 16_384;
/** Objects and arrays nested deeper than this are refused, so a post can't be a deep blob that breaks later reads. */
export const MAX_ENTRY_DATA_DEPTH = 32;

const NOT_OBJECT = 'data must be a JSON object, for example {"sku":"A-1","qty":2}.';
const NOT_PLAIN = "data must be plain JSON: objects, arrays, strings, numbers, booleans and null.";
const NOT_STABLE = "data has a value JSON can't keep unchanged (undefined, NaN, Infinity, or a function).";

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}

/** Walk a value JSON.stringify would keep as-is. Throws when it wouldn't. `seen` is the objects still on the path. */
function walk(value: unknown, depth: number, seen: Set<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(NOT_STABLE);
    return;
  }
  if (typeof value !== "object") throw new Error(NOT_STABLE);
  if (seen.has(value)) throw new Error("data must be a JSON object (no cycles).");
  if (depth > MAX_ENTRY_DATA_DEPTH) throw new Error(`data is nested too deeply (max ${MAX_ENTRY_DATA_DEPTH}).`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        // A hole stringifies as null, which is not the value that was posted.
        if (!Object.prototype.hasOwnProperty.call(value, i)) throw new Error(NOT_STABLE);
        walk(value[i], depth + 1, seen);
      }
      return;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new Error(NOT_PLAIN);
    if (Object.getOwnPropertySymbols(value).length) throw new Error(NOT_STABLE);
    const rec = value as Record<string, unknown>;
    for (const k of Object.keys(rec)) walk(rec[k], depth + 1, seen);
  } finally {
    seen.delete(value);
  }
}

/**
 * The JSON to store, or null when the post didn't include data.
 * The string is what read and get parse back: same keys, same values, same order.
 */
export function prepareEntryData(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(NOT_OBJECT);
  walk(value, 1, new Set());
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    throw new Error("data must be a JSON object (no cycles).");
  }
  const bytes = utf8Bytes(text);
  if (bytes > MAX_ENTRY_DATA) throw new Error(`data is too large (${bytes} bytes; max ${MAX_ENTRY_DATA}).`);
  return text;
}

/** The object stored in the data column, or undefined when the entry has none (or the column is unreadable). */
export function readEntryData(stored: string | null | undefined): EntryData | undefined {
  if (!stored) return undefined;
  try {
    const v = JSON.parse(stored) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) return v as EntryData;
  } catch {
    /* a bad row shouldn't hide the entry */
  }
  return undefined;
}

/** The line read and get append so an agent sees the object unchanged: `data: {"sku":"A-1"}`. */
export function entryDataLine(data: EntryData): string {
  return `data: ${JSON.stringify(data)}`;
}

/** What the injection screen (heuristic and model) reads for an entry: its text and, since read prints it to agents,
 *  its data (jxn's agent #2346). The data's keys and string values go in as plain lines, not as JSON: in JSON every
 *  string is in quotation marks, which the screen would take for quoted text and only soft-flag. */
export function screenedText(e: { text: string; data?: EntryData | null }): string {
  if (!e.data) return e.text;
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push(k); walk(x); }
  };
  walk(e.data);
  return `${e.text}\n${out.join("\n")}`;
}
