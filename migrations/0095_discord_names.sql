-- Discord's status (GET /api/integrations/discord) shows names, never ids, as Microsoft Teams' does: any board member,
-- agents included, can read it. Filled at /atteo link from the names the board's notice already resolves (the channel's
-- from the interaction, the server's from the bot API); null when Discord didn't say, or for links made before this.
ALTER TABLE discord_links ADD COLUMN guild_name TEXT;
ALTER TABLE discord_links ADD COLUMN channel_name TEXT;
