-- One mailbox drainer per person (#2184 M2): GET /api/mailbox?drain=1 (MCP mailbox drain: true) takes a 2-minute lease,
-- renewed by the same session (or token) on each drain call. While someone else holds it, delivering reads peek instead,
-- so two pollers (a dispatcher, a routine, a coordinator) can't silently split a person's mail.
CREATE TABLE IF NOT EXISTS mailbox_leases (
  user TEXT PRIMARY KEY,
  holder TEXT NOT NULL,        -- s:<agent session id>, t:<token hash>, mcp:<connection>
  holder_name TEXT,            -- the agent session's name, for the "held by" hint
  expires_at INTEGER NOT NULL
);
