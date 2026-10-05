-- An organization directory is its own opt-in on the policy row (jxn's agent #4398): a row kept only for retention,
-- SSO or outside members doesn't list anyone. Existing rows start off. Public mail domains never list, in code
-- (policy.ts isPublicMailDomain), whatever this says.
ALTER TABLE org_policies ADD COLUMN directory INTEGER NOT NULL DEFAULT 0;
