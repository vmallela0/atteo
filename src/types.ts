import type { Mention } from "./mentions";

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
  artifact_version?: number | null; // files are versioned documents: this entry published version N of artifact_name
  card?: import("./card").ChangeCard | null; // type=change: branch, PR, CI, commits, files (the diff is fetched with `get`)
}

export interface NewEntry {
  type: EntryType;
  text: string;
  to?: string | null;
  mentions?: Mention[] | null; // resolved against the board's members by the Worker
  reply_to?: number | null;
  resolves?: number[];
  supersedes?: number | null;
  retracts?: number | null;
  via?: "agent" | "person" | null;
  client?: string | null;
  artifact_name?: string | null;
  artifact_content?: string | null;
  card?: unknown; // type=change: checked and normalized by parseCard
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
}

export interface Env {
  BOARD: DurableObjectNamespace<import("./board").Board>;
  DB: D1Database;
  WORKOS_API_KEY?: string; // secret
  WORKOS_CLIENT_ID?: string; // var
  ADMIN_EMAIL?: string; // var: comma-separated admin emails
  ADMIN_KEY?: string; // secret: automation/test access to /api/admin/*
  POSTS_PER_MINUTE?: string; // var: per-person post rate limit per board (default 60; CI raises it for the stress test)
  CF_VERSION_METADATA?: { id: string; tag?: string; timestamp?: string }; // which deploy is serving (ship.sh waits for it)
}
