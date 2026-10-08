// X/Twitter post cards (vedu DM #26): a message with a link to an X post shows the post (author, @handle, text, date)
// under it on the web board, instead of a bare link. The words come from X's public oEmbed endpoint on ONE fixed host
// (never a URL from the message, so this can't be used to fetch anything else), as text only: X's HTML never reaches a
// page. Cached a day per post id (Workers Cache API, like tts.ts); failures are cached a few minutes. Encrypted boards
// don't ask (the server would learn which posts their messages link to). Agents' reads are unchanged.
import type { Env } from "./types";
import { rateCheck } from "./limits";

/** A link to one X post: x.com, twitter.com, www./mobile., any query or fragment. Group 1: handle, group 2: post id. */
export const X_STATUS_RE = /^https:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{1,20})(?:[/?#]|$)/i;

export interface XCard {
  author: string;
  handle: string;
  text: string;
  date: string;
  url: string;
}

/** The post a link points at, or null for anything that isn't a link to one post. */
export function parseXUrl(u: string): { handle: string; id: string } | null {
  const m = X_STATUS_RE.exec(u.trim());
  return m ? { handle: m[1], id: m[2] } : null;
}

const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const ID_RE = /^\d{1,20}$/;
/** The only host this asks. publish.twitter.com answers with a 301 to it, and redirects aren't followed. */
export const OEMBED_ORIGIN = "https://publish.x.com";
export const oembedUrl = (id: string, handle = "i") =>
  `${OEMBED_ORIGIN}/oembed?url=${encodeURIComponent(`https://twitter.com/${HANDLE_RE.test(handle) ? handle : "i"}/status/${id}`)}&omit_script=1&dnt=true`;

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };
/** HTML entities → characters (named ones X uses, and every numeric one). Unknown names stay as they are. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "";
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

/** Markup → plain text: <br> is a line break, every other tag goes (a link keeps its words), then entities decode. */
const toText = (html: string) => decodeEntities(html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, "")).replace(/[ \t]+\n/g, "\n").trim();

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** X's oEmbed JSON → a card, or null when it isn't one (a deleted or private post answers 200 with an HTML page). */
export function parseOembed(j: unknown, id: string): XCard | null {
  if (!j || typeof j !== "object") return null;
  const o = j as { author_name?: unknown; author_url?: unknown; html?: unknown };
  if (typeof o.html !== "string" || !/<blockquote[^>]*twitter-tweet/i.test(o.html)) return null;
  const html = o.html;
  const p = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(html);
  const text = p ? toText(p[1]) : "";
  // "&mdash; Name (@handle) <a href=…/status/…>October 7, 2026</a>": the date is that last link's words.
  const tail = html.slice(p ? p.index + p[0].length : 0);
  const links = [...tail.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)];
  const date = links.length ? toText(links[links.length - 1][1]) : "";
  const fromUrl = typeof o.author_url === "string" ? /^https:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/?$/i.exec(o.author_url)?.[1] : undefined;
  const fromHtml = /\(@([A-Za-z0-9_]{1,15})\)/.exec(tail)?.[1];
  const handle = fromUrl ?? fromHtml;
  if (!handle || (!text && !date)) return null;
  const author = typeof o.author_name === "string" && o.author_name.trim() ? clip(o.author_name.trim(), 80) : handle;
  return { author, handle, text: clip(text, 1200), date: clip(date, 40), url: `https://x.com/${handle}/status/${id}` };
}

// ---------- fetching, with the cache ----------

export const CARD_SECONDS = 86_400; // a day
export const MISS_SECONDS = 300; // a failure is asked again after five minutes
export const TIMEOUT_MS = 3000;
export const MAX_BYTES = 64 * 1024;

export interface XCardDeps {
  fetch: typeof fetch;
  cache: Pick<Cache, "match" | "put"> | null; // caches.default in the Worker; null skips caching
  waitUntil?: (p: Promise<unknown>) => void;
  timeoutMs?: number;
}

