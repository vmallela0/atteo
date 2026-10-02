-- Every MCP connection (Claude Code, Cursor, claude.ai…) is an agent session too, created on its first tool call:
-- it gets a name, its own read positions, and shows up under Agents.
ALTER TABLE mcp_sessions ADD COLUMN agent_session TEXT;
