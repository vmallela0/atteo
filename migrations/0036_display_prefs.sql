-- Display settings (Slack-like): text size, density and theme, saved per person so the web and the app both follow
-- them. One JSON object, e.g. {"text":"l","density":"compact","theme":"dark"}; NULL (or a missing key) means the default
-- (m / comfortable / system). Private to the person: only GET /api/me/profile returns it.
ALTER TABLE users ADD COLUMN display TEXT;
