-- Organization policies, by email domain (set by operators): e.g. people at acme.com must sign in with their SSO.
CREATE TABLE IF NOT EXISTS org_policies (
  domain TEXT PRIMARY KEY,         -- e.g. acme.com
  require_sso INTEGER NOT NULL DEFAULT 0,
  max_retention_days INTEGER,      -- boards they create keep messages at most this long
  allow_outside_members INTEGER NOT NULL DEFAULT 1, -- boards they create can include people from other domains
  updated_at INTEGER NOT NULL
);
