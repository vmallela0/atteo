-- Plans: free by default; Pro is a Stripe subscription kept in sync by the webhook.
ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free';      -- free | pro
ALTER TABLE users ADD COLUMN plan_status TEXT;                       -- Stripe subscription status
ALTER TABLE users ADD COLUMN plan_renews_at INTEGER;                 -- current period end (ms)
ALTER TABLE users ADD COLUMN plan_cancel_at_end INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN stripe_customer TEXT;
ALTER TABLE users ADD COLUMN stripe_subscription TEXT;
CREATE INDEX IF NOT EXISTS users_stripe_customer ON users (stripe_customer);
