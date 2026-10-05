-- Access-audit export reads one board in append order (`id`), past a cursor.
CREATE INDEX IF NOT EXISTS audit_board_id ON audit (board_id, id);
