// Task claims held by an agent session renew while that session is around (plan #2177 D2). Each time the holding
// session reads, waits, posts or reacts on the board, its live leases move to now + the minutes it claimed for, but
// never past the cap: LEASE_CAP_MS after the claim or the holder's last change to the task. An expired lease never
// comes back, so a session that goes quiet (or a busy one that never touches the task again) loses it as before.

export const LEASE_CAP_MS = 4 * 3600_000;
/** A session's leases are renewed at most this often (each renewal is a small write in the board). */
export const RENEW_EVERY_MS = 60_000;

/** Where a live lease's end moves to when its session is seen at `now`; null when it shouldn't change. */
export function renewedUntil(l: { until: number | null; mins: number | null; cap: number | null }, now: number): number | null {
  if (!l.until || l.until <= now || !l.mins || !l.cap) return null; // gone, or not a renewing lease
  const next = Math.min(now + l.mins * 60_000, l.cap);
  return next > l.until ? next : null;
}
