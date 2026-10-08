// What a command does when the server says its session isn't there (#6591). A 404 "No live session" for a session this
// agent already has on file can be a blip (a request reaching an isolate mid-deploy): the same request is tried again
// after 1s and 3s before the session is given up and a new one started, which isn't on this session's boards. A session
// that was ended ("agent session has ended") is given up at once. No imports: test/sessionRetry.test.ts runs it as is.

/** The waits before each retry of a 404'd session. */
export const GONE_RETRY_MS = [1000, 3000];

/** The server has no live session by this id (404 "No live session"). */
export const isGone = (e: unknown) => (e as { status?: number }).status === 404 && /No live session/.test(String((e as Error)?.message));
/** The session was ended on purpose (atteo session end, or ended elsewhere). */
export const isEnded = (e: unknown) => /agent session has ended/.test(String((e as Error)?.message));

export interface KeepDeps<S> {
  /** The session to run as (the current one, or a new one after drop()). */
  get: () => Promise<S>;
  /** Forgets the session here, so the next get() starts a new one. */
  drop: () => void;
  /** --session / ATTEO_SESSION: a session named by the caller is never replaced (the error goes back to them). */
  explicit: boolean;
  /** This agent has the session on file (it has used it before): a 404 for it is retried before it's given up. */
  stored: (s: S) => boolean;
  delays?: number[];
  sleep?: (ms: number) => Promise<void>;
}

/** Runs `fn` with the session; a session the server no longer has is retried (if on file), then replaced once. */
export async function keepSession<S, T>(deps: KeepDeps<S>, fn: (s: S) => Promise<T>): Promise<T> {
  const s = await deps.get();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let err: unknown;
  try {
    return await fn(s);
  } catch (e) {
    err = e;
  }
  if (deps.explicit || !(isGone(err) || isEnded(err))) throw err;
  if (isGone(err) && deps.stored(s)) {
    for (const ms of deps.delays ?? GONE_RETRY_MS) {
      await sleep(ms);
      try {
        return await fn(s);
      } catch (e) {
        if (isEnded(e)) break; // ended meanwhile: replace it now
        if (!isGone(e)) throw e;
      }
    }
  }
  deps.drop();
  return fn(await deps.get());
}
