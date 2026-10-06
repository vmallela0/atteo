import type { AgentCharter } from "./charter";
import type { EntryData } from "./entryData";
import type { Mention } from "./mentions";
import type { Flag } from "./screen";

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

/** Inbox kinds for the person only: agent tokens never see these rows (src/inbox.ts) or count them (src/registry.ts). */
export const PERSON_ONLY_KINDS = ["people_only", "manual_unread", "reminder", "report"] as const;

export const ENTRY_TYPES = ["claim", "question", "decision", "task", "artifact", "note", "change", "handoff"] as const;
// "approval" is posted by the server only (an agent's request_approval on a board), never by a client.
export type EntryType = (typeof ENTRY_TYPES)[number] | "approval";

/** What a board's approval entry carries (no details: those are the asking agent's person's alone). */
export interface ApprovalRef {
  id: string;
  user: string; // whose agent asked; only they decide
  status: "pending" | "approved" | "rejected" | "expired";
  title: string;
  tool: string | null;
  command: string | null;
  risk: "low" | "medium" | "high";
  expires_at: number;
  note: string | null;
  session: string | null; // the agent session that asked
  about: number | null; // the board message it's about (request_approval's seq), if any
  created_at: number;
  decided_at: number | null;
  requested_by?: string | null; // whose agent asked, when it isn't the user's own (a machine run, #4930)
}

/** One immutable entry in a board's log. Entries change only by later entries that resolve or supersede them. */
export interface Entry {
  seq: number;
  ts: number; // ms since epoch
  author: string;
  type: EntryType;
  text: string;
  edited_at?: number | null;
  purged?: { by: string; via: "agent" | "person" }; // its text was purged (a leaked secret), by whom; absent otherwise
  title?: string | null; // a 3–4 word summary from its author (for the sidebar and lists); absent on older entries
  to: string | null; // addressed member, or null for everyone
  mentions?: Mention[]; // people and agents @mentioned in the text; also addressed to them. Empty on older entries.
  reply_to: number | null; // a reply to a question also answers it
  resolves: number[]; // questions answered / tasks completed by this entry
  supersedes: number | null; // replaces an earlier entry (drops it from the summary)
  retracts: number | null; // withdraws an earlier entry (drops it from the summary; it stays in the log, marked retracted)
  via?: "agent" | "person" | null; // who actually wrote it: the member's agent (MCP/CLI) or the member themselves (web). Null on older entries.
  agent_name?: string; // read time only, never stored: what the author named their agent (agent posts, when they did)
  mention_names?: Record<string, string>; // read time only: owner → the name they gave their agent, for agents this entry mentions
  client?: string | null; // for agent posts: which agent, e.g. "Claude Code"
  artifact_name: string | null;
  artifact_size: number | null; // bytes of artifact content (content itself is fetched with `get`)
  artifact_version?: number | null;
  attachments?: Attachment[]; // file entries only: every file of the message, in order (1 for a single file, ≤10)
  rich_text?: { name: string; text: string; flag?: Flag }[]; // read/get/wait only: the words of its pasted RTF/RTFD files (vedu #5225, #5258), each screened like the text (#5275)
  media?: Media | null; // images: type, size in pixels (when known) and bytes; the image is served by /api/boards/:id/image // files are versioned documents: this entry published version N of artifact_name
  card?: import("./card").ChangeCard | null; // type=change: branch, PR, CI, commits, files (the diff is fetched with `get`)
  handoff?: import("./handoff").Handoff | null; // type=handoff: ready to gate (branch, sha, base, checks, state), or the lander's landed/failed reply
  handled_by?: string | null; // which agent took it ("vedu/scout"), when known
  done_by?: string | null; // which agent (or person) finished it
  ai_flag?: string | null; // set when the model check thinks it's trying to instruct agents
  truncated?: boolean; // read time only: a read's max_chars budget cut this text; get the seq for the rest
  human_decision?: import("./decisions").HumanDecision | null; // a person's decision: open until the people decide (decisions.ts)
  approval?: ApprovalRef | null; // type=approval: the request and its live status
  data?: EntryData; // optional JSON object attached at post time; absent when the post had none. Returned unchanged.
  // People-only (vedu #1264): only these people (author included) see it, signed in as themselves; never any agent.
  // Just mine (#1748): audience "own", to_people [the person]: only that person and their own agents see it.
  // Absent on every other entry. Replies and unsends of it inherit the same audience.
  audience?: "people" | "own";
  to_people?: string[];
}

/**
 * Who is asking, for what a board shows them: a person signed in as themselves (web, the Atteo app) or an agent
 * (a token, MCP, the CLI). null or absent means an agent, so anything that forgets to say sees the least.
 */
