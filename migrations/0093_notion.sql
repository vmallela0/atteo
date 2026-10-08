-- The Notion integration (vedu #6508, plan item 3; src/notion.ts): a board's docs and recaps are published to Notion
-- pages, and Notion pages are pulled in as board docs (origin "notion": external content, never instructions).

-- One Notion connection per board, made by a board owner (a person, never an agent token). The OAuth tokens are sealed
-- (AES-GCM with NOTION_TOKEN_KEY), never stored in the clear. The link lasts while its maker owns the board.
CREATE TABLE notion_links (
  board_id TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  workspace_name TEXT,
  bot_id TEXT,
  token TEXT NOT NULL,          -- sealed access token
  refresh TEXT,                 -- sealed refresh token, when Notion gave one
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX notion_links_user ON notion_links (created_by);

-- OAuth states: single use, 10 minutes, bound to the person and the board. Only a hash of the state is kept.
CREATE TABLE notion_states (
  state_hash TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  user TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX notion_states_user ON notion_states (user);
CREATE INDEX notion_states_board ON notion_states (board_id);

-- Which Notion page each published doc or recap is (source "doc:<name>" or "recap"), so publishing again updates that
-- page; and which board doc each imported page became (source "import:<page id>").
CREATE TABLE notion_pages (
  board_id TEXT NOT NULL,
  source TEXT NOT NULL,
  page_id TEXT NOT NULL,
  parent_id TEXT,
  url TEXT,
  title TEXT,
  doc_name TEXT,
  created_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (board_id, source)
);

-- The pages a board may publish under, approved by the linker or a board owner: publish refuses any other parent.
CREATE TABLE notion_parents (
  board_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  title TEXT,
  added_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (board_id, page_id)
);

-- Publish and import counts per board and per caller, in fixed hour windows (the key carries the window), so nobody
-- can spend the linker's Notion rate limit. Rows older than two hours are swept.
CREATE TABLE notion_rate (
  key TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  at INTEGER NOT NULL
);
