-- The Discord integration (vedu #6508, plan #6509 item 2; src/discord.ts): one Discord channel follows one Atteo board.
-- Board posts go to the channel through the bot; /atteo post and /atteo ask in the channel come back to the board.

-- One channel per board, linked by a board owner (a person, never an agent token) with a one-time code redeemed by
-- /atteo link in that channel. No token is stored: the bot's token is a Worker secret (DISCORD_BOT_TOKEN).
CREATE TABLE discord_links (
  board_id TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,     -- the Atteo owner who minted the code; the link lasts while they own the board
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  linked_by TEXT,               -- the Discord user id that ran /atteo link
  linked_by_name TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX discord_links_channel ON discord_links (channel_id);
CREATE INDEX discord_links_user ON discord_links (created_by);
CREATE INDEX discord_links_guild ON discord_links (guild_id);

-- Link codes: single use, 10 minutes, bound to the owner and the board. Only a hash of the code is kept.
CREATE TABLE discord_codes (
  code_hash TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  user TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX discord_codes_user ON discord_codes (user);
CREATE INDEX discord_codes_board ON discord_codes (board_id);

-- Interactions already handled (a hash of the signed body), and /atteo ask questions whose answer goes back in the
-- command's own reply (not posted to the channel twice). Kept a day.
CREATE TABLE discord_seen (
  key TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
