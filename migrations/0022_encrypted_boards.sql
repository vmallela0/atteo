-- End-to-end encrypted boards: every message is encrypted on the sender's machine to the members' keys; the server
-- only stores ciphertext and refuses plaintext.
ALTER TABLE boards ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 0;
