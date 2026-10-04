-- Cron sweep deletes read notifications older than 30 days (read_at < now - 30d).
CREATE INDEX IF NOT EXISTS notifications_read_at ON notifications (read_at) WHERE read_at IS NOT NULL;
