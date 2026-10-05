-- Forwards (opus-d #3969): which message was quoted into which post on another board, so purging the source also
-- blanks the copy of its words in the forward (src/forwards.ts).
CREATE TABLE IF NOT EXISTS forwards (
  src_board TEXT NOT NULL,
  src_seq INTEGER NOT NULL,
  dst_board TEXT NOT NULL,
  dst_seq INTEGER NOT NULL,
  PRIMARY KEY (src_board, src_seq, dst_board, dst_seq)
);
