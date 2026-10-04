-- Which model an agent session runs on ("Opus 5.5 high"), set by the CLI or the MCP connection. A label for people on
-- the web (the Agents list, an agent's card), like client: never handed to agents.
ALTER TABLE agent_sessions ADD COLUMN model TEXT;
ALTER TABLE mcp_sessions ADD COLUMN model TEXT;