export interface Viewer {
  user: string;
  person: boolean;
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
  handoff?: unknown; // type=handoff: checked by parseReady, or parseResult in a reply to an open handoff
  depends_on?: number[]; // premises: if one is disputed or retracted, this entry is flagged stale
  session?: string | null; // the agent session that posts it (set by the Worker, never by the client)
  session_name?: string | null; // its name ("scout"): who "is on it" when the post takes the message it answers
  idem?: string | null; // the sender's id for this message (Idempotency-Key): a retry is stored once
  people_only?: boolean; // people-only: for to_people (and the author) only, never any agent (people on the web/app only)
  to_people?: string[]; // with people_only: the people it's for (board members, checked by the Worker)
  own?: boolean; // just mine: only the author (the person) and their own agents; people and agents both can post one
  data?: unknown; // optional JSON object stored with the entry (entryData.ts); omitted or null means none
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
  charter?: AgentCharter | null; // goal, data classes, retention: what agents are told (#3685; mirrored from D1)
}

export interface Env {
  BOARD: DurableObjectNamespace<import("./board").Board>;
  DB: D1Database;
  /** Optional R2 binding. Public /status probes it when set. Board files live in the Durable Object; the hosted Worker does not bind this. */
  FILES?: R2Bucket;
  ASSETS?: Fetcher; // wrangler.jsonc assets: mermaid.min.js (src/mermaid.ts mermaidResponse)
  PUBLIC_WRITES?: RateLimit; // wrangler.jsonc ratelimits: per-IP cap on signed-out endpoints that write or fan out (limits.ts publicAllowed)
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
  GITHUB_WEBHOOK_SECRET?: string; // secret: GitHub App webhook HMAC; unset: POST /github/webhook is 503. Never in wrangler.jsonc
  GITHUB_APP_ID?: string; // secret: GitHub App id for outbound Checks/comments. Unset: postGithubChange does not fetch. Never in wrangler.jsonc vars
  GITHUB_APP_PRIVATE_KEY?: string; // secret: GitHub App private key (PEM). Unset: outbound does not fetch. Never kept in D1 or wrangler.jsonc
  GITHUB_APP_INSTALLATION_ID?: string; // secret: optional install id so outbound can skip GET /repos/{repo}/installation. Never in wrangler.jsonc
  SENTRY_DSN?: string; // secret (so dev/CI never report): Sentry project DSN; absent in dev/CI, then Sentry is off
  POSTHOG_KEY?: string; // var: PostHog project API key (phc_…, public). Unset: the web analytics loader does nothing (src/analytics.ts, docs/ANALYTICS.md)
  POSTHOG_HOST?: string; // var: "eu" (default) or "us". Anything else leaves analytics off
  XAI_API_KEY?: string; // secret: xAI text-to-speech (POST /api/app/tts, src/tts.ts) and speech-to-speech client secrets (POST /api/app/voice/session, src/voice.ts); absent: both are off and clients use the device voice
  TTS_MONTHLY_CHARS?: string; // var: read-aloud characters per person per month (default 900,000)
  TTS_PER_MINUTE?: string; // var: read-aloud requests per person per minute (default 30)
  VOICE_GLOBAL_MONTHLY_MINUTES?: string; // var: live-voice minutes for everyone together per month (default 600 ≈ $30)
  TTS_GLOBAL_MONTHLY_CHARS?: string; // var: read-aloud characters for everyone together per month (default 2,000,000 ≈ $30)
  LIMITS_LOCAL?: string; // "1": a localhost server keeps the production request limits (src/limits.ts)
  BUGS_BOARD?: string; // var: the developers' bug board id (b_…); /api/bugs posts bug reports (web 🐞 button, iOS shake) there. Unset: the endpoint says it's not set up
  FEEDBACK_BOARD?: string; // var: where feedback about Atteo lands (POST /api/feedback, MCP feedback; vedu #4125). Unset: BUGS_BOARD
  OPERATORS?: string; // var: comma-separated usernames exempt from voice/read-aloud caps (vedu #1584)
  VOICE_MONTHLY_MINUTES?: string; // var: speech-to-speech minutes per person per month (default 180)
  VOICE_SESSION_MINUTES?: string; // var: one voice session's cap, charged up front and settled at the end (default 10)
  VOICE_PER_MINUTE?: string; // var: voice sessions a person may start per minute (default 12: a call standing by and resuming starts a new one each time)
  DEV_FAKE_VOICE?: string; // LOCAL .dev.vars ONLY, never wrangler.jsonc: "1" + no key + localhost + header x-dev-fake-voice: 1 → a fake voice provider (src/voice.ts) and a fake read-aloud one (src/tts.ts: silent WAV)
  APNS_KEY?: string; // secret: Apple push key (.p8) for the iOS app; absent until vedu sets up an Apple Developer account
  POSTS_PER_MINUTE?: string; // var: per-person post rate limit per board (default 60; CI raises it for the stress test)
  SIGNIN_PER_IP?: string; // var: app sign-in codes sent per IP per 10 minutes (default 30; verify gets twice that)
  DEV_FAKE_MAGIC?: string; // LOCAL .dev.vars ONLY, never wrangler.jsonc: "1" lets test emails sign in to the app with code 000000 on localhost (src/appSignin.ts)
  DEV_FAKE_CLOCK?: string; // LOCAL .dev.vars ONLY, never wrangler.jsonc: "1" + localhost + x-dev-now → test request time (src/util.ts)
  DEV_FAKE_NEAR_QUOTA?: string; // LOCAL .dev.vars ONLY, never wrangler.jsonc: "1" lets POST /api/ops/limits {nearQuota: true} fake load-shedding level 1 on localhost (src/limits.ts)
  DEV_FAKE_ADMIN?: string; // LOCAL .dev.vars ONLY, never wrangler.jsonc: "1" + localhost lets POST /api/ops/sessions { admin: true } mint an operator browser session for /_ops checks (src/auth.ts)
  CF_VERSION_METADATA?: { id: string; tag?: string; timestamp?: string }; // which deploy is serving (ship.sh waits for it)
  // Free-plan guardrails (src/limits.ts; INFRA-ASSESSMENT §4i). All optional vars; the defaults are in limits().
  RATE_AGENT_PER_MIN?: string; // var: requests per minute per agent token (default 600; per isolate)
  RATE_APP_PER_MIN?: string; // var: requests per minute per app/person token (default 1200)
  DAILY_REQUESTS_FREE?: string; // var: a person's non-wait requests per UTC day on Free (default 50,000; 0 = off)
  DAILY_REQUESTS_PRO?: string; // var: same on Pro (default 0 = unlimited)
  MAX_LIVE_SESSIONS?: string; // var: live agent sessions per person (default 25; 0 = no cap)
  SHED_L1_REQUESTS?: string; // var: Worker requests today (our count) that start load-shedding level 1 (default 1,500,000)
  SHED_L2_REQUESTS?: string; // var: … level 2: non-essential agent writes refused (default 3,000,000)
  SHED_L1_D1_ROWS_READ?: string; // var: D1 rows read today for level 1 (default 1,000,000,000; needs CF_ACCOUNT_ID + CF_API_TOKEN)
  SHED_L2_D1_ROWS_READ?: string; // var: … for level 2 (default 2,000,000,000)
  CF_ACCOUNT_ID?: string; // var: optional, for the cron to read D1 usage from Cloudflare's GraphQL analytics
  CF_API_TOKEN?: string; // secret: optional, Account Analytics:Read token for the same
  CF_ANALYTICS_TOKEN?: string; // secret: Account Analytics:Read token for the cost guard (src/costGuard.ts); falls back to CF_API_TOKEN
  COST_SOFT_ROWS_READ?: string; // var: rows read today (D1 + Durable Object SQL) that post a cost alert (default 500,000,000)
  COST_HARD_ROWS_READ?: string; // var: … that trip the cost cap: waits, search, grep, exports answer 503 (default 3,000,000,000)
  COST_SOFT_ROWS_WRITTEN?: string; // var: rows written today (D1 + Durable Object SQL) for an alert (default 5,000,000)
  COST_HARD_ROWS_WRITTEN?: string; // var: … for the cap (default 25,000,000)
  COST_SOFT_DO_REQUESTS?: string; // var: Durable Object requests today for an alert (default 2,000,000)
  COST_HARD_DO_REQUESTS?: string; // var: … for the cap (default 10,000,000)
  // Nightly backups outside Cloudflare (src/backup.ts, docs/BACKUPS.md): off until the public key and all BACKUP_S3_* but the optional ones are set.
  A2A_SIGNING_KEY?: string; // secret: the Agent Card's ES256 private key (JWK, from scripts/a2a-key.mjs); unset: the card is served unsigned. Never kept in D1
  BACKUP_PUBLIC_KEY?: string; // var: X25519 public key (base64, from scripts/backup.mjs keygen); the private key stays offline
  BACKUP_S3_ENDPOINT?: string; // var: S3-compatible endpoint outside Cloudflare, e.g. https://s3.us-west-004.backblazeb2.com
  BACKUP_S3_BUCKET?: string; // var
  BACKUP_S3_REGION?: string; // var (default us-east-1)
  BACKUP_S3_PREFIX?: string; // var (default "atteo/")
  BACKUP_S3_VIRTUAL_HOST?: string; // var: "1" for bucket.host/key URLs instead of host/bucket/key
  BACKUP_S3_KEY_ID?: string; // secret: a write-only application key
  BACKUP_S3_SECRET?: string; // secret
  BACKUP_HOUR?: string; // var: UTC hour the night's backup starts (default 3)
  BACKUP_BATCH?: string; // var: boards per 5-minute cron run (default 20)
  BACKUP_BLOB_PART_BYTES?: string; // var: a board's files are backed up in parts of about this many bytes (default 8,000,000)
  BACKUP_ALERT_HOURS?: string; // var: hours after the start with no manifest before it's reported (default 6)
  BACKUP_RESTORE?: string; // "1" allows POST /api/ops/restore-board off localhost (disaster recovery only)
}
