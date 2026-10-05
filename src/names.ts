// People's display names on the web (jxn #4369): a person shows as the name they chose, with their @handle on hover.
// The handle stays wherever it's an address (typed @mentions, the Log, agents' "<handle>'s agent"). A display name is
// the person's own text (up to 60 characters), so it is cleaned of invisible and direction-changing characters, drawn
// isolated (<bdi>), and one that reads as another person's handle ("vedu" or "@vedu" when vedu is on the page, or any
// "@name") carries the real @handle beside it, so nobody can pass as someone else by name.

import type { Env } from "./types";
import { esc } from "./util";

/** Controls, zero-width and bidi-override characters: invisible, or able to reorder what's around them. */
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f­؜ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/g;

/** The display name as shown, or null when there's nothing to show (unset, blank, or only invisible characters). */
export function cleanDisplay(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.replace(INVISIBLE, "").replace(/\s+/g, " ").trim().slice(0, 60);
  return s || null;
}

/** What to call a person in plain text: their display name, else their handle. */
export function shownName(handle: string, display: string | null | undefined): string {
  return cleanDisplay(display) ?? handle;
}

/**
 * Whether `display` could pass for another person: it's written as a handle ("@vedu"), or it is the handle of someone
 * the page also shows (`known`: the board's members, the people in a list). A plain "Vedu" for vmallela is fine.
 */
export function looksLikeOtherHandle(handle: string, display: string, known?: Iterable<string> | null): boolean {
  const d = display.replace(/^@/, "").toLowerCase();
  if (d === handle.toLowerCase()) return false;
  if (/^@[a-z0-9]/i.test(display)) return true;
  for (const k of known ?? []) if (k.toLowerCase() === d) return true;
  return false;
}

/**
 * A person's name as HTML: the display name (isolated, "@handle" on hover), plus a faint "@handle" when the display
 * name could pass for someone else (looksLikeOtherHandle). Just the escaped handle when they have no display name.
 */
export function personHtml(handle: string, display: string | null | undefined, known?: Iterable<string> | null): string {
  const d = cleanDisplay(display);
  if (!d || d === handle) return esc(handle);
  return `<bdi class="pn" title="@${esc(handle)}">${esc(d)}</bdi>${looksLikeOtherHandle(handle, d, known) ? ` <span class="pn-h">@${esc(handle)}</span>` : ""}`;
}

/** handle → display name, for those that have a usable one (the page's map: entries, typing, receipts, menus). */
export function displayMap(people: { user?: string; name?: string; display_name?: string | null }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of people) {
    const h = p.user ?? p.name;
    const d = cleanDisplay(p.display_name);
    if (h && d && d !== h) out[h] = d;
  }
  return out;
}

// Per-isolate cache, so pages that name people outside a board's member list (the sidebar's chats, the inbox) cost at
// most one small D1 read for the names not seen in the last minute.
const cache = new Map<string, { d: string | null; at: number }>();
const TTL = 60_000;

/** Display names for `handles` (handle → display, only those that have one): cached; one IN query for the rest. */
export async function displayNames(env: Env, handles: string[]): Promise<Record<string, string>> {
  const now = Date.now();
  const want = [...new Set(handles.filter(Boolean))].slice(0, 90); // D1 takes at most 100 bound parameters
  const miss = want.filter((h) => !((cache.get(h)?.at ?? 0) > now - TTL));
  if (miss.length) {
    const r = await env.DB.prepare(`SELECT name, display_name FROM users WHERE name IN (${miss.map(() => "?").join(",")})`)
      .bind(...miss)
      .all<{ name: string; display_name: string | null }>()
      .catch(() => null);
    if (r) {
      if (cache.size > 5000) cache.clear();
      const got = new Map(r.results.map((x) => [x.name, x.display_name]));
      for (const h of miss) cache.set(h, { d: got.get(h) ?? null, at: now });
    }
  }
  const out: Record<string, string> = {};
  for (const h of want) {
    const d = cleanDisplay(cache.get(h)?.d);
    if (d && d !== h) out[h] = d;
  }
  return out;
}

/** Forget a person's cached name (they just changed it), so this isolate shows the new one at once. */
export function forgetDisplayName(handle: string): void {
  cache.delete(handle);
}
