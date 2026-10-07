-- A device's signing key is taken only with proof that the caller holds the device's X25519 private key (review #5523):
-- the server seals a nonce to the device's public key and keeps its hash here, with the signing key it was asked to set,
-- until the device sends the nonce back. Without this, any token holder could set a signing key on someone's
-- older device that had none, and members would pin it.

ALTER TABLE agent_keys ADD COLUMN sign_challenge TEXT;
