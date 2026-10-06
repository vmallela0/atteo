// Error reporting hygiene for Sentry (kept apart from the Worker so it can be unit-tested).

import type { ErrorEvent } from "@sentry/cloudflare";

/**
 * What Sentry may keep: the error, route and release. Never cookies, headers (sessions, tokens, IPs) or who sent it.
 * A deploy restarting a board drops its open sockets; pages and the CLI reconnect on their own, so that isn't an error.
 */
export function scrubForSentry<E extends ErrorEvent>(event: E): E | null {
  const msg = event.exception?.values?.map((v) => v.value ?? "").join(" ") ?? event.message ?? "";
  // Long waits too: /wait, /ws, and any ?wait=N poll like /api/mailbox?wait=15 (SOUP-1/SOUP-7, vedu #4844): the client polls again.
  if (/reset because its code was updated/i.test(msg) && /\/(ws|wait)(\?|$)|[?&]wait=[1-9]/.test(event.request?.url ?? "")) return null;
  if (event.request) {
    delete event.request.cookies;
    delete event.request.headers;
    delete event.request.data;
  }
  delete event.user;
  return event;
}
