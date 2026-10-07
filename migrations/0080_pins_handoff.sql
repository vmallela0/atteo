-- Review #5567: when one of your devices approves another, it hands it the pins it holds (the devices it trusts, per
-- person), sealed to the new device's X25519 key and signed by the approver. The server keeps only that ciphertext.
ALTER TABLE agent_keys ADD COLUMN pins TEXT;
