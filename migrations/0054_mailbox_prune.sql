-- Cron sweep deletes acked mailbox rows older than 30 days (agent_seen_at < now - 30d).
CREATE INDEX IF NOT EXISTS notifications_agent_seen_at ON notifications (agent_seen_at) WHERE agent_seen_at IS NOT NULL;
