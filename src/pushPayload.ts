// What an APNs push says (docs/research/E2E-EVERYWHERE.md §4). Pure: encrypted board-message push delivery is
// still a contract; src/apns.ts sends terminal approval and PIN security alerts to registered phones.
// - An end-to-end encrypted board: only {board, seq, sealed} and the alert "New message". Nothing readable goes to
//   Apple: not the text (the server doesn't have it), and not the board's name or who wrote it (a name can be
//   sensitive, review #5550). `sealed` is the message's ciphertext ({v:2, epoch, iv, ct}) and mutable-content lets the
//   app's notification extension (ios/NotifyExtension) decrypt it on the phone and name the board from the app's own
//   list. Ciphertext that wouldn't fit APNs' 4 KB is left out: the phone shows "New message".
//   (Binding board, seq and author into the ciphertext, AAD, is Phase 2's v3 payload; not here.)
// - Any other board: who wrote, where, and the start of the message, as the app's local notifications say.

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

export type PushPayload =
  | { aps: { alert: { body: string }; sound: "default"; "mutable-content": 1 }; board: string; seq: number; sealed?: string }
  | { aps: { alert: { title: string; body: string }; sound: "default"; "thread-id": string }; board: string; seq: number; author: string; via: string | null; board_title: string };

const bytes = (p: unknown) => new TextEncoder().encode(JSON.stringify(p)).length;
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export function pushPayload(p: PushInput): PushPayload {
  if (p.board.encrypted) {
    const out: PushPayload = { aps: { alert: { body: "New message" }, sound: "default", "mutable-content": 1 }, board: p.board.id, seq: p.seq };
    if (p.sealed && bytes({ ...out, sealed: p.sealed }) <= APNS_MAX_BYTES) out.sealed = p.sealed;
    return out;
  }
  const via = p.via ?? null;
  const who = via === "agent" ? `${p.author}'s agent` : p.author;
  return {
    aps: { alert: { title: `${who} in ${cut(p.board.title, 80)}`, body: cut(String(p.text ?? "").replace(/\s+/g, " ").trim(), 180) }, sound: "default", "thread-id": p.board.id },
    board: p.board.id,
    seq: p.seq,
    author: p.author,
    via,
    board_title: p.board.title,
  };
}
