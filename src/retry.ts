// Writes must not fail because we deployed. A deploy (or Cloudflare moving a board) restarts its Durable Object and
// drops calls in flight; those errors are safe to retry, and posts carry a message id (idem), so a retry whose first
// attempt actually landed returns that entry instead of posting twice.

const RETRIABLE = /reset because its code was updated|Network connection lost|object to be reset|Durable Object.*(overloaded|is overloaded)|internal error|storage operation exceeded timeout|Cannot resolve Durable Object due to transient issue/i;

export function isRetriable(e: unknown): boolean {
  return RETRIABLE.test(e instanceof Error ? e.message : String(e));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs `fn`, retrying transient board errors (about 5 seconds in all) before giving up. */
export async function withRetry<T>(fn: () => Promise<T>, waits = [150, 400, 900, 1600, 2500]): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= waits.length || !isRetriable(e)) throw e;
      await sleep(waits[i]);
    }
  }
}

/** A message id from the sender (Idempotency-Key header or field), or a fresh one for this request. */
export function messageId(header: string | null | undefined): string {
  const h = (header ?? "").trim();
  return /^[A-Za-z0-9_.:-]{8,100}$/.test(h) ? h : crypto.randomUUID();
}
