-- Cross-signed device lists (E2E design §2.2, Phase 1c). Each device also has an Ed25519 signing key; a person's later
-- device is signed by one of their existing devices when that device approves it. Other members' clients verify the
-- signature against the signer's key they pinned, so the server can't slip in a "device" for someone: it can't sign one.
-- Devices from before this (and the iPhone app until it adopts it) stay unsigned and keep the old rule: only their
-- owner's own devices hand them a board's key.

ALTER TABLE agent_keys ADD COLUMN sign_pub TEXT;
ALTER TABLE agent_keys ADD COLUMN signed_by TEXT;
ALTER TABLE agent_keys ADD COLUMN sig TEXT;
