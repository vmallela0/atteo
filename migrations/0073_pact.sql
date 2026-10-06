-- PACT (docs/PACT.md): a person's agent reaching a business's agent over A2A.
-- Providers we've registered with: the interface origin and the audience (aud) that provider assigned us.
-- Added by hand (docs/PACT.md), never from a request.
CREATE TABLE IF NOT EXISTS pact_providers (
  origin TEXT PRIMARY KEY,   -- https://provider.example.com: where its interface URLs live
  audience TEXT NOT NULL,    -- the JWT aud it told us to use
  name TEXT,
  added_at INTEGER NOT NULL
);

-- The opaque id (JWT sub) each provider sees for a person: random, one per person per provider, so providers can't
-- link a person across each other, and it survives a signing-key rotation.
CREATE TABLE IF NOT EXISTS pact_subjects (
  user TEXT NOT NULL,
  provider TEXT NOT NULL,
  sub TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user, provider)
);

-- One conversation (A2A contextId) per person per brand interface.
CREATE TABLE IF NOT EXISTS pact_contexts (
  user TEXT NOT NULL,
  interface_url TEXT NOT NULL,
  context_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user, interface_url)
);

-- Each approval sends once: the approval id is spent when the message goes out.
CREATE TABLE IF NOT EXISTS pact_sends (
  approval_id TEXT PRIMARY KEY,
  user TEXT NOT NULL,
  interface_url TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  status INTEGER
);
