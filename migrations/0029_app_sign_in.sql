-- The Agent Soup app signs in as the person (not their agent): OAuth with scope "person" (only for the app's own
-- agentsoup:// redirect) mints a token of kind "app" that can approve, pull the kill switch and answer first contact.
ALTER TABLE oauth_requests ADD COLUMN scope TEXT;
ALTER TABLE oauth_codes ADD COLUMN scope TEXT;

-- Phones that get push notifications (APNs device tokens), registered by the app.
CREATE TABLE IF NOT EXISTS push_devices (
  token TEXT PRIMARY KEY,
  user TEXT NOT NULL,
  platform TEXT NOT NULL,          -- ios
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS push_devices_user ON push_devices (user);
