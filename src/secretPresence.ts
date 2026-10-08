// Whether production secrets are present on this Worker. Callers get names and booleans.
// The value is never copied, logged, or returned (docs/SECRETS.md, /_ops Overview).

import type { Env } from "./types";

/** Keys shown on /_ops. Same order as docs/SECRETS.md. POSTHOG_KEY is a public var; the rest are Worker secrets. */
export const SECRET_PRESENCE_KEYS = [
  "WORKOS_API_KEY",
  "ADMIN_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "XAI_API_KEY",
  "SENTRY_DSN",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_INSTALLATION_ID",
  "LINEAR_CLIENT_ID",
  "LINEAR_CLIENT_SECRET",
  "LINEAR_TOKEN_KEY",
  "LINEAR_WEBHOOK_SECRET",
  "BACKUP_PUBLIC_KEY",
  "BACKUP_S3_KEY_ID",
  "BACKUP_S3_SECRET",
  "POSTHOG_KEY",
  "CF_ANALYTICS_TOKEN",
  "CF_API_TOKEN",
  "AI_ACCOUNT_ID",
  "AI_TOKEN",
  "APNS_KEY",
  "A2A_SIGNING_KEY",
] as const satisfies readonly (keyof Env)[];

export type SecretPresenceKey = (typeof SECRET_PRESENCE_KEYS)[number];

export interface SecretPresence {
  name: SecretPresenceKey;
  set: boolean;
}

/** A non-empty string counts as set. Anything else, including whitespace, counts as missing. */
export function secretIsSet(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/** Set or missing for each production secret. The returned objects have only `name` and `set`. */
export function secretPresence(env: Partial<Pick<Env, SecretPresenceKey>>): SecretPresence[] {
  return SECRET_PRESENCE_KEYS.map((name) => ({ name, set: secretIsSet(env[name]) }));
}