export const cacheKey = (id: string) => `https://xcard.atteo.invalid/v1/${id}`;

/** The body as text, or null past `max` bytes (stops reading there). */
async function readCapped(res: Response, max: number): Promise<string | null> {
  if (Number(res.headers.get("content-length") ?? 0) > max) return null;
  if (!res.body) return "";
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const all = new Uint8Array(n);
  let at = 0;
  for (const p of parts) (all.set(p, at), (at += p.byteLength));
  return new TextDecoder().decode(all);
}

/** One post from X, uncached: the card, or null for anything else (an error, a redirect, too big, too slow, not JSON). */
export async function fetchOembed(id: string, handle: string, deps: Pick<XCardDeps, "fetch" | "timeoutMs">): Promise<XCard | null> {
  try {
    const res = await deps.fetch(oembedUrl(id, handle), { redirect: "manual", headers: { accept: "application/json" }, signal: AbortSignal.timeout(deps.timeoutMs ?? TIMEOUT_MS) });
    if (res.status !== 200 || !/json/i.test(res.headers.get("content-type") ?? "")) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const body = await readCapped(res, MAX_BYTES);
    return body == null ? null : parseOembed(JSON.parse(body), id);
  } catch {
    return null;
  }
}

const inflight = new Map<string, Promise<XCard | null>>(); // one ask per post at a time, in this isolate

/** The card for post `id`: from the cache, else from X (and cached, a day for a card, five minutes for a miss). */
export async function getCard(id: string, handle: string, deps: XCardDeps): Promise<{ card: XCard | null; cache: "hit" | "miss" }> {
  const key = cacheKey(id);
  const hit = deps.cache ? await deps.cache.match(key).catch(() => undefined) : undefined;
  if (hit) {
    const j = (await hit.json().catch(() => null)) as { card?: XCard | null } | null;
    if (j && "card" in j) return { card: j.card ?? null, cache: "hit" };
  }
  let p = inflight.get(id);
  if (!p) {
    p = fetchOembed(id, handle, deps).finally(() => inflight.delete(id));
    inflight.set(id, p);
  }
  const card = await p;
  if (deps.cache) {
    const put = deps.cache
      .put(key, Response.json({ card }, { headers: { "cache-control": `public, max-age=${card ? CARD_SECONDS : MISS_SECONDS}` } }))
      .catch((e) => console.warn("x-card cache put failed", e instanceof Error ? e.message : String(e)));
    if (deps.waitUntil) deps.waitUntil(put);
  }
  return { card, cache: "miss" };
}

// ---------- the route ----------

/** Cards a minute for one person or agent (on top of the per-token limit every API call has). */
export const PER_MINUTE = 60;

const err = (error: string, status: number, headers: HeadersInit = {}) => Response.json({ error }, { status, headers });

/** GET /api/x-card?id=<post id>&handle=<handle> → {author, handle, text, date, url}; 404 when X has no such post. */
export async function route(url: URL, viewer: { name: string } | null, deps: XCardDeps & { now?: () => number }): Promise<Response> {
  if (!viewer) return err("sign in required", 401);
  const id = url.searchParams.get("id") ?? "";
  const handle = url.searchParams.get("handle") ?? "";
  if (!ID_RE.test(id)) return err("id must be an X post id (digits).", 400);
  if (handle && !HANDLE_RE.test(handle)) return err("handle must be an X handle.", 400);
  const rl = rateCheck(`xcard:${viewer.name}`, PER_MINUTE, (deps.now ?? Date.now)());
  if (!rl.ok) return err(`Too many post previews: at most ${PER_MINUTE} a minute. Try again in ${rl.retryAfter}s.`, 429, { "retry-after": String(rl.retryAfter) });
  const { card, cache } = await getCard(id, handle || "i", deps);
  const headers = { "x-card-cache": cache, "cache-control": card ? "private, max-age=3600" : "private, max-age=300" };
  if (!card) return Response.json({ error: "No preview for that post." }, { status: 404, headers });
  return Response.json(card, { headers });
}

