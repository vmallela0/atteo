// Forwards and purge (opus-d #3969, after alt-c's purge #3573 and #3619): a forward copies a message's words into a
// post on another board, so purging the message alone leaves the leak there. The forward route records which message
// went where; purge then blanks each copy's quote of it (the rest of the forward, the forwarder's note and other
// quoted messages, stays). A quote block is a paragraph of "> " lines that names the source: "> **who** · #N" on top
// (a whole message) or "> — who, #N" at the bottom (an excerpt).

import type { Env } from "./types";

export const PURGED_QUOTE = "> (removed: purged where it was posted)";
/** A forward's quote of a message removed because the source board no longer keeps messages that old. */
export const RETAINED_QUOTE = "> (removed: past the retention of the board it was posted on)";

/** The forward's text with every quote block of source message #srcSeq replaced; `changed` when there was one. */
export function scrubQuote(text: string, srcSeq: number, replacement = PURGED_QUOTE): { text: string; changed: boolean } {
  const head = new RegExp(`^> \\*\\*[^\\n]*\\*\\* · #${srcSeq}$`);
  const foot = new RegExp(`^> — [^\\n]*, #${srcSeq}$`);
  let changed = false;
  const paras = text.split("\n\n").map((p) => {
    const lines = p.split("\n");
    if (!lines.every((l) => l.startsWith(">"))) return p;
    if (!head.test(lines[0]) && !foot.test(lines[lines.length - 1])) return p;
    changed = true;
    return head.test(lines[0]) ? `${lines[0]}\n${replacement}` : replacement;
  });
  return { text: paras.join("\n\n"), changed };
}

/** One recorded copy of source message #src_seq, quoted into dst_seq on dst_board. */
export interface ForwardRow {
  src_seq: number;
  dst_board: string;
  dst_seq: number;
}

/** Under D1's 100-bind cap: one bind for the source board, the rest for source seqs. */
const FORWARD_IN = 80;

/** Forwards of these source messages. Empty seqs skip the query. */
export async function forwardsFor(env: Env, srcBoard: string, seqs: number[]): Promise<ForwardRow[]> {
  const out: ForwardRow[] = [];
  for (let i = 0; i < seqs.length; i += FORWARD_IN) {
    const chunk = seqs.slice(i, i + FORWARD_IN);
    const q = chunk.map(() => "?").join(",");
    const res = await env.DB.prepare(`SELECT src_seq, dst_board, dst_seq FROM forwards WHERE src_board = ? AND src_seq IN (${q})`).bind(srcBoard, ...chunk).all<ForwardRow>();
    out.push(...(res.results ?? []));
  }
  return out;
}

/** Forget a forward row once its quote has been blanked, so a later retention pass does not open that board again. */
export async function dropForward(env: Env, srcBoard: string, row: ForwardRow): Promise<void> {
  await env.DB.prepare("DELETE FROM forwards WHERE src_board = ? AND src_seq = ? AND dst_board = ? AND dst_seq = ?").bind(srcBoard, row.src_seq, row.dst_board, row.dst_seq).run();
}

/** Remember that `seqs` on board `src` were quoted into `dstSeq` on board `dst`. */
export async function recordForward(env: Env, src: string, seqs: number[], dst: string, dstSeq: number): Promise<void> {
  if (!seqs.length) return;
  await env.DB.batch(seqs.map((s) => env.DB.prepare("INSERT OR IGNORE INTO forwards (src_board, src_seq, dst_board, dst_seq) VALUES (?, ?, ?, ?)").bind(src, s, dst, dstSeq)));
}

/** After #seq on `board` is purged: blank its quote in every forward of it. Returns how many forwards changed. */
export async function scrubForwards(env: Env, board: string, seq: number): Promise<number> {
  const rows = (await env.DB.prepare("SELECT dst_board, dst_seq FROM forwards WHERE src_board = ? AND src_seq = ?").bind(board, seq).all<{ dst_board: string; dst_seq: number }>()).results;
  let n = 0;
  for (const r of rows) {
    const changed = await env.BOARD.get(env.BOARD.idFromName(r.dst_board)).scrubForwardQuote(r.dst_seq, seq).catch(() => false);
    if (changed) n++;
  }
  return n;
}
