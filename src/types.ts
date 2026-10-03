import type { Mention } from "./mentions";

export interface Media {
  mime: string;
  w: number | null;
  h: number | null;
  size: number;
}

/**
 * One file of a file entry (type "artifact"). Every file entry has at least one; a message with several files (up to
 * 10, see POST /api/boards/:id/upload) lists them in the order they were sent. Each file is version `version` of the
 * board file `name`, fetched from GET /api/boards/:id/image?name=…&version=… (images inline, anything else as a download).
 * `mime` is the sniffed type for images and binaries, "text/plain" for text files. `w`/`h` only for images whose size is known.
 */
export interface Attachment {
  name: string;
  mime: string;
  size: number;
  w?: number;
  h?: number;
  version: number | null;
}

export const ENTRY_TYPES = ["claim", "question", "decision", "task", "artifact", "note", "change"] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

/** One immutable entry in a board's log. Entries change only by later entries that resolve or supersede them. */
export interface Entry {
  seq: number;
  ts: number; // ms since epoch
  author: string;
  type: EntryType;
  text: string;
  title?: string | null; // a 3–4 word summary from its author (for the sidebar and lists); absent on older entries
  to: string | null; // addressed member, or null for everyone
  mentions?: Mention[]; // people and agents @mentioned in the text; also addressed to them. Empty on older entries.
  reply_to: number | null; // a reply to a question also answers it
  resolves: number[]; // questions answered / tasks completed by this entry
  supersedes: number | null; // replaces an earlier entry (drops it from the summary)
  retracts: number | null; // withdraws an earlier entry (drops it from the summary; it stays in the log, marked retracted)
  via?: "agent" | "person" | null; // who actually wrote it: the member's agent (MCP/CLI) or the member themselves (web). Null on older entries.
  client?: string | null; // for agent posts: which agent, e.g. "Claude Code"
  artifact_name: string | null;
  artifact_size: number | null; // bytes of artifact content (content itself is fetched with `get`)
  artifact_version?: number | null;
  attachments?: Attachment[]; // file entries only: every file of the message, in order (1 for a single file, ≤10)
  media?: Media | null; // images: type, size in pixels (when known) and bytes; the image is served by /api/boards/:id/image // files are versioned documents: this entry published version N of artifact_name
  card?: import("./card").ChangeCard | null; // type=change: branch, PR, CI, commits, files (the diff is fetched with `get`)
  handled_by?: string | null; // which agent took it ("vedu/scout"), when known
  done_by?: string | null; // which agent (or person) finished it
  ai_flag?: string | null; // set when the model check thinks it's trying to instruct agents
  human_decision?: import("./decisions").HumanDecision | null; // a person's decision: open until the people decide (decisions.ts)
}

export interface NewEntry {
  type: EntryType;
  text: string;
  title?: string | null; // 2–5 words for lists and summaries (agents set it; the web derives one)
  to?: string | null;
  mentions?: Mention[] | null; // resolved against the board's members by the Worker
  reply_to?: number | null; // 0: top level on purpose (an agent's answer is otherwise threaded, see Board.autoThread)
  resolves?: number[];
  supersedes?: number | null;
  retracts?: number | null;
  via?: "agent" | "person" | null;
  client?: string | null;
  artifact_name?: string | null;
  artifact_content?: string | null;
  card?: unknown; // type=change: checked and normalized by parseCard
  depends_on?: number[]; // premises: if one is disputed or retracted, this entry is flagged stale
  session?: string | null; // the agent session that posts it (set by the Worker, never by the client)
  idem?: string | null; // the sender's id for this message (Idempotency-Key): a retry is stored once
}

export interface Member {
  name: string;
  cursor: number; // last seq this member has read
  joined_at: number;
  last_seen: number;
}

export interface BoardInfo {
  id: string;
  title: string;
  created_by: string;
  created_at: number;
  entry_count: number;
  last_seq: number;
  archived?: boolean; // read-only until restored
  encrypted?: boolean; // end-to-end encrypted: messages are ciphertext only (read/write with the CLI)
}

export interface Env {
  BOARD: DurableObjectNamespace<import("./board").Board>;
  DB: D1Database;
  WORKOS_API_KEY?: string; // secret
  WORKOS_CLIENT_ID?: string; // var
  ADMIN_EMAIL?: string; // var: comma-separated admin emails
  ADMIN_KEY?: string; // secret: automation/test access to /api/admin/*
  AI_ACCOUNT_ID?: string; // secret: Workers AI over REST (injection screening); absent in dev/CI, then screening is skipped
  AI_TOKEN?: string; // secret
  STRIPE_SECRET_KEY?: string; // secret
  PUBLIC_URL?: string; // var: the public address (https://atteo.dev) for every link back to the product; see publicOrigin in util.ts
  ALLOW_LOCAL_WEBHOOKS?: string; // dev/CI only: allow http://localhost webhook URLs and the test sink
  STRIPE_WEBHOOK_SECRET?: string; // secret
  SENTRY_DSN?: string; // secret (so dev/CI never report): Sentry project DSN; absent in dev/CI, then Sentry is off
  APNS_KEY?: string; // secret: Apple push key (.p8) for the iOS app; absent until vedu sets up an Apple Developer account
  POSTS_PER_MINUTE?: string; // var: per-person post rate limit per board (default 60; CI raises it for the stress test)
  SIGNIN_PER_IP?: string; // var: app sign-in codes sent per IP per 10 minutes (default 30; verify gets twice that)
  DEV_FAKE_MAGIC?: string; // LOCAL .dev.vars ONLY, never wrangler.jsonc: "1" lets test emails sign in to the app with code 000000 on localhost (src/appSignin.ts)
  CF_VERSION_METADATA?: { id: string; tag?: string; timestamp?: string }; // which deploy is serving (ship.sh waits for it)
}
