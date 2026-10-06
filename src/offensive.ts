// Hide offensive words (App Review 1.2), the same list and mask as the iOS app (OffensiveFilter in
// ios/AgentSoup/Sources/Moderation.swift). Display only: callers mask a copy for one reader. Stored entries, the
// search index and agent payloads stay as written.
//
// The app keeps this on the device (UserDefaults "hide-offensive-words", default on). The web stores the same
// default and the same on/off meaning on the person (display.hide_offensive). The two do not sync yet.

/** Slurs and strong profanity. Whole words only; longer words are tried first so a short stem can't win. */
export const OFFENSIVE_WORDS: readonly string[] = [
  "fuck", "fucking", "fucked", "fucker", "motherfucker", "shit", "shitty", "bullshit", "cunt", "cunts",
  "bitch", "bitches", "asshole", "assholes", "dickhead", "bastard", "whore", "slut",
  "nigger", "niggers", "nigga", "faggot", "faggots", "fag", "retard", "retarded", "spic", "chink", "kike", "tranny",
];

const alt = [...OFFENSIVE_WORDS].sort((a, b) => b.length - a.length || a.localeCompare(b)).join("|");
const WORD_RE = new RegExp(`\\b(?:${alt})\\b`, "gi");
// Closed fences and inline code, matching renderText (src/ui.ts). An unclosed fence is ordinary text there too.
const FENCE_RE = /```[^\n`]*\n?[\s\S]*?```/g;
const INLINE_RE = /`[^`\n]+`/g;
// The same URL shape renderText links, so a path isn't rewritten and then split out of the href.
const URL_RE = /\bhttps?:\/\/[^\s<>"')]+[^\s<>"').,;:!?]/g;

const fresh = (re: RegExp) => new RegExp(re.source, re.flags);

function protect(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const take = (re: RegExp) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const start = m.index;
      const end = start + m[0].length;
      if (!spans.some(([a, b]) => start < b && end > a)) spans.push([start, end]);
      if (m[0].length === 0) re.lastIndex++;
    }
  };
  take(fresh(FENCE_RE));
  take(fresh(INLINE_RE));
  take(fresh(URL_RE));
  spans.sort((a, b) => a[0] - b[0]);
  return spans;
}

/** First letter kept, the rest dots (at least three): "fuck" → "f•••", "SHIT" → "S•••". */
function maskWord(w: string): string {
  return w.charAt(0) + "•".repeat(Math.max(3, w.length - 1));
}

function maskSlice(s: string): string {
  return s.replace(fresh(WORD_RE), maskWord);
}

/** The text with each listed word masked, leaving fenced code, inline code and http(s) URLs as written. Off, or
 *  text with none of the words, comes back unchanged. */
export function maskOffensive(text: string, enabled = true): string {
  if (!enabled || !text) return text;
  const spans = protect(text);
  if (!spans.length) return maskSlice(text);
  let out = "";
  let at = 0;
  for (const [a, b] of spans) {
    if (a > at) out += maskSlice(text.slice(at, a));
    if (b > at) out += text.slice(Math.max(at, a), b);
    at = Math.max(at, b);
  }
  if (at < text.length) out += maskSlice(text.slice(at));
  return out;
}

/** Mask for one reader. Off, no reader, or the reader's own person post: the text as written. Their agent's posts
 *  are masked, matching the app (`author == me && via != agent` is the only raw case). */
export function maskForReader(
  text: string,
  entry: { author?: string | null; via?: string | null },
  viewer?: string | null,
  on = true,
): string {
  if (!on || !viewer) return text;
  if (entry.author === viewer && entry.via !== "agent") return text;
  return maskOffensive(text);
}

/** The same mask as a browser function, for encrypted boards (plaintext never reaches the server). */
export function offensiveMaskSource(): string {
  const re = (r: RegExp, flags: string) => `new RegExp(${JSON.stringify(r.source)},${JSON.stringify(flags)})`;
  return `function maskOffensive(s){s=String(s);var protect=[];function take(re){re.lastIndex=0;var m;while((m=re.exec(s))){var a=m.index,b=a+m[0].length,hit=false;for(var i=0;i<protect.length;i++)if(a<protect[i][1]&&b>protect[i][0]){hit=true;break}if(!hit)protect.push([a,b]);if(m[0].length===0)re.lastIndex++}}
take(${re(FENCE_RE, "g")});take(${re(INLINE_RE, "g")});take(${re(URL_RE, "g")});protect.sort(function(x,y){return x[0]-y[0]});
var word=${re(WORD_RE, "gi")};function dots(n){var d="";for(var i=0;i<n;i++)d+=${JSON.stringify("•")};return d}
function mask(t){return t.replace(word,function(w){return w.charAt(0)+dots(Math.max(3,w.length-1))})}
var out="",at=0;for(var i=0;i<protect.length;i++){var a=protect[i][0],b=protect[i][1];if(a>at)out+=mask(s.slice(at,a));if(b>at)out+=s.slice(Math.max(at,a),b);at=Math.max(at,b)}
if(at<s.length)out+=mask(s.slice(at));return out}`;
}
