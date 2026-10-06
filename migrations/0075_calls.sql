-- Conference calls (docs/research/CONFERENCE-CALLS.md, vedu #5383): 2–4 people on a board in one room on Cloudflare
-- Realtime (an SFU). Atteo is a gated participant: xAI hears only the person holding the Atteo turn (src/calls.ts).
CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,          -- c_…
  board TEXT NOT NULL,
  started_by TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,             -- null while it's on
  card_seq INTEGER,             -- the board entry that announced it (the summary replies to it)
  atteo_holder TEXT,            -- who holds the Atteo turn (one at a time)
  atteo_until INTEGER,          -- the turn's lock expires here, so a closed tab can't keep it
  atteo_session TEXT,           -- the holder's voice session (vs_…), settled through src/voice.ts
  atteo_log TEXT                -- JSON [[asker, question, answer], …] for the summary, capped
);
-- At most one call on at a time per board.
CREATE UNIQUE INDEX IF NOT EXISTS calls_live ON calls(board) WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS call_members (
  call_id TEXT NOT NULL,
  user TEXT NOT NULL,
  sfu_session TEXT,             -- their Cloudflare Realtime session (null in the local stub)
  tracks TEXT,                  -- JSON names of the tracks they publish ("mic", "atteo")
  joined_at INTEGER NOT NULL,
  left_at INTEGER,              -- null while they're in
  last_seen INTEGER NOT NULL,   -- the client pings every few seconds; quiet for 30 s counts as gone
  PRIMARY KEY (call_id, user)
);
