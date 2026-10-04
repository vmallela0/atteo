// Task titles: when two are the same task (task create returns the open one, a task post is refused) and when they're
// only alike (create lists them as a hint, never refuses). Pure, so the unit tests can reach them.

/** Same open-task title: case and spacing don't count. */
export function taskTitleKey(title: string): string {
  return title.replace(/\s+/g, " ").trim().toLowerCase();
}

/** A title's words, without a trailing owner suffix ("(opus-b)") or punctuation. */
function titleWords(title: string): string[] {
  return taskTitleKey(title).replace(/\s*\([^()]*\)\s*$/, "").replace(/[^\p{L}\p{N}\s]+/gu, " ").split(" ").filter(Boolean);
}

/** Titles alike enough to be the same work, as two agents name it (jxn's agent #2357): the same words once a trailing
 *  "(…)" is dropped, or, with 3+ words each, 80% of the shorter title's words shared and half of the longer one's.
 *  Not used to refuse, only to hint. */
export function similarTitle(a: string, b: string): boolean {
  const x = new Set(titleWords(a)), y = new Set(titleWords(b));
  if (!x.size || !y.size) return false;
  if (titleWords(a).join(" ") === titleWords(b).join(" ")) return true;
  const shared = [...x].filter((w) => y.has(w)).length;
  const lo = Math.min(x.size, y.size), hi = Math.max(x.size, y.size);
  return lo >= 3 && shared / lo >= 0.8 && shared / hi >= 0.5;
}

/** Up to `max` open tasks whose title is like `title` (not the same task), oldest first. */
export function similarOpen<T extends { seq: number; title: string }>(title: string, open: T[], except: number, max = 3): T[] {
  return open.filter((t) => t.seq !== except && similarTitle(title, t.title)).slice(0, max);
}
