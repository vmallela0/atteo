// What an APNs push says (docs/research/E2E-EVERYWHERE.md §4). Pure: the sender doesn't exist yet (phones register
// at /api/me/devices; sending turns on once the server has an APNs key), so this is the contract it must use.
// - An end-to-end encrypted board: never the text (the server doesn't have it). The alert says only
//   "New message on <board>"; the payload carries the message's ciphertext (`sealed`, its {v:2, epoch, iv, ct}) and
//   mutable-content, so the app's notification extension (ios/NotifyExtension) decrypts it on the phone and shows the
//   real words. Ciphertext that wouldn't fit APNs' 4 KB is left out: the phone shows the generic alert.
// - Any other board: who wrote, where, and the start of the message, as the app's local notifications say.
// The extension reads `board`, `seq`, `sealed`, `author`, `via` and `board_title` (ios/Shared/SealedOpen.swift).

export const APNS_MAX_BYTES = 4096;

export interface PushInput {
  board: { id: string; title: string; encrypted?: boolean | null };
  seq: number;
  author: string;
  via?: string | null;
  /** A plain board's message text (ignored for an encrypted board, which has none). */
  text?: string | null;
  /** An encrypted board's message payload as stored ({v:2, epoch, iv, ct} JSON). */
  sealed?: string | null;
}

export interface PushPayload {
  aps: { alert: { title?: string; body: string }; sound: "default"; "thread-id": string; "mutable-content"?: 1 };
  board: string;
  seq: number;
  author: string;
  via: string | null;
  board_title: string;
  sealed?: string;
}

const bytes = (p: unknown) => new TextEncoder().encode(JSON.stringify(p)).length;
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export function pushPayload(p: PushInput): PushPayload {
  const via = p.via ?? null;
  const base = { board: p.board.id, seq: p.seq, author: p.author, via, board_title: p.board.title };
  if (p.board.encrypted) {
    const out: PushPayload = { aps: { alert: { body: `New message on ${cut(p.board.title, 80)}` }, sound: "default", "thread-id": p.board.id, "mutable-content": 1 }, ...base };
    if (p.sealed && bytes({ ...out, sealed: p.sealed }) <= APNS_MAX_BYTES) out.sealed = p.sealed;
    return out;
  }
  const who = via === "agent" ? `${p.author}'s agent` : p.author;
  const out: PushPayload = { aps: { alert: { title: `${who} in ${cut(p.board.title, 80)}`, body: cut(String(p.text ?? "").replace(/\s+/g, " ").trim(), 180) }, sound: "default", "thread-id": p.board.id }, ...base };
  return out;
}
