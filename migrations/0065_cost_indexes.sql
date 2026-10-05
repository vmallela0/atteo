-- Cost guard (vedu #4340): indexes for the queries that read the most D1 rows in production (Cloudflare GraphQL
-- d1QueriesAdaptiveGroups, Oct 3–5). See docs/COSTS.md for the before/after numbers.

-- The inbox lists (web inbox, For you, the app) sort a person's notifications newest first and take a page. With only
-- (user, read_at, created_at) the planner read every notification the person has and sorted them (1,750–2,700 rows a
-- call in prod); walking (user, created_at) backwards stops after the page.
CREATE INDEX IF NOT EXISTS notifications_user_created ON notifications (user, created_at);

-- Pending invitations by address are looked up as lower(email) = lower(?), which can't use invites_by_email.
CREATE INDEX IF NOT EXISTS invites_email_lower ON invites (lower(email));

-- The retention cron lists boards that set a retention: a small partial index instead of a scan of every board.
CREATE INDEX IF NOT EXISTS boards_retention ON boards (retention_days) WHERE retention_days IS NOT NULL;

-- The cost guard's switch (src/costGuard.ts): one row. The cron sets capped_at past a hard cap; an operator clears it on
-- /_ops. While it's set, long-poll waits, search, grep and exports answer 503.
CREATE TABLE IF NOT EXISTS cost_guard (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  capped_at INTEGER,
  reason TEXT,
  cleared_at INTEGER,
  cleared_by TEXT
);
