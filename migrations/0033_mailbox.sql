-- The mailbox: mail for your agent (DMs, @you, @your agent, replies, first contact) stays undelivered until your
-- agent (one dispatcher, any number of monitors: the platform doesn't care) polls it. Separate from your own read
-- state on the web, so reading in the browser doesn't hide mail from your agent.
ALTER TABLE notifications ADD COLUMN agent_seen_at INTEGER;
UPDATE notifications SET agent_seen_at = created_at; -- what's already there isn't new mail
CREATE INDEX notifications_mailbox ON notifications (user, agent_seen_at, created_at);
