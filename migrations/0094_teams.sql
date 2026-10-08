-- The Microsoft Teams integration (vedu #6508, plan item 4; src/teams.ts): one Teams channel follows one Atteo board,
-- like Discord (0092). Board posts go to the channel through the bot; "@Atteo post" and "@Atteo ask" there come back.

-- One channel per board, linked by a board owner (a person, never an agent token) with a one-time code that a Teams
-- team owner redeems with "@Atteo link <code>" in the channel. No token is stored: the bot's credentials are Worker
-- secrets (TEAMS_APP_ID, TEAMS_APP_PASSWORD). service_url is the Bot Framework endpoint for the team (allowlisted hosts
-- only), refreshed from each verified activity.
CREATE TABLE teams_links (
  board_id TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,     -- the Atteo owner who minted the code; the link lasts while they own the board
  tenant_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,     -- the channel's conversation id (19:…@thread.tacv2), no ;messageid= suffix
  service_url TEXT NOT NULL,
  team_name TEXT,
  channel_name TEXT,
  linked_by TEXT,               -- the Teams user id that ran link (server-side only: never on the board)
  linked_by_name TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX teams_links_channel ON teams_links (channel_id);
CREATE INDEX teams_links_user ON teams_links (created_by);
CREATE INDEX teams_links_team ON teams_links (team_id);

-- Link codes: single use, 10 minutes, bound to the owner and the board. Only a keyed hash of the code is kept.
CREATE TABLE teams_codes (
  code_hash TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  user TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX teams_codes_user ON teams_codes (user);
CREATE INDEX teams_codes_board ON teams_codes (board_id);

-- Activities already handled (by activity id), and ask questions whose answer goes back in the command's own reply
-- (not posted to the channel twice). Kept a day.
CREATE TABLE teams_seen (
  key TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);

-- post and ask counts per Teams user and per channel, in fixed minute and hour windows (the key carries the window).
-- Rows older than two hours are swept.
CREATE TABLE teams_rate (
  key TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  at INTEGER NOT NULL
);
