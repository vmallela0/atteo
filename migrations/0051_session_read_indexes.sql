-- D1 read cost (#1495): the hottest queries scanned whole session tables on every call
-- (~2.5M + ~1M + ~0.7M rows/day of a 5M/day Free cap). Partial/compound indexes so they read only live rows.
-- "SELECT boards FROM agent_sessions WHERE ended_at IS NULL AND last_seen > ?" and the kind='main' variant
CREATE INDEX IF NOT EXISTS agent_sessions_live ON agent_sessions (last_seen) WHERE ended_at IS NULL;
-- "SELECT user, MAX(last_seen) FROM mcp_sessions WHERE board_id = ? AND last_seen > ? GROUP BY user"
CREATE INDEX IF NOT EXISTS mcp_sessions_board_seen ON mcp_sessions (board_id, last_seen);
