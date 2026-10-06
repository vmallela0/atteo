-- startDeviceLogin forgets logins that ended more than a day ago
-- (DELETE FROM device_logins WHERE expires_at < ?). Without an index that is a
-- full scan of device_logins on every POST /api/device/start. The table is small
-- today (docs/CLOUDFLARE_HARDENING.md: ~240 rows) but the index is free insurance.
CREATE INDEX IF NOT EXISTS device_logins_expires_at ON device_logins (expires_at);
