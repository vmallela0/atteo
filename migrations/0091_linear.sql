-- The Linear integration (vedu #6508; src/linear.ts): a board's tasks become issues in one Linear team, and status
-- changes and comments on those issues come back to the board.

-- One Linear connection per board, made by a member (a person, never an agent token). The OAuth tokens are sealed
-- (AES-GCM with LINEAR_TOKEN_KEY), never stored in the clear. team_id stays NULL until the person picks a team; until
-- then nothing syncs.
CREATE TABLE linear_links (
  board_id TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,
  org_id TEXT NOT NULL,
  org_name TEXT,
  linear_user TEXT,            -- the Linear user the token acts as: its own comments aren't brought back to the board
  token TEXT NOT NULL,         -- sealed access token
  refresh TEXT,                -- sealed refresh token, when Linear gave one
  expires_at INTEGER,          -- when the access token runs out (ms), when Linear said
  team_id TEXT,
  team_key TEXT,
  team_name TEXT,
  project_id TEXT,
  project_name TEXT,
  states TEXT,                 -- JSON [{id, name, type, position}]: the team's workflow states
  blocked_label TEXT,          -- the team's "blocked" label id, if it has one
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX linear_links_user ON linear_links (created_by);

-- Which Linear issue each board task is. synced: a hash of the title and description last sent; state_type: the
-- Linear state type last sent or seen (backlog, unstarted, started, completed, canceled), so neither side echoes.
CREATE TABLE linear_issues (
  board_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  issue_id TEXT NOT NULL,
  identifier TEXT,
  url TEXT,
  synced TEXT,
  state_type TEXT,
  blocked INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (board_id, seq)
);
CREATE UNIQUE INDEX linear_issues_issue ON linear_issues (issue_id);

-- Webhook deliveries already handled, and comments Atteo itself made (not brought back). Kept a day.
CREATE TABLE linear_seen (
  key TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