/** The Worker's deps: global fetch and caches.default. */
export function workerDeps(_env: Env, ctx: ExecutionContext): XCardDeps {
  return { fetch: (i, init) => fetch(i, init), cache: typeof caches !== "undefined" ? caches.default : null, waitUntil: (p) => ctx.waitUntil(p) };
}

// ---------- the board page's side (in the board tail, never on an encrypted board) ----------

/**
 * Finds links to X posts in messages as they come near the screen (and in ones that arrive live), asks /api/x-card once
 * per post, and puts a card under the message: name, @handle, the post's words (clamped to six lines) and its date,
 * linking to the post. Everything from the server is set with textContent; a post with no card leaves the link as is.
 */
export const X_CARD_JS = `
{const XRE=new RegExp(${JSON.stringify(X_STATUS_RE.source)},'i'),xcMemo=new Map(),XMAX=3;
const xcGet=(id,h)=>{let p=xcMemo.get(id);if(!p){p=fetch('/api/x-card?id='+id+'&handle='+encodeURIComponent(h)).then(r=>r.ok?r.json():null).catch(()=>null);xcMemo.set(id,p)}return p};
const xcEl=(t,c,s)=>{const e=document.createElement(t);e.className=c;if(s!=null)e.textContent=s;return e};
function xcCard(j){if(!j||typeof j.url!=='string'||!XRE.test(j.url))return null;const a=xcEl('a','xc');a.href=j.url;a.target='_blank';a.rel='noopener noreferrer';
  const hd=xcEl('div','xc-hd');hd.append(xcEl('span','xc-who',String(j.author||j.handle||'')),xcEl('span','xc-h','@'+String(j.handle||'')),xcEl('span','xc-x','𝕏'));a.append(hd);
  if(j.text)a.append(xcEl('div','xc-t',String(j.text)));if(j.date)a.append(xcEl('div','xc-d',String(j.date)));return a}
// The posts a message links to (its own words, not quotes), as "id handle" pairs; a body is redone when they change
// (an edit, a task's text refreshed in place), so its cards always match its links.
function xcIds(b){const out=new Map();b.querySelectorAll('a[href]').forEach(l=>{if(out.size>=XMAX||l.closest('blockquote'))return;const m=XRE.exec(l.getAttribute('href')||'');if(m&&!out.has(m[2]))out.set(m[2],m[1])});return out}
function xcFill(body){const ids=xcIds(body);let box=body.nextElementSibling;if(box&&!box.classList.contains('xcs'))box=null;
  if(box)[...box.children].forEach(c=>{if(!ids.has(c.dataset.id))c.remove()});if(!ids.size){if(box)box.remove();return}
  if(!box){box=xcEl('div','xcs');body.after(box)}
  ids.forEach((h,id)=>{if([...box.children].some(c=>c.dataset.id===id))return;const slot=xcEl('div','xc-slot');slot.dataset.id=id;box.append(slot);
    xcGet(id,h).then(j=>{const c=xcCard(j);if(c&&slot.isConnected){c.dataset.id=id;slot.replaceWith(c)}else slot.remove()})})}
const xcIO='IntersectionObserver' in window?new IntersectionObserver(es=>es.forEach(x=>{if(x.isIntersecting){xcIO.unobserve(x.target);xcFill(x.target)}}),{rootMargin:'600px 0px'}):null;
function xcScan(){const t=document.getElementById('thread');if(!t)return;t.querySelectorAll('.entry .body').forEach(b=>{const k=[...xcIds(b).keys()].join(',');
  if((b.dataset.xck||'')===k)return;b.dataset.xck=k;if(xcIO&&k)xcIO.observe(b);else xcFill(b)})}
xcScan();let xcQ=false;const xcT=document.getElementById('thread');if(xcT)new MutationObserver(()=>{if(xcQ)return;xcQ=true;requestAnimationFrame(()=>{xcQ=false;xcScan()})}).observe(xcT,{childList:true,subtree:true})}
`;
