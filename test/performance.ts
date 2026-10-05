// Warm both inputs, then alternate their order and take the best of three for each.
// Shared CPU slowdown cancels in the ratio; isolated scheduling pauses are discarded.
export function growthRatio(small: () => unknown, large: () => unknown, now = () => performance.now()): number {
  small();
  large();
  const best = [Infinity, Infinity];
  const runs = [small, large];
  for (let trial = 0; trial < 3; trial++) {
    for (const i of trial % 2 ? [1, 0] : [0, 1]) {
      const start = now();
      runs[i]();
      best[i] = Math.min(best[i], now() - start);
    }
  }
  // Insufficient clock resolution must not silently pass a regression.
  return best[0] > 0 ? best[1] / best[0] : Infinity;
}
