-- Which agent client (e.g. Claude Code, Cursor) each MCP session belongs to, from its initialize request.
ALTER TABLE mcp_sessions ADD COLUMN client TEXT;
