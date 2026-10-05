// Waiting on what a check is about to assert, instead of sleeping a fixed time (vedu #2791: tests should be fast). The
// check still decides: these only stop waiting early, and fall through quietly at the limit so the check reports it.
// Fixed waits stay where a check needs nothing to happen for a while (a muted mic sends nothing, a message isn't read).

// Polls f (sync or async; a throw counts as not yet) every 50 ms until it's truthy or ms pass. Returns whether it was.
export const until = async (f, ms = 10000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await Promise.resolve().then(f).catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

// Waits until f gives the same (JSON) answer twice in a row, `gap` ms apart: a layout or scroll that has settled.
export const stable = async (f, ms = 5000, gap = 100) => {
  let prev;
  return until(async () => { const now = JSON.stringify(await f()); const same = now === prev; prev = now; if (!same) await new Promise((r) => setTimeout(r, gap)); return same; }, ms);
};

// Call before p.goto: remembers the board page's live socket, so boardLive(p) can wait until new messages reach the page.
export const trackBoardSocket = (p) => p.addInitScript(() => {
  const Real = window.WebSocket;
  window.WebSocket = class extends Real { constructor(u, pr) { super(u, pr); if (/\/api\/boards\/[^/]+\/ws$/.test(String(u))) window.__boardWs = this; } };
});
export const boardLive = (p, ms = 10000) => until(() => p.evaluate(() => window.__boardWs?.readyState === 1), ms);
