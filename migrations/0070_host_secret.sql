-- atteo host (#4939): each registered machine gets its own secret, shown once to the daemon; only its hash is kept. The
-- host's own endpoints (next, result) need it, so no other token of the owner can take approved runs or fake results.
ALTER TABLE hosts ADD COLUMN secret_hash TEXT;
