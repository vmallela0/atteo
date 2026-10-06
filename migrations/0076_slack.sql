-- The Slack bridge (vedu #5401; design: board #5405, docs/SLACK.md). A board is carried into Slack channels: questions,
-- approvals and handoffs as their own messages, the rest in one rolling digest per channel, and Slack thread replies
-- posted on the board as the person who wrote them. Board text is never stored here, only which Slack message is which entry.

-- One row per Slack workspace the app is installed in. The bot token is encrypted at rest (AES-GCM, SLACK_TOKEN_KEY);
-- NULL once the app is uninstalled or the token revoked (revoked_at). created_by: the Atteo person who installed it.
CREATE TABLE slack_installs (
  team_id TEXT PRIMARY KEY,
  enterprise_id TEXT,
  team_name TEXT NOT NULL,
  bot_user_id TEXT NOT NULL,
  bot_token TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

-- A board followed by a channel. One board per channel (a Slack Connect channel has one id across companies, so a
-- second link to it is refused); one board may be in several channels. lane: 'decisions' (questions, approvals,
-- handoffs, what names a linked person; the rest in the digest) or 'everything'. paused: why posting stopped
-- ('archived', 'removed', 'disconnected', 'shared' until the owner confirms), NULL while live.
CREATE TABLE slack_links (
  channel_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  channel_name TEXT NOT NULL,
  board_id TEXT NOT NULL,
  lane TEXT NOT NULL DEFAULT 'decisions',
  shared INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  paused TEXT,
  audience_at INTEGER,
  -- the rolling digest: the current message (ts, when it started, what it says so far) and what's waiting for it
  digest_ts TEXT,
  digest_since INTEGER,
  digest_n INTEGER NOT NULL DEFAULT 0,
  digest_agents TEXT,
  pending_n INTEGER NOT NULL DEFAULT 0,
  pending_agents TEXT,
  pending_latest TEXT,
  pending_flagged INTEGER NOT NULL DEFAULT 0,
  pending_missed INTEGER NOT NULL DEFAULT 0,
  flushed_at INTEGER
);
CREATE INDEX slack_links_board ON slack_links (board_id);
CREATE INDEX slack_links_team ON slack_links (team_id);

-- A Slack person ↔ an Atteo person, made only on a signed-in Atteo page (or by installing the app, which proves both).
CREATE TABLE slack_people (
  team_id TEXT NOT NULL,
  slack_user TEXT NOT NULL,
  enterprise_id TEXT,
  user TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, slack_user)
);
CREATE INDEX slack_people_user ON slack_people (user);

-- Single-use, 10-minute nonces: 'install' (OAuth state), 'pick' (the channel picker), 'person' (linking a Slack person).
CREATE TABLE slack_nonces (
  nonce TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  user TEXT,
  board_id TEXT,
  team_id TEXT,
  slack_user TEXT,
  slack_name TEXT,
  enterprise_id TEXT,
  expires_at INTEGER NOT NULL
);

-- Which Slack message is which board entry, per channel: a retry edits instead of posting again, replies thread under
-- their root, and an edit or unsend updates the message.
CREATE TABLE slack_messages (
  channel_id TEXT NOT NULL,
  board_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts TEXT NOT NULL,
  team_id TEXT NOT NULL,
  PRIMARY KEY (channel_id, board_id, seq)
);
CREATE INDEX slack_messages_ts ON slack_messages (channel_id, ts);

-- An approval's DM to its owner, per workspace, so the decision updates it (and its buttons go away).
CREATE TABLE slack_dms (
  approval_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  channel_id TEXT,
  ts TEXT,
  PRIMARY KEY (approval_id, team_id)
);

-- Inbound dedupe: Slack event ids, interaction ids and thread replies (channel:ts → the entry it became), kept an hour.
CREATE TABLE slack_seen (
  key TEXT PRIMARY KEY,
  seq INTEGER,
  at INTEGER NOT NULL
);

-- How a decision was made, for the audit trail: NULL (the web or the app) or "slack:<team>/<user>".
ALTER TABLE approvals ADD COLUMN decided_via TEXT;
