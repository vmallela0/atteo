// What atteo read prints from an end-to-end encrypted board (#5542): decrypted on this machine, but a member's writing.
// Kept apart from commands.ts so its tests can import it alone.

import { flagNote, screenText } from "../../src/screen";
import { proseForAgent } from "../../src/util";

/** A message's structured parts, encrypted beside its text as the envelope's `x` (docs/SPEC.md §16): older clients read the text alone. */
export type SealedExtras = { xv?: 1; title?: string; files?: SealedFileRef[] };
export type SealedFileRef = { id: string; name: string; mime: string; size: number; key: string; chunk: number; w?: number; h?: number };

const oneLine = (t: string) => t.replace(/\s+/g, " ").trim();
export const fmtSize = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`);
/** A decrypted message for an agent, written like a plain board's: every member-written field (text, title, file names)
 *  stays indented under its header line, so none can pass for another entry's header; the screen's verdict is on the
 *  header. Callers fence the result (#5542). */
export const encLine = (e: { seq: number; ts: number; author: string; via: string | null; type: string; to: string | null; reply_to: number | null; text: string; edited_at?: number | null; extras?: SealedExtras }) => {
  const one = (s: unknown, max = 200) => oneLine(proseForAgent(String(s ?? ""))).slice(0, max);
  const files = (e.extras?.files ?? []).map((f) => `\n    📎 ${one(f.name)} (${fmtSize(Number(f.size) || 0)})`).join("");
  const title = e.extras?.title ? `${one(e.extras.title)}: ` : "";
  const text = proseForAgent(String(e.text ?? "")).replace(/\r\n?|[\u2028\u2029\u0085\v\f]/g, "\n");
  const flag = screenText([e.extras?.title ?? "", text, ...(e.extras?.files ?? []).map((f) => String(f.name ?? ""))].join("\n"));
  return `#${e.seq} ${e.type} · ${e.via === "agent" ? `${e.author}'s agent` : e.author}${e.to ? ` → ${e.to}` : ""}${e.reply_to ? ` · re #${e.reply_to}` : ""} · ${new Date(e.ts).toISOString().slice(0, 16).replace("T", " ")}Z${e.edited_at ? " · edited" : ""}${flag ? ` · ⚠ ${flagNote(flag)}` : ""}\n    ${title}${text.replace(/\n/g, "\n    ")}${files}${files ? `\n    (atteo download ${e.seq} saves ${e.extras!.files!.length === 1 ? "it" : "them"}, decrypted on this machine)` : ""}`;
};

/** A sealed file id as the server issues them; anything else (a path, a query) is never fetched or written (#5542). */
export const SEALED_FILE_ID = /^sf_[a-z0-9]{1,40}$/;

/** Extras are a member's writing like the text: a string title, and only well-formed file references (a server-issued
 *  id, a key, a whole size) are kept. */
export function cleanExtras(x: unknown): SealedExtras {
  const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
  const files = Array.isArray(o.files)
    ? (o.files as SealedFileRef[]).filter((f) => !!f && SEALED_FILE_ID.test(String(f.id)) && typeof f.key === "string" && typeof f.name === "string" && Number.isInteger(f.size) && f.size >= 0)
    : [];
  return { ...(typeof o.title === "string" && o.title ? { title: o.title } : {}), ...(files.length ? { files } : {}) };
}

