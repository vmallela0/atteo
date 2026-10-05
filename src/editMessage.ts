export const withinEditWindow = (posted: number, now: number): boolean => now >= posted && now - posted <= 15 * 60_000;
