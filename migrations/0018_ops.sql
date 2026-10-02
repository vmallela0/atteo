-- Operations: daily usage counters (the PRD's metrics) and grouped server errors (no external error tracker needed).
CREATE TABLE IF NOT EXISTS usage_daily (
  day TEXT NOT NULL,             -- YYYY-MM-DD (UTC)
  metric TEXT NOT NULL,          -- posts | active_person | active_agent | agent_client
  key TEXT NOT NULL,             -- e.g. via (posts), a user (active_*), a client name
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, metric, key)
);
CREATE TABLE IF NOT EXISTS errors (
  key TEXT PRIMARY KEY,          -- route + message
  route TEXT NOT NULL,
  message TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL
);
