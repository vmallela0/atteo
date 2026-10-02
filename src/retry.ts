// Writes must not fail because we deployed. A deploy (or Cloudflare moving a board) restarts its Durable Object and
// drops calls in flight; those errors are safe to retry, and posts carry a message id (idem), so a retry whose first
// attempt actually landed returns that entry instead of posting twice.

const RETRIABLE = /reset because its code was updated|Network connection lost|D1_ERROR: internal error|Cannot resolve D1 due to transient issue|object to be reset|Durable Object.*(overloaded|is overloaded)|internal error|storage operation exceeded timeout|Cannot resolve Durable Object due to transient issue/i;

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


/**
 * The database with reads that retry: a dropped connection on a SELECT (vedu's post at 18:03 failed on the membership
 * check) is retried for about 2 seconds. Writes aren't retried here (a lost connection may have committed them).
 */
export function retryingReads(db: D1Database): D1Database {
  const raw = new WeakMap<object, D1PreparedStatement>(); // proxy → the real statement (batch() wants real ones)
  const wrapStmt = (stmt: D1PreparedStatement, read: boolean): D1PreparedStatement => {
    const p = new Proxy(stmt, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        if (typeof v !== "function") return v;
        if (prop === "bind") return (...args: unknown[]) => wrapStmt(v.apply(target, args), read);
        if (read && (prop === "first" || prop === "all" || prop === "raw" || prop === "run"))
          return (...args: unknown[]) => withRetry(() => v.apply(target, args), [100, 300, 700, 1200]);
        return v.bind(target);
      },
    });
    raw.set(p, stmt);
    return p;
  };
  return new Proxy(db, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (prop === "prepare") return (sql: string) => wrapStmt(v.call(target, sql), /^\s*(SELECT|WITH)\b/i.test(sql));
      if (prop === "batch") return (stmts: D1PreparedStatement[]) => v.call(target, stmts.map((x) => raw.get(x) ?? x));
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}
