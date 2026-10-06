// Design system: tokens, base styles, components and the shared client script.
// Minimal and quiet (in the spirit of Vercel Geist / Linear): neutral grays, one ink color for primary actions,
// hairline borders, light + dark, works down to phone width. Type: Onest / STIX Two Text / Courier Prime (fontfaces.ts).

import { APPLE_TOUCH_PNG_B64 } from "./appleIcon";
import { APP_FONT_CSS, FONT_V } from "./fontfaces";
import { chartHtml } from "./chart";
import { STATUS_CSS, statusHtml } from "./status";
import { highlightMentions, type Mention } from "./mentions";
import { MERMAID_CSS, MERMAID_JS, mermaidHtml } from "./mermaid";
import { CODE_COLOR_CSS, CODE_COLOR_JS, fnv } from "./codecolor";
import { TALK_CSS } from "./talk";
import { AGENT_LOGO_CSS } from "./agent-logos";
import { ASK_CSS, DOC_CSS, GUIDE_CSS } from "./pageCss";
import { esc } from "./util";
import { personHtml, shownName } from "./names";
import { clientTable, dirOf, tr, type Lang } from "./i18n";
import { analyticsScriptTag, currentAnalytics } from "./analytics";

/** Report-only for now (jxn's agent #2636): violations go to /api/csp-report and the ops console. Set this to true to
 *  enforce once a day of reports is clean; nothing else changes (every inline script already carries the nonce). */
export const CSP_ENFORCE = false;
export const CSP_REPORT_PATH = "/api/csp-report";

/** The one outside host the web may open a socket to: the voice provider (voice.ts REALTIME_URL; a test keeps them in
 *  step). 'self' covers the board's own live socket (ws/wss on this host), so an injected script can't open one out. */
export const VOICE_SOCKET_ORIGIN = "wss://api.x.ai";

/**
 * The form-action source for one place a form's POST may redirect to: an http(s) URL's origin, or another scheme on its
 * own ("cursor:", an app's "atteo:"). Browsers apply form-action to the redirect after a POST too, so the OAuth consent
 * page must allow its client's redirect_uri or connecting Claude.ai or Cursor fails once the CSP is enforced. null when
 * the URL can't be a source (a source list is space-separated, so nothing odd goes in).
 */
export function formActionSource(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol === "http:" || u.protocol === "https:") return /^https?:\/\/[a-z0-9.:\[\]-]+$/i.test(u.origin) ? u.origin : null;
  return /^[a-z][a-z0-9+.-]*:$/i.test(u.protocol) && !/^(javascript|data|blob|file|filesystem|about):$/i.test(u.protocol) ? u.protocol : null;
}

// Each HTML response owns its nonce. Stylesheets come from 'self' (/app.css and page-only sheets); leftover <style>
// blocks carry the nonce. style-src-attr separately allows server/client HTML style attributes; CSSOM property
// assignments (composer height, pickers, diagram sizing) don't require it. Inline handlers are forbidden; page code
// uses listeners. Mermaid is this origin's pinned
// /mermaid.min.js and loads with an SRI hash (mermaid.ts), so a substituted file fails the integrity check.
// The pages are private, revalidated each time (no shared cache may keep one person's page, or pin one nonce for many
// responses); no-store would also keep them out of the back/forward cache.
// img-src blob: is upload thumbnails and bug-report pictures (URL.createObjectURL). Avatars, board pictures and posted
// images are this origin. Icons are inline SVG or clip-path, so data: is not an image source. font-src is only
// /fonts/*.woff2. media-src blob: is read-aloud, the Display voice sample, and Talk's silent media-key wav; live Talk
// audio is WebAudio on connect-src, not a media element. No data: font or media, and no media host besides 'self'.
// The pinned mermaid.min.js inserts one fixed <style> block of its own (a nonce can't reach it), so it's allowed by its hash;
// a new mermaid build changes the hash and the csp browser checks name the new one.
const MERMAID_STYLE_HASH = "'sha256-lCZPv+siQGbLyHufN87S4tT1GlG+V8T7J184kcDeWZ4='";
export function pageSecurity(opts: { formAction?: string[] } = {}) {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  const formAction = ["'self'", ...(opts.formAction ?? []).map(formActionSource).filter((x): x is string => !!x)].join(" ");
  // PostHog's ingest host is added only while a project key is configured (src/analytics.ts). script-src stays first-party.
  const ph = currentAnalytics();
  const connect = ph ? `'self' ${VOICE_SOCKET_ORIGIN} ${ph.host}` : `'self' ${VOICE_SOCKET_ORIGIN}`;
  const policy = `default-src 'self'; script-src 'self' 'nonce-${nonce}'; script-src-attr 'none'; style-src 'self' 'nonce-${nonce}' ${MERMAID_STYLE_HASH}; style-src-attr 'unsafe-inline'; img-src 'self' blob:; font-src 'self'; media-src 'self' blob:; connect-src ${connect}; frame-src 'self' about:; frame-ancestors 'none'; base-uri 'none'; form-action ${formAction}; object-src 'none'; report-uri ${CSP_REPORT_PATH}; report-to csp`;
  const headers: Record<string, string> = {
    [CSP_ENFORCE ? "content-security-policy" : "content-security-policy-report-only"]: policy,
    "reporting-endpoints": `csp="${CSP_REPORT_PATH}"`,
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "cache-control": "private, no-cache",
  };
  return { nonce, headers };
}

/** Put the page nonce on every <style> that doesn't already have one (noscript, leftover page blocks). */
export function styleNonce(html: string, nonce: string): string {
  return html.replace(/<style\b(?![^>]*\bnonce=)/gi, `<style nonce="${nonce}"`);
}

// Dark tokens: the system setting picks them unless Display says light; Display can also force them.
const DARK = `  --bg:#0E0E0E;--bg-subtle:#1A1918;--bg-hover:#1F1E1C;--line:#2A2926;--line-strong:#3A3935;
  --ink:#FAFAF7;--text:#EDEBE5;--muted:#A9A69F;--faint:#8E8C85;--on-ink:#0E0E0E;--cone:#C2414D;--oxblood:#B5484A;--bg-raised:#141414;
  --accent:#FAFAF7;--ok:#3ecf75;--warn:#fb923c;--danger:#f87171;
  --q:#fbbf24;--claim:#4ade80;--decision:#a78bfa;--task:#38bdf8;--artifact:#a3a3a3;--note:#737373;
  --shadow:0 1px 2px rgba(0,0,0,.4);--shadow-lg:0 12px 48px rgba(0,0,0,.6);
  --av-l:22%;--av-c:80%;--av-s:6%;--tile-l:34%;
  color-scheme:dark;`;

/** The interface face, fetched with the page instead of after the CSS parses (latin; other subsets load as needed). */
const FONT_PRELOAD = `<link rel="preload" href="/fonts/onest-latin.woff2?v=${FONT_V}" as="font" type="font/woff2" crossorigin>`;

export const CSS = `
#thread-scroll[data-wait]>#thread{visibility:hidden} /* until the board script has placed it (html.ts) */
:root{
  /* The design language (v1, jxn #4682): neutral throughout. Ink on paper, bone and stone around it, line for dividers,
     graphite for secondary text. Oxblood has one job, human intervention: Stop and halted states, nowhere else (on ink
     it's oxblood-lifted); --cone is the current logo's alone until the new mark lands. Primary actions, you, mentions, unread, links and focus are ink. */
  --bg:#FAFAF7;--bg-subtle:#F2EFE8;--bg-hover:#ECE8DF;--line:#E4E1D9;--line-strong:#D9D6CE;
  --ink:#0E0E0E;--text:#161614;--muted:#5A5853;--faint:#6B6964;--on-ink:#FAFAF7;--cone:#6A1B24;--oxblood:#6E1F22;--bg-raised:#FAFAF7;
  --on-fill:#FFFFFF;--preview-bg:#FFFFFF; /* text on a saturated fill (avatars, status marks, scrims); an HTML preview's page */
  --accent:#0E0E0E;--ok:#16a34a;--warn:#c2410c;--danger:#dc2626;
  --q:#d97706;--claim:#16a34a;--decision:#7c3aed;--task:#0284c7;--artifact:#737373;--note:#a3a3a3;
  --shadow:0 1px 2px rgba(0,0,0,.04),0 4px 16px rgba(0,0,0,.04);--shadow-lg:0 12px 48px rgba(0,0,0,.12);
  --av-l:90%;--av-c:26%;--av-s:8%;--tile-l:36%;
  --r:10px;--r-sm:7px;
  color-scheme:light;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${DARK}}}
:root[data-theme="dark"]{${DARK}}
/* Semantic tokens (jxn #2706): components use these, never the palette or a literal, so a change of look is one place.
   cta = ink, the one primary action; intervene = oxblood, Stop and halted only (jxn #4682); status colours stay their own. */
:root{
  --cta:var(--ink);--on-cta:var(--on-ink);--intervene:var(--oxblood);--on-intervene:#FAFAF7; /* paper on oxblood: 10.7:1; on oxblood-lifted 5.0:1 */
  --you:var(--ink);--you-soft:color-mix(in srgb,var(--ink) 5%,transparent);--you-flash:color-mix(in srgb,var(--ink) 12%,transparent);
  --mention-fg:var(--ink);--mention-bg:color-mix(in srgb,var(--ink) 7%,transparent);--mention-line:color-mix(in srgb,var(--ink) 40%,transparent);
  --mention-you-bg:color-mix(in srgb,var(--ink) 15%,transparent);--mention-you-line:color-mix(in srgb,var(--ink) 65%,transparent);
  --rail-mark:color-mix(in srgb,var(--muted) 16%,transparent);--rail-on:color-mix(in srgb,var(--muted) 60%,transparent);--rail-you:var(--ink);
  --unread:var(--ink);--voice:var(--ink);--badge-bg:var(--accent);--badge-fg:var(--on-ink);--focus:var(--accent);
  --mark:color-mix(in srgb,var(--ink) 14%,transparent);
  --private:color-mix(in srgb,var(--ink) 50%,transparent);--private-soft:color-mix(in srgb,var(--ink) 6%,transparent);
}
*{box-sizing:border-box}
[hidden]{display:none!important} /* the hidden attribute always wins over a component display (e.g. .btn is inline-flex) */
/* Scrollbars: thin and quiet (Linear/Slack-like), one per scrolling pane. Chrome and Safari use the ::-webkit
   rules (Chrome ignores them once scrollbar-width is set, so that's Firefox-only); darker while the pane is hovered. */
:root{--sb:color-mix(in srgb,var(--muted) 35%,transparent);--sb-hover:color-mix(in srgb,var(--muted) 70%,transparent)}
/* How far a message highlight reaches past the entry: left, past the avatar; right, only up to the scroll rail (jxn #2003). */
:root{--hl-l:12px;--hl-r:4px}@media(max-width:640px){:root{--hl-l:8px}}
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track,::-webkit-scrollbar-corner{background:transparent}
::-webkit-scrollbar-thumb{background:var(--sb);border-radius:6px}
:hover::-webkit-scrollbar-thumb{background:var(--sb-hover)}
@supports not selector(::-webkit-scrollbar){*{scrollbar-width:thin;scrollbar-color:var(--sb) transparent}*:hover{scrollbar-color:var(--sb-hover) transparent}}
html{-webkit-text-size-adjust:100%}
/* Type (design language v1, jxn #4682): three layers. STIX Two Text for the brand and titles, Courier Prime for ids,
   payloads and code, Onest for message text and the controls around it (jxn #4726: message text isn't mono),
   all served by this Worker (fontfaces.ts). Onest covers Latin, Cyrillic and Vietnamese; other scripts fall through to
   the system's own font for that script, per page language. */
:root{--font-ui:"Onest",ui-sans-serif,system-ui,-apple-system,"Segoe UI","PingFang SC","Hiragino Sans GB","Noto Sans SC","Microsoft YaHei",sans-serif;
  --font-head:"STIX Two Text","Onest",Georgia,"Times New Roman",serif;--font-mono:"Courier Prime",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
html:lang(zh-Hant){--font-ui:"Onest",ui-sans-serif,system-ui,-apple-system,"Segoe UI","PingFang TC","Noto Sans TC","Microsoft JhengHei",sans-serif}
html:lang(ja){--font-ui:"Onest",ui-sans-serif,system-ui,-apple-system,"Segoe UI","Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans JP","Yu Gothic UI",Meiryo,sans-serif}
html:lang(ko){--font-ui:"Onest",ui-sans-serif,system-ui,-apple-system,"Segoe UI","Apple SD Gothic Neo","Noto Sans KR","Malgun Gothic",sans-serif}
html:lang(hi){--font-ui:"Onest",ui-sans-serif,system-ui,-apple-system,"Segoe UI","Kohinoor Devanagari","Noto Sans Devanagari","Nirmala UI",sans-serif}
html:lang(bn){--font-ui:"Onest",ui-sans-serif,system-ui,-apple-system,"Segoe UI","Kohinoor Bangla","Noto Sans Bengali","Nirmala UI",sans-serif}
html:lang(ar){--font-ui:"Onest",ui-sans-serif,system-ui,-apple-system,"Segoe UI","Geeza Pro","Noto Sans Arabic","Noto Naskh Arabic",Tahoma,sans-serif}
html:lang(zh-Hant),html:lang(ja),html:lang(ko),html:lang(hi),html:lang(bn),html:lang(ar),html:lang(zh-Hans),html:lang(zh){--font-head:var(--font-ui)} /* STIX Two covers Latin, Greek and Cyrillic only: a headline in these scripts uses the interface stack */
body{margin:0;background:var(--bg);color:var(--text);font:13.5px/1.5 var(--font-ui);
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
a{color:inherit;text-decoration:none}
a.link{color:var(--accent);text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:2px}a.link:hover{text-decoration-thickness:2px}
code,pre,.mono{font-family:var(--font-mono);font-size:13px}
h1,h2,h3{color:var(--ink);font-weight:600;letter-spacing:-.02em;margin:0}h1,h2{font-family:var(--font-head);letter-spacing:-.01em}
h1{font-size:22px;line-height:1.25}h2{font-size:15px}h3{font-size:13px}
p{margin:0}
.muted{color:var(--muted)}.faint{color:var(--faint)}.small{font-size:13px}.xs{font-size:12px}
.row{display:flex;align-items:center;gap:8px}.row.wrap{flex-wrap:wrap}.grow{flex:1;min-width:0}
.stack>*+*{margin-top:12px}
.truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* header */
.nav{position:sticky;top:0;z-index:20;background:color-mix(in srgb,var(--bg) 82%,transparent);backdrop-filter:saturate(180%) blur(12px);
  -webkit-backdrop-filter:saturate(180%) blur(12px);border-bottom:1px solid var(--line)}
.nav .in{max-width:1180px;margin:0 auto;height:56px;padding:0 20px;display:flex;align-items:center;gap:16px}
.brand{display:flex;align-items:center;gap:5px;font-weight:600;letter-spacing:-.01em;color:var(--ink)}
.brand svg{display:block}
.wm{font-family:var(--font-head);font-weight:400;font-size:22px;line-height:1;letter-spacing:-.01em}.wm.lg{font-size:40px} /* the wordmark: lowercase "atteo" in STIX Two Text 400 (jxn #4682) */
.nav .links{display:flex;gap:4px;margin-left:8px}
.nav .links a{color:var(--muted);padding:6px 10px;border-radius:6px}
.nav .links a:hover,.nav .links a[aria-current]{color:var(--ink);background:var(--bg-hover)}
.nav .right{margin-left:auto;display:flex;align-items:center;gap:10px}
main{max-width:1180px;margin:0 auto;padding:40px 20px 96px}
main.narrow{max-width:720px}

/* controls */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;height:30px;padding:0 12px;border-radius:var(--r-sm);
  border:1px solid var(--line-strong);background:var(--bg);color:var(--ink);font:inherit;font-weight:500;cursor:pointer;white-space:nowrap;
  transition:background .15s,border-color .15s,opacity .15s}
.btn:hover{background:var(--bg-hover)}
.btn.primary{background:var(--cta);border-color:var(--cta);color:var(--on-cta)}
.btn.primary:hover{opacity:.88}
.btn.ghost{border-color:transparent;background:transparent;color:var(--muted)}.btn.ghost:hover{color:var(--ink);background:var(--bg-hover)}
.btn.danger{color:var(--danger)}.btn.intervene{background:var(--intervene);border-color:var(--intervene);color:var(--on-intervene)}
.btn.sm{height:26px;padding:0 9px;font-size:12.5px}.btn.lg{height:40px;padding:0 18px;font-size:14.5px}
.btn[disabled]{opacity:.5;cursor:default}
/* touch: small buttons keep their look but take a 40px-tall tap (an invisible margin above and below); the composer bar and message actions keep theirs, so a tap meant for the message lands on it */
@media (pointer:coarse){.btn{position:relative}.btn::after{content:"";position:absolute;inset:-6px 0}.btn.sm::after{inset:-8px 0}.composer .btn::after,.entry .acts .btn::after{content:none}
  .side-link{height:40px}}
.btn:focus-visible,.input:focus-visible,a:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.input{height:32px;width:100%;padding:0 12px;border:1px solid var(--line-strong);border-radius:var(--r-sm);background:var(--bg);color:var(--text);font:inherit;
  transition:border-color .15s,box-shadow .15s}
.input:focus{outline:none;border-color:var(--faint);box-shadow:0 0 0 3px color-mix(in srgb,var(--faint) 22%,transparent)}
textarea.input{height:auto;min-height:84px;padding:10px 12px;resize:vertical;line-height:1.5}
select.input{appearance:none;padding-right:30px;background-image:linear-gradient(135deg,transparent 45%,var(--faint) 45%,var(--faint) 55%,transparent 55%),linear-gradient(45deg,transparent 45%,var(--faint) 45%,var(--faint) 55%,transparent 55%);
  background-repeat:no-repeat;background-position:right 15px center,right 10px center;background-size:6px 6px,6px 6px}
label.lbl{display:block;font-size:13px;font-weight:500;color:var(--ink);margin:0 0 6px}
.hint{font-size:12.5px;color:var(--muted);margin-top:6px}
.field+.field{margin-top:16px}
.seg{display:inline-flex;padding:2px;border:1px solid var(--line);border-radius:8px;background:var(--bg-subtle)}
.seg input{display:none}.seg label,.seg button{padding:4px 10px;border:0;border-radius:6px;background:none;font:inherit;font-size:13px;color:var(--muted);cursor:pointer}
.seg input:checked+label,.seg button[aria-pressed="true"]{background:var(--bg);color:var(--ink);box-shadow:var(--shadow);font-weight:500}.seg button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}

/* surfaces */
.card{border:1px solid var(--line);border-radius:var(--r);background:var(--bg);box-shadow:var(--shadow)}
.card.pad{padding:20px}
.section-title{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 14px}
@media (max-width:640px){.section-title{flex-wrap:wrap;align-items:flex-start}.section-title>div:first-child{flex-basis:100%}}
.divider{height:1px;background:var(--line);margin:20px 0}
.badge{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 8px;border-radius:999px;border:1px solid var(--line);
  font-size:12px;color:var(--muted);background:var(--bg)}
.dot{width:7px;height:7px;border-radius:50%;background:currentColor;display:inline-block;flex:none}
.live .dot{color:var(--ok);box-shadow:0 0 0 0 color-mix(in srgb,var(--ok) 50%,transparent);animation:pulse 2.4s infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--ok) 45%,transparent)}70%{box-shadow:0 0 0 7px transparent}100%{box-shadow:0 0 0 0 transparent}}
.type{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--muted)}
.type .dot{width:6px;height:6px}
/* Type chips are neutral (jxn #2858, the design language's secondaries): dot and label fall back to .type's muted. */
.type span:not(.dot){color:var(--muted)}

/* avatars */
.av{--h:220;width:28px;height:28px;flex:none;border-radius:50%;display:inline-grid;place-items:center;font-size:11.5px;font-weight:600;letter-spacing:.01em;
  background:hsl(var(--h) var(--av-s) var(--av-l));color:hsl(var(--h) 12% var(--av-c));user-select:none;position:relative;overflow:hidden}
.av.sm{width:22px;height:22px;font-size:10px}.av.xs{width:18px;height:18px;font-size:8px;flex:none}.av.lg{width:40px;height:40px;font-size:15px}
.av.agent{border-radius:7px}
.av-img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:inherit;opacity:0}
.av-img.ok{opacity:1}
.av.sm.agent{border-radius:5px}
.av-wrap{position:relative;display:inline-flex}
.av-wrap.live::after{content:"";position:absolute;right:-2px;bottom:-2px;width:8px;height:8px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 2px var(--bg)}
.badge.kind{height:18px;font-size:11px;padding:0 6px}
.entry .meta .via{font-size:12px;color:var(--faint)}
.badge.conn{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 40%,var(--line))}.badge.conn[hidden]{display:none}
.badge.kind.agent{color:var(--accent);border-color:color-mix(in srgb,var(--accent) 35%,var(--line))}
.avs{display:inline-flex}.avs .av{border:2px solid var(--bg);margin-left:-7px}.avs .av:first-child{margin-left:0}

/* lists & tables */
.list{border:1px solid var(--line);border-radius:var(--r);overflow:hidden;background:var(--bg)}
.list .item{display:flex;align-items:center;gap:14px;padding:10px 16px;border-top:1px solid var(--line);transition:background .12s}
.list .item:first-child{border-top:0}
.list a.item:hover{background:var(--bg-subtle)}
.tbl{width:100%;border-collapse:collapse;font-size:13.5px}
.tbl th{text-align:left;font-weight:500;color:var(--muted);font-size:12px;padding:8px 16px;border-bottom:1px solid var(--line);background:var(--bg-subtle);white-space:nowrap}
.tbl td{padding:9px 16px;border-top:1px solid var(--line);vertical-align:middle}
.tbl tr:first-child td{border-top:0}
.scroll-x{overflow-x:auto}
.sm-only{display:none}
.empty{text-align:center;padding:48px 20px;color:var(--muted)}
.empty h3{font-size:15px;margin-bottom:6px}

/* copy field */
.copy{position:relative;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--bg-subtle)}
.copy pre{margin:0;padding:12px 84px 12px 14px;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.55;color:var(--ink)}
.copy .btn{position:absolute;top:7px;right:7px}

/* dialog */
dialog{border:1px solid var(--line);border-radius:14px;padding:0;background:var(--bg);color:var(--text);box-shadow:var(--shadow-lg);
  width:min(560px,calc(100vw - 32px));max-height:calc(100vh - 64px)}
dialog::backdrop{background:rgba(0,0,0,.45)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) dialog{background:var(--bg-raised);border-color:var(--line-strong)}}
:root[data-theme="dark"] dialog{background:var(--bg-raised);border-color:var(--line-strong)}
dialog .hd{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:20px 22px 0}
dialog .bd{padding:16px 22px 22px}
.crop-dlg{width:min(360px,calc(100vw - 24px));max-height:calc(100dvh - 24px);margin:auto;overflow:hidden}
.crop-dlg[open]{display:flex;flex-direction:column}.crop-dlg .bd{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;padding:16px;min-height:0;overflow-y:auto}
.crop-dlg canvas{display:block;width:100%;height:auto;min-width:0;aspect-ratio:1;border-radius:12px;background:var(--bg-subtle);touch-action:none;cursor:grab}
.crop-dlg canvas:active{cursor:grabbing}.crop-row{display:flex;align-items:center;gap:10px;min-width:0}.crop-row .xs{flex:0 0 56px}.crop-row input[type=range]{flex:1 1 0;min-width:0;accent-color:var(--ink)}
.crop-foot{display:flex;justify-content:space-between;gap:12px;padding:0 16px 16px}
dialog[open]{animation:pop .16s ease-out}dialog:focus{outline:none}@media (prefers-reduced-motion:reduce){dialog[open]{animation:none}}
@keyframes pop{from{opacity:0;transform:translateY(6px) scale(.985)}to{opacity:1;transform:none}}

/* flash / toast */
.flash{padding:12px 14px;border-radius:var(--r-sm);border:1px solid var(--line);background:var(--bg-subtle);font-size:13.5px}
.flash.ok{border-color:color-mix(in srgb,var(--ok) 35%,var(--line))}
.flash.err{border-color:color-mix(in srgb,var(--danger) 40%,var(--line));color:var(--danger)}
#toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%) translateY(20px);opacity:0;pointer-events:none;
  background:var(--ink);color:var(--on-ink);padding:9px 14px;border-radius:8px;font-size:13px;transition:all .2s;z-index:50}
#toast.show{opacity:1;transform:translateX(-50%)}

/* board */
.crumbs{font-size:13px;color:var(--muted);margin-bottom:8px}.crumbs a:hover{color:var(--ink)}
.layout{display:grid;gap:28px;grid-template-columns:minmax(0,1fr)}
@media(min-width:960px){.layout{grid-template-columns:minmax(0,1fr) 300px}.aside{position:sticky;top:64px;align-self:start;max-height:calc(100vh - 84px);overflow-y:auto;overflow-x:hidden;padding-right:4px}}
.thread{display:flex;flex-direction:column}
.entry{display:flex;gap:12px;padding:16px 0;border-top:1px solid var(--line)}
.catch-up{display:flex;justify-content:center;margin:10px 0 8px}.catch-up .btn{border-radius:999px;gap:6px}
.rc-src{margin-top:14px;padding-top:10px;border-top:1px solid var(--line)}
.new-line{display:flex;align-items:center;gap:8px;margin:0;font-size:11px;line-height:1;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--unread)}.new-line span{line-height:1;padding-top:1px}.new-line::after{content:"";flex:1;height:1px;background:color-mix(in srgb,var(--unread) 45%,transparent)}.new-line+.entry{border-top-color:transparent}
.thread>.entry:first-child{border-top:0;padding-top:4px}
.entry .meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px;line-height:20px}
.entry .who{font-weight:600;color:var(--ink)}
.entry .to{color:var(--muted)}
.entry .when,.entry .seq{color:var(--faint);font-size:12.5px}
.entry [data-edit-box]{display:block;width:100%;min-height:100px;resize:vertical;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);font:inherit}
.entry [data-edit-box]+.btn{margin-top:8px;margin-right:6px}
.entry [data-version-list]{margin:8px 0;padding:8px 10px;border-left:2px solid var(--line);color:var(--muted);font-size:13px}
.entry [data-version-list]>div+div{margin-top:8px;padding-top:8px;border-top:1px solid var(--line)}
.entry .seq:hover{color:var(--ink)}
.entry .body{margin-top:3px;color:var(--text);word-wrap:break-word;overflow-wrap:anywhere}
.entry .body p+p{margin-top:8px}
.body ul,.body ol{margin:6px 0;padding-left:20px}.body li{margin:2px 0}
.body li.ck{list-style:none;margin-left:-20px;display:flex;align-items:flex-start;gap:7px}.body li.ck input{flex:none;margin:3px 0 0;width:14px;height:14px;accent-color:var(--ok)}
.body li.ck.done>span{color:var(--muted);text-decoration:line-through;text-decoration-color:color-mix(in srgb,var(--muted) 60%,transparent)}
.body li.ck input:enabled{cursor:pointer}.body li.ck input:disabled{opacity:1}
.body .md-h{margin:12px 0 4px;font-size:14px;color:var(--ink)}.body .md-h:first-child{margin-top:0}
.entry .body pre{background:var(--bg-subtle);border:1px solid var(--line);border-radius:8px;padding:10px 12px;overflow-x:auto;margin:8px 0;white-space:pre}
.entry .body code{background:var(--bg-hover);padding:1px 5px;border-radius:4px}
.entry .body pre code{background:none;padding:0}
.entry .body a{color:var(--accent);text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:2px}
.entry .refs{margin-top:6px;font-size:12.5px;color:var(--faint)}
.entry .refs a:hover{color:var(--ink)}
.entry.flash-in{animation:flashin 1.6s ease-out,entryin .32s cubic-bezier(.2,.7,.3,1)}
@keyframes entryin{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}} /* new messages rise in gently (jxn #1366) */
@media(prefers-reduced-motion:reduce){.entry.flash-in{animation:flashin 1.6s ease-out}}
/* Long boards scroll smoothly (jxn #1365): only messages near the view are on the page (the rest are placeholders, see
   ghostSync), so each one is laid out for real; a placeholder keeps its exact height and a faint line where its text was. */
#thread>.ghost{border-top:1px solid var(--line);box-sizing:border-box;overflow:hidden}#thread>.ghost>*{display:none}
#thread>.ghost::before{content:"";display:block;margin:20px 0 0 44px;width:min(40%,280px);height:10px;border-radius:5px;background:color-mix(in srgb,var(--muted) 10%,transparent)}
.entry .rbadge{display:none;height:18px;font-size:11px}
.entry .fbadge{height:18px;font-size:11px;color:var(--warn);border-color:color-mix(in srgb,var(--warn) 40%,var(--line))}
.entry .fbadge.quoted{color:var(--muted);border-color:var(--line)}
.entry.retracted>.grow>.body,.entry.retracted>.grow>.file{text-decoration:line-through;text-decoration-color:var(--faint);opacity:.55}
.body.purged p{color:var(--muted);font-style:italic} /* purged (#3853): the placeholder, not the words */
#purge-dlg .pg-rotate{margin:0}
.entry.retracted>.grow>.meta .rbadge{display:inline-flex}
/* Display (Account → Display): text size and density for the chat; saved per person so web and app match. */
:root[data-text="s"] .entry .body{font-size:12.5px}:root[data-text="s"] .entry .meta{font-size:12px}
:root[data-text="l"] .entry .body{font-size:15.5px;line-height:1.55}:root[data-text="l"] .entry .meta{font-size:14px}
:root[data-text="l"] .entry .body code,:root[data-text="l"] .entry .body pre{font-size:14px}
:root[data-text="l"] .composer textarea{font-size:15.5px}
:root[data-density="compact"] .entry{padding:7px 0;gap:10px}:root[data-density="compact"] .thread>.entry:first-child{padding-top:4px}:root[data-density="compact"] .replies .entry{padding:4px 0 0}
:root[data-density="compact"] .entry .body{margin-top:0}:root[data-density="compact"] .entry .body p+p{margin-top:4px}
.dp-lang{max-width:300px}.dp-voice-row{display:flex;gap:8px;align-items:center}.dp-voice{width:180px;max-width:100%}.dp-grid{display:grid;grid-template-columns:fit-content(240px) minmax(0,1fr);gap:12px 20px;align-items:center;justify-items:start}.dp-grid .lbl{margin:0;font-size:13px;font-weight:500;color:var(--ink)}
.dp-grid .seg{flex-wrap:wrap}.dp-grid .seg input{display:inline;position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}
.dp-grid .seg input:focus-visible+label{outline:2px solid var(--accent);outline-offset:1px}
@media (max-width:640px){.dp-grid{grid-template-columns:minmax(0,1fr);gap:6px}.dp-grid .lbl:not(:first-child){margin-top:8px}.dp-grid .seg{display:flex;justify-self:stretch;flex-wrap:nowrap}.dp-grid .seg label{flex:1 1 0;text-align:center}}
.entry .acts{margin-left:auto;display:inline-flex;gap:2px;opacity:0;transition:opacity .12s}
.entry:hover>.grow>.meta>.acts,.entry .acts:focus-within,.entry .acts:has(.danger){opacity:1} /* only the message under the pointer, not its whole thread */
/* Retract takes no room in the header line, so narrow screens don't get a blank line under every entry. Touch
   screens have no hover: there it appears on the entry you opened (tap its #number). */
.entry{position:relative}
/* The hover toolbar floats in the gap above the message (never over its text), like a small card. */
@media(hover:hover){.entry .acts{position:absolute;top:-13px;right:6px;z-index:3;padding:1px;background:var(--bg);border:1px solid var(--line);border-radius:8px;box-shadow:var(--shadow)}
  .entry .acts .btn.sm{height:24px;padding:0 7px} /* a little tighter: the bar stays clear of the sender line's time (opus-b, #4140) */.entry .acts .rx-q{width:26px}#thread>.entry:first-child .acts{top:2px}
  .entry .meta [data-history]{position:relative;z-index:4}}
/* "edited" reads with the time, "1m ago · edited" (jxn #4287): quiet text that opens the history, not a pill. */
.meta .edited{border:0;padding:0;margin:0 0 0 -4px;background:none;font:inherit;font-size:12.5px;color:var(--muted);cursor:pointer}.meta .edited::before{content:"· "}.meta .edited:hover{color:var(--ink);text-decoration:underline} /* "edited" stays clickable under the hover bar (own messages sit on the right) */
.more-acts{display:none}
@media(hover:none){.entry .meta>.more-acts{display:inline-flex;align-items:center;justify-content:center;margin-left:auto;width:32px;height:24px;padding:0;border:0;border-radius:6px;background:none;color:var(--muted);font-size:18px;line-height:1;letter-spacing:1px;cursor:pointer}
  .entry .meta>.more-acts[aria-expanded="true"]{background:var(--bg-hover);color:var(--ink)}
  .entry.tap>.grow>.meta>.acts,.entry:target>.grow>.meta>.acts{flex-basis:100%;margin-left:0}}
/* iOS Safari only sends a tap on plain content to a page-level click handler when it looks clickable: without this, tapping a message to reply did nothing on iPhones (jxn #888) */
@media(hover:none){#thread .entry{cursor:pointer;-webkit-tap-highlight-color:transparent}}
@media(hover:none){.entry .acts{display:none;flex-wrap:wrap;max-width:100%;row-gap:4px} /* narrow phones and threads: the actions wrap instead of running off screen */.entry:target>.grow>.meta .acts,.entry.sel>.grow>.meta .acts,.entry.tap>.grow>.meta .acts{display:inline-flex;opacity:1}}
/* "Replying to …" above the composer: the reply goes to that agent (or mentions that person). */
/* replying: a slim line above the composer's text (who, and the first line of what you're answering) */
.replying{display:flex;align-items:center;gap:6px;margin:0 0 8px;padding-block:2px;padding-inline:10px 2px;border-inline-start:2px solid var(--accent);font-size:12.5px;color:var(--muted)}
.replying[hidden]{display:none}
.replying .rp-go{all:unset;flex:1;min-width:0;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:22px}
.replying .rp-go:focus-visible{outline:2px solid var(--accent);outline-offset:1px;border-radius:4px}
.replying b{color:var(--text);font-weight:550}.replying .rp-go:hover b{text-decoration:underline}
.replying .rp-text{color:var(--faint)}.replying .rp-text:empty{display:none}.replying .rp-text::before{content:": "}
.replying .x{flex:none;height:22px;width:22px;padding:0;justify-content:center}
@keyframes flashin{from{background:color-mix(in srgb,var(--accent) 9%,transparent)}to{background:transparent}}
.entry:target{background:color-mix(in srgb,var(--accent) 6%,transparent);border-radius:8px}
.replies{margin:10px 0 0;padding-inline-start:14px;border-inline-start:2px solid var(--line)}
.replies:empty{display:none}
.replies .entry{border-top:0;padding:10px 0 0}
.file{margin-top:8px;border:1px solid var(--line);border-radius:8px;overflow:hidden}
.file .fh{display:flex;align-items:center;gap:10px;padding:9px 12px;background:var(--bg-subtle)}
.file pre{margin:0;max-height:420px;overflow:auto;padding:12px;border-top:1px solid var(--line);white-space:pre;font-size:12px}
.t-change{color:var(--accent)}.t-handoff{color:var(--ok)}
/* Members & access */
dialog.access-dlg{width:min(640px,calc(100vw - 24px))}
/* Invite an agent (#1855): a small + after the members' faces, and a two-choice dialog */
.av-add{flex:none;display:inline-grid;place-items:center;width:22px;height:22px;border-radius:50%;border:1px dashed var(--line-strong);background:transparent;color:var(--muted);cursor:pointer;padding:0}.av-add:hover{color:var(--ink);border-color:var(--ink)}
dialog.ia-dlg{width:min(560px,calc(100vw - 24px))}.ia-opt h3{margin:0 0 4px;font-size:14px}.ia-opt+.ia-opt{border-top:1px solid var(--line);padding-top:14px}.ia-opt .copy{margin:8px 0}.ia-opt form{margin-top:8px;flex-wrap:wrap}
.acc-sec{padding:14px 0;border-top:1px solid var(--line)}.acc-sec:first-child{border-top:0;padding-top:0}
.acc-sec h3{font-size:12.5px;font-weight:600;color:var(--ink);margin:0 0 8px}.acc-sec summary{cursor:pointer}
.acc-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.acc-sel{width:auto;height:30px;font-size:12.5px;padding:0 8px}
/* phones: a member's name on one line, role and end date side by side under it, lined up with the name */
@media(max-width:640px){#acc-members{gap:12px}#acc-members .acc-row{display:grid;grid-template-columns:auto auto minmax(0,1fr);gap:6px 8px}#acc-members .acc-row>.grow{grid-column:2/4}#acc-members .acc-sel{grid-row:2;width:100%;min-width:0;padding-right:26px;background-position:right 9px center}#acc-members .acc-sel:first-of-type{grid-column:2}#acc-members .acc-sel:last-of-type{grid-column:3}}
@media(max-width:360px){#acc-members .acc-sel:first-of-type{grid-column:1/3}#acc-members .acc-sel{font-size:12.5px;padding-left:8px;padding-right:22px;background-position:right 6px center}} /* the narrowest phones: the role starts under the picture so the end date fits (Onest runs a little wider than Geist did) */
.add-agent{display:block;width:100%;margin:0 0 22px;font:inherit;color:var(--ink);text-align:start;cursor:pointer}.add-agent:hover{border-color:var(--line-strong)}.add-agent-plus{font-weight:600;color:var(--muted);margin-inline-end:8px}
/* Everyday: "Bring your assistant" (/welcome), the home banner that points to it, and Account's "Your assistant" card.
   Plain words, big tiles; headings a step above the web's h1 like the Everyday mockups (ios/qa/design/everyday). */
.ev{max-width:560px;margin:4px auto 0}
.ev h1{font-size:26px;line-height:1.2;letter-spacing:-.03em;margin:16px 0 8px}
.ev-lede{font-size:15px;line-height:1.55;color:var(--muted)}
.ev-now{margin-top:12px;font-size:13.5px;color:var(--ok)}
.ev-list{margin-top:22px}
.ev-row{display:flex;align-items:center;gap:14px;padding:14px 16px;border-top:1px solid var(--line)}
.ev-row:first-child{border-top:0}
.ev-ic{flex:none;width:40px;height:40px;border-radius:10px;display:grid;place-items:center;background:var(--bg-subtle);border:1px solid var(--line-strong);color:var(--ink);font-weight:600;font-size:16px}
.ev-ic .pebble{width:28px;height:28px}
.ev-name{font-size:16px;font-weight:600;color:var(--ink);line-height:1.3}
.ev-sub{font-size:13px;color:var(--muted);line-height:1.4}
.ev-sub .ok{color:var(--ok)}
.ev-row>.btn{flex:none;height:36px;padding:0 16px;font-size:14px}
.ev-soon{flex:none;white-space:nowrap}
.ev-or{display:flex;align-items:center;gap:12px;margin:18px 0;color:var(--faint);font-size:13px}
.ev-or::before,.ev-or::after{content:"";flex:1;height:1px;background:var(--line)}
.ev-own{border-color:color-mix(in srgb,var(--ink) 25%,var(--line));background:color-mix(in srgb,var(--ink) 3%,var(--bg))}
.ev-own .ev-ic{background:transparent;border-color:transparent}
.ev-foot-links{margin-top:28px;display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center;font-size:13.5px;color:var(--muted)}
.ev-foot-links a{color:var(--accent)}.ev-foot-links a:hover{text-decoration:underline}
dialog.ev-sheet{width:min(480px,calc(100vw - 32px))}
.ev-sheet .hd h2{font-size:18px}
.ev-intro{font-size:14px;color:var(--muted);line-height:1.5}
.ev-steps{list-style:none;counter-reset:ev;margin:16px 0 0;padding:0}
.ev-steps>li{counter-increment:ev;position:relative;padding:0 0 18px 38px;font-size:14.5px;line-height:1.5;color:var(--text)}
.ev-steps>li::before{content:counter(ev);position:absolute;left:0;top:-1px;width:26px;height:26px;border-radius:50%;background:var(--bg-hover);border:1px solid var(--line);color:var(--ink);font-weight:600;font-size:13px;display:grid;place-items:center}
.ev-steps b{color:var(--ink);font-weight:600}
.ev-copy{display:flex;width:100%;margin-top:10px;height:46px;font-size:15.5px}
.ev-link{margin-top:8px;padding:8px 10px;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--bg-subtle);color:var(--muted);font-size:12.5px;overflow-wrap:anywhere;user-select:all}
.ev-open{margin-top:10px;height:38px;font-size:14px}
.ev-note{margin:0 0 14px;padding:10px 12px;border-radius:var(--r-sm);background:var(--bg-subtle);border:1px solid var(--line);font-size:13px;color:var(--muted);line-height:1.5}
.ev-alt{margin:0 0 14px;font-size:13px;color:var(--muted);line-height:1.5}
.ev-alt .btn{margin-top:6px}
.ev-done{display:flex;align-items:center;gap:12px;flex-wrap:wrap;border-top:1px solid var(--line);padding-top:14px}
.ev-done .btn{height:42px;padding:0 20px;font-size:15px}
.ev-status{flex:1;min-width:160px;font-size:13.5px;color:var(--muted)}
.ev-status.ok{color:var(--ok);font-size:16px;font-weight:600}
.ev-banner{display:flex;align-items:center;gap:14px;margin:0 0 22px;padding:16px 18px}
.ev-banner .pebble{flex:none;width:36px;height:36px}
.ev-banner b{display:block;font-size:15px;color:var(--ink)}
.ev-banner .ev-acts{display:flex;align-items:center;gap:6px;flex:none}
.ev-acct{display:flex;align-items:center;gap:14px;padding:14px 16px;color:inherit}
a.ev-acct:hover{background:var(--bg-subtle)}
.ev-acct .ev-chg{flex:none;color:var(--muted);font-size:13.5px}
@media (max-width:640px){
  dialog.ev-sheet{width:100%;max-width:100%;margin:auto 0 0;border-radius:16px 16px 0 0;max-height:92dvh;border-bottom:0}
  .ev h1{font-size:24px}
  .ev-banner{flex-wrap:wrap}.ev-banner .grow{flex-basis:calc(100% - 50px)}.ev-banner .ev-acts{width:100%;justify-content:flex-end}
}
@media (max-width:360px){.ev-row{gap:10px;padding:12px}.ev-ic{width:34px;height:34px;font-size:14px}.ev-row>.btn{padding:0 12px}.ev-name{font-size:15px}}
.cn-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}@media (max-width:560px){.cn-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
.cn-tile{display:grid;grid-template-columns:20px minmax(0,1fr);column-gap:10px;row-gap:2px;align-items:center;justify-items:start;padding:10px 12px;border:1px solid var(--line);border-radius:var(--r);background:var(--bg);color:var(--ink);font:inherit;text-align:left;cursor:pointer;text-decoration:none}.cn-tile:hover{border-color:var(--line-strong);background:var(--bg-subtle)}.cn-tile .cn-logo{grid-row:span 2}.cn-tile b{font-size:13.5px;font-weight:600}.cn-tile span{font-size:12px;color:var(--muted)}
.cn-list{list-style:none;margin:4px 0 0;padding:0;display:flex;flex-direction:column;gap:10px}.cn-list li>.copy{margin-top:5px}
.doc-code{margin:0;font-size:12.5px;line-height:1.55;white-space:pre-wrap;word-break:break-word}
@media (max-width:640px){.pfp{flex-wrap:wrap}.pfp>.row:last-child{flex-basis:100%;justify-content:flex-start}}
.pf-grid{display:grid;grid-template-columns:110px 1fr;gap:10px 14px;align-items:center}.pf-grid .lbl{margin:0}.pf-grid textarea{resize:vertical;min-height:56px}
.pf-check{display:flex;gap:10px;align-items:flex-start;cursor:pointer}.pf-check input{margin-top:3px}.pf-check>span{display:flex;flex-direction:column;gap:1px}
@media (max-width:640px){.pf-grid{grid-template-columns:1fr;gap:6px}}
@media (max-width:640px){.boards-bar{flex-wrap:wrap}.boards-bar .bsearch{flex-basis:100%}}
.tk.cl:not(:has(.cl-f:not([hidden]))){flex-wrap:nowrap}.tk.cl>.tk-who,.tk.cl>.cl-cmd{flex:0 1 auto;min-width:0}.tk.cl>.tk-st,.tk.cl>.btn{flex:none}
.cl-cmd{display:inline-flex;align-items:center;gap:4px;max-width:260px;min-width:0;height:22px;padding:0 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--text);font-size:11.5px;cursor:pointer}.cl-cmd:hover:not([disabled]){border-color:var(--line-strong);color:var(--ink)}.cl-cmd[disabled]{cursor:default;color:var(--muted)}.cl-cmd>span:first-child{color:var(--faint)}
/* Board info → Agents */
.ag h3{margin-top:0}.ag-list{list-style:none;margin:0 0 6px;padding:0}.ag-row{display:flex;align-items:center;gap:8px;padding:4px 0;font-size:13px;min-width:0}
.ag-name{color:var(--ink);font-weight:500}.ag-main{display:flex;flex-direction:column;min-width:0}.ag-status{font-size:12px;color:var(--muted)}.ag-row time{font-size:11.5px;color:var(--faint);flex:none}.ag-hint{margin:8px 0 4px}.ag .copy pre{font-size:11.5px}
.ag-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;vertical-align:1px;box-sizing:border-box}.ag-dot.idle{background:var(--muted);opacity:.7}.ag-dot.gone{border:1.5px solid var(--faint)}
.ag-row[data-state="gone"] .ag-name{color:var(--muted)}
.ag{padding-bottom:14px;margin-bottom:14px;border-bottom:1px solid var(--line)}
/* Board info → Charter */
.ch-lead{margin:0 0 8px}.ch-dl{margin:0}.ch-dl dt{margin-top:8px;font-size:11px;letter-spacing:.02em;text-transform:uppercase;color:var(--faint)}.ch-dl dd{margin:2px 0 0;font-size:13px;color:var(--text);white-space:pre-wrap}
/* A person's display name, and their real @handle beside it when the name reads like someone else's (jxn #4369). */
.pn-h{color:var(--faint);font-weight:400;font-size:.92em}
.ch-classes{display:flex;flex-wrap:wrap;gap:4px}.ch-members{list-style:none;margin:0;padding:0}.ch-members li{font-size:13px;padding:2px 0}
#ch-form:not([hidden]),#ch-notes{display:flex;flex-direction:column;gap:8px;margin-top:8px}.ch-note{display:flex;align-items:center;gap:8px}.ch-note .xs{width:7em;flex:none}
.ch-err{color:var(--danger);min-height:1em;margin:0}#ch-form .lbl{margin:0}
.kill{display:flex;align-items:center;gap:14px;margin-top:12px;padding:12px 14px;border:1px solid color-mix(in srgb,var(--intervene) 40%,var(--line));border-radius:var(--r)}.kill b{color:var(--ink);font-size:13px}.kill p{margin:2px 0 0}
.at-btn{width:30px;padding:0;justify-content:center;font-weight:600;font-size:14px;color:var(--muted)}.at-btn:hover{color:var(--ink)}
/* quotes (forwarded messages) */
.body blockquote.md-q{margin:6px 0;padding:6px 10px;border-inline-start:3px solid var(--line-strong);background:var(--bg-subtle);border-radius:0 6px 6px 0;color:var(--text)}
/* a quoted selection (vedu #1022): a compact box with who said it and ↗ original */
.body blockquote.qt{max-width:560px;padding:7px 11px;border:1px solid var(--line);border-radius:10px}
.qt-hd{display:flex;align-items:baseline;gap:10px;margin-bottom:2px;font-size:12.5px}.qt-who{font-weight:600;color:var(--ink);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.qt-go{margin-left:auto;flex:none;text-decoration:none}.qt-go:hover{text-decoration:underline}
.sel-float{position:fixed;z-index:60;display:flex;gap:6px;box-shadow:var(--shadow-lg);border-radius:var(--r-sm);background:var(--bg);padding:4px}
/* multi-select and forward (vedu #4601): an in-flow gutter survives message highlight padding. */
.sel-bar{display:none;align-items:center;gap:10px;padding:10px 12px;margin-bottom:8px;font-size:13px}.selecting .sel-bar:not([hidden]){display:flex}
.selecting .composer,.selecting #thread .rd,.selecting .rail,.selecting .rail-tip{display:none}.selecting #thread .entry{cursor:pointer}.selecting .entry .acts,.selecting .entry .more-acts{display:none!important}
.selecting #thread .entry::before{content:"";flex:none;align-self:flex-start;margin-top:6px;width:16px;height:16px;border:1.5px solid var(--line-strong);border-radius:50%;background:var(--bg)}
.selecting #thread .entry.picked::before{border-color:var(--accent);background:var(--accent);box-shadow:inset 0 0 0 3px var(--bg)}
.selecting #thread .entry.picked{background:color-mix(in srgb,var(--accent) 9%,var(--bg));border-radius:8px}
.fwd-dlg{width:min(520px,calc(100vw - 24px))}.fwd-list{list-style:none;margin:0;padding:0;max-height:220px;overflow:auto;border:1px solid var(--line);border-radius:var(--r-sm)}
.fwd-list li{display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:pointer;font-size:13px;min-width:0}.fwd-list li+li{border-top:1px solid var(--line)}
.fwd-list li:hover{background:var(--bg-hover)}.fwd-list li[aria-selected="true"]{background:color-mix(in srgb,var(--accent) 9%,var(--bg));color:var(--ink)}
.fwd-dot{width:8px;height:8px;border-radius:2px;background:var(--faint);flex:none}
.fwd-prev{max-height:160px;overflow:auto;display:flex;flex-direction:column;gap:6px}.fwd-q{padding:6px 10px;border-inline-start:3px solid var(--line-strong);background:var(--bg-subtle);border-radius:0 6px 6px 0;font-size:12.5px;min-width:0}
.badge.hdl{position:relative;z-index:4;height:18px;font-size:11px;color:var(--accent);border-color:color-mix(in srgb,var(--accent) 35%,var(--line))}
.badge.hdl.done{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 35%,var(--line))}
.hdl-prog{margin-top:4px;color:var(--muted);overflow-wrap:anywhere}.hdl-prog.stalled{color:var(--intervene)} /* the agent's progress under a message it's on (#2498) */
.badge.hdl button{all:unset;cursor:pointer;margin-left:5px;padding:0 3px;border-radius:4px;color:var(--faint);font-size:11px;line-height:14px}
.badge.hdl button:hover{background:var(--bg-hover);color:var(--ink)}
.badge.hdl button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.bc-last{margin:6px 0 0;font-size:13px;color:var(--muted);line-height:1.4}.bc-last b{color:var(--text);font-weight:500}
/* board settings: triggers (a rule per line; yours have Pause / Delete) and the form to add one */
.acc-sec[hidden]{display:none}.trg-row{display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-top:1px solid var(--line)}.trg-row:first-child{border-top:0;padding-top:0}.trg-row.off .small{color:var(--muted)}
.trg-p{margin-top:2px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}.trg-acts{flex:none;gap:2px}
.trg-new{display:flex;flex-direction:column;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid var(--line)}
.trg-when,.trg-wake{display:flex;align-items:center;gap:8px;min-width:0}.trg-when .acc-url{flex:1;min-width:0}.trg-when .acc-url[hidden]{display:none}.trg-wake .acc-sel{flex:1;min-width:0}
.trg-new textarea.input{min-height:60px;font-size:13px}
/* board settings: schedules (shared crons): a row each with an on/off switch, and the add form (time, zone, day chips) */
.sch-new .acc-url{width:100%}.sch-when{display:flex;align-items:center;gap:8px;min-width:0}.sch-when #sch-at{flex:none;width:auto}.sch-when .acc-sel{flex:1;min-width:0}
.sch-days{display:flex;flex-wrap:wrap;gap:6px}
.sch-day{height:28px;min-width:44px;padding:0 10px;border-radius:999px;border:1px solid var(--line);background:var(--bg-subtle);color:var(--muted);font:inherit;font-size:12.5px;cursor:pointer}
.sch-day:hover{border-color:var(--line-strong)}.sch-day[aria-pressed="true"]{border-color:color-mix(in srgb,var(--accent) 55%,var(--line));background:color-mix(in srgb,var(--accent) 10%,var(--bg));color:var(--accent)}
.sch-day:focus-visible,.sch-tog:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.sch-tog{position:relative;flex:none;width:34px;height:20px;margin:4px 6px 0 0;padding:0;border:0;border-radius:999px;background:var(--line-strong);cursor:pointer}
.sch-tog span{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--bg);box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s}
.sch-tog[aria-checked="true"]{background:var(--accent)}.sch-tog[aria-checked="true"] span{transform:translateX(14px)}
.sch-row .trg-acts{align-items:flex-start}.sch-row.off .small b{color:var(--muted)}
@media(max-width:640px){.sch-row .trg-acts{margin-left:0;gap:10px;align-items:center}.sch-row .sch-tog{margin:0}}
@media(max-width:640px){.trg-when{flex-wrap:wrap}.trg-when .acc-sel{flex:1 1 100%;min-width:0;width:100%}.trg-row{flex-wrap:wrap;row-gap:2px}.trg-row>.grow{flex-basis:100%}.trg-acts{margin-left:-9px}}
.acc-url{font-size:12px;height:30px}.acc-to{position:relative;min-width:200px}.acc-to .input{width:100%}
.acc-sug{position:absolute;left:0;right:0;top:calc(100% + 4px);z-index:5;list-style:none;margin:0;padding:4px;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--bg);box-shadow:var(--shadow-lg)}
.acc-sug[hidden]{display:none}.acc-sug li{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;font-size:13px;cursor:pointer;min-width:0}
.acc-sug li[aria-selected="true"],.acc-sug li:hover{background:var(--bg-hover)}
.acc-list{list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column;gap:8px}
/* Access across your boards (#3568): each owned board's grants under it; a mark on what's worth reviewing */
.acc-all-g{list-style:none;margin:6px 0 0;padding:0 0 0 12px;border-left:2px solid var(--line);display:grid;gap:6px}
.acc-all-r{display:flex;align-items:center;gap:8px;min-width:0}.acc-all-r .grow{min-width:0;overflow-wrap:anywhere}.acc-rv{color:var(--warn);font-weight:500}
.sr-list{list-style:none;margin:0;padding:0;display:grid;gap:6px}.sr-row{display:flex;align-items:center;gap:8px;min-width:0}.sr-row .grow{min-width:0;overflow-wrap:anywhere}
.sr-form{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:12px;padding-top:12px;border-top:1px solid var(--line)}.sr-form .input{width:auto;flex:1 1 150px;min-width:0}.sr-form [hidden]{display:none}.sr-err{color:var(--danger);margin:0;flex-basis:100%}
@media (max-width:600px){.sr-form [name="action"]{flex-basis:100%}}
.acc-dl{margin:10px 0 0} /* the full access log as JSON (#3375): the list above is only the latest 50 */
.sum h3 .linkish,.linkish{border:0;background:none;padding:0;font:inherit;font-size:12px;color:var(--accent);cursor:pointer;text-decoration:underline;text-underline-offset:2px}.linkish:hover{text-decoration-thickness:2px}
/* view-only members: nothing that writes */
.ro .composer,.ro [data-qr],.ro [data-rx-add],.ro button[data-reply],.ro .rx-add,.ro [data-tk],.ro .kb-new,.ro #doc-new,.ro #doc-edit{display:none!important}
.ro .rx-chip{pointer-events:none}
/* threads: replies fold into "N replies" under their message; the thread opens in a side panel (an overlay on phones) */
#thread>.entry>.grow>.replies{display:none}#thread>.entry.thr-open>.grow>.replies{display:block}
/* Replies post in the conversation (jxn #1040): a bar quoting what they answer; the thread opens as an overlay */
.rq{display:flex;flex-direction:column;align-items:flex-start;gap:1px;max-width:100%;margin:4px 0 2px;padding:4px 10px;border:0;border-inline-start:3px solid var(--line-strong);border-radius:0 8px 8px 0;background:var(--bg-subtle);color:var(--muted);font:inherit;font-size:12.5px;text-align:left;cursor:pointer}
.rq:hover{background:var(--bg-hover);border-inline-start-color:var(--muted)}.rq-who{font-weight:600;color:var(--text)}.rq-t{display:block;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.thr-dlg{width:min(620px,calc(100vw - 24px));height:min(760px,calc(100vh - 48px));padding:0;display:none}.thr-dlg[open]{display:flex;flex-direction:column}
.thr-hd{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 16px;border-bottom:1px solid var(--line)}.thr-hd b{color:var(--ink)}.thr-hd .grow{flex:1}
.thr-list{flex:1;overflow:auto;padding:4px 16px 12px}.thr-list>.entry:first-child{border-top:0}.thr-list>.entry.hit{background:color-mix(in srgb,var(--accent) 7%,transparent)}
.thr-dlg>.composer.in-thr{margin:0 12px 12px;flex:none}.thr-dlg>.typing{margin:0 12px 6px 16px;flex:none}.composer.in-thr .replying{display:none}.composer.in-thr .input{max-height:30vh}
@media (max-width:640px){.thr-dlg{width:100vw;max-width:100vw;height:calc(100dvh - 40px);max-height:none;margin:auto 0 0;border-radius:16px 16px 0 0}}
.thr-sum{display:flex;flex-direction:column;align-items:stretch;gap:2px;width:fit-content;max-width:100%;margin-top:6px;padding:3px 10px 4px 4px;text-align:left;border:1px solid transparent;border-radius:8px;background:none;font:inherit;font-size:12.5px;color:var(--accent);cursor:pointer}
.thr-sum:hover{border-color:var(--line);background:var(--bg-subtle)}.thr-sum .faint{color:var(--faint)}
.thr-sum .avs .av{width:20px;height:20px;font-size:8.5px}
.thr-head{display:inline-flex;align-items:center;gap:8px}
.thr-line{display:block;padding-left:4px;font-size:12.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.thr-line b{color:var(--text);font-weight:500}
.entry.hit{background:var(--mark);border-radius:8px;transition:background .6s} /* a tint, no side bar: an inset bar bends around the rounded corners (jxn #1086) */
/* a task in the conversation: status, priority, who it's for / who holds it, and Claim · Done · Open */
.tk{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px;padding:6px 6px 6px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg-subtle);font-size:12.5px}
.tk[hidden]{display:none}
.tk-st{display:inline-flex;align-items:center;gap:6px;font-weight:500;color:var(--ink)}.tk-st .dot{width:8px;height:8px;border-radius:50%;background:var(--muted)}
.st-doing .dot{background:var(--accent)}.st-blocked .dot,.st-stopped .dot{background:var(--warn)}.st-done .dot{background:var(--ok)}
.cl-asserted{color:var(--muted);font-weight:400}.cl-evidenced .dot{background:var(--task)}.cl-verified{color:var(--ok)}.cl-verified .dot{background:var(--ok)}.cl-disputed{color:var(--danger)}.cl-disputed .dot{background:var(--danger)}
.cl-ev a{color:var(--muted);text-decoration:underline;text-decoration-color:var(--line-strong);text-underline-offset:2px}.cl-ev a:hover{color:var(--ink)}
.cl-acts{display:contents}.cl-f{display:flex;gap:6px;flex-basis:100%}.cl-f[hidden]{display:none}.cl-f .input{flex:1;height:28px;font-size:12.5px}
/* Human decisions: a person's decision, decided by the people (pill · who's agreed · Agree / Object · Close for its author) */
.hd-open .tk-st .dot{background:var(--decision)}.hd-decided .tk-st{color:var(--ok)}.hd-decided .tk-st .dot{background:var(--ok)}.hd-dropped .tk-st{color:var(--muted)}.hd-dropped .tk-st .dot{background:var(--muted)}
.hd-ms{display:inline-flex;align-items:center;gap:5px}.hd-m{position:relative;display:inline-flex}.hd-m .av{width:20px;height:20px;font-size:8.5px}.hd-m.w .av{background:transparent;color:var(--muted);border:1px dashed var(--muted)}.hd-m.w .av-img{opacity:.5} /* hasn't voted: an empty dashed ring with readable initials (faded initials fell to 2:1) */
.hd-m i{position:absolute;right:-4px;bottom:-3px;width:12px;height:12px;border-radius:50%;display:grid;place-items:center;font-size:8px;font-style:normal;font-weight:700;line-height:1;color:var(--on-fill);box-shadow:0 0 0 1.5px var(--bg-subtle)}
.hd-m.y i{background:var(--ok)}.hd-m.n i{background:var(--danger)}
.hd-b.on-y{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 40%,var(--line))}.hd-b.on-n{color:var(--danger);border-color:color-mix(in srgb,var(--danger) 40%,var(--line))}
.hd-note{flex-basis:100%;min-width:0;color:var(--muted);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.hd-note b{color:var(--text);font-weight:500}
.hd-out{display:inline-flex;gap:6px}.hd-out[hidden],.hd-f .btn[hidden]{display:none}
.badge.stale{height:18px;font-size:11px;color:var(--warn);border-color:color-mix(in srgb,var(--warn) 40%,var(--line))}
.st-done{color:var(--muted)}.tk-who{color:var(--muted)}
.tk-prog{display:inline-flex;align-items:center;gap:6px;color:var(--muted);font-variant-numeric:tabular-nums}
.tk-bar{display:inline-block;width:56px;height:4px;border-radius:2px;background:var(--line);overflow:hidden}.tk-bar i{display:block;height:100%;background:var(--ok);border-radius:2px;transition:width .2s}
/* phones: the card's buttons stay together on its one line: the progress bar gets shorter, empty bits take no room */
@media(max-width:640px){.tk{flex-wrap:nowrap}.tk>.tk-st,.tk>.btn{flex:none}.tk>.tk-prog{min-width:0}.tk-bar{width:28px}.tk>.tk-who:empty{display:none}.tk>.btn.sm{padding:0 7px}}
@media(max-width:360px){.tk-bar{display:none}}
/* approval card (conversation and Inbox): the exact command, where it stands, Approve / Deny for the person asked */
.qr{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.qr[hidden]{display:none}.qr-b{gap:6px;max-width:100%;border-radius:999px}.qr-t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.qr-k{font:inherit;font-size:10.5px;min-width:16px;height:16px;line-height:16px;padding:0 3px;border-radius:4px;border:1px solid var(--line);color:var(--muted);background:var(--bg)}@media(hover:none){.qr-k{display:none}}
.apc{margin-top:8px;max-width:640px}.apc>.tk{margin-top:0}.apc-cmd{margin:0 0 6px;max-height:220px;overflow:auto;padding:8px 10px;border-radius:8px;background:var(--bg-subtle);border:1px solid var(--line);font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.apc .tk-st .dot{background:var(--warn)}.apc.st-approved .tk-st .dot{background:var(--ok)}.apc.st-rejected .tk-st .dot{background:var(--danger)}.apc.st-expired .tk-st .dot{background:var(--muted)}
.apc.st-approved .tk-st{color:var(--ok)}.apc.st-rejected .tk-st,.apc.st-expired .tk-st{color:var(--muted)}
.apc[tabindex]:focus-visible,.apc.kbd-sel,.approval:focus-visible,.approval.sel{outline:2px solid var(--accent);outline-offset:3px;border-radius:8px}
.apc-kbd{display:none;align-self:center;margin-right:4px}.apc-kbd kbd,.ap-keys kbd{font-size:10.5px}.apc[tabindex]:focus-visible .apc-kbd,.apc.kbd-sel .apc-kbd,.entry.sel .apc .apc-kbd{display:inline}
/* The hint never appears on a click (it would shift the buttons under the pointer), nor on touch or narrow screens. */
@media (hover:none),(max-width:480px){.apc-kbd,.ap-keys{display:none!important}}
.apc-acts{display:inline-flex;gap:6px;flex:none;margin-left:auto}.apc .tk{flex-wrap:wrap} /* too narrow for both: the buttons drop under the status, still on the right */.apc-acts[hidden]{display:none}.apc-risk{color:var(--danger);font-weight:500;white-space:nowrap}.apc-note{margin:6px 0 0}
.inbox-item .apc{margin:0;padding:0 10px 12px 42px}.inbox-item .apc .dot{margin-top:0}
.tk-subs{list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column;gap:1px;font-size:12.5px}
.tk-subs li{display:flex;align-items:center;gap:8px;min-width:0;padding:3px 8px;border-inline-start:2px solid var(--line)}.tk-subs .grow{color:var(--text);text-decoration:none}.tk-subs a.grow:hover{text-decoration:underline}
.tk-subs li.st-done .grow{color:var(--muted);text-decoration:line-through;text-decoration-color:color-mix(in srgb,var(--muted) 60%,transparent)}
.kcard .ksub{color:var(--muted);min-width:0;flex:0 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* reactions: chips under a message; the add button shows on hover (always on touch screens) */
.rx{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.rx.has{margin-top:6px}
.rx-chip{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 8px;border-radius:999px;border:1px solid var(--line);background:var(--bg-subtle);color:var(--text);font:inherit;font-size:12.5px;cursor:pointer}
.rx-chip:hover{border-color:var(--line-strong)}
.rx-chip.on{border-color:color-mix(in srgb,var(--accent) 55%,var(--line));background:color-mix(in srgb,var(--accent) 10%,var(--bg))}
.rx-chip .e{font-size:14px;line-height:1}.rx-chip .c{font-variant-numeric:tabular-nums;color:var(--muted)}.rx-chip.on .c{color:var(--accent)}
.rx-add{display:none;align-items:center;height:24px;padding:0 7px;border-radius:999px;border:1px dashed var(--line-strong);background:none;color:var(--muted);font:inherit;font-size:13px;cursor:pointer}
.rx-add span{font-size:11px;margin-left:1px}.rx-add:hover{color:var(--ink);border-style:solid}
.rx.has .rx-add{display:inline-flex}
.thr-list .rx .rx-add{display:inline-flex} /* a thread has no hover action bar, so its replies keep the add-reaction button */ /* with no reactions yet, "☺+" lives in the message's hover actions */
/* agents' 🤔 / ✅ on a person's message: a quiet receipt line under it, like the app */
.rx.has-rcpt{margin-top:4px}.rx.has.has-rcpt{margin-top:6px}
.rx-rcpt{flex-basis:100%;display:flex;flex-wrap:wrap;align-items:center;gap:0 6px;font-size:12px;line-height:18px;color:var(--muted)}
.rx-rcpt .e{font-size:11.5px}.rx-rcpt{column-gap:12px}
/* One marker each: the message's own "on it" / "done" pill wins over the agent's 🤔 / ✅ receipt. */
.entry:has(>.grow>.meta>.hdl:not(.done))>.grow>.rx>.rx-rcpt>.think,.entry:has(>.grow>.meta>.hdl.done)>.grow>.rx>.rx-rcpt>.done{display:none}
/* The emoji picker: a popover by the button on desktop, a bottom sheet on phones (the .sheet class, set from the width). */
.rx-pick{position:fixed;z-index:50;display:flex;flex-direction:column;width:352px;max-width:calc(100vw - 16px);height:min(420px,calc(100vh - 16px));overflow:hidden;
  border-radius:12px;border:1px solid var(--line);background:var(--bg);color:var(--text);box-shadow:var(--shadow-lg)}
.rx-pick[hidden],.rp-scrim[hidden]{display:none}
.rx-pick.sheet{left:0;right:0;top:auto;width:auto;max-width:none;height:min(72vh,480px);border-radius:14px 14px 0 0;border-width:1px 0 0;padding-bottom:env(safe-area-inset-bottom)}
.rp-scrim{position:fixed;inset:0;z-index:49;background:rgba(0,0,0,.32)}
.rp-quick{display:flex;flex-wrap:wrap;gap:2px;padding:8px 8px 6px;border-bottom:1px solid var(--line)}
.rp-e{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;padding:0;border:0;border-radius:8px;background:none;color:inherit;font-size:22px;line-height:1;cursor:pointer}
.rp-e:hover{background:var(--bg-hover)}.rp-e.kb{background:var(--bg-hover);box-shadow:inset 0 0 0 2px var(--accent)}
.rp-e.on{background:color-mix(in srgb,var(--accent) 12%,var(--bg))}
.rp-quick .rp-e{width:34px;height:34px;font-size:20px}
.rp-slot{border:1px solid var(--line-strong);background:var(--bg-subtle)}.rp-slot.auto{border-style:dashed;background:none;opacity:.55}
.rp-slot.sel{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.rx-pick.cz .rp-quick>:nth-child(3){margin-right:9px} /* the first 3 are the one-click ones */
.rp-cz{padding:6px 10px 8px;border-bottom:1px solid var(--line);font-size:12px;line-height:1.4;color:var(--muted)}.rp-cz[hidden]{display:none}.rp-cz p{margin:0}
.rp-czb{display:flex;align-items:center;gap:4px;margin-top:6px}.rp-czb .btn.ghost{min-width:28px;justify-content:center}
.rp-search{padding:8px 8px 4px}.rp-search .input{height:32px}
.rp-tabs{display:flex;gap:2px;padding:0 6px 4px;border-bottom:1px solid var(--line)}.rx-pick.searching .rp-tabs{display:none}
.rp-tabs button{flex:1;min-width:0;height:28px;padding:0;border:0;border-radius:6px;background:none;font-size:15px;line-height:1;cursor:pointer;opacity:.7}
.rp-tabs button:hover{background:var(--bg-hover);opacity:1}
.rp-body{position:relative;flex:1;min-height:0;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;padding:0 8px 8px}
.rp-h{position:sticky;top:0;z-index:1;padding:8px 2px 4px;background:var(--bg);font-size:11.5px;font-weight:600;color:var(--muted)}
.rp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(36px,1fr));gap:1px}
.rp-none{padding:28px 8px;text-align:center;font-size:13px;color:var(--muted)}
.rp-foot{display:flex;align-items:center;gap:8px;min-height:40px;padding:4px 10px;border-top:1px solid var(--line);font-size:12.5px;color:var(--muted)}
.rp-big{font-size:22px;line-height:1}.rp-nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.rp-foot .linkish[hidden]{display:none}
.rx-tip{position:fixed;z-index:50;display:flex;align-items:center;gap:10px;max-width:280px;padding:8px 12px;border-radius:10px;background:var(--ink);color:var(--on-ink);font-size:12.5px;line-height:1.35;box-shadow:var(--shadow-lg);pointer-events:none}
.rx-tip[hidden]{display:none}.rx-tip .big{font-size:24px;line-height:1}.rx-tip .faint{color:color-mix(in srgb,var(--on-ink) 65%,transparent)}
.entry .acts .rx-q{width:28px;padding:0;justify-content:center;font-size:14px}
/* images: inline in the conversation (real proportions, capped), full size in a lightbox; attachments in the composer */
.img{margin:8px 0 0}.img-open{display:block;padding:0;border:0;background:none;cursor:zoom-in;max-width:100%;touch-action:manipulation;-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}
.img img{display:block;max-width:min(100%,440px);max-height:340px;width:auto;height:auto;border-radius:8px;border:1px solid var(--line);background:var(--bg-subtle);pointer-events:none;-webkit-user-drag:none}
.img figcaption{margin-top:4px}
/* a message with several files: pictures in a grid (1, 2, 1+2, 2×2; "+N" on the last), other files as chips below */
.mfiles{margin-top:8px;width:min(100%,440px)}
.mgrid{display:grid;gap:3px;border-radius:8px;overflow:hidden;border:1px solid var(--line);background:var(--line)}
.mgrid.g2{grid-template-columns:1fr 1fr;aspect-ratio:2/1}
.mgrid.g3{grid-template-columns:2fr 1fr;grid-template-rows:1fr 1fr;aspect-ratio:3/2}
.mgrid.g3 .mg-tile:first-child{grid-row:span 2}
.mgrid.g4{grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;aspect-ratio:4/3}
.mg-tile{position:relative;display:block;padding:0;border:0;background:var(--bg-subtle);cursor:zoom-in;min-width:0;min-height:0;overflow:hidden;touch-action:manipulation;-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}
.mg-tile[hidden]{display:none}
.mg-tile img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;pointer-events:none;-webkit-user-drag:none}
.mgrid.g1{display:block;border:0;background:none;border-radius:0}
.mgrid.g1 .mg-tile{background:none;max-width:100%}
.mgrid.g1 .mg-tile img{position:static;display:block;max-width:100%;max-height:340px;width:auto;height:auto;object-fit:contain;border-radius:8px;border:1px solid var(--line);background:var(--bg-subtle)}
.mg-more{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.48);color:var(--on-fill);font-size:22px;font-weight:600}
.mchips .fh+.fh{border-top:1px solid var(--line)}
.mfiles .mchips{margin-top:6px}
.mcap{margin-top:4px}
.entry.retracted>.grow>.mfiles{opacity:.55}
/* The viewer is as big as its picture (jxn #2990): not the 560px every other dialog is, which cropped wide pictures */
:root dialog.lightbox{padding:0;border:0;background:transparent;box-shadow:none;width:fit-content;height:fit-content;max-width:min(96vw,1600px);max-height:92vh;cursor:zoom-out}
dialog.lightbox::backdrop{background:rgba(0,0,0,.78)}
dialog.lightbox img{display:block;max-width:min(96vw,1600px);max-height:92vh;width:auto;height:auto;border-radius:8px}
/* Zoom (a picture bigger than the screen): a click shows it at full size in a viewer the size of the screen, panned by
   scrolling or dragging; a click again fits it again. */
dialog.lightbox.zoomable img{cursor:zoom-in}
:root dialog.lightbox.zoomed{display:grid;width:100vw;height:100dvh;max-width:none;max-height:none;margin:0;overflow:auto;overscroll-behavior:contain;cursor:grab}
dialog.lightbox.zoomed img{max-width:none;max-height:none;margin:auto;border-radius:0;cursor:zoom-out}
/* Phones (vedu #4650): a tap opens a full-bleed viewer. fit-content + 96vw/92vh lets WebKit size the dialog to the
   picture's intrinsic pixels, so a wide screenshot is cropped and the page (mention chips, message chrome) shows
   through the transparent frame. Thumbnails aren't selectable, so the tap doesn't put handles on nearby @mentions. */
@media (max-width:640px),(hover:none){
  :root dialog.lightbox[open]{display:grid;place-items:center;inset:0;width:100vw;height:100dvh;max-width:none;max-height:none;margin:0;overflow:hidden;border-radius:0;background:rgba(0,0,0,1)}
  dialog.lightbox::backdrop{background:rgba(0,0,0,1)}
  dialog.lightbox img{max-width:100vw;max-height:100dvh;border-radius:0;-webkit-touch-callout:none}
  :root dialog.lightbox.zoomed{overflow:auto;place-items:initial}
}
.lb-nav{position:fixed;top:50%;transform:translateY(-50%);width:44px;height:44px;border-radius:50%;border:0;background:rgba(0,0,0,.55);color:var(--on-fill);font-size:28px;line-height:1;cursor:pointer;display:grid;place-items:center;padding:0 0 3px}
.lb-nav:hover{background:rgba(0,0,0,.75)}.lb-nav[hidden],.lb-count[hidden]{display:none}
.lb-prev{left:max(8px,env(safe-area-inset-left))}.lb-next{right:max(8px,env(safe-area-inset-right))}
.lb-save{position:fixed;top:14px;right:14px;z-index:2;background:rgba(0,0,0,.6);border-color:transparent;color:var(--on-fill)}.lb-save:hover{background:rgba(0,0,0,.8)}[dir=rtl] .lb-save{right:auto;left:14px}
.lb-count{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);color:var(--on-fill);background:rgba(0,0,0,.55);padding:3px 10px;border-radius:12px;font-variant-numeric:tabular-nums}
.entry.pending .ph-att{padding:8px 0 0}
.attachments{display:flex;gap:8px;flex-wrap:wrap;padding:10px 12px 0}
.attachments[hidden]{display:none}
.att{position:relative;display:block}
.att img{display:block;height:64px;width:auto;max-width:140px;object-fit:cover;border-radius:7px;border:1px solid var(--line)}
.att-x{position:absolute;top:-6px;right:-6px;width:18px;height:18px;border-radius:50%;border:1px solid var(--line-strong);background:var(--bg);color:var(--muted);font-size:10px;line-height:1;cursor:pointer;display:grid;place-items:center;padding:0}
.att-x:hover{color:var(--ink)}
.att.file{display:flex;flex-direction:column;justify-content:center;gap:2px;height:64px;max-width:180px;padding:0 12px;border:1px solid var(--line);border-radius:7px;background:var(--bg-subtle)}
.att-name{font-size:12px;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* Dictation (#2081, #2089): the mic sits where Post is, like the app's. Empty box: only the mic; once there's text (or a
   file), Post, and the mic steps aside unless it's listening. Text the page puts there (a reply's @mention) keeps both. */
.composer .mic-btn{width:32px;height:32px;margin:-3px 0;padding:0;justify-content:center;border-radius:999px;background:var(--cta);border-color:var(--cta);color:var(--on-cta);touch-action:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}.composer .mic-btn:hover{opacity:.88}
.composer .mic-btn.on{background:var(--danger);border-color:var(--danger)}.composer .mic-btn.on svg{animation:mic-pulse 1.2s ease-in-out infinite}@keyframes mic-pulse{50%{opacity:.5}}
.composer:has(.mic-btn:not([hidden])):has(#attachments[hidden]):has(textarea:placeholder-shown) .post-btn{display:none}
.composer.typed:has(textarea:not(:placeholder-shown)) .mic-btn:not(.on){display:none}
.composer .attach{width:30px;padding:0;justify-content:center;color:var(--muted)}.composer .attach:hover{color:var(--ink)}
.conv.drop .composer,.thr-dlg.drop .composer{box-shadow:0 0 0 2px var(--accent)}
.doc-img img{display:block;max-width:100%;height:auto;border-radius:8px;border:1px solid var(--line);background:var(--bg-subtle)}
/* read receipts: a ring on your latest message, filling green as people and agents see it; a dot on each @mention */
.entry .meta .when{cursor:pointer}
.entry.has-rd>.grow{padding-right:24px}
.rd{position:absolute;right:0;bottom:12px;width:16px;height:16px;display:grid;place-items:center;cursor:default;outline-offset:2px;padding:0;border:0;background:none;color:inherit;font:inherit;opacity:.55;transition:opacity .15s}
.rd::before{content:"";position:absolute;inset:-6px}
.entry:hover>.rd,.rd:focus-visible,.rd.open,.entry:focus-within>.rd{opacity:1}
@media (hover:hover){.rd:hover{opacity:1}}
.rd svg{display:block}.rd .t{fill:none;stroke:var(--line-strong);stroke-width:2}.rd .p{fill:none;stroke:var(--ok);stroke-width:2;stroke-linecap:round;transition:stroke-dasharray .3s}
.rd.all .t{fill:var(--ok);stroke:var(--ok)}.rd .ck{fill:none;stroke:var(--bg);stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.rd-pop{visibility:hidden;opacity:0;position:absolute;right:24px;bottom:-6px;z-index:6;min-width:170px;max-width:320px;padding:8px 10px;border-radius:8px;background:var(--ink);color:var(--on-ink);text-align:left;
  font-size:12px;line-height:18px;box-shadow:var(--shadow-lg);display:flex;flex-direction:column;gap:2px;white-space:nowrap;pointer-events:none;transition:opacity .12s}
.rd:focus-visible .rd-pop,.rd.open .rd-pop{visibility:visible;opacity:1}
@media (hover:hover){.rd:hover .rd-pop{visibility:visible;opacity:1}}
.rd-hush .rd-pop{visibility:hidden!important}
.rd.down .rd-pop{bottom:auto;top:-6px}
/* An open thread nests its replies inside the root entry, so the root's ring would sit beside the last reply's: one ring there. */
.entry.thr-open>.rd{display:none}.entry.thr-open.has-rd>.grow{padding-right:0}
.rd-pop b{font-weight:600;margin-bottom:2px}.rd-pop>span{display:flex;align-items:center;gap:6px}.rd-pop .av.sm{width:16px;height:16px;font-size:7px}
.rd-pop .nm{flex:1;overflow:hidden;text-overflow:ellipsis}.rd-pop i{font-style:normal;font-size:11px;opacity:.65}.rd-pop .y i{color:var(--ok);opacity:1}.rd-pop .n{opacity:.6}
@media (pointer:coarse){.rd{width:20px;height:20px;right:-2px}.rd::before{inset:-10px}}
.entry .body .mention{position:relative}
/* the dot takes the mention's own colour: an outline until they've seen it, filled once they have */
.entry .body .mention{--dot:var(--accent)}.entry .body .mention.me{--dot:var(--unread)}
.entry .body .mention::after{content:"";position:absolute;top:-3px;right:-3px;width:6px;height:6px;border-radius:50%;box-shadow:0 0 0 1.5px var(--bg);
  border:1.5px solid var(--dot);background:var(--bg);box-sizing:border-box}
.entry .body .mention.seen::after{background:var(--dot)}
/* change cards: a git change as a card (branch → base, CI, PR, commits, files, reviews, diff on demand) */
.meta .via.owner{color:var(--muted)}.meta .via.sess{font-family:var(--font-mono);font-size:12.5px;color:var(--muted)}
.composer.sending .attachments{display:none}
/* One piece (jxn #4304, #4325): Reload keeps its corners and sits the same 4px in on top, right and bottom; the bar
   takes the button's corners (its radius plus the inset and the 1px border), so the edges line up. */
.upd-bar{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:60;display:flex;align-items:center;gap:10px;padding:4px 4px 4px 16px;border:1px solid var(--line);border-radius:calc(var(--r-sm) + 5px);background:var(--bg);box-shadow:var(--shadow-lg);font-size:13px;color:var(--ink);white-space:nowrap}
.md-tw{overflow-x:auto;margin:6px 0;max-width:100%}.md-t{border-collapse:collapse;font-size:13px;line-height:1.45}.md-t th,.md-t td{border:1px solid var(--line);padding:4px 9px;text-align:left;vertical-align:top}.md-t th{background:var(--bg-subtle);color:var(--ink);font-weight:600}
.ch{margin:8px 0;padding:10px 12px 6px;border:1px solid var(--line);border-radius:10px;background:var(--bg);max-width:620px}.ch-t{font-size:13px;font-weight:600;color:var(--ink);margin-bottom:4px}
.ch{container-type:inline-size}.ch-svg{display:block;width:100%;height:auto;overflow:visible}.ch-narrow{display:none}@container (max-width:420px){.ch-wide{display:none}.ch-narrow{display:block}}.ch-grid{stroke:var(--line);stroke-width:1}.ch-axis{stroke:var(--line-strong,var(--line));stroke-width:1}
.ch-y,.ch-x{fill:var(--muted);font-size:11px;font-family:inherit}.ch-y{text-anchor:end}.ch-x{text-anchor:middle}
.ch-l{fill:none;stroke-width:2.2;stroke-linejoin:round;stroke-linecap:round}.ch-a{stroke:none;opacity:.16}.ch-p{stroke:var(--bg);stroke-width:1.5}
.ch-s0{fill:var(--accent);stroke:var(--accent)}.ch-s1{fill:var(--ok);stroke:var(--ok)}.ch-s2{fill:var(--warn);stroke:var(--warn)}.ch-s3{fill:var(--decision);stroke:var(--decision)}
.ch-s4{fill:var(--danger);stroke:var(--danger)}.ch-s5{fill:var(--claim);stroke:var(--claim)}.ch-s6{fill:var(--task);stroke:var(--task)}.ch-s7{fill:var(--muted);stroke:var(--muted)}
.ch-l.ch-s0,.ch-l.ch-s1,.ch-l.ch-s2,.ch-l.ch-s3,.ch-l.ch-s4,.ch-l.ch-s5,.ch-l.ch-s6,.ch-l.ch-s7{fill:none}
rect.ch-s0,rect.ch-s1,rect.ch-s2,rect.ch-s3,rect.ch-s4,rect.ch-s5,rect.ch-s6,rect.ch-s7,path.ch-s0,path.ch-s1,path.ch-s2,path.ch-s3,path.ch-s4,path.ch-s5,path.ch-s6,path.ch-s7{stroke:var(--bg);stroke-width:1}
.ch-legend{display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:6px;font-size:12px;color:var(--text)}.ch-legend span{display:inline-flex;align-items:center;gap:5px}.ch-legend b{color:var(--muted);font-weight:500}
.ch-k{width:10px;height:10px;border-radius:3px;display:inline-block;border:0}.ch-k.ch-s0{background:var(--accent)}.ch-k.ch-s1{background:var(--ok)}.ch-k.ch-s2{background:var(--warn)}.ch-k.ch-s3{background:var(--decision)}.ch-k.ch-s4{background:var(--danger)}.ch-k.ch-s5{background:var(--claim)}.ch-k.ch-s6{background:var(--task)}.ch-k.ch-s7{background:var(--muted)}
.ch-pie{display:flex;align-items:center;gap:16px;flex-wrap:wrap}.ch-pie .ch-svg{width:170px;flex:none}.ch-pie .ch-legend{flex-direction:column;gap:4px}
${STATUS_CSS}
.ch-data{margin-top:4px}.ch-data summary{cursor:pointer;font-size:11.5px;color:var(--faint);list-style:none}.ch-data summary::-webkit-details-marker{display:none}.ch-data summary:hover{color:var(--ink)}
.code-b{position:relative;margin:6px 0;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--bg-subtle)}.code-b>pre{margin:0;border:0;border-radius:0}.code-h{display:flex;align-items:center;justify-content:space-between;padding:3px 6px 3px 10px;border-bottom:1px solid var(--line);font-size:11.5px;color:var(--muted)}.code-copy{all:unset;cursor:pointer;padding:2px 8px;border-radius:6px;font-size:11.5px;color:var(--muted)}.code-copy:hover{background:var(--bg-hover);color:var(--ink)}
.dev-mode{display:flex;align-items:center;gap:12px;border-style:dashed;cursor:pointer}.dev-ic{font-family:var(--font-mono);color:var(--muted);font-size:13px}
input.switch{appearance:none;-webkit-appearance:none;flex:none;width:42px;height:24px;margin:0;border-radius:999px;background:var(--line-strong,var(--line));position:relative;cursor:pointer;transition:background .15s}
input.switch::after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:var(--bg);box-shadow:0 1px 2px rgba(0,0,0,.25);transition:left .15s}input.switch:checked{background:var(--ink)}input.switch:checked::after{left:21px}
/* Everyday (#1272): the same entries in plainer clothes; Developer mode is today's page unchanged. */
:root[data-mode="everyday"] .entry .seq,:root[data-mode="everyday"] .meta .via:not(.owner):not(.sess),:root[data-mode="everyday"] [aria-controls="panel-log"],
:root[data-mode="everyday"] .entry .chg,:root[data-mode="everyday"] .apc-cmd,:root[data-mode="everyday"] .apc-risk,:root[data-mode="everyday"] .ag-hint,
:root[data-mode="everyday"] .ag-hint+.copy,:root[data-mode="everyday"] #soul-side,:root[data-mode="everyday"] .meta .t-change,:root[data-mode="everyday"] .side-link .count.dev{display:none!important}
:root:not([data-mode="everyday"]) .ev-res{display:none}
:root[data-mode="everyday"] #board-tabs [aria-controls="panel-tasks"]{order:1}:root[data-mode="everyday"] #board-tabs [aria-controls="panel-docs"]{order:2}:root[data-mode="everyday"] #board-tabs>*:not([role=tab]){order:3}
.ev-res{display:flex;align-items:center;gap:10px;margin-top:8px;padding:12px 14px;border:1px solid var(--line);border-radius:12px;background:var(--bg)}.ev-res b{font-size:16px;color:var(--ink);font-weight:600;line-height:1.35}
.ev-ok{flex:none;width:22px;height:22px;border-radius:50%;background:var(--ok);color:var(--bg);display:inline-flex;align-items:center;justify-content:center;font-size:13px;font-weight:700}
:root[data-mode="everyday"] .bp-title h1{font-size:26px;letter-spacing:-.01em}:root[data-mode="everyday"] .section-title h1{font-size:26px}
@media(max-width:640px){:root[data-mode="everyday"] .bp-title h1{font-size:22px}}
.composer .po-btn{width:30px;padding:0;justify-content:center;color:var(--muted);transition:color .15s,border-color .15s}.composer .po-btn:hover{color:var(--ink)}.composer .po-btn.on{color:var(--on-ink);background:var(--ink);border-radius:999px}
.composer .po-btn.on{width:auto;padding:0 9px 0 7px;gap:4px}.po-lbl{font-size:12px;font-weight:600;white-space:nowrap}.po-lbl:empty{display:none}
.composer .po-btn.on.own{background:var(--accent);border-color:var(--accent);color:var(--bg)}
@media(max-width:640px){.composer .po-btn.on{padding:0 8px 0 6px}.po-lbl{font-size:11.5px}}
.po-note{margin:0 0 8px;padding:6px 10px;border-radius:8px;background:var(--private-soft);font-size:12.5px;color:var(--text)}.po-note[hidden]{display:none}
.po-seg{display:inline-flex;vertical-align:baseline;border:1px solid var(--line);border-radius:999px;padding:1px;background:var(--bg);margin-right:2px}
.po-seg button{border:0;background:none;font:inherit;font-size:12px;line-height:1.5;padding:1px 9px;border-radius:999px;color:var(--muted);cursor:pointer}
.po-seg button:hover{color:var(--ink)}.po-seg button[aria-checked="true"]{background:var(--ink);color:var(--on-ink);font-weight:600}
.po-seg button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}.composer.po{box-shadow:0 0 0 1.5px var(--private)}
.pv-dlg{width:min(1100px,calc(100vw - 24px));height:min(860px,calc(100vh - 40px));padding:0;display:none}.pv-dlg[open]{display:flex;flex-direction:column}
.pv-hd{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--line)}.pv-hd .mono{min-width:0;font-size:13px}
.pv-body{flex:1;min-height:0;display:flex;justify-content:center;background:var(--bg-subtle);overflow:auto}.pv-body iframe{border:0;height:100%;background:var(--preview-bg);transition:width .2s}.pv-note{margin:0;padding:6px 12px;border-top:1px solid var(--line)}
@media(max-width:640px){.pv-dlg{width:100vw;max-width:100vw;height:100dvh;max-height:none;margin:0;border-radius:0}.pv-w{display:none}}
/* Highlights (mention tint, new-message flash, jump tint) bleed past the avatar whatever the density, so it never sits on the edge (jxn #1311),
   and on the right only as far as the rail, never under it (jxn #2003). The thread's scroller makes room for the left bleed so it isn't clipped. */
/* The linked message (:target, which stays after a reload) and the keyboard's j/k pick (.sel) bleed the same way, so no tinted card
   sits 12px in from the rest (jxn #4680). */
#thread>.entry:is(.for-you,.flash-in,.hit,.sel,:target),.thr-list>.entry:is(.for-you,.hit,:target){margin-left:calc(-1*var(--hl-l));margin-right:calc(-1*var(--hl-r));padding-left:var(--hl-l);padding-right:var(--hl-r);border-radius:8px}
/* …and a seen-by ring on such a message stays where it was, clear of the rail (jxn #1751). */
#thread>.entry:is(.for-you,.flash-in,.hit,.sel,:target)>.rd,.thr-list>.entry:is(.for-you,.hit,:target)>.rd{right:var(--hl-r)}
@media (pointer:coarse){#thread>.entry:is(.for-you,.flash-in,.hit,.sel,:target)>.rd,.thr-list>.entry:is(.for-you,.hit,:target)>.rd{right:calc(var(--hl-r) - 2px)}}
${MERMAID_CSS}
${CODE_COLOR_CSS}
${TALK_CSS}
${AGENT_LOGO_CSS}
.slash-menu li{align-items:baseline}.slash-menu li b{flex:none;white-space:nowrap}.slash-menu li .k{margin-left:10px;flex:1;min-width:0;text-align:left} /* "/task" never splits (jxn #1391) */
.mem-act{display:none}.mem-on .mem-act{display:inline-flex;width:30px;padding:0;justify-content:center;color:var(--muted)}.mem-on .mem-act:hover{color:var(--ink)}
.soul-prev{white-space:pre-wrap;font-size:12.5px;line-height:1.5;color:var(--text);max-height:7.5em;overflow:hidden;-webkit-mask-image:linear-gradient(#000 70%,transparent);mask-image:linear-gradient(#000 70%,transparent)}
.soul-meta{margin:4px 0 6px}.soul-edit{margin-top:2px}
.mem-list{list-style:none;margin:0;padding:0}.mem-it{display:grid;grid-template-columns:1fr auto;gap:0 6px;padding:5px 0;border-top:1px solid var(--line)}.mem-it:first-child{border-top:0}
.mem-t{font-size:12.5px;color:var(--ink);overflow-wrap:anywhere}.mem-m{grid-column:1}.mem-m a{color:inherit}.mem-x{grid-row:1/3;grid-column:2;align-self:center;width:26px;padding:0;justify-content:center;color:var(--faint)}.mem-x:hover{color:var(--danger)}
.mem-add{display:flex;gap:6px;margin-top:8px}.mem-add .input{flex:1;min-width:0;height:30px;font-size:12.5px}
.soul-dlg{width:min(640px,calc(100vw - 24px))}.soul-dlg form{padding:18px}.soul-dlg .hd{display:flex;justify-content:space-between;gap:12px;margin-bottom:12px}.soul-dlg textarea{width:100%;min-height:260px;font-size:13px;line-height:1.5;resize:vertical}
.chg{margin-top:8px;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--bg)}
.chg-h{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 12px;background:var(--bg-subtle);color:var(--muted);font-size:13px}
.chg-br{color:var(--ink);font-size:12px;padding:1px 6px;border-radius:5px;background:var(--bg-hover);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chg-pr{color:var(--accent);font-weight:500;font-size:12.5px}.chg-pr:hover{text-decoration:underline}
.chg-go{cursor:pointer;transition:border-color .15s}.chg-go:hover{border-color:var(--line-strong)}.chg-go .chg-diff,.chg-go details>ul{cursor:auto}
.chg-commits a.sha{flex:none;color:var(--muted);font-size:11.5px}.chg-commits a.sha code{background:none;padding:0;font-size:inherit;color:inherit}.chg-commits a.sha:hover{color:var(--accent);text-decoration:underline}
.ci{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:500}.ci .dot{width:7px;height:7px;border-radius:50%;background:currentColor}
.ci-passing{color:var(--ok)}.ci-failing{color:var(--danger)}.ci-pending{color:var(--warn)}
.chg-sec{padding:8px 12px;border-top:1px solid var(--line)}
.chg-label{font-size:12px;color:var(--muted);margin-bottom:4px}
.chg ul{list-style:none;margin:0;padding:0}
.chg-commits li{display:flex;gap:8px;align-items:baseline;font-size:13px;line-height:20px;min-width:0}
.chg-commits .sha{flex:none;font-size:11.5px;color:var(--muted);background:none;padding:0}
.chg-files li{display:flex;align-items:center;gap:10px;font-size:12.5px;line-height:22px;min-width:0}
.chg-files .path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left} /* long paths keep their file name */
.chg-files .n{flex:none;font-variant-numeric:tabular-nums}
.chg .add{color:var(--ok)}.chg .del{color:var(--danger)}
.chg .bar{display:inline-flex;gap:2px;flex:none}.chg .bar i{width:7px;height:7px;border-radius:2px;background:var(--line-strong)}
.chg .bar i.a{background:var(--ok)}.chg .bar i.d{background:var(--danger)}
.chg details>summary{cursor:pointer;font-size:12px;color:var(--muted);padding:2px 0;list-style:none}.chg details>summary:hover{color:var(--ink)}
.chg details>summary::-webkit-details-marker{display:none}
.chg-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 12px;border-top:1px solid var(--line)}
.chg-reviews{font-size:12.5px;color:var(--muted);display:flex;gap:12px;flex-wrap:wrap}.rv b{color:var(--ink);font-weight:500}
.chg-diff[hidden]{display:none}
.chg-diff{margin:0;padding:8px 0;border-top:1px solid var(--line);background:var(--bg-subtle);font-size:12px;line-height:1.5;overflow-x:auto;white-space:pre}
.chg-diff span{display:block;padding:0 12px;min-width:max-content;min-height:1.5em}
.chg-diff .da{background:color-mix(in srgb,var(--ok) 13%,transparent)}.chg-diff .dd{background:color-mix(in srgb,var(--danger) 12%,transparent)}
.chg-diff .dk{color:var(--accent)}.chg-diff .dh{color:var(--ink);font-weight:600}
.sum h3{font-size:12px;font-weight:500;color:var(--muted);text-transform:none;margin:22px 0 8px;display:flex;justify-content:space-between}
.sum h3:first-child{margin-top:0}
/* Board info sections fold: the heading is the toggle (chevron, title, count); folded, a one-line peek of the newest item */
.fold h3{display:flex;align-items:flex-start;gap:8px}.fold h3 .linkish{line-height:20px}
.sum .fold h3{margin-top:22px}.sum>.fold:first-child h3,.sum>.waiting+.fold h3{margin-top:12px}.sum>.fold:first-child h3{margin-top:0}
.fold-h{all:unset;box-sizing:border-box;flex:1;min-width:0;display:grid;grid-template-columns:12px auto 1fr;align-items:center;column-gap:6px;cursor:pointer;border-radius:5px;margin:-3px -4px;padding:3px 4px;color:var(--muted)}
.fold-h:hover{color:var(--ink);background:var(--bg-hover)}
.fold-h:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.fold-c{transform:rotate(90deg);transition:transform .15s;opacity:.7}
.fold.folded .fold-c{transform:none}
.fold-t{white-space:nowrap}.fold-n{justify-self:end}
.fold-peek{display:none;grid-column:2/4;font-size:12px;color:var(--faint);font-weight:400}
.fold.folded .fold-peek{display:block}
.fold.folded .fold-b{display:none}
.fold.folded h3{margin-bottom:0}
.sum .fold.folded+.fold h3{margin-top:14px}
@media (prefers-reduced-motion:reduce){.fold-c{transition:none}}
.sum ul{list-style:none;margin:0;padding:0}
.sum li a{display:flex;align-items:center;gap:8px;padding:6px 8px;margin:0 -8px;border-radius:6px;font-size:13px;line-height:1.45}
.sum li a:hover{background:var(--bg-hover)}
.sum ul.capped:not(.all)>li:nth-last-child(n+4){display:none} /* the newest 3 until "Show all" */
.sum .sum-more{display:block;margin:2px 0 0;font-size:12px}
.sum li.q{display:flex;align-items:center;gap:4px}.sum li.q>a{flex:1;min-width:0;margin-right:0}
.sum-ans{flex:none;width:24px;height:24px;margin-right:-6px;display:inline-flex;align-items:center;justify-content:center;border:1px solid transparent;border-radius:6px;background:none;color:var(--faint);font-size:12px;cursor:pointer}
.sum-ans:hover,.sum-ans:focus-visible{color:var(--ok);border-color:var(--line);background:var(--bg)}.sum-ans:disabled{opacity:.4;cursor:default}
.sum li .n{color:var(--faint);flex:none;font-variant-numeric:tabular-nums}
.sum li .one{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sum li .avs{flex:none;min-width:34px}.sum li>.row>.btn.ghost.sm:last-child{margin-right:-9px} /* Remove/Leave: its text lines up with the right edge, like last seen */.sum li .avs .av{width:18px;height:18px;font-size:8px;margin-left:-6px}.sum li .avs .av:first-child{margin-left:0}
/* a stacked avatar without a picture shows initials, which the next one would cover ("MO" read as "MC"): overlap it by the ring only. Pictures keep the tight stack. */
.avs .av:not(:has(.av-img))+.av{margin-left:-2px}

.sum .none{font-size:13px;color:var(--faint)}
.waiting{border:1px solid var(--line-strong);background:var(--bg-subtle);border-radius:var(--r-sm);padding:10px 12px;margin-bottom:6px}
.composer{margin-top:20px;position:relative}
.mention{color:var(--mention-fg);font-weight:500;background:var(--mention-bg);padding:0 3px;border-radius:4px;white-space:nowrap}
.mention.agent{border:1px dashed var(--mention-line);padding:0 3px}
/* Takes real space (border, not an outline ring), so it never overlaps the text or the mention next to it. */
.mention.me{color:var(--mention-fg);background:var(--mention-you-bg);border:1px solid var(--mention-you-line);padding:0 3px;margin:0 1px}
/* The highlight extends beyond the entry on both sides (content stays put), so it never starts at the avatar. */
.entry.for-you{margin-left:calc(-1*var(--hl-l));margin-right:calc(-1*var(--hl-r));padding-left:var(--hl-l);padding-right:var(--hl-r);background:var(--you-soft);border-radius:8px;animation:foryou 1.6s ease-out 1}
.entry.for-you .rd{right:var(--hl-r)}
@keyframes foryou{from{background:var(--you-flash)}}
.hc-gap{height:12px}
.mention-menu{position:absolute;left:12px;bottom:calc(100% - 6px);z-index:5;width:min(280px,calc(100% - 24px));list-style:none;margin:0;padding:6px;
  border:1px solid var(--line);border-radius:10px;background:var(--bg);box-shadow:var(--shadow-lg)}
.mention-menu li{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:7px;cursor:pointer;font-size:13px;color:var(--text)}
.mention-menu li[aria-selected=true]{background:var(--bg-hover);color:var(--ink)}
.mention-menu li .k{margin-left:auto;color:var(--faint);font-size:12px}
/* A person's agents sit under them, joined by a small elbow line */
.mention-menu li.sub{position:relative;padding-left:26px}
.mention-menu li.sub::before{content:"";position:absolute;left:15px;top:-2px;height:calc(50% + 2px);width:7px;border-left:1.5px solid var(--line-strong,var(--line));border-bottom:1.5px solid var(--line-strong,var(--line));border-bottom-left-radius:5px}
.mention-menu li.sub .av{width:18px;height:18px;font-size:8.5px}
.mention-menu .hint{padding:4px 8px 2px;font-size:11.5px;color:var(--faint);cursor:default}
.composer .bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 12px;border-top:1px solid var(--line)}
/* phones: one row, Post on the right; the type picker scrolls sideways when it can't fit (it comes after the rule above so it wins) */
@media(max-width:480px){.composer .bar{flex-wrap:nowrap;gap:6px;padding:8px 10px}.composer .bar>*{flex:none}.composer .bar .grow{display:none}.composer .bar>.primary{margin-left:auto}.composer .bar>.mic-btn{margin-left:auto}.composer .bar>.mic-btn~.primary{margin-left:0}.composer.typed:has(textarea:not(:placeholder-shown)) .bar>.mic-btn:not(.on)~.primary{margin-left:auto}
  .composer .bar>.seg{flex:0 1 auto;min-width:0;overflow-x:auto;scrollbar-width:none}.composer .seg::-webkit-scrollbar{display:none}.composer .seg label{flex:none;padding:4px 7px;font-size:12.5px;white-space:nowrap}}
@media(max-width:387px){.composer .bar{gap:4px}.composer .seg label{padding:4px 5px;font-size:12px}}
@media(max-width:359px){.composer .bar>.seg{-webkit-mask-image:linear-gradient(90deg,#000 calc(100% - 18px),transparent);mask-image:linear-gradient(90deg,#000 calc(100% - 18px),transparent)}}
.composer .to-pick{display:inline-flex;align-items:center;gap:6px;min-width:0}
.composer .to-pick select{height:30px;padding-top:0;padding-bottom:0;font-size:13px;max-width:190px}
@media(max-width:480px){.composer .to-pick .xs{display:none}.composer .to-pick select{max-width:120px}}
.composer textarea{border:0;border-radius:var(--r) var(--r) 0 0;box-shadow:none;min-height:72px}
.composer textarea:focus{box-shadow:none}
/* iOS Safari zooms into any field under 16px and leaves the page zoomed (wider than the screen); !important beats the 12.5px/15px field rules and inline sizes. */
@media(max-width:860px){input,textarea,select{font-size:max(16px,1em)!important}}


/* app shell (Linear-style): sidebar + top bar + content */
.app{display:grid;grid-template-columns:232px minmax(0,1fr);min-height:100vh}
.sidebar{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;gap:2px;padding:10px 8px;border-right:1px solid var(--line);background:var(--bg-subtle);overflow:auto}
.sidebar .ws{display:flex;align-items:center;gap:5px;padding:6px 8px 10px;font-weight:600;color:var(--ink)}
.sidebar .search{display:flex;align-items:center;gap:8px;height:30px;margin:0 0 8px;padding:0 9px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--faint);cursor:pointer;font:inherit;font-size:13px;text-align:left}
.sidebar .search:hover{border-color:var(--line-strong);color:var(--muted)}
.sidebar .search kbd{margin-left:auto}
.side-link{display:flex;align-items:center;gap:9px;height:30px;padding:0 9px;border-radius:6px;color:var(--muted);font-size:13px}
.side-link:hover{background:var(--bg-hover);color:var(--ink)}
.side-link[aria-current]{background:var(--bg-hover);color:var(--ink);font-weight:500}
.side-link svg{flex:none;opacity:.85}
.side-link .count{margin-left:auto;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:var(--badge-bg);color:var(--badge-fg);font-size:11px;font-weight:600;display:inline-flex;align-items:center;justify-content:center}
.side-link .count[hidden]{display:none}
.inbox{list-style:none;margin:0;padding:4px}
.legal h2{font-size:15px;margin:18px 0 6px}.legal p{font-size:13.5px;line-height:1.6;color:var(--text)}
.entry.pending{opacity:.6}.entry.pending .body{white-space:pre-wrap}.entry.pending.failed .faint{color:var(--danger)}
.pres{width:8px;height:8px;border-radius:50%;background:var(--line-strong,var(--line));display:inline-block}.pres.on{background:var(--ok)}
/* People and profiles */
.ppl-h{font-size:13px;font-weight:600;color:var(--ink);margin:28px 0 8px}.ppl-h .faint{font-weight:400}
.ppl-org-hint{margin:0 0 10px}
.ppl-find{position:relative;margin-top:16px}.ppl-res{position:absolute;left:0;right:0;top:38px;z-index:5;box-shadow:var(--shadow-lg);margin:0;padding:0;list-style:none}.ppl-res[hidden]{display:none}
.ppl-pres{gap:6px}.ppl-note{margin-top:10px}.ppl-blocked{margin-top:20px}.ppl-blocked summary{cursor:pointer}.ppl-blocked .list{margin-top:8px}
.prof{display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap}
.prof-av{position:relative;flex:none}.prof-av .av.lg{width:64px;height:64px;font-size:22px}
.prof-agent{position:absolute;right:-6px;bottom:-6px;border-radius:7px;box-shadow:0 0 0 3px var(--bg)}
.prof-name{font-size:20px;line-height:1.25}.prof-pres{gap:6px;margin-top:8px}.prof-bio{margin:10px 0 0;font-size:13.5px;color:var(--text)}.prof-act{gap:6px;flex:none}
/* hover cards */
.hcard{position:fixed;z-index:60;width:280px;padding:14px;border:1px solid var(--line);border-radius:12px;background:var(--bg);box-shadow:var(--shadow-lg)}
.hcard[hidden]{display:none}.hcard .hc-list{list-style:none;margin:10px 0 0;padding:0;display:grid;gap:8px;max-height:50vh;overflow:auto}.hc-people li{display:flex;align-items:center;gap:8px;min-width:0}.hcard .av.lg{width:40px;height:40px;font-size:15px}
.hc-name{font-weight:600;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.hc-pres{gap:6px;margin-top:10px}.hc-bio{margin:8px 0 0;font-size:12.5px;color:var(--muted)}.hc-act{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}.hc-agent{margin-top:10px;padding-top:10px;border-top:1px solid var(--line)}.hc-caps{display:flex;flex-wrap:wrap;gap:4px;margin-top:8px}.hc-live{margin-top:8px;color:var(--muted)}
.hcard .link{text-decoration:underline;text-underline-offset:2px}
.hc-back{position:fixed;inset:0;z-index:158;background:rgba(0,0,0,.4)}.hc-back[hidden]{display:none}
.hcard.sheet{z-index:159;left:0;right:0;bottom:0;top:auto;width:auto;max-height:80vh;overflow:auto;border-radius:16px 16px 0 0;padding:18px 18px calc(18px + env(safe-area-inset-bottom));animation:slide-up .18s ease-out}
.hcard.sheet .hc-act .btn{flex:1 1 auto;justify-content:center;min-height:40px}
@keyframes slide-up{from{transform:translateY(24px);opacity:0}to{transform:none;opacity:1}}
.mention[data-hc],.entry>.av[data-hc],.entry .who[data-hc]{cursor:pointer}.mention[data-hc]:focus-visible,.entry>.av[data-hc]:focus-visible,.entry .who[data-hc]:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:6px}
.entry .who[data-hc]:hover{text-decoration:underline;text-underline-offset:2px}
.prof-hero{display:flex;gap:22px;align-items:center;flex-wrap:wrap}.prof-hero .prof-av .av.lg{width:96px;height:96px;font-size:32px}.prof-hero .prof-agent .av.sm{width:30px;height:30px;font-size:11px}
.prof-hero .prof-name{font-size:26px}.prof-bio{max-width:52ch}
.prof-sec{margin-top:16px}.prof-sec h2{font-size:15px;margin:0 0 8px}.prof-agent-sec{display:flex;gap:14px;align-items:flex-start}.prof-agent-sec:target,.prof-agent-sec.hl{box-shadow:0 0 0 2px var(--accent)}
.prof-boards{display:flex;flex-wrap:wrap;gap:8px;margin:0;padding:0;list-style:none}.prof-boards a{display:inline-block;padding:5px 10px;border:1px solid var(--line);border-radius:999px;color:var(--ink);font-size:13px}.prof-boards a:hover{background:var(--hover,color-mix(in srgb,var(--muted) 10%,transparent))}
@media (max-width:860px){.prof-hero{flex-direction:column;align-items:flex-start}.prof-hero .prof-act{width:100%}.prof-hero .prof-act .btn{flex:1;min-height:40px;justify-content:center}}
/* approvals: risk shows as the card's left edge and its badge */
.approval{padding:16px 18px;border-inline-start:3px solid var(--line)}.approval:target{outline:2px solid var(--accent);outline-offset:3px}.approval.risk-medium{border-inline-start-color:var(--warn)}.approval.risk-high{border-inline-start-color:var(--danger)}
.ap-hd{display:flex;gap:12px;align-items:flex-start}.ap-title{font-size:15px;font-weight:600;line-height:1.35;margin:0 0 3px}
.approval.risk-medium .ap-risk{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 40%,var(--line))}.approval.risk-high .ap-risk{color:var(--danger);border-color:color-mix(in srgb,var(--danger) 40%,var(--line))}
.ap-details{max-height:280px;overflow:auto;margin:12px 0 0;padding:10px 12px;border-radius:8px;background:var(--bg-subtle);border:1px solid var(--line);font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.ap-form{display:flex;gap:6px;margin-top:12px}
.ap-sub{font-size:13px;font-weight:600;margin:28px 0 8px}
.ap-done{padding:0;list-style:none;margin:0}.ap-done>li+li{border-top:1px solid var(--line)}
.ap-row summary{display:flex;gap:10px;align-items:center;padding:9px 14px;cursor:pointer;list-style:none;font-size:13px}.ap-row summary::-webkit-details-marker{display:none}
.ap-row summary:hover{background:var(--bg-hover)}.ap-row>p,.ap-row>pre{margin:0 14px 12px}
.ap-st{flex:none;width:64px;font-size:11.5px;font-weight:600;color:var(--muted)}.ap-st.st-approved{color:var(--ok)}.ap-st.st-rejected{color:var(--danger)}
@media (max-width:640px){.ap-form{flex-wrap:wrap}.ap-form .input{flex-basis:100%}.ap-form .btn{flex:1}}
.load-earlier{display:block;margin:6px auto 12px}
/* Profile pictures */
.pfps{display:grid;gap:10px}
.pfp{gap:14px;align-items:center}
/* Plans */
.plans{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
.plan{border:1px solid var(--line);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:10px}
.plan.cur{border-color:var(--accent)}
.plan-price{font-size:24px;font-weight:600;color:var(--ink)}
.plan ul{margin:0;padding-left:18px;font-size:13px;color:var(--muted);display:flex;flex-direction:column;gap:4px}
/* Boards page */
.boards-bar{gap:10px;margin:4px 0 16px;flex-wrap:wrap}
.bsearch .input{width:100%}
.bgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
.bcard{position:relative;display:flex;flex-direction:column;gap:8px;padding:14px 14px 12px;border:1px solid var(--line);border-radius:12px;background:var(--bg);transition:border-color .12s,box-shadow .12s}
.bcard:hover{border-color:color-mix(in srgb,var(--ink) 22%,var(--line));box-shadow:0 1px 0 var(--line),0 6px 18px -12px rgba(0,0,0,.25)}
.bcard[hidden]{display:none}
.bcard.archived{opacity:.7}
.bcard-link{position:absolute;inset:0;border-radius:12px;z-index:0}
.bcard .bc-edit,.bcard .bc-links a{position:relative;z-index:1}
.bc-top{gap:8px;align-items:center}
.bc-top h3{margin:0;font-size:14.5px;font-weight:600;color:var(--ink)}
.bc-dot{width:10px;height:10px;border-radius:3px;background:hsl(var(--h) 8% 55%);flex:none}
.bc-unread{font-size:11px;font-weight:600;color:var(--badge-fg);background:var(--badge-bg);border-radius:9px;padding:1px 7px;white-space:nowrap}
.bc-edit{opacity:0;transition:opacity .12s}
.bcard:hover .bc-edit,.bc-edit:focus-visible{opacity:1}
@media(hover:none){.bc-edit{opacity:1}}
.bc-desc{margin:0;font-size:13px;color:var(--muted);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:2.6em}
.bc-tags{display:flex;flex-wrap:wrap;gap:4px}
.tag{font-size:11.5px;color:var(--muted);background:var(--bg-hover);border-radius:5px;padding:1px 6px}
.bc-links{display:flex;flex-wrap:wrap;gap:10px;font-size:12px}
.bc-foot{gap:8px;align-items:center;margin-top:auto}
mark{background:var(--mark);color:inherit;border-radius:2px;padding:0 1px}
/* Tasks board */
.task-dlg{width:min(720px,calc(100vw - 32px))}
.task-dlg .td-title{font-size:15px;font-weight:600}
.td-fields{gap:10px;flex-wrap:wrap;margin-bottom:10px}
.td-fields label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted)}
.td-body{width:100%;min-height:220px;font-size:12.5px;line-height:1.5}
.td-hist{margin:6px 0 0;padding-left:16px}
.kanban-head{gap:10px;padding:12px 0;align-items:center;flex:none}
.kb-new{gap:6px;margin:0}.kb-new .input{width:240px}.kb-new .btn{height:32px} /* as tall as the box beside it */
.kanban{display:grid;grid-template-columns:repeat(4,minmax(220px,1fr));gap:12px;overflow-x:auto;align-items:start;padding-bottom:6px}
.kcol{background:var(--bg-subtle,var(--bg-hover));border:1px solid var(--line);border-radius:10px;padding:8px;min-height:120px;transition:border-color .1s,background .1s}
.kcol.over{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 6%,var(--bg))}
.kcol h3{font-size:12.5px;font-weight:600;color:var(--ink);margin:2px 4px 8px}
.kcards{display:flex;flex-direction:column;gap:6px}
.kcard{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px 10px;cursor:grab;display:flex;flex-direction:column;gap:4px}
.kcard:focus-visible,#kanban:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.kcard:hover{border-color:color-mix(in srgb,var(--ink) 25%,var(--line))}
.kcard.dragging{opacity:.5}
.kres{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.kres-l{color:var(--accent)}.kres-l:hover{text-decoration:underline}.kres .btn{margin-left:auto;padding:1px 10px}
.kcard .ktext{font-size:13px;color:var(--ink);line-height:1.4}
.kmeta{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--faint);min-height:18px}.kmeta .seq{color:var(--faint)}.kmeta .badge{height:17px;font-size:10.5px}
@media (max-width:640px){.kb-hint{display:none}.kb-new{flex:1}.kb-new .input{width:auto;flex:1}}
.badge.pri-high{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 45%,var(--line))}
.badge.pri-medium{color:var(--accent)}
.badge.pri-low{color:var(--faint)}
.inbox-item a{display:flex;gap:10px;align-items:flex-start;padding:10px;border-radius:8px;color:inherit}
.inbox-item a:hover{background:var(--bg-hover)}
.inbox-item.unread b{color:var(--ink)}
.inbox-item .dot{width:8px;height:8px;border-radius:50%;background:var(--accent);flex:none;margin-top:6px}
.remind-menu{position:relative;z-index:5;display:inline-block;font-size:12px}
.remind-menu summary{cursor:pointer;list-style:none;padding:5px 8px;border-radius:6px;color:var(--muted)}
.remind-menu summary:hover{background:var(--bg-hover);color:var(--ink)}
.remind-menu summary::-webkit-details-marker{display:none}
/* In a message's toolbar Remind me is one of its buttons (jxn #4140): the summary is a .btn like Reply, and the menu
   lines up with them instead of sitting on the text baseline. */
.acts .remind-menu{display:inline-flex;align-items:center;font-size:inherit}.acts .remind-menu summary.btn{list-style:none}
.remind-menu>div{position:absolute;right:0;top:100%;width:175px;padding:4px;background:var(--bg);border:1px solid var(--line);border-radius:8px;box-shadow:var(--shadow);z-index:20}
.remind-menu button{display:block;width:100%;padding:7px 8px;border:0;border-radius:5px;background:none;color:var(--ink);text-align:start;cursor:pointer;font:inherit}
.remind-menu button:hover{background:var(--bg-hover)}
.inbox-item>.remind-menu{margin:0 0 6px 44px}

.side-label{font-size:11.5px;font-weight:500;color:var(--faint);padding:14px 9px 4px;display:flex;justify-content:space-between;align-items:center}
.side-label a{color:var(--faint)}.side-label a:hover{color:var(--ink)}
.working{display:inline-flex;align-items:center;gap:5px;flex:none;font-size:11px;font-weight:500;color:var(--muted);white-space:nowrap}.working[hidden]{display:none}
.working .dot,.ag-dot.live{background:var(--ok);animation:breathe 2.4s ease-in-out infinite}
@keyframes breathe{0%,100%{box-shadow:0 0 0 0 color-mix(in srgb,var(--ok) 45%,transparent)}50%{box-shadow:0 0 0 3px color-mix(in srgb,var(--ok) 18%,transparent)}}
.side-board-row{display:flex;align-items:center;position:relative}.side-board-row .side-board{flex:1;min-width:0}.pin-actions{position:relative;z-index:3}.pin-actions summary{list-style:none;cursor:pointer;color:var(--muted);padding:4px 7px;border-radius:6px}.pin-actions summary::-webkit-details-marker{display:none}.pin-actions summary:hover{background:var(--bg-hover);color:var(--ink)}.pin-actions>button{position:absolute;right:0;top:100%;white-space:nowrap;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--ink);padding:7px 14px;box-shadow:var(--shadow-lg);cursor:pointer}.pin-actions>button:hover{background:var(--bg-hover)}.pin-mark{font-size:12px;flex:none}.side-board .working{margin-left:auto;font-size:10.5px}.side-board .working .dot{width:6px;height:6px}
@media (prefers-reduced-motion:reduce){.working .dot,.ag-dot.live{animation:none}}
.board-head-menu{position:relative}.bc-menu{z-index:3}.board-head-menu summary{list-style:none;cursor:pointer}.board-head-menu summary::-webkit-details-marker{display:none}.board-head-menu-items{position:absolute;right:0;top:32px;z-index:30;min-width:165px;padding:4px;background:var(--bg);border:1px solid var(--line);border-radius:8px;box-shadow:var(--shadow-lg)}.board-head-menu-items button{display:block;width:100%;padding:8px;text-align:start;border:0;background:transparent;color:var(--ink);cursor:pointer}.board-head-menu-items button:hover{background:var(--bg-hover)}.side-board-row{position:relative;display:flex;align-items:center}.side-board-row>.side-board{flex:1;min-width:0;padding-right:30px}.board-row-menu{position:absolute;right:3px;top:2px;z-index:4}.board-row-menu summary{list-style:none;cursor:pointer;padding:3px 6px;color:var(--muted)}.board-row-menu summary::-webkit-details-marker{display:none}.board-row-menu .brm-items{position:absolute;right:0;top:27px;z-index:5;min-width:150px;padding:4px;border:1px solid var(--line);border-radius:7px;background:var(--bg);box-shadow:var(--shadow-lg)}.board-row-menu .brm-items button{display:block;width:100%;white-space:nowrap;padding:8px 12px;border:0;border-radius:5px;background:transparent;color:var(--ink);text-align:start;cursor:pointer}.board-row-menu .brm-items button:hover{background:var(--bg-hover)}.side-board .bdot{width:8px;height:8px;margin:0 5px;border-radius:3px;flex:none;background:hsl(var(--h) 8% 55%)}
/* board pictures (like a group chat's photo): a rounded square, its initial underneath until the image loads */
.bpic{--h:220;position:relative;overflow:hidden;flex:none;display:inline-grid;place-items:center;width:28px;height:28px;border-radius:7px;
  background:hsl(var(--h) 8% var(--tile-l));color:var(--on-fill);font-size:13px;font-weight:600;line-height:1;user-select:none}
.bpic.xs{width:18px;height:18px;border-radius:5px;font-size:9px}.bpic.sm{width:24px;height:24px;border-radius:6px;font-size:11px}.bpic.lg{width:40px;height:40px;border-radius:10px;font-size:17px}
.bpic img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0}.bpic img.ok{opacity:1}
.bp-pic{all:unset;cursor:pointer;display:inline-flex;flex:none;border-radius:7px}.bp-pic:hover .bpic{filter:brightness(.92)}.bp-pic:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.bpic-row{gap:12px;margin-bottom:12px}
.sidebar .me{margin-top:auto;border-top:1px solid var(--line);padding-top:8px}
/* Report a bug: a quiet word at the very bottom of the sidebar, under the account row (jxn #4011). */
/* Report a bug (jxn #4051): a real button at the end of the account row, a warning triangle. */
.sidebar .me{display:flex;align-items:center;gap:6px}.sidebar .me>.side-link{flex:1;min-width:0}
.bug-help{margin-top:4px}
.bug-btn{flex:none;width:30px;height:30px;padding:0;display:inline-grid;place-items:center;border:1px solid var(--line-strong);color:var(--muted);background:var(--bg)}
.bug-btn:hover{color:var(--ink);border-color:var(--ink);background:var(--bg)}
/* Send feedback (vedu #4125): the speech bubble is an inline SVG in the button (img-src does not allow data:). */
/* Leaving Atteo (jxn #4173): the address in full, wrapped, before you go. */
#leave .leave-url{margin:0;padding:10px 12px;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--bg-subtle);font-size:13px;overflow-wrap:anywhere;color:var(--ink)}
#leave .ft,#feedback .ft{display:flex;justify-content:flex-end;gap:8px;padding:0 22px 20px}
/* The report dialog (jxn #4053, #4116): what happened, the pictures you added (paper clip, paste or drop), then Cancel / Send. */
#bug form{display:block}
#bug .bd{display:grid;gap:12px}
#bug textarea.input{min-height:110px}
.bug-pics{display:flex;flex-wrap:wrap;gap:10px;padding-top:4px}.bug-pics[hidden]{display:none}
#bug.drop .bd{outline:2px dashed var(--line-strong);outline-offset:-6px;border-radius:var(--r)}
#bug .ft{display:flex;align-items:center;gap:8px;padding:0 22px 20px}#bug .ft .grow{flex:1}
.bug-attach{width:34px;height:34px;padding:0;display:inline-grid;place-items:center;color:var(--muted)}.bug-attach:hover{color:var(--ink)}
.bug-private{display:flex;align-items:center;justify-content:center;min-height:44px;border:1px dashed var(--line-strong);border-radius:8px;color:var(--muted);font-size:13px;margin:10px 0;padding:0 10px;text-align:center}
.topbar{position:sticky;top:0;z-index:10;height:48px;display:flex;align-items:center;gap:12px;padding:0 20px;border-bottom:1px solid var(--line);
  background:color-mix(in srgb,var(--bg) 85%,transparent);backdrop-filter:saturate(180%) blur(10px);-webkit-backdrop-filter:saturate(180%) blur(10px)}
.topbar .crumbs{margin:0;display:flex;align-items:center;gap:8px;min-width:0;font-size:13px}
.topbar .crumbs .cur{color:var(--ink);font-weight:500}
.topbar .actions{margin-left:auto;display:flex;gap:8px;align-items:center}
/* phones: just the current page's name (the menu button leads back to Boards/People), so a long board name still shows */
@media(max-width:480px){.topbar .crumbs>:not(.cur){display:none}.topbar .crumbs .cur{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}}
.content{max-width:1120px;margin:0 auto;padding:28px 24px 96px}
.content.narrow{max-width:760px}
.menu-btn{display:none}
.nav-x,.nav-scrim{display:none}
@media(max-width:860px){.app{grid-template-columns:1fr}.sidebar{position:fixed;inset:0 auto 0 0;width:260px;z-index:40;transform:translateX(-100%);transition:transform .2s,box-shadow .2s}
  .app.nav-open .sidebar{transform:none;box-shadow:var(--shadow-lg)}.menu-btn{display:inline-flex}.content{padding:20px 16px 80px}.topbar{padding:0 12px}
  /* The open drawer closes with its ✕, a tap on the dimmed page beside it, a swipe back to the left, or Esc (jxn #2223). */
  .nav-x{display:inline-flex;position:absolute;top:8px;right:8px;width:32px;padding:0;justify-content:center;z-index:1}
  .app.nav-open .nav-scrim{display:block;position:fixed;inset:0;z-index:39;background:rgba(0,0,0,.32)}}
/* Connect an agent, always in the phone menu (vedu #2241): the board's header button goes once an agent is connected. */
.side-connect{display:none}@media(max-width:860px){.side-connect{display:flex}}
.side-connect .ev-l,:root[data-mode="everyday"] .side-connect .dev-l{display:none}:root[data-mode="everyday"] .side-connect .ev-l{display:inline}
kbd{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 4px;border:1px solid var(--line-strong);border-bottom-width:2px;
  border-radius:4px;font:500 10.5px/1 var(--font-mono);color:var(--muted);background:var(--bg)}

/* tabs */
.tabs{display:flex;gap:2px;border-bottom:1px solid var(--line);margin-bottom:18px}
.tabs button{font:inherit;font-size:13px;background:none;border:0;border-bottom:2px solid transparent;margin-bottom:-1px;padding:8px 10px;color:var(--muted);cursor:pointer}
.tabs button:hover{color:var(--ink)}.tabs button[aria-selected=true]{color:var(--ink);border-bottom-color:var(--ink);font-weight:500}
/* phones: tabs stay one line each and the row scrolls sideways when it can't fit (the line under them is a shadow so the scroll box doesn't clip the selected tab's underline) */
@media(max-width:640px){.tabs{overflow-x:auto;scrollbar-width:none;border-bottom:0;box-shadow:inset 0 -1px var(--line)}.tabs::-webkit-scrollbar{display:none}.tabs button{flex:none;white-space:nowrap;margin-bottom:0;padding:8px 9px}.bp-tabs .tabs{box-shadow:none;overflow:visible}.bp-tabs .tabs button{margin-bottom:-1px}}
[role=tabpanel][hidden]{display:none}

/* event log (Stripe-style) */
.log{width:100%;border-collapse:collapse;font-size:13px}
.log th{text-align:left;font-weight:500;font-size:12px;color:var(--muted);padding:7px 12px;border-bottom:1px solid var(--line);white-space:nowrap}
.log td{padding:8px 12px;border-top:1px solid var(--line);white-space:nowrap}
.log tr.ev{cursor:pointer}.log tr.ev:hover td{background:var(--bg-subtle)}
.log tr.ev.sel td{background:var(--bg-hover)}
.log td.sum{white-space:normal;color:var(--text);max-width:420px}
.log td.sum span{display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden}
.log .mono{color:var(--muted)}

/* side sheet (raw payload) */
dialog.sheet{margin:0 0 0 auto;height:100vh;max-height:100vh;width:min(520px,100vw);border-radius:0;border-width:0 0 0 1px}
dialog.sheet[open]{animation:slide .18s ease-out}
@keyframes slide{from{transform:translateX(24px);opacity:0}to{transform:none;opacity:1}}
.kv{display:grid;grid-template-columns:110px minmax(0,1fr);gap:8px 12px;font-size:13px}
.kv dt{color:var(--muted)}.kv dd{margin:0;color:var(--ink);overflow-wrap:anywhere}
pre.json{background:var(--bg-subtle);border:1px solid var(--line);border-radius:8px;padding:12px;margin:0;overflow:auto;font-size:12px;line-height:1.55;max-height:50vh}
.json .k{color:var(--accent)}.json .s{color:var(--claim)}.json .n{color:var(--decision)}

/* command palette */
dialog.palette{margin-top:12vh;width:min(600px,calc(100vw - 24px));border-radius:12px}
.palette input{border:0;border-radius:0;height:48px;padding:0 4px;font-size:15px;background:transparent;box-shadow:none!important}
.palette ul{list-style:none;margin:0;padding:6px;max-height:50vh;overflow:auto}
.pal-in{display:flex;align-items:center;gap:8px;padding:0 12px;border-bottom:1px solid var(--line);color:var(--muted)}
.pal-in input{flex:1;min-width:120px;box-shadow:none!important}
.pal-chips{display:inline-flex;gap:6px;flex-wrap:wrap}
.pal-chip{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 4px 0 8px;border-radius:6px;font-size:12.5px;font-weight:500;color:var(--accent);background:color-mix(in srgb,var(--accent) 10%,transparent);white-space:nowrap}
.pal-chip button{border:0;background:none;color:inherit;opacity:.6;cursor:pointer;font-size:10px;padding:2px 3px}.pal-chip button:hover{opacity:1}
.pal-filters{display:flex;gap:6px;flex-wrap:wrap;padding:8px 12px;border-bottom:1px solid var(--line)}.pal-filters[hidden]{display:none}
.pal-opt{height:24px;padding:0 9px;border-radius:999px;border:1px solid var(--line);background:var(--bg-subtle);color:var(--muted);font:inherit;font-size:12px;cursor:pointer}
.pal-opt:hover{color:var(--ink);border-color:var(--line-strong)}
.palette li.pal-g{padding:8px 10px 2px;font-size:11.5px;color:var(--faint);cursor:default;text-transform:uppercase;letter-spacing:.04em}
.palette .pal-l{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.palette .pal-l mark{background:var(--mark);color:inherit;border-radius:3px;padding:0 1px}
.palette li{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:7px;cursor:pointer;font-size:13.5px;color:var(--text)}
.palette li[aria-selected=true]{background:var(--bg-hover);color:var(--ink)}
.palette li .k{flex:none;white-space:nowrap;margin-left:auto;color:var(--faint);font-size:12px}
.palette .foot{display:flex;gap:14px;padding:8px 14px;border-top:1px solid var(--line);font-size:12px;color:var(--faint)}
@media (pointer:coarse){.palette .foot{display:none}}
@media (max-width:640px){.palette li:not(.pal-g){flex-wrap:wrap;row-gap:1px}.palette li .pal-l{flex:1 1 100%}.palette li .k{margin-left:0;font-size:11.5px}}
.entry.sel{background:var(--bg-subtle);border-radius:8px}

/* inline board title rename */
.title-edit{display:flex;align-items:center;gap:6px;min-width:0}
.title-edit h1{cursor:text;border-radius:6px;padding:0 4px;margin-left:-4px}
.title-edit h1:hover{background:var(--bg-hover)}
.title-edit .pencil{opacity:0;transition:opacity .12s}
.title-edit:hover .pencil,.title-edit .pencil:focus-visible{opacity:1}
/* touch screens never hover, so the pencil was only a blank gap; tapping the title renames */
@media(hover:none){.title-edit .pencil{display:none}}
.title-input{font-size:22px;font-weight:600;letter-spacing:-.02em;height:40px;max-width:640px}

/* shared documents */
.docs{display:grid;gap:20px;grid-template-columns:minmax(0,1fr)}
@media(min-width:860px){.docs{grid-template-columns:220px minmax(0,1fr)}}
.doc-item{display:flex;justify-content:space-between;gap:8px;padding:6px 8px;margin:0 -8px;border-radius:6px;font-size:13px}
.doc-item:hover,.doc-item.on{background:var(--bg-hover)}
.doc-item{align-items:baseline}.doc-item>.xs{flex:none;white-space:nowrap}.doc-item>.truncate{min-width:0} /* a long name shortens; its version and size stay on its line */
@media (pointer:coarse){.doc-item{padding:10px 8px}}
.doc-body{font-size:14px}.doc-body p+p{margin-top:10px}
/* board page: the header and tabs stay put; the thread, sidebar, log and docs each scroll on their own */
.content.full{max-width:1160px;height:calc(100vh - 48px);height:calc(100dvh - 48px);padding:6px 20px 0;display:flex;flex-direction:column;overflow:hidden}
.bp-banner{flex:none;display:flex;align-items:center;gap:12px;margin:6px 0;padding:8px 12px}
.e2e-bar{flex-wrap:wrap}.e2e-asks{flex-basis:100%;display:flex;flex-direction:column;gap:6px}.e2e-asks:empty{display:none}
.e2e-ask{display:flex;align-items:center;gap:10px;padding-top:6px;border-top:1px solid var(--line)}.e2e-ask.xs{display:block}
.entry .body .e2e-text{white-space:pre-wrap}.e2e-none{color:var(--muted);font-style:italic}
.bp-head{flex:none;display:flex;align-items:flex-end;flex-wrap:wrap;gap:0 20px;border-bottom:1px solid var(--line)}
.bp-title{flex:1 1 320px;min-width:0;display:flex;align-items:center;gap:14px;padding:6px 0 7px}
.bp-head h1{font-size:17px;line-height:26px;margin:0;min-width:0}
.bp-head .title-edit{min-width:0;flex:0 1 auto}
.bp-meta{gap:10px;flex-wrap:nowrap;min-width:0;white-space:nowrap}
.bp-meta:has(.avs){flex:none} /* the board name gives way, not the members */
.bp-tabs{display:flex;align-items:flex-end;gap:8px;flex:none}
.bp-tabs .tabs{border-bottom:0;margin-bottom:0}
.bp-tabs .tabs button{padding:7px 10px}
/* the sidebar toggle sits in the board area, top right: over the sidebar's corner, or the thread's when it's hidden */
.bp-panel .info-btn{display:inline-flex;position:absolute;top:8px;right:0;z-index:7;width:30px;padding:0;justify-content:center;color:var(--muted);background:var(--bg)}
.info-btn svg{flex:none}
/* Right-to-left (Arabic, #2335): the grid and flex layout mirror on their own with dir=rtl; these are the pieces placed
   by left/right. People's words keep their own direction, paragraph by paragraph (an English message on an Arabic page). */
[dir=rtl] .bp-panel .info-btn{right:auto;left:0}[dir=rtl] .info-btn .count{right:auto;left:-4px}
@media(max-width:860px){[dir=rtl] .sidebar{inset:0 0 0 auto;transform:translateX(100%)}[dir=rtl] .app.nav-open .sidebar{transform:none}[dir=rtl] .nav-x{right:auto;left:8px}}
[dir=rtl] .composer textarea,[dir=rtl] .cmp-mirror{unicode-bidi:plaintext}[dir=rtl] pre,[dir=rtl] code,[dir=rtl] kbd,[dir=rtl] .mono{direction:ltr;unicode-bidi:isolate}
.entry .body,.entry .body :is(p,li,h1,h2,h3,h4,h5,h6,blockquote,td,th,dd,dt),.rq-t,.fwd-q{unicode-bidi:plaintext;text-align:start}
.info-btn:hover,.info-btn[aria-expanded=true]{color:var(--ink)}
.info-btn .fill{opacity:0;transition:opacity .12s}.info-btn[aria-expanded=true] .fill{opacity:.35}
.info-btn .count{position:absolute;top:-3px;right:-4px;min-width:15px;height:15px;padding:0 4px;border-radius:999px;background:var(--badge-bg);color:var(--badge-fg);font-size:10px;font-weight:600;display:inline-grid;place-items:center;line-height:1}
.bp-panel{flex:1;min-height:0;display:flex;flex-direction:column}
.bp-panel>.layout{flex:1;min-height:0;grid-template-rows:minmax(0,1fr);position:relative;gap:20px}
@media(min-width:960px){.bp-panel>.layout{grid-template-columns:minmax(0,1fr) 280px}.bp-panel>.layout.info-collapsed{grid-template-columns:minmax(0,1fr)}.layout.info-collapsed>.aside{display:none}
  .layout.info-collapsed>.conv{width:100%;max-width:820px;margin:0 auto} /* a readable measure even with the sidebar hidden */}
.bp-panel .aside{position:static;align-self:stretch;max-height:none;min-height:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;margin:40px 0 0 -8px;padding:4px 8px 16px 8px}
/* Board info scrolls below the panel toggle (nothing slides under it), with a thin, faint scrollbar. */
.aside::-webkit-scrollbar{width:4px}
.aside::-webkit-scrollbar-track{margin:4px 0 8px}
.aside::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--muted) 22%,transparent)}
.aside::-webkit-scrollbar-thumb:hover{background:var(--sb-hover)}
.layout.info-collapsed .rail{top:44px} /* clear of the toggle when it sits over the thread */
.conv{display:flex;flex-direction:column;min-height:0;min-width:0}
.thread-wrap{flex:1;min-height:0;position:relative;display:flex}
.thread-scroll{flex:1;min-width:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;padding:8px 22px 8px var(--hl-l);margin-left:calc(-1*var(--hl-l));scrollbar-width:none} /* the left padding is room for a highlight's bleed, which overflow-x would clip */
.thread-scroll::-webkit-scrollbar{display:none} /* the rail stands in for its scrollbar */
.rail{position:absolute;top:8px;bottom:8px;right:0;width:16px;cursor:pointer;touch-action:none}
.rail i{position:absolute;right:3px;width:8px;height:2px;margin-top:-1px;border-radius:1px;background:var(--rail-mark);transition:background .12s,width .12s}
.rail i.on{background:var(--rail-on);width:10px}.rail i[data-n]{height:3px;margin-top:-1.5px}.rail i.me{background:var(--rail-you);width:10px}
.rail:hover i{background:var(--sb)}.rail:hover i.on{background:var(--muted)}.rail:hover i.me{background:var(--rail-you)} /* only a message that mentions you is black (jxn #4120) */
.rail-tip{position:absolute;right:22px;z-index:5;max-width:min(360px,70%);padding:5px 9px;margin-top:-13px;border-radius:7px;background:var(--ink);color:var(--on-ink);
  font-size:12px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;box-shadow:var(--shadow-lg)}
.rail-tip[hidden]{display:none}
.new-pill{position:absolute;left:50%;bottom:12px;transform:translateX(-50%);z-index:4;box-shadow:var(--shadow-lg);border-radius:999px}
.new-pill[hidden],.info-btn .count[hidden],.info-btn[hidden]{display:none}
.conv .composer{flex:none;margin:6px 0 max(12px,env(safe-area-inset-bottom))}
.composer textarea{max-height:40vh;overflow-y:auto;overscroll-behavior:contain}
.conv .composer textarea{min-height:48px;resize:none}
@media(max-width:480px){.composer textarea{max-height:200px}}
/* composer mention chips: the mirror draws the text (chips included) under a transparent textarea that keeps the caret */
.cmp-field{position:relative}
.cmp-mirror{position:absolute;box-sizing:border-box;margin:0;border:0;pointer-events:none;overflow:hidden;white-space:pre-wrap;overflow-wrap:break-word;color:var(--text)}
.cmp-field textarea{position:relative;background:transparent;color:transparent;caret-color:var(--text)}
.cmp-field textarea::placeholder{color:var(--faint)}
.cmp-field textarea::selection{color:transparent;background:color-mix(in srgb,var(--accent) 28%,transparent)}
.cmp-mirror .chip{color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,transparent);border-radius:4px;box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 12%,transparent)}
.cmp-mirror .chip.agent{outline:1px dashed color-mix(in srgb,var(--accent) 50%,transparent);outline-offset:1px}
#panel-log .list{flex:1;min-height:0;overflow:auto;margin-top:16px}
#panel-log .log th{position:sticky;top:0;z-index:1;background:var(--bg-subtle)}
/* phones: each entry is two lines (who, #, time; then type and summary), so nothing sits off to the side */
@media(max-width:640px){#panel-log .log thead{display:none}#panel-log .log,#panel-log .log tbody{display:block}
  #panel-log .log tr.ev{display:grid;grid-template-columns:auto minmax(0,1fr) auto auto;grid-template-areas:"who who seq time" "type sum sum sum";align-items:center;gap:4px 8px;padding:9px 12px;border-top:1px solid var(--line)}
  #panel-log .log tr.ev:first-child{border-top:0}#panel-log .log tr.ev:hover,#panel-log .log tr.ev.sel{background:var(--bg-hover)}
  #panel-log .log tr.ev td{padding:0;border:0;min-width:0;background:none}
  #panel-log .log td:nth-child(1){grid-area:time;font-size:11.5px}#panel-log .log td:nth-child(2){grid-area:seq;font-size:11.5px}
  #panel-log .log td:nth-child(3){grid-area:who;overflow:hidden}#panel-log .log td:nth-child(3) .row{flex-wrap:nowrap;white-space:nowrap}
  #panel-log .log td:nth-child(4){grid-area:type}#panel-log .log td:nth-child(5){display:none}#panel-log .log td.sum{grid-area:sum;max-width:none}}
#panel-log>p{flex:none;margin:8px 0 14px}
#panel-docs .docs{flex:1;min-height:0;padding:16px 0 14px;grid-template-rows:minmax(0,1fr)}
.doc-list{min-height:0;overflow-y:auto;overflow-x:hidden;padding:0 8px;margin:0 -8px} /* room for the items' hover background */
.doc-view{min-height:0;overflow-y:auto;overflow-x:hidden}
.doc-view.editing{display:flex;flex-direction:column;overflow:hidden} /* only the editor scrolls */
.doc-view.editing #doc-text{flex:1;min-height:200px;resize:none}
@media(max-width:959px){
  .bp-panel .aside{display:none}
  .layout.info-open>.aside{display:block;position:absolute;inset:0;z-index:6;background:var(--bg);margin:0;padding:44px 2px 16px}
  .info-btn[aria-expanded="true"]>svg,.info-btn[aria-expanded="true"]>.count{display:none}.info-btn[aria-expanded="true"]::after{content:"✕"} /* its ✕ while the panel covers the conversation (jxn #2223) */
  .bp-panel .rail{top:44px}
  .layout.info-open>.conv{visibility:hidden} /* only the open panel's scrollbar shows */
}
@media(max-width:859px){
  .content.full{padding:4px 12px 0}
  .bp-head{flex-direction:column;align-items:stretch;flex-wrap:nowrap} /* one column: a wrapping one sizes to its widest row and pushes the members off a 320px screen */
  .bp-title{flex:none;gap:10px;padding:4px 0 0}
  .bp-tabs .tabs button{padding:7px 8px}
  #panel-docs .docs{grid-template-rows:auto minmax(0,1fr)}
  .doc-list{max-height:22vh}
}

/* landing */
.hero{text-align:center;padding:64px 0 40px}
.hero h1{font-size:clamp(34px,6vw,56px);letter-spacing:-.045em;line-height:1.05;margin:18px auto 16px;max-width:760px}
.hero p.lead{font-size:17px;color:var(--muted);max-width:560px;margin:0 auto 28px}
.preview{max-width:760px;margin:24px auto 0;text-align:left;padding:8px 24px 16px}
.steps{display:grid;gap:16px;margin-top:32px}
@media(min-width:760px){.steps{grid-template-columns:repeat(3,1fr)}}
.steps .card{padding:20px}.steps .k{font-size:12px;color:var(--faint);margin-bottom:10px}
.stat{font-size:28px;font-weight:600;letter-spacing:-.03em;color:var(--ink)}
.grid4{display:grid;gap:12px;grid-template-columns:repeat(2,1fr)}@media(min-width:760px){.grid4{grid-template-columns:repeat(4,1fr)}}
.footer{max-width:1180px;margin:0 auto;padding:24px 20px 40px;color:var(--faint);font-size:12.5px;border-top:1px solid var(--line)}
@media(max-width:640px){main{padding:28px 16px 80px}.nav .in{padding:0 16px}.nav .links{display:none}h1{font-size:24px}.list .item{padding:12px 14px}
  .hide-sm{display:none!important}.sm-only{display:inline}
  .tbl th,.tbl td{padding-left:12px;padding-right:12px}}
/* "… is typing" above the composer: avatars, a name, three breathing dots */
.typing{display:flex;align-items:center;gap:8px;min-height:22px;margin:0 0 6px 4px;font-size:12px;color:var(--muted)}
.typing .ty-avs{display:inline-flex}.typing .ty-avs .av{width:18px;height:18px;font-size:8px;border:2px solid var(--bg);margin-left:-6px}.typing .ty-avs .av:first-child{margin-left:0}
.ty-dots{display:inline-flex;gap:3px}.ty-dots i{width:4px;height:4px;border-radius:50%;background:currentColor;opacity:.35;animation:tydot 1.2s infinite}
.ty-dots i:nth-child(2){animation-delay:.2s}.ty-dots i:nth-child(3){animation-delay:.4s}
@keyframes tydot{30%{opacity:1;transform:translateY(-2px)}60%,100%{opacity:.35;transform:none}}
@media (prefers-reduced-motion:reduce){.ty-dots i{animation:none;opacity:.6}}
/* Message numbers stay out of people's way: the header's #N shows on hover/focus; "#N" in text is a titled chip */
.entry .meta .seq{opacity:0;transition:opacity .12s}.entry:hover>.grow>.meta .seq,.entry .meta .seq:focus-visible{opacity:1}
@media (hover:none){.entry .meta .seq{display:none}}
a.ref{display:inline-flex;align-items:center;max-width:22em;padding:0 6px;border-radius:5px;background:var(--bg-hover);color:var(--text);font-size:.92em;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;vertical-align:bottom}
a.ref:hover{color:var(--ink);background:color-mix(in srgb,var(--accent) 12%,var(--bg-hover))}
.sum li .n,.kmeta .seq,#td-seq{display:none}
/* The pinned doc (vedu #977): a slim bar on top of the conversation and the side panel's first section */
.pin-bar{flex:none;margin:8px 0;min-width:0}
@media(max-width:959px){.pin-bar{margin-right:38px}}.layout.info-collapsed .pin-bar{margin-right:38px} /* clear of the board-info toggle in the corner */
.pin-open{display:flex;align-items:center;gap:8px;width:100%;min-width:0;height:32px;padding:0 10px;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--bg-subtle);color:var(--text);font:inherit;font-size:13px;text-align:left;cursor:pointer}
.pin-open:hover{border-color:var(--line-strong);background:var(--bg-hover)}.pin-open svg,.pin-card svg{flex:none;color:var(--muted)}
.pin-name{flex:0 1 auto;color:var(--ink);font-size:12.5px;font-weight:500}.pin-peek{flex:1 1 0;min-width:0;color:var(--muted)}
.pin-card{display:flex;flex-direction:column;align-items:stretch;gap:4px;width:100%;min-width:0;padding:8px 10px;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--bg);color:var(--text);font:inherit;text-align:left;cursor:pointer}
.pin-card:hover{border-color:var(--line-strong)}.pin-card b{font-size:12.5px;color:var(--ink)}
.pin-prev{position:relative;max-height:150px;overflow:hidden;font-size:12.5px;line-height:1.5;margin-top:2px}
.pin-prev::after{content:"";position:absolute;left:0;right:0;bottom:0;height:36px;background:linear-gradient(transparent,var(--bg))}
.pin-prev h1,.pin-prev h2,.pin-prev h3{font-size:13px;margin:4px 0;color:var(--ink);text-transform:none}.pin-prev p,.pin-prev ul,.pin-prev ol{margin:4px 0}
.pin-img{display:block;max-width:100%;max-height:150px;border-radius:6px;margin-top:4px}
#doc-pin svg{margin-right:2px}#doc-pin.on{color:var(--accent)}
/* Recap: a header button and a sheet (bottom sheet on phones) */
.recap-btn{position:relative;gap:5px;align-self:center;color:var(--muted)}.recap-btn:hover{color:var(--ink)}
/* People (jxn #1731): only what people wrote. Agents' posts are hidden for this viewer alone (a root attribute from this browser) */
/* One-line messages (jxn #2690): a message that doesn't mention you is its sender and first line on one row; a tap
   opens it (.ol-open), the page's ⋯ opens them all (data-ol-all). Which ones fold is the page script's call (.ol). */
:root[data-compact="others"]:not([data-ol-all]) #thread>.entry.ol:not(.ol-open){padding-top:5px;padding-bottom:5px;cursor:pointer;align-items:center}
:root[data-compact="others"]:not([data-ol-all]) #thread>.entry.ol:not(.ol-open)>.av{width:20px;height:20px;font-size:9px;margin-top:0}
:root[data-compact="others"]:not([data-ol-all]) #thread>.entry.ol:not(.ol-open)>.grow{display:flex;align-items:baseline;gap:8px;min-width:0}
:root[data-compact="others"]:not([data-ol-all]) #thread>.entry.ol:not(.ol-open)>.grow>.meta{flex:0 1 auto;max-width:46%;flex-wrap:nowrap;overflow:hidden;white-space:nowrap}
:root[data-compact="others"]:not([data-ol-all]) #thread>.entry.ol:not(.ol-open)>.grow>.body{flex:1;min-width:0;margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--muted)}
:root[data-compact="others"]:not([data-ol-all]) #thread>.entry.ol:not(.ol-open)>.grow>.body *{display:inline;margin:0;padding:0;border:0;background:none;font-size:inherit;font-weight:inherit;white-space:nowrap}
:root[data-compact="others"]:not([data-ol-all]) #thread>.entry.ol:not(.ol-open)>.grow>.body br,:root[data-compact="others"]:not([data-ol-all]) #thread>.entry.ol:not(.ol-open)>.grow>.body img,:root[data-compact="others"]:not([data-ol-all]) #thread>.entry.ol:not(.ol-open)>.grow>:not(.meta):not(.body),:root[data-compact="others"]:not([data-ol-all]) #thread>.entry.ol:not(.ol-open) .acts,:root[data-compact="others"]:not([data-ol-all]) #thread>.entry.ol:not(.ol-open) .more-acts,:root[data-compact="others"]:not([data-ol-all]) #thread>.entry.ol:not(.ol-open)>.rd{display:none}
/* Folded rows keep only avatar, name, time and text (jxn #4635); metadata returns when opened. */
:root[data-compact="others"]:not([data-ol-all]) #thread>.entry.ol:not(.ol-open)>.grow>.meta>:not(.who):not(.when),
:root[data-compact="others"]:not([data-ol-all]) #thread>.entry.ol:not(.ol-open)>.grow>.body .mention::after{display:none}
.agent-info{display:none;color:var(--muted)}
:root[data-compact="others"] #thread>.entry.ol:is(.ol-open,[data-ol-all] .ol)>.grow>.meta>.agent-info{display:inline}
:root[data-compact="others"] #thread>.entry.ol:is(.ol-open,[data-ol-all] .ol)>.grow>.meta>.who{order:-2}:root[data-compact="others"] #thread>.entry.ol:is(.ol-open,[data-ol-all] .ol)>.grow>.meta>.when{order:-1} /* name, time, then the details: the time stays clear of the first row's action bar */
:root[data-compact="others"] #thread>.entry.ol:is(.ol-open,[data-ol-all] .ol)>.grow>.meta>:is(.seq,.t-change){display:inline-flex!important}
:root:not([data-compact="others"]) .ol-all{display:none}
.mu-line{display:none}
.entry.mu:not(.mu-open)>:not(.mu-line){display:none!important} /* a muted member's post: one line until opened (#3602) */
.entry.mu:not(.mu-open){padding-top:3px;padding-bottom:3px}
.entry.mu:not(.mu-open)>.mu-line{display:block;background:none;border:0;padding:2px 0;font:inherit;font-size:12.5px;color:var(--faint);cursor:pointer;text-align:left}
.mu-line:hover{color:var(--muted)}
.rp-err{color:var(--danger);margin:0}
:root[data-compact="others"] #thread>.entry.ol:focus-visible{outline:2px solid var(--accent);outline-offset:-2px;border-radius:6px}
:root[data-replies="thread"] #thread>.entry[data-root],:root[data-replies="thread"] #thread>.ghost[data-root]{display:none} /* replies only in their threads (vedu #2360) */
:root[data-pf] #thread>.entry.by-agent,:root[data-pf] #thread>.ghost.by-agent,:root[data-pf] .thr-dlg:not(.thr-all) .thr-list>.entry.by-agent:not(:first-child){display:none}
/* A thread's own Show agents (jxn #2191): only under Hide agents, only when the thread has agents' replies. */
.thr-pf{color:var(--muted)}.thr-pf:hover{color:var(--ink)}.thr-pf[aria-pressed="true"]{color:var(--ink);background:var(--bg-hover)}.thr-pf[hidden],:root:not([data-pf]) .thr-pf{display:none}
.pf-btn{gap:5px;align-self:center;color:var(--muted)}.pf-btn:hover{color:var(--ink)}.pf-btn[aria-pressed="true"]{color:var(--ink);background:var(--bg-hover)}
.pf-empty{margin:28px auto;max-width:420px;padding:0 16px;text-align:center;font-size:13px;color:var(--faint)}
@media(max-width:640px){.pf-btn span{display:none}.pf-btn{width:30px;padding:0;justify-content:center}} /* phones: the icon, so Recap still fits by the tabs */
@media(max-width:379px){.recap-l{display:none}.recap-btn{width:30px;padding:0;justify-content:center}.recap-dot{position:absolute;top:4px;right:4px;margin:0;box-shadow:0 0 0 2px var(--bg)}} /* with Hide agents beside it */
@media(max-width:359px){.bp-tabs{gap:2px}.bp-tabs .tabs button{padding-left:5px;padding-right:5px}} /* the narrowest phones: Recap stays clear of the info button below it */
@media(pointer:coarse){.bp-tabs>.pf-btn,.bp-tabs>.recap-btn{z-index:1}} /* their taller tap areas sit over the conversation's top edge */
.pf-list{flex:none}.pf-list[aria-pressed="true"]{background:var(--bg-hover);color:var(--ink);border-color:var(--line-strong)}
.recap-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--accent);align-self:flex-start;margin:5px 0 0 -2px}
dialog.recap-dlg{width:min(560px,calc(100vw - 32px));max-height:min(80vh,720px)}
.recap-dlg .bd{overflow-y:auto;max-height:calc(min(80vh,720px) - 80px)}
.rc-sec+.rc-sec{margin-top:18px}.rc-sec h3{font-size:12px;font-weight:600;color:var(--muted);margin:0 0 6px;text-transform:none}
.rc-sec ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.rc-sec li a{display:flex;flex-direction:column;gap:1px;padding:6px 8px;margin:0 -8px;border-radius:6px;color:var(--text);text-decoration:none;min-width:0}
.rc-sec li a:hover{background:var(--bg-hover)}.rc-t{font-size:13.5px;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rc-owe+.rc-owe{margin-top:10px}.rc-owe-h{display:flex;align-items:center;gap:6px;font-size:13px;margin-bottom:2px}.rc-owe-h b{color:var(--ink);font-weight:500}
.rc-none{margin:4px 0}
@media(max-width:359px){.recap-l{display:none}.recap-btn{width:30px;padding:0;justify-content:center}.recap-dot{position:absolute;top:4px;right:4px;margin:0;box-shadow:0 0 0 2px var(--bg)}}
@media(max-width:640px){dialog.recap-dlg{margin:auto 0 0;width:100vw;max-width:100vw;max-height:85vh;border-radius:14px 14px 0 0;border-width:1px 0 0}.recap-dlg .bd{max-height:calc(85vh - 80px)}}
`;

// The mark (jxn #2944/#2980, vedu #2968): hand-drawn tin-can phones, an oxblood cone (you) wired to two ink cans
// (agents). Its hand wobble is the SVG filter; never recoloured beyond its two tokens, which follow the theme (ink and
// cone, so on dark it's paper and the brighter oxblood). At least 20px tall. Same drawing as ios/design/logo-cans.
const LOGO = `<svg class="pebble" width="24" height="24" viewBox="112 112 800 800" aria-hidden="true"><defs><filter id="atm" x="-10%" y="-10%" width="120%" height="120%"><feTurbulence type="fractalNoise" baseFrequency="0.018" numOctaves="2" seed="7"/><feDisplacementMap in="SourceGraphic" scale="16"/></filter></defs><g transform="translate(512 512) translate(-519.9 -507.7)"><g filter="url(#atm)" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M400.0 512.0Q512.1 403.2 650.0 330.0M400.0 512.0Q517.1 623.8 660.0 700.0" stroke="var(--ink)" stroke-width="22"/><g stroke-width="36"><g transform="translate(400.0 512.0) rotate(-90.0)" stroke="var(--cone)"><path d="M-95 -200L-19 0H19L95 -200"/><ellipse cx="0" cy="-200" rx="95" ry="32.3"/></g><g transform="translate(650.0 330.0) rotate(53.9)" stroke="var(--ink)"><path d="M-70 -200V-6Q0 30.8 70 -6V-200"/><ellipse cx="0" cy="-200" rx="70" ry="23.8"/></g><g transform="translate(660.0 700.0) rotate(125.9)" stroke="var(--ink)"><path d="M-70 -200V-6Q0 30.8 70 -6V-200"/><ellipse cx="0" cy="-200" rx="70" ry="23.8"/></g></g></g></g></svg>`;

/** The mark at another height (the first-run screen and Account's "Your assistant" card). */
export function pebble(px: number): string {
  return LOGO.replace('width="24" height="24"', `width="${px}" height="${px}"`);
}

/** The wordmark is plain STIX Two Text now (jxn #4682), with no filter: kept so pages that place it still build. */
export const WORDMARK_DEFS = "";

// The app icon (atteo-icon-light / -dark): the mark on its paper (or ink) tile.
export const ICON_LIGHT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs><clipPath id="bsq"><rect width="1024" height="1024" rx="230"/></clipPath><filter id="brough" x="-10%" y="-10%" width="120%" height="120%"><feTurbulence type="fractalNoise" baseFrequency="0.018" numOctaves="2" seed="7"/><feDisplacementMap in="SourceGraphic" scale="16"/></filter></defs><g clip-path="url(#bsq)"><rect width="1024" height="1024" fill="#FAFAF7"/><g transform="translate(512 512) translate(-519.9 -507.7)"><g filter="url(#brough)" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M400.0 512.0Q512.1 403.2 650.0 330.0M400.0 512.0Q517.1 623.8 660.0 700.0" stroke="#0E0E0E" stroke-width="22"/><g stroke-width="36"><g transform="translate(400.0 512.0) rotate(-90.0)" stroke="#6A1B24"><path d="M-95 -200L-19 0H19L95 -200"/><ellipse cx="0" cy="-200" rx="95" ry="32.3"/></g><g transform="translate(650.0 330.0) rotate(53.9)" stroke="#0E0E0E"><path d="M-70 -200V-6Q0 30.8 70 -6V-200"/><ellipse cx="0" cy="-200" rx="70" ry="23.8"/></g><g transform="translate(660.0 700.0) rotate(125.9)" stroke="#0E0E0E"><path d="M-70 -200V-6Q0 30.8 70 -6V-200"/><ellipse cx="0" cy="-200" rx="70" ry="23.8"/></g></g></g></g></g></svg>`;
export const ICON_DARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs><clipPath id="bsq"><rect width="1024" height="1024" rx="230"/></clipPath><filter id="brough" x="-10%" y="-10%" width="120%" height="120%"><feTurbulence type="fractalNoise" baseFrequency="0.018" numOctaves="2" seed="7"/><feDisplacementMap in="SourceGraphic" scale="16"/></filter></defs><g clip-path="url(#bsq)"><rect width="1024" height="1024" fill="#0E0E0E"/><g transform="translate(512 512) translate(-519.9 -507.7)"><g filter="url(#brough)" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M400.0 512.0Q512.1 403.2 650.0 330.0M400.0 512.0Q517.1 623.8 660.0 700.0" stroke="#FAFAF7" stroke-width="22"/><g stroke-width="36"><g transform="translate(400.0 512.0) rotate(-90.0)" stroke="#C2414D"><path d="M-95 -200L-19 0H19L95 -200"/><ellipse cx="0" cy="-200" rx="95" ry="32.3"/></g><g transform="translate(650.0 330.0) rotate(53.9)" stroke="#FAFAF7"><path d="M-70 -200V-6Q0 30.8 70 -6V-200"/><ellipse cx="0" cy="-200" rx="70" ry="23.8"/></g><g transform="translate(660.0 700.0) rotate(125.9)" stroke="#FAFAF7"><path d="M-70 -200V-6Q0 30.8 70 -6V-200"/><ellipse cx="0" cy="-200" rx="70" ry="23.8"/></g></g></g></g></g></svg>`;
export const FAVICON_SVG = ICON_LIGHT_SVG; // the paper tile reads on light and dark tab bars alike
// The icons' addresses carry a hash of the drawing (jxn #4247): browsers keep a favicon for days, so a new logo only
// shows once its address changes.
export const FAVICON_SRC = `/favicon.svg?v=${fnv(FAVICON_SVG)}`;
export const APPLE_TOUCH_SRC = `/apple-touch-icon.png?v=${fnv(APPLE_TOUCH_PNG_B64)}`;

export interface Viewer {
  name: string;
  email: string;
  display_name: string | null;
  admin: boolean;
  via?: "agent" | "person"; // "agent" when the request came with a personal token (scripts, CLI, other agents)
  lang?: Lang; // the interface language for pages (i18n.ts); English when unset
}

function extraCss(hrefs?: string[]): string {
  return (hrefs ?? []).map((href) => `<link rel="stylesheet" href="${esc(href)}">`).join("");
}

export function page(
  title: string,
  body: string,
  opts: { viewer?: Viewer | null; nav?: "boards" | "admin" | "me" | null; narrow?: boolean; script?: string; status?: number; headers?: HeadersInit; lang?: Lang; formAction?: string[]; css?: string[] } = {},
): Response {
  const v = opts.viewer;
  const security = pageSecurity({ formAction: opts.formAction });
  const link = (href: string, label: string, key: string) => `<a href="${esc(href)}"${opts.nav === key ? ' aria-current="page"' : ""}>${label}</a>`;
  const nav = `<header class="nav"><div class="in">
<a class="brand" href="/">${LOGO}<span class="wm">atteo</span></a>
${v ? `<nav class="links">${link("/", esc(tr(opts.lang, "Boards")), "boards")}</nav>` : ""}
<div class="right">${
    v
      ? `<a href="/me" class="row" title="${esc(tr(opts.lang, "Account"))}">${avatar(v.name)}<span class="small hide-sm">${esc(v.name)}</span></a>`
      : `<a class="btn sm primary" href="/auth/login">${esc(tr(opts.lang, "Sign in"))}</a>`
  }</div></div></header>`;
  const html = styleNonce(`<!doctype html><html lang="${opts.lang ?? "en"}"${dirOf(opts.lang) === "rtl" ? ' dir="rtl"' : ""}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
${FONT_PRELOAD}
<link rel="icon" href="${FAVICON_SRC}" type="image/svg+xml"><link rel="apple-touch-icon" href="${APPLE_TOUCH_SRC}">
<link rel="stylesheet" href="${APP_CSS_SRC}">${extraCss(opts.css)}${DISPLAY_HEAD.replace("<script>", `<script nonce="${security.nonce}">`)}</head><body>${WORDMARK_DEFS}${nav}
<main${opts.narrow ? ' class="narrow"' : ""}>${body}</main>
<div id="toast" role="status" aria-live="polite"></div>
${analyticsScriptTag(security.nonce)}<script src="${APP_JS_SRC}" nonce="${security.nonce}"></script>${opts.script ? `<script nonce="${security.nonce}">${opts.script}</script>` : ""}</body></html>`, security.nonce);
  const headers = new Headers(opts.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  for (const [name, value] of Object.entries(security.headers)) headers.set(name, value);
  return new Response(html, { status: opts.status ?? 200, headers });
}

// ---------- components ----------

export function hue(name: string): number {
  // FNV-1a: spreads short handles across the palette better than a simple multiplicative hash.
  let h = 0x811c9dc5;
  for (const c of name) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  const hues = [8, 28, 46, 140, 168, 192, 214, 248, 280, 322];
  return hues[h % hues.length];
}

export function initials(name: string): string {
  const parts = name.split(/[._\-\s]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? parts[0]?.[1] ?? "")).toUpperCase();
}

/** People are circles; their agents are rounded squares with a small bolt, so the two read apart at a glance. */
/** Initials on a color, covered by the member's picture when they've set one (a missing picture just stays hidden). */
export function avatar(name: string, size: "" | "xs" | "sm" | "lg" = "", agent = false): string {
  const src = `/avatar/${encodeURIComponent(name)}${agent ? "?k=agent" : ""}`;
  return `<span class="av ${size}${agent ? " agent" : ""}" style="--h:${hue(name)}" title="${esc(agent ? `${name}'s agent` : name)}">${esc(initials(name))}<img class="av-img" src="${esc(src)}" alt="" loading="lazy"></span>`;
}

export function avatarStack(names: string[], max = 5): string {
  const shown = names.slice(0, max).map((n) => avatar(n, "sm")).join("");
  const more = names.length > max ? `<span class="xs muted" style="margin-left:6px">+${names.length - max}</span>` : "";
  return `<span class="avs">${shown}</span>${more}`;
}

export function typeTag(type: string, lang?: Lang): string {
  return `<span class="type t-${esc(type)}"><span class="dot"></span><span>${esc(tr(lang, type))}</span></span>`;
}

export function copyField(id: string, text: string): string {
  return `<div class="copy"><pre class="mono" id="${id}">${esc(text)}</pre><button type="button" class="btn sm" data-copy="${id}">Copy</button></div>`;
}

/** Relative time rendered on the server and kept fresh by the client script. */
export function when(ts: number, lang?: Lang): string {
  return `<time class="when" datetime="${new Date(ts).toISOString()}" data-ts="${ts}" title="${new Date(ts).toUTCString()}">${relTime(ts, Date.now(), lang)}</time>`;
}

export function relTime(ts: number, now = Date.now(), lang?: Lang): string {
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 45) return tr(lang, "just now");
  if (s < 3600) return tr(lang, "{n}m ago", { n: Math.round(s / 60) });
  if (s < 86400) return tr(lang, "{n}h ago", { n: Math.round(s / 3600) });
  if (s < 86400 * 7) return tr(lang, "{n}d ago", { n: Math.round(s / 86400) });
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Small, safe markdown subset for entry bodies: fenced code, inline code, **bold**, http(s) links, paragraphs.
 * Everything is escaped first; only these constructs are turned back into tags.
 */
/** Markdown-ish text to HTML. `mentions` (the entry's stored mentions) are highlighted; other "@x" stays plain. */
/** Named agents for the text being rendered (owner → name), so "@Jarvis" draws as a chip; set only while renderText runs. */
let NAMES: Record<string, string> | null = null;
/** The author's own forms, drawn as chips for display only (highlightMentions' `self`); set only while renderText runs. */
let SELF: Mention[] | null = null;
export function renderText(text: string, mentions?: Mention[] | null, names?: Record<string, string> | null, self?: Mention[] | null): string {
  NAMES = names ?? null;
  SELF = self ?? null;
  try {
    return renderTextInner(text, mentions);
  } finally {
    NAMES = null;
    SELF = null;
  }
}
function renderTextInner(text: string, mentions?: Mention[] | null): string {
  const out: string[] = [];
  const ck = { n: 0 }; // checklist items ("- [ ] …") are numbered in order, so a page can tick the n-th one
  // ```lang blocks: [text, lang, code, text, …]; ```chart draws a chart, ```mermaid a diagram once it's on screen (vedu #1246).
  const parts = text.split(/```([^\n`]*)\n?([\s\S]*?)```/g);
  parts.forEach((part, i) => {
    if (i % 3 === 1) return;
    if (i % 3 === 2) {
      const lang = parts[i - 1].trim().toLowerCase();
      if (lang === "status") return void out.push(statusHtml(part)); // the status card (#1289), made live by the board page

      // Code gets a small header with its language and Copy (jxn #1255).
      const code = `<pre><code>${esc(part.replace(/\n$/, ""))}</code></pre>`;
      out.push(lang === "chart" ? chartHtml(part) : lang === "mermaid" ? mermaidHtml(part) : `<div class="code-b"><div class="code-h"><span class="mono">${esc(lang.replace(/[^\w+#.-]/g, "").slice(0, 20)) || "code"}</span><button type="button" class="code-copy" data-copy-code aria-label="Copy the code">Copy</button></div>${code}</div>`);
      return;
    }
    const paras = part.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    for (const p of paras) out.push(block(p, mentions, ck));
  });
  return out.join("");
}

/** One paragraph-sized block: headings (#–###), bullet and numbered lists, or a paragraph. */
function block(p: string, mentions?: Mention[] | null, ck = { n: 0 }): string {
  const lines = p.split("\n");
  const out: string[] = [];
  let list: { kind: "ul" | "ol"; items: string[] } | null = null;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join("\n"), mentions)}</p>`);
    para = [];
  };
  const flushList = () => {
    const item = (i: string) => {
      const c = i.match(/^\[( |x|X)\]\s+(.+)$/);
      if (!c) return `<li>${inline(i, mentions)}</li>`;
      const done = c[1] !== " ";
      return `<li class="ck${done ? " done" : ""}" data-ck="${ck.n++}"><input type="checkbox" disabled${done ? " checked" : ""}><span>${inline(c[2], mentions)}</span></li>`;
    };
    if (list) out.push(`<${list.kind}>${list.items.map(item).join("")}</${list.kind}>`);
    list = null;
  };
  let quote: string[] | null = null;
  const flushQuote = () => {
    // A quote ending "— who, #N" quotes message N (vedu #1022): a box with who said it and a link back to it.
    const src = quote && quote.length > 1 ? quote[quote.length - 1].match(/^— (.+), #(\d{1,6})$/) : null;
    if (src) out.push(`<blockquote class="md-q qt"><div class="qt-hd"><span class="qt-who">${esc(src[1])}</span><a class="qt-go" href="#e${src[2]}" data-jump="${src[2]}">↗ original</a></div><div class="qt-t">${inline(quote!.slice(0, -1).join("\n"), mentions)}</div></blockquote>`);
    else if (quote) out.push(`<blockquote class="md-q">${inline(quote.join("\n"), mentions)}</blockquote>`);
    quote = null;
  };
  // Markdown tables ("| a | b |" rows with a "|---|---|" line under the header): a real table, scrolling sideways when wide.
  let table: string[] | null = null;
  const cells = (r: string) => r.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  const flushTable = () => {
    const t = table;
    table = null;
    if (!t) return;
    if (t.length < 2 || !/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(t[1].trim())) {
      para.push(...t);
      return;
    }
    const align = cells(t[1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : ""));
    const td = (tag: string, c: string, i: number) => `<${tag}${align[i] ? ` style="text-align:${align[i]}"` : ""}>${inline(c, mentions)}</${tag}>`;
    out.push(`<div class="md-tw"><table class="md-t"><thead><tr>${cells(t[0]).map((c, i) => td("th", c, i)).join("")}</tr></thead><tbody>${t.slice(2).map((r) => `<tr>${cells(r).map((c, i) => td("td", c, i)).join("")}</tr>`).join("")}</tbody></table></div>`);
  };
  for (const line of lines) {
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushPara();
      flushList();
      flushQuote();
      (table ??= []).push(line);
      continue;
    }
    flushTable();
    // "> " lines are a quote (forwarded messages are written this way).
    const q = line.match(/^>\s?(.*)$/);
    if (q) {
      flushPara();
      flushList();
      (quote ??= []).push(q[1]);
      continue;
    }
    flushQuote();
    const h = line.match(/^(#{1,3})\s+(.+)$/);
    const ul = line.match(/^\s*[-*]\s+(.+)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (h) {
      flushPara();
      flushList();
      const level = h[1].length + 2; // # → h3, ## → h4, ### → h5 (stay below page headings)
      out.push(`<h${level} class="md-h">${inline(h[2], mentions)}</h${level}>`);
    } else if (ul || ol) {
      flushPara();
      const kind = ul ? "ul" : "ol";
      if (!list || list.kind !== kind) {
        flushList();
        list = { kind, items: [] };
      }
      list.items.push((ul ?? ol)![1]);
    } else {
      flushList();
      para.push(line);
    }
  }
  flushTable();
  flushPara();
  flushList();
  flushQuote();
  return out.join("");
}

const URL_RE = /\bhttps?:\/\/[^\s<>"')]+[^\s<>"').,;:!?]/g;

function inline(s: string, mentions?: Mention[] | null): string {
  const chunks = s.split(/(`[^`\n]+`)/g);
  return chunks
    .map((c, i) => {
      if (i % 2 === 1) return `<code>${esc(c.slice(1, -1))}</code>`;
      let h = esc(c);
      h = h.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
      // Links and mentions are found in separate pieces, so a mention is never wrapped inside a link's href.
      const urls = h.match(URL_RE) ?? [];
      h = h
        .split(URL_RE)
        .map((t, j) => highlightMentions(t, mentions, NAMES, SELF) + (j < urls.length ? `<a href="${urls[j]}" target="_blank" rel="noopener noreferrer">${urls[j]}</a>` : ""))
        .join("");
      return h.replace(/\n/g, "<br>");
    })
    .join("");
}

// ---------- client script (shared by every page) ----------

// Applies the saved Display settings before first paint, so the page never flashes the wrong size or theme.
const DISPLAY_HEAD = `<script>try{const d=JSON.parse(localStorage.getItem('atteo-display')||'{}'),r=document.documentElement;
if(d.text==='s'||d.text==='l')r.dataset.text=d.text;if(d.density==='compact')r.dataset.density='compact';if(d.theme==='light'||d.theme==='dark')r.dataset.theme=d.theme;if(d.ev===true)r.dataset.mode='everyday';if(d.replies==='thread')r.dataset.replies='thread';if(d.compact==='others')r.dataset.compact='others'}catch{}</script>`; // mode: what the account said last time (set on the first sync)

const CLIENT_JS = `
// Saving a picture or a file (jxn #2684) is an <a download data-save>. On a phone that can share files (iOS Safari,
// Android Chrome) it opens the share sheet instead (Save Image, Save to Files, AirDrop…); anywhere else, or if sharing
// isn't allowed after the fetch, the browser downloads it.
// Another site asks first, with the whole address (jxn #4173).
const ext=h=>{try{const u=new URL(h,location.href);return u.origin!==location.origin&&/^https?:$/.test(u.protocol)?u.href:''}catch(x){return''}},$l=i=>document.getElementById(i);
document.addEventListener('click',e=>{if(e.defaultPrevented||e.button||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;const a=e.target.closest?.('a[href]:not([data-save])');
  if(a&&a.closest('.entry .body,.entry .chg,#doc-view,.pin-peek,.pin-card')&&ext(a.getAttribute('href'))){e.preventDefault();leaveTo(a.href)}
  else if(e.target.closest?.('#leave-go')){const d=$l('leave');d.close();open(d.dataset.href,'_blank','noopener,noreferrer')}});
window.leaveTo=h=>{const x=ext(h);if(!x)return open(h,'_blank','noopener,noreferrer');let d=$l('leave');
  if(!d){d=document.createElement('dialog');d.id='leave';d.setAttribute('aria-labelledby','leave-title');d.innerHTML='<div class="hd"><h2 id="leave-title"></h2><button type="button" class="btn ghost sm" data-close>✕</button></div><div class="bd"><p class="mono leave-url" id="leave-url"></p></div><div class="ft"><button type="button" class="btn" data-close></button><button type="button" class="btn primary" id="leave-go"></button></div>';
    const b=d.querySelectorAll('button');d.querySelector('h2').textContent=tr('Open this link?');b[0].ariaLabel=tr('Close');b[1].textContent=tr('Cancel');b[2].textContent=tr('Open');document.body.append(d)}
  $l('leave-url').textContent=x;d.dataset.href=x;d.showModal();$l('leave-go').focus()};
document.addEventListener('click',async e=>{const a=e.target.closest&&e.target.closest('a[data-save]');if(!a||!navigator.canShare||!matchMedia('(pointer:coarse)').matches)return;e.preventDefault();
  const name=a.getAttribute('download')||'file',dl=()=>{const x=document.createElement('a');x.href=a.href;x.download=name;document.body.append(x);x.click();x.remove()};
  try{const b=await (await fetch(a.href)).blob(),f=new File([b],name,{type:b.type||'application/octet-stream'});if(navigator.canShare({files:[f]}))return await navigator.share({files:[f]})}
  catch(err){if(err&&err.name==='AbortError')return}dl()});
document.addEventListener('load',e=>{if(e.target instanceof HTMLImageElement&&e.target.matches('.av-img,.bpic img'))e.target.classList.add('ok')},true);
document.addEventListener('error',e=>{if(e.target instanceof HTMLImageElement&&e.target.matches('.av-img,.bpic img'))e.target.remove()},true);
document.querySelectorAll('.av-img,.bpic img').forEach(img=>{if(img.complete){if(img.naturalWidth)img.classList.add('ok');else img.remove()}});
document.addEventListener('click',e=>{const b=e.target.closest('[data-approve]');if(b)document.getElementById('approve').value=b.dataset.approve},true);

/** Bidi controls, zero-width space, word joiner, and BOM. ZWJ and ZWNJ stay (emoji, Persian, Hindi, Bengali). Arabic marks stay. */
function bidi(s){return String(s??'').replace(/[\\u202A-\\u202E\\u2066-\\u2069\\u200B\\u2060\\uFEFF]/g,'')}
/** The one HTML escaper for every page script. */
function esc(s){return bidi(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c])}
/** The interface in this page's language (i18n.ts): the English as written, looked up in window.I18N; {name} filled from v. */
function tr(s,v){let x=(window.I18N&&window.I18N[s])||s;if(v)for(const k in v)x=x.split('{'+k+'}').join(v[k]);return x}
(()=>{
const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)];
// Display settings: applied now, remembered here for the next first paint, and picked up from the account once per tab (so a change on the phone reaches the web).
window.applyDisplay=d=>{const r=document.documentElement;d=d||{};
  if(d.text==='s'||d.text==='l')r.dataset.text=d.text;else delete r.dataset.text;
  if(d.density==='compact')r.dataset.density='compact';else delete r.dataset.density;
  if(d.theme==='light'||d.theme==='dark')r.dataset.theme=d.theme;else delete r.dataset.theme;
  // Replies only in their threads (vedu #2360): the chat shows top-level messages, each with its "N replies".
  if(d.replies==='thread')r.dataset.replies='thread';else delete r.dataset.replies;
  // One line per message unless it mentions you (jxn #2690): the board folds the others; a tap opens one.
  if(d.compact==='others')r.dataset.compact='others';else delete r.dataset.compact;
  // Everyday (the default) or Developer (#1272): the server says which, from your choice or (auto) whether you've connected a coding agent.
  let ev=r.dataset.mode==='everyday';if(typeof d.developer==='boolean')ev=!d.developer;if(ev)r.dataset.mode='everyday';else delete r.dataset.mode;
  try{localStorage.setItem('atteo-display',JSON.stringify({text:d.text||'m',density:d.density||'comfortable',theme:d.theme||'system',ev,replies:d.replies==='thread'?'thread':'chat',compact:d.compact==='others'?'others':'off'}))}catch{}
  document.dispatchEvent(new CustomEvent('atteo-mode',{detail:{everyday:ev}}));document.dispatchEvent(new CustomEvent('atteo-replies'))};
if($('a[href="/me"]')){let fresh=false;try{fresh=!!sessionStorage.getItem('atteo-display-sync');sessionStorage.setItem('atteo-display-sync','1')}catch{}
  if(!fresh)fetch('/api/me/profile').then(r=>r.ok?r.json():null).then(j=>{const d=j&&j.profile&&j.profile.display;if(d&&typeof d==='object')applyDisplay({...d,developer:j.profile.developer})}).catch(()=>{})}
// A new version shipped while this page was open (jxn #1221): offer a reload rather than keep running old code. Checked on
// coming back to the tab and every 10 minutes; drafts are saved as you type, so reloading loses nothing.
(()=>{let v0=null;const chk=async()=>{try{const j=await (await fetch('/health',{cache:'no-store'})).json();if(!j||!j.version)return;if(v0===null){v0=j.version;return}
  if(j.version===v0||document.getElementById('upd-bar'))return;const b=document.createElement('div');b.id='upd-bar';b.className='upd-bar';b.setAttribute('role','status');
  b.innerHTML='<span>'+tr('Atteo was updated')+'</span><button class="btn sm primary" type="button">'+tr('Reload')+'</button>';b.querySelector('button').addEventListener('click',()=>location.reload());document.body.appendChild(b)}catch(e){}};
  chk();document.addEventListener('visibilitychange',()=>{if(!document.hidden)chk()});setInterval(chk,600000)})();
// Everyday words in the sidebar (#1272): Boards are "Chats". Developer mode keeps today's words.
(()=>{const words=()=>{const ev=document.documentElement.dataset.mode==='everyday';document.querySelectorAll('.side-link[href="/"],.side-link[href="/chats"]').forEach(a=>{a.setAttribute('href',ev?'/chats':'/');const x=a.querySelector('span:not(.count)');if(x)x.textContent=ev?tr('Chats'):tr('Boards')})};
  words();document.addEventListener('atteo-mode',words)})();
window.toast=(m)=>{const t=$('#toast');t.textContent=m;t.classList.add('show');clearTimeout(t._h);t._h=setTimeout(()=>t.classList.remove('show'),1800)};
document.addEventListener('click',e=>{
  const c=e.target.closest('[data-copy]');
  if(c){const src=$('#'+c.dataset.copy);navigator.clipboard.writeText('value' in src?src.value:src.innerText).then(()=>toast(tr('Copied to clipboard')),()=>src.select&&src.select());return}
  const o=e.target.closest('[data-open]');if(o){const d=$('#'+o.dataset.open),from=o.closest('dialog[open]');if(from&&from!==d)from.close();d&&!d.open&&d.showModal();const f=d&&d.querySelector('input:not([type=hidden]):not([type=checkbox]),textarea');if(f)f.focus();else if(d){d.tabIndex=-1;d.focus()}return} // no ring on the close button
  const x=e.target.closest('[data-close]');if(x){x.closest('dialog').close();return}
});
$$('dialog').forEach(d=>d.addEventListener('click',e=>{if(e.target===d)d.close()}));
function rel(ts){const s=Math.max(0,(Date.now()-ts)/1000);if(s<45)return tr('just now');if(s<3600)return tr('{n}m ago',{n:Math.round(s/60)});if(s<86400)return tr('{n}h ago',{n:Math.round(s/3600)});if(s<604800)return tr('{n}d ago',{n:Math.round(s/86400)});return new Date(ts).toISOString().slice(0,10)}
$$('button[data-copy]').forEach(b=>{if(b.textContent==='Copy')b.textContent=tr('Copy')});
window.refreshTimes=()=>$$('time[data-ts]').forEach(t=>t.textContent=rel(+t.dataset.ts));setInterval(refreshTimes,30000);if(window.I18N&&Object.keys(window.I18N).length)refreshTimes();
// Posting never fails silently: a message gets an id (Idempotency-Key) and is retried through dropped connections and
// restarts for a couple of minutes; the server stores it once however many tries arrive. Your text stays until it lands.
window.sendReliably=async(url,body,onRetry)=>{const key=crypto.randomUUID?crypto.randomUUID():Date.now()+'-'+Math.random().toString(36).slice(2);
  const waits=[500,1000,2000,4000,8000,15000,30000,30000,30000];
  for(let i=0;;i++){let res=null;try{res=await fetch(url,{method:'POST',headers:{'content-type':'application/json','idempotency-key':key},body:JSON.stringify(body)})}catch(e){}
    if(res&&(res.ok||(res.status<500&&res.status!==408&&res.status!==429)))return res;
    if(i>=waits.length)return res||new Response(JSON.stringify({error:"Couldn't reach Atteo. Your message is still in the box; send it again."}),{status:503});
    onRetry&&onRetry(i);await new Promise(r=>setTimeout(r,waits[i]))}};
// Forms marked data-api post JSON to their action and show the reply in [data-result]; data-reliable ones retry (above).
document.addEventListener('submit',async e=>{
  const f=e.target.closest('form[data-api]');if(!f)return;e.preventDefault();
  const b=f.querySelector('button[type=submit],button:not([type])'),r=f.querySelector('[data-result]');
  b&&(b.disabled=true);
  try{
    const body=Object.fromEntries(new FormData(f));
    const res=f.dataset.reliable!==undefined?await sendReliably(f.action,body,()=>window[f.dataset.retrying]&&window[f.dataset.retrying](f))
      :await fetch(f.action,{method:f.dataset.method||'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).catch(()=>new Response(JSON.stringify({error:"Couldn't reach Atteo. Check your connection and try again."}),{status:503}));
    const j=await res.json().catch(()=>({error:'Request failed ('+res.status+')'}));
    if(f.dataset.done&&res.ok&&window[f.dataset.done]){window[f.dataset.done](j,f)}
    else if(!res.ok&&f.dataset.failed&&window[f.dataset.failed]){window[f.dataset.failed](j,f)}
    else if(r){r.hidden=false;r.className='flash '+(res.ok?'ok':'err');r.textContent=j.message||j.error||'Done'}
    else if(!res.ok&&window.toast)toast(j.error||'Something went wrong');
    if(res.ok&&f.dataset.reset!==undefined)f.reset();
  }finally{b&&(b.disabled=false)}
});
})();
${MERMAID_JS}
${CODE_COLOR_JS}`;

// Every page's stylesheet and shell script, served by the Worker as /app.css and /app.js (index.ts), versioned by a hash of
// their text and cached for good: a page no longer carries ~135KB of CSS and ~40KB of JS inline on every navigation, and
// the script gets V8's code cache. A page's own script stays inline (it carries that page's data) and runs after it.
export const APP_CSS = `${APP_FONT_CSS}\n${CSS}`;
export const APP_CSS_SRC = `/app.css?v=${fnv(APP_CSS)}`;
export const APP_JS = CLIENT_JS;
export const APP_JS_SRC = `/app.js?v=${fnv(APP_JS)}`;
/** Page-only stylesheets (Guide / Ask / Docs). Kept off /app.css so board and inbox stay in the CSS budget. */
export const PAGE_CSS: Record<string, string> = { "/guide.css": GUIDE_CSS, "/ask.css": ASK_CSS, "/docs.css": DOC_CSS };
export const GUIDE_CSS_SRC = `/guide.css?v=${fnv(GUIDE_CSS)}`;
export const ASK_CSS_SRC = `/ask.css?v=${fnv(ASK_CSS)}`;
export const DOC_CSS_SRC = `/docs.css?v=${fnv(DOC_CSS)}`;

// ---------- app shell (signed-in pages) ----------

const ICON = {
  clip: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M13.5 7.6 8.3 12.8a3.2 3.2 0 0 1-4.5-4.5l5.6-5.6a2.1 2.1 0 0 1 3 3L6.8 11.3a1 1 0 0 1-1.5-1.5l4.9-4.9"/></svg>`, // the composer's paper clip, for the bug report
  warn: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.3 14.4 13.4H1.6Z"/><path d="M8 6.4v3.4" stroke-linecap="round"/><circle cx="8" cy="11.5" r=".8" fill="currentColor" stroke="none"/></svg>`, // a warning triangle: Report a bug (jxn #4051)
  feedback: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 3.5h11v7.5H7l-3 2.5V11H2.5Z"/></svg>`, // speech bubble: Send feedback (vedu #4125)
  plug: `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M6 2v3M10 2v3M4.5 5h7v2.5a3.5 3.5 0 0 1-7 0zM8 11v3"/></svg>`,
  boards: `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="2" y="2" width="5" height="5" rx="1.2"/><rect x="9" y="2" width="5" height="5" rx="1.2"/><rect x="2" y="9" width="5" height="5" rx="1.2"/><rect x="9" y="9" width="5" height="5" rx="1.2"/></svg>`,
  admin: `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M8 1.8l5 2v4c0 3-2.2 5.2-5 6.4C5.2 13 3 10.8 3 7.8v-4z"/></svg>`,
  me: `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="8" cy="5.5" r="2.8"/><path d="M2.8 14c.8-2.6 2.8-4 5.2-4s4.4 1.4 5.2 4"/></svg>`,
  approve: `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M8 1.8l5 2v4c0 3-2.2 5.2-5 6.4C5.2 13 3 10.8 3 7.8v-4z"/><path d="M5.8 8l1.6 1.6 2.9-3"/></svg>`,
  foryou: `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 7.2L8 2.5l5.5 4.7V13a.8.8 0 0 1-.8.8H3.3a.8.8 0 0 1-.8-.8z"/><path d="M6.3 13.8V10h3.4v3.8"/></svg>`,
  inbox: `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M2 9.5l1.8-6h8.4l1.8 6v3.5H2z"/><path d="M2 9.5h3.5l1 1.5h3l1-1.5H14"/></svg>`,
  search: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>`,
  menu: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M2 4h12M2 8h12M2 12h12"/></svg>`,
  plus: `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>`,
  guide: `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><path d="M8 4.2C6.6 3 4.6 2.6 2.5 2.8v9.6c2.1-.2 4.1.2 5.5 1.4 1.4-1.2 3.4-1.6 5.5-1.4V2.8c-2.1-.2-4.1.2-5.5 1.4z"/><path d="M8 4.2v9.6"/></svg>`,
  bug: `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="9" r="4"/><path d="M8 5V3.2M5.2 5.6L4 4.2M10.8 5.6L12 4.2M2.5 8.5h1.6M11.9 8.5h1.6M3.6 12l1.5-.9M12.4 12l-1.5-.9M5.5 10.9h5"/></svg>`,
};

export interface SideBoard {
  id: string;
  title: string;
  kind?: string | null; // "direct": a private board between two friends (title "a ↔ b"); "agent": "Your agent", you and your own agents
  live?: number; // agent sessions working on it right now
  pinned?: boolean;
  picture?: string | null; // the board picture's URL (members only, versioned), or null
  peer_name?: string | null; // a direct board: the other person's display name (jxn #4369)
}

/** The first letter of a board's title (or its first emoji), for a board without a picture. */
export function boardInitial(title: string): string {
  return (Array.from(title.trim())[0] ?? "?").toUpperCase();
}

/**
 * A board's picture as a rounded square (its initial shows until the image loads, or if it fails). Without a picture:
 * `fallback` if given (the sidebar's dot, the Boards grid's dot), else the initial on the board's color.
 */
export function boardPic(b: { id: string; title: string; picture?: string | null }, size: "" | "xs" | "sm" | "lg" = "", fallback?: string): string {
  if (!b.picture && fallback !== undefined) return fallback;
  const img = b.picture ? `<img src="${esc(b.picture)}" alt="" loading="lazy">` : "";
  return `<span class="bpic${size ? ` ${size}` : ""}" style="--h:${hue(b.id)}" aria-hidden="true">${esc(boardInitial(b.title))}${img}</span>`;
}

/** "N working" with a breathing green dot: agents on a board right now. Always rendered (hidden at 0) so it can update live. */
export function working(n: number, boardId: string): string {
  return `<span class="working" data-live="${esc(boardId)}" title="${n} agent${n === 1 ? "" : "s"} working now"${n ? "" : " hidden"}><span class="dot"></span><span class="wk-n">${n} working</span></span>`;
}

/** The other person on a direct board ("a ↔ b"), from the viewer's side. */
export function directPeer(b: SideBoard, me: string): string {
  const [a, c] = b.title.split(" ↔ ");
  return a === me ? (c ?? a) : a;
}

export function appPage(
  title: string,
  opts: {
    viewer: Viewer;
    boards: SideBoard[];
    active: string; // "boards" | "admin" | "me" | a board id
    crumbs: string; // trusted HTML
    actions?: string; // trusted HTML
    body: string;
    script?: string;
    narrow?: boolean;
    full?: boolean; // fills the viewport below the top bar; the page lays out its own scrolling areas
    status?: number;
    css?: string[];
  },
): Response {
  const v = opts.viewer;
  const L = v.lang,
    T = (s: string, vars?: Record<string, string | number>) => tr(L, s, vars);
  const cur = (k: string) => (opts.active === k ? ' aria-current="page"' : "");
  const shared = opts.boards.filter((b) => b.kind !== "direct" && b.kind !== "agent"),
    direct = opts.boards.filter((b) => b.kind === "direct"),
    own = opts.boards.find((b) => b.kind === "agent");
  const sideBoards = shared
    .map((b) => `<div class="side-board-row"><a class="side-link side-board" href="/b/${esc(b.id)}"${cur(b.id)}>${boardPic(b, "xs", `<span class="bdot" style="--h:${hue(b.id)}"></span>`)}<span class="truncate">${esc(b.title)}</span>${b.pinned ? `<span class="pin-mark" aria-label="${esc(T("Pinned"))}" title="${esc(T("Pinned"))}">📌</span>` : ""}${working(b.live ?? 0, b.id)}</a><details class="board-row-menu"><summary aria-label="${esc(T("More actions"))}" title="${esc(T("More actions"))}">⋯</summary><div class="brm-items"><button type="button" data-mark-unread="${esc(b.id)}">${esc(T("Mark as unread"))}</button><button type="button" data-pin-board="${esc(b.id)}">${esc(T(b.pinned ? "Unpin" : "Pin"))}</button></div></details></div>`)
    .join("");
  // Direct boards read as the person you share them with.
  const sideDirect = direct
    .map((b) => `<a class="side-link side-board" href="/b/${esc(b.id)}"${cur(b.id)}>${avatar(directPeer(b, v.name), "xs")}<span class="truncate">${personHtml(directPeer(b, v.name), b.peer_name, [v.name])}</span>${working(b.live ?? 0, b.id)}</a>`)
    .join("");
  // "Your agent", pinned first under DMs: your private chat with your own agents (/agent makes it the first time).
  const sideOwn = `<a class="side-link side-board" href="${own ? `/b/${esc(own.id)}` : "/agent"}"${own ? cur(own.id) : ""} data-agent-chat>${avatar(v.name, "xs", true)}<span class="truncate">${esc(T("Your agent"))}</span>${own ? working(own.live ?? 0, own.id) : ""}</a>`;
  const paletteItems = [
    { label: T("Your agent"), hint: T("Chat"), href: own ? `/b/${own.id}` : "/agent" },
    ...opts.boards.filter((b) => b.kind !== "agent").map((b) => ({ label: b.kind === "direct" ? T("{name} (direct)", { name: shownName(directPeer(b, v.name), b.peer_name) }) : b.title, hint: T("Board"), href: `/b/${b.id}` })),
    { label: T("For you"), hint: T("Home"), href: "/for-you" },
    { label: T("Inbox"), hint: "G I", href: "/inbox" },
    { label: T("Approvals"), hint: "G A", href: "/approvals" },
    { label: T("People and friends"), hint: "G P", href: "/people" },
    { label: T("New board"), hint: "C", href: "/?new=1" },
    { label: T("All boards"), hint: "G B", href: "/" },
    { label: T("Account and agent connections"), hint: "G M", href: "/me" },
    { label: T("Guide"), hint: T("What Atteo can do"), href: "/guide" },
    { label: T("Keyboard shortcuts"), hint: "?", href: "#shortcuts" },
    ...(v.admin ? [{ label: "Ops console", hint: "Operators", href: "/_ops" }] : []),
  ];
  const body = `<div class="app" id="app">
<aside class="sidebar" id="sidebar" aria-label="${esc(T("Navigation"))}">
  <button class="btn ghost sm nav-x" type="button" data-nav-close aria-label="${esc(T("Close menu"))}" title="${esc(T("Close menu"))}">✕</button>
  <a class="ws" href="/">${LOGO}<span class="wm">atteo</span></a>
  <button class="search" type="button" data-palette>${ICON.search}<span>${esc(T("Search or jump to…"))}</span><kbd>⌘K</kbd></button>
  <a class="side-link" href="/for-you"${cur("foryou")}>${ICON.foryou}<span>${esc(T("For you"))}</span></a>
  <a class="side-link" href="/inbox"${cur("inbox")}>${ICON.inbox}<span>${esc(T("Inbox"))}</span><span class="count" id="inbox-count" hidden></span></a>
  <a class="side-link" href="/approvals"${cur("approvals")}>${ICON.approve}<span>${esc(T("Approvals"))}</span><span class="count" id="approvals-count" hidden></span></a>
  <a class="side-link" href="/"${cur("boards")}>${ICON.boards}<span>${esc(T("Boards"))}</span></a>
  <a class="side-link" href="/people"${cur("people")}>${ICON.me}<span>${esc(T("People"))}</span></a>
  <a class="side-link" href="/guide"${cur("guide")}>${ICON.guide}<span>${esc(T("Guide"))}</span></a>
  <a class="side-link side-connect" href="/me#connect" data-connect>${ICON.plug}<span class="dev-l">${esc(T("Connect an agent"))}</span><span class="ev-l">${esc(T("Connect your assistant"))}</span></a>
  ${v.admin ? `<a class="side-link" href="/_ops"${cur("admin")}>${ICON.admin}<span>Ops</span></a>` : ""}
  <div class="side-label"><span>${esc(T("Your boards"))}</span><a href="/?new=1" title="${esc(T("New board (C)"))}" aria-label="${esc(T("New board"))}">${ICON.plus}</a></div>
  ${sideBoards || `<p class="xs faint" style="padding:2px 9px">${esc(T("No boards yet"))}</p>`}
  <div class="side-label"><span>${esc(T("DMs"))}</span></div>${sideOwn}${sideDirect}
  <div class="me"><a class="side-link" href="/me">${avatar(v.name, "sm")}<span class="truncate">${personHtml(v.name, v.display_name, opts.boards.filter((b) => b.kind === "direct").map((b) => directPeer(b, v.name)))}</span></a><button class="btn ghost sm bug-btn" type="button" data-feedback aria-label="${esc(T("Send feedback"))}">${ICON.feedback}</button><button class="btn ghost sm bug-btn" type="button" data-bug data-bug-src="${BUG_JS_SRC}" aria-label="${esc(T("Report a bug"))}" title="${esc(T("Report a bug"))}">${ICON.warn}</button></div>
</aside>
<div class="nav-scrim" data-nav-close aria-hidden="true"></div>
<div class="grow" style="min-width:0">
  <header class="topbar"><button class="btn ghost sm menu-btn" type="button" data-nav aria-label="${esc(T("Menu"))}" aria-controls="sidebar" aria-expanded="false">${ICON.menu}</button>
    <nav class="crumbs" aria-label="Breadcrumb">${opts.crumbs}</nav><div class="actions">${opts.actions ?? ""}</div></header>
  <div class="content${opts.narrow ? " narrow" : ""}${opts.full ? " full" : ""}">${opts.body}</div>
</div></div>
<dialog class="palette" id="palette" aria-label="${esc(T("Search"))}">
<div class="pal-in"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/></svg><span class="pal-chips" id="pal-chips"></span><input class="input" id="palette-q" placeholder="${esc(T("Search messages, files, boards and actions…"))}" autocomplete="off" aria-label="Search" aria-controls="palette-list"></div>
<div class="pal-filters" id="pal-filters" aria-label="${esc(T("Filters"))}"></div>
<ul id="palette-list" role="listbox"></ul><div class="foot"><span><kbd>↑</kbd> <kbd>↓</kbd> ${esc(T("move"))}</span><span><kbd>↵</kbd> ${esc(T("open"))}</span><span><kbd>⌫</kbd> ${esc(T("remove filter"))}</span><span><kbd>esc</kbd> ${esc(T("close"))}</span></div></dialog>
<dialog id="shortcuts"><div class="hd"><h2>${esc(T("Keyboard shortcuts"))}</h2><button class="btn ghost sm" data-close aria-label="${esc(T("Close"))}">✕</button></div>
<div class="bd"><dl class="kv">
<dt><kbd>⌘K</kbd> <kbd>/</kbd></dt><dd>${esc(T("Search or jump to a board"))}</dd>
<dt><kbd>N</kbd></dt><dd>${esc(T("Next thing that needs you, on any board"))}</dd>
<dt><kbd>C</kbd></dt><dd>${esc(T("New board, or write on the current board"))}</dd>
<dt><kbd>I</kbd></dt><dd>${esc(T("Invite someone to the current board"))}</dd>
<dt><kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> <kbd>4</kbd></dt><dd>${esc(T("Conversation / Log / Files / Tasks"))}</dd>
<dt><kbd>↵</kbd> · <kbd>⇧</kbd> <kbd>↵</kbd></dt><dd>${esc(T("Post · new line"))}</dd>
<dt><kbd>⌘F</kbd></dt><dd>${esc(T("Search this board's messages"))}</dd>
<dt><kbd>@</kbd></dt><dd>${esc(T("Mention a person or their agent"))}</dd>
<dt><kbd>J</kbd> <kbd>K</kbd></dt><dd>${esc(T("Move down / up through entries"))}</dd>
<dt><kbd>↵</kbd></dt><dd>${esc(T("Open the selected entry's details"))}</dd>
<dt><kbd>↵</kbd> · <kbd>⌫</kbd></dt><dd>${esc(T("Approve · deny the selected or focused approval (asks first when it's high risk)"))}</dd>
<dt><kbd>G</kbd> ${esc(T("then"))} <kbd>I</kbd> <kbd>A</kbd> <kbd>B</kbd> <kbd>P</kbd> <kbd>M</kbd></dt><dd>${esc(T("Go to Inbox / Approvals / Boards / People / Account"))}</dd>
<dt><kbd>?</kbd></dt><dd>${esc(T("This list"))}</dd></dl></div></dialog>
<script>window.PALETTE=${JSON.stringify(paletteItems).replace(/</g, "\\u003c")};${v.admin ? "window.OPS=1;" : ""}</script>`;
  return rawPage(title, body, (opts.script ?? "") + scriptSrc(SHELL_JS_SRC), opts.status, v.lang ?? "en", opts.css);
}

const PINS_JS = `
(()=>{document.addEventListener('click',async e=>{const b=e.target.closest('[data-pin-board]');if(!b)return;e.preventDefault();e.stopPropagation();
  b.disabled=true;try{const r=await fetch('/api/me/pins',{cache:'no-store'}),j=await r.json();if(!r.ok)throw Error(j.error||tr('Could not save'));
    const id=b.dataset.pinBoard,old=j.pins||[],next=old.includes(id)?old.filter(x=>x!==id):[...old,id];
    const put=await fetch('/api/me/pins',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({pins:next})});const saved=await put.json();if(!put.ok)throw Error(saved.error||tr('Could not save'));location.reload();
  }catch(err){alert(err.message)}finally{b.disabled=false}})})();`;

// Inbox badge on every signed-in page: checks on load, when the tab comes back, and every minute. With permission,
// a new item also shows a browser notification (once per item, across tabs), but only what interrupts (src/notify.ts):
// "now" items at once, "digest" items counted and summed up once when the next digest slot passes, "none" never.
const INBOX_JS = `
(()=>{const el=document.getElementById('inbox-count');if(!el)return;const base=document.title;
let seen=0;try{seen=+localStorage.getItem('inbox-seen')||0}catch{}
const tz=encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC');let dgAt=0;try{dgAt=+localStorage.getItem('inbox-dg-at')||0}catch{}
window.inboxRefresh=async()=>{try{const r=await fetch('/api/inbox/count?tz='+tz);if(!r.ok)return;const j=await r.json();
  el.hidden=!j.unread;el.textContent=j.unread>99?'99+':String(j.unread);document.title=(j.unread?'('+j.unread+') ':'')+base;
  const ap=document.getElementById('approvals-count');if(ap){ap.hidden=!j.approvals;ap.textContent=String(j.approvals||'')}
  const can='Notification' in window&&Notification.permission==='granted',l=j.latest,ns=j.notify||{},due=ns.digest_at,dn=ns.digest_count;
  // The digest: the server counts what waited for the slot at digest_at; it shows once, when that slot is new here.
  if(due>dgAt){if(dgAt&&dn&&can)new Notification(tr(dn===1?'{n} update since the last digest':'{n} updates since the last digest',{n:dn}),{body:(ns.digest_boards||[]).join(', '),tag:'inbox-digest'}).onclick=()=>{focus();location.href='/inbox'};
    dgAt=due;try{localStorage.setItem('inbox-dg-at',String(due))}catch{}}
  if(l&&l.created_at>seen){if(l.kind!=='manual_unread'&&seen&&(!l.interrupt||l.interrupt==='now')&&can&&!(document.visibilityState==='visible'&&location.pathname==='/b/'+l.board_id)){
    const ap=l.kind==='approval',who=ap?'Your agent':l.actor_via==='agent'?l.actor+"'s agent":(l.actor_name||l.actor);
    const n=new Notification(who+(ap?' is asking for your approval':l.kind==='mention'?' mentioned you':l.kind==='decision'?' asks for a decision':l.kind==='reply'?' replied to you':l.kind==='friend_request'?' wants to be friends':l.kind==='friend_accept'?' accepted your request':l.kind==='report'?' reported a post to you, as an owner':' wrote to your agent'),{body:l.excerpt,tag:'inbox-'+l.id});
    n.onclick=()=>{window.focus();location.href=ap?'/approvals':l.board_id?'/b/'+l.board_id+'#e'+l.seq:'/people'}}
  seen=l.created_at;try{localStorage.setItem('inbox-seen',String(seen))}catch{}}}catch{}};
inboxRefresh();setInterval(inboxRefresh,60000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)inboxRefresh()})})();`;

// "N working" on the sidebar's boards (and the Boards page): refreshed every minute while the tab is visible.
const LIVE_JS = `
(()=>{if(!document.querySelector('[data-live]'))return;
window.liveRefresh=async()=>{if(document.hidden)return;try{const r=await fetch('/api/me/boards');if(!r.ok)return;const j=await r.json();const n={};(j.boards||[]).forEach(b=>n[b.id]=b.live_agents||0);
  document.querySelectorAll('[data-live]').forEach(el=>{const k=n[el.dataset.live]||0;el.hidden=!k;el.title=k+' agent'+(k===1?'':'s')+' working now';el.querySelector('.wk-n').textContent=k+' working'})}catch{}};
setInterval(liveRefresh,60000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)liveRefresh()})})();`;

/** In a page's script, loads a cached script file at this point (rawPage splits the inline script around it). */
export const scriptSrc = (src: string): string => `\u0000${src}\u0000`;
// The page's inline script, with any scriptSrc() parts as their own <script src> between inline parts, in order.
// …and fetched from the head on, so it's there (usually from the cache) by the time the parser reaches it.
const scriptPreloads = (script: string): string =>
  script
    .split("\u0000")
    .filter((_, i) => i % 2)
    .map((src) => `<link rel="preload" as="script" href="${esc(src)}">`)
    .join("");
const pageScripts = (script: string, nonce: string): string =>
  script
    .split("\u0000")
    .map((part, i) => (i % 2 ? `<script src="${esc(part)}" nonce="${nonce}"></script>` : part ? `<script nonce="${nonce}">${part}</script>` : ""))
    .join("");
/** Loaded and localized on the first bug-report click, like the feedback form. */
export const BUG_DIALOG = `<dialog id="bug" aria-labelledby="bug-title"><form id="bug-form">
<div class="hd"><div><h2 id="bug-title">Report a bug</h2><p class="muted small bug-help">It goes to the developers. Add pictures if they help: paste them, drop them here or use the paper clip.</p></div><button type="button" class="btn ghost sm" data-close aria-label="Close">✕</button></div>
<div class="bd">
  <textarea class="input" id="bug-text" rows="4" required minlength="8" maxlength="2000" aria-label="What happened? What did you expect?" placeholder="What happened? What did you expect?"></textarea>
  <div class="bug-pics" id="bug-pics" hidden></div>
  <input type="file" id="bug-files" accept="image/*" multiple hidden>
</div>
<div class="ft"><button type="button" class="btn ghost sm bug-attach" id="bug-attach" aria-label="Attach files" title="Attach files or images (or paste or drop them)">${ICON.clip}</button><span class="grow"></span><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit" id="bug-send">Send report</button></div>
</form></dialog>`;

// Report a bug (jxn #3336, #4116): the account row's button opens a form: what happened, and pictures if they help,
// added like the composer's (the paper clip, a paste or a drop), shown as thumbnails you can remove. Nothing is captured
// on its own. Pictures are scaled to 1600 px and sent as JPEG (PNG kept when it's already small), at most 4 and 1.9 MB
// together (the endpoint's cap), as multipart to POST /api/bugs (501 while the bug board isn't set up).
const BUG_JS = `
(async()=>{
try{const r=await fetch('/bug-form');if(!r.ok)throw Error();document.body.insertAdjacentHTML('beforeend',await r.text())}
catch{document.getElementById('bug-js')?.remove();toast(tr("Couldn't open it"));return}
const MAXN=4,MAX=1900000;let pics=[];
const $=id=>document.getElementById(id);
const total=()=>pics.reduce((n,p)=>n+p.blob.size,0);
// One picture, made small enough: kept as it is when it's a small PNG/JPEG, else drawn at 1600 px or less as JPEG.
const fit=async(file)=>{if((file.type==='image/png'||file.type==='image/jpeg')&&file.size<=600000)return file;
  const bmp=await createImageBitmap(file),k=Math.min(1,1600/Math.max(bmp.width,bmp.height)),w=Math.round(bmp.width*k),h=Math.round(bmp.height*k);
  const c=document.createElement('canvas');c.width=w;c.height=h;const g=c.getContext('2d');g.fillStyle='#fff';g.fillRect(0,0,w,h);g.drawImage(bmp,0,0,w,h);
  let q=.85,b;do{b=await new Promise(r=>c.toBlob(r,'image/jpeg',q));q-=.15}while(b&&b.size>700000&&q>.3);return b};
const render=()=>{const box=$('bug-pics');if(!box)return;box.hidden=!pics.length;box.textContent='';
  pics.forEach((p,i)=>{const s=document.createElement('span');s.className='att';const im=document.createElement('img');im.src=p.url;im.alt='';
    const x=document.createElement('button');x.type='button';x.className='att-x';x.dataset.bugRm=String(i);x.setAttribute('aria-label',tr('Remove'));x.textContent='✕';s.append(im,x);box.append(s)})};
const add=async(files)=>{for(const f of files){if(!/^image[/]/.test(f.type||'')){toast(tr('Only pictures can go with a bug report.'));continue}
    if(pics.length>=MAXN){toast(tr('At most 4 pictures in a bug report.'));break}
    try{const b=await fit(f);if(!b||total()+b.size>MAX){toast(tr('That picture is too large for the report.'));continue}pics.push({blob:b,url:URL.createObjectURL(b)})}
    catch(e){toast(tr("Couldn't read that picture."))}}
  render()};
const clear=()=>{pics.forEach(p=>URL.revokeObjectURL(p.url));pics=[];render()};
const run=()=>{const d=$('bug');if(!d)return;$('bug-text').value='';clear();if(!d.open)d.showModal();$('bug-text').focus()};
document.addEventListener('click',e=>{if(e.target.closest('[data-bug]'))run()});
run(); // bug.js is only loaded on a bug click: that first click is this run
document.addEventListener('click',e=>{const x=e.target.closest('[data-bug-rm]');if(x){const i=+x.dataset.bugRm;URL.revokeObjectURL(pics[i].url);pics.splice(i,1);render();return}
  if(e.target.closest('#bug-attach'))$('bug-files').click()});
$('bug-files')?.addEventListener('change',e=>{add([...e.target.files]);e.target.value=''});
$('bug-text')?.addEventListener('paste',e=>{const fs=[...(e.clipboardData?.files||[])];if(fs.length){e.preventDefault();add(fs)}});
const dlg=$('bug');
dlg.addEventListener('click',e=>{if(e.target===dlg)dlg.close()});
dlg?.addEventListener('dragover',e=>{if([...(e.dataTransfer?.types||[])].includes('Files')){e.preventDefault();dlg.classList.add('drop')}});
dlg?.addEventListener('dragleave',e=>{if(!dlg.contains(e.relatedTarget))dlg.classList.remove('drop')});
dlg?.addEventListener('drop',e=>{dlg.classList.remove('drop');const fs=[...(e.dataTransfer?.files||[])];if(fs.length){e.preventDefault();add(fs)}});
dlg?.addEventListener('close',clear);
$('bug-form')?.addEventListener('submit',async e=>{e.preventDefault();
  const t=$('bug-text').value.trim();if(t.length<8)return;
  const send=$('bug-send');send.disabled=true;
  try{const fd=new FormData();fd.append('note',t);fd.append('path',location.pathname+location.hash);
    fd.append('context',JSON.stringify({board:(window.BOARD_CTX||{}).id||undefined,os:navigator.platform||undefined,device:'web '+innerWidth+'x'+innerHeight}));
    pics.forEach((p,i)=>fd.append('screenshot',p.blob,'picture-'+(i+1)+(p.blob.type==='image/png'?'.png':'.jpg')));
    const r=await fetch('/api/bugs',{method:'POST',body:fd});const j=await r.json().catch(()=>({}));
    if(r.status===501){toast(tr("Bug reporting isn't set up yet — the developers will enable it soon."));return}
    if(!r.ok)throw Error(j.error||tr('Could not send it'));
    $('bug').close();toast(tr('Report sent — thank you.'));
  }catch(err){toast(err.message||tr('Could not send it'))}finally{send.disabled=false}});
})();`;

// Board switches feel instant (#3717): a board link held under the pointer for a moment (Chrome's "moderate") has its
// page fetched ahead, so the click only renders. Opening a board changes nothing on the server (nothing is marked read);
// browsers without speculation rules ignore it. App pages name the rules in a Speculation-Rules header (index.ts serves
// the file), so there's no inline JSON script for the CSP or the script checks to deal with.
export const BOARD_PREFETCH_RULES = JSON.stringify({ prefetch: [{ source: "document", where: { href_matches: "/b/*" }, eagerness: "moderate" }] });
export const BOARD_PREFETCH_PATH = "/speculation-rules.json";
// Report a bug (jxn #3336, glm-b #3343): the sidebar button captures the page as a PNG in the browser (the DOM is
function rawPage(title: string, body: string, script: string, status = 200, lang: Lang = "en", css?: string[]): Response {
  const security = pageSecurity();
  const html = styleNonce(`<!doctype html><html lang="${lang}"${dirOf(lang as Lang) === "rtl" ? ' dir="rtl"' : ""}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
${FONT_PRELOAD}${scriptPreloads(script)}
<link rel="icon" href="${FAVICON_SRC}" type="image/svg+xml"><link rel="apple-touch-icon" href="${APPLE_TOUCH_SRC}">
<link rel="stylesheet" href="${APP_CSS_SRC}">${extraCss(css)}${DISPLAY_HEAD.replace("<script>", `<script nonce="${security.nonce}">`)}</head><body>${WORDMARK_DEFS}${body.replace("<script>window.PALETTE=", `<script nonce="${security.nonce}">window.PALETTE=`)}
<div id="toast" role="status" aria-live="polite"></div>
${lang === "en" ? "" : `<script nonce="${security.nonce}">window.I18N=${clientTable(lang)}</script>`}${analyticsScriptTag(security.nonce)}<script src="${APP_JS_SRC}" nonce="${security.nonce}"></script>${pageScripts(script, security.nonce)}</body></html>`, security.nonce);
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "content-language": lang, vary: "Accept-Language, Cookie", "speculation-rules": `"${BOARD_PREFETCH_PATH}"`, ...security.headers } });
}

/** Send feedback (vedu #4125): the form, fetched on the first click from /feedback-form and localized there, so pages
 *  don't carry it (web-budget). English as written; i18n.localize translates its text, labels and placeholder. */
export const FEEDBACK_DIALOG = `<dialog id="feedback" aria-labelledby="fb-title"><form id="fb-form">
<div class="hd"><div><h2 id="fb-title">Send feedback</h2><p class="muted small" style="margin-top:4px">An idea, a complaint, something you like: it goes to the Atteo team. Only what you write here is sent.</p></div><button type="button" class="btn ghost sm" data-close aria-label="Close">✕</button></div>
<div class="bd"><textarea class="input" id="fb-text" rows="4" required maxlength="2000" aria-label="Your feedback" placeholder="Your feedback"></textarea><p class="small" id="fb-status" role="status" hidden></p><span id="fb-thanks" hidden>Thanks, the Atteo team will read it.</span><span id="fb-err" hidden>Couldn&#39;t send it. Try again.</span></div>
<div class="ft"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit" id="fb-send">Send</button></div>
</form></dialog>`;

/** Send feedback's script (vedu #4125), loaded on the first click of the 💬 button: fetches the form from /feedback-form
 *  (localized there), opens it, and posts a few words for the Atteo team to /api/feedback (the board it's about rides
 *  along by id). Served hashed and immutable like /bug.js, so pages carry only the few bytes that load it. */
const FEEDBACK_JS = `(()=>{const $=(s)=>document.querySelector(s);
const open=async()=>{let d=$('#feedback');
  if(!d){const r=await fetch('/feedback-form').catch(()=>null);if(!r||!r.ok)return;document.body.insertAdjacentHTML('beforeend',await r.text());d=$('#feedback')}
  $('#fb-status').hidden=true;d.showModal();$('#fb-text').focus()};
document.addEventListener('click',e=>{if(e.target.closest('[data-feedback]'))open()});
document.addEventListener('submit',async e=>{if(e.target.id!=='fb-form')return;e.preventDefault();const d=$('#feedback'),t=$('#fb-text'),st=$('#fb-status'),b=$('#fb-send');b.disabled=true;
  const fail=(m)=>{st.hidden=false;st.textContent=m||$('#fb-err').textContent};
  try{const r=await fetch('/api/feedback',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:t.value,board:location.pathname.match(/^\\/b\\/(b_[a-z0-9]+)/)?.[1]})});
    const j=await r.json().catch(()=>({}));if(r.ok){t.value='';d.close();window.toast&&toast($('#fb-thanks').textContent)}else fail(j.error)}catch{fail()}finally{b.disabled=false}});
open();
})();`;
export const FEEDBACK_PAGE_JS = FEEDBACK_JS;
export const FEEDBACK_JS_SRC = `/feedback.js?v=${fnv(FEEDBACK_PAGE_JS)}`;

const SHELL_JS = `
(()=>{const NONCE=document.currentScript?.nonce||'';
const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)];
// Report a bug: the capture lives in /bug.js (web-budget: not on every page) — the first click loads it, and it
// runs the capture for that click itself; later clicks are its own listener.
document.addEventListener('click',e=>{const b=e.target.closest('[data-bug]');if(!b||document.getElementById('bug-js'))return;
  const s=document.createElement('script');s.id='bug-js';s.src=b.dataset.bugSrc;s.nonce=NONCE;document.head.appendChild(s)});
// Send feedback (vedu #4125): /feedback.js (web-budget: not on every page) — the first click loads it, and it opens the
// form for that click itself; later clicks are its own listener.
document.addEventListener('click',e=>{if(!e.target.closest('[data-feedback]')||document.getElementById('fb-js'))return;
  const s=document.createElement('script');s.id='fb-js';s.src='${FEEDBACK_JS_SRC}';s.nonce=NONCE;document.head.appendChild(s)});
// Search (⌘K everywhere; ⌘F on a board starts with "This board · Messages"): filters show up front like VS Code or Lark,
// and become chips; results mix boards and actions with ranked messages and files (this board, or all your boards).
const pal=$('#palette'),q=$('#palette-q'),list=$('#palette-list'),pChips=$('#pal-chips'),pFilt=$('#pal-filters');
let sel=0,items=[],chips=[],mode=null,run=0,timer=null;
const B=()=>window.BOARD_CTX||null; // on a board page: {id, me, members, jump(seq), openFile(name, version)}
const KINDS=[['messages',tr('Messages')],['files',tr('Files')],['boards',tr('Boards')],['actions',tr('Actions')]],TYPES=['question','task','decision','claim','note','change','artifact'];
const h=x=>String(x==null?'':x).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const has=(k,v)=>chips.some(c=>c.k===k&&(v==null||c.v===v)),chip=k=>chips.find(c=>c.k===k);
const who=(u,agent)=>{const me=B()&&B().me;return u===me?(agent?'your agent':'you'):(agent?u+"'s agent":u)};
const label=c=>c.k==='board'?tr('This board'):c.k==='kind'?KINDS.find(k=>k[0]===c.v)[1]:c.k==='type'?tr('type:')+' '+tr(c.v):tr('from')+' '+who(c.v,c.agent);
function paintChips(){pChips.innerHTML=chips.map((c,i)=>'<span class="pal-chip">'+h(label(c))+'<button type="button" data-pchip="'+i+'" aria-label="Remove '+h(label(c))+'">✕</button></span>').join('');
  const o=[];if(B()&&!has('board'))o.push(['board','',tr('This board')]);if(!has('kind'))KINDS.forEach(([v,l])=>o.push(['kind',v,l]));
  if(B()&&!has('from'))o.push(['from','',tr('From…')]);if(!has('type'))o.push(['type','',tr('Type…')]);
  pFilt.innerHTML=o.map(x=>'<button type="button" class="pal-opt" data-popt="'+x[0]+'" data-v="'+x[1]+'">'+h(x[2])+'</button>').join('');pFilt.hidden=!o.length}
function paint(rows){items=rows;sel=Math.min(sel,Math.max(0,rows.length-1));let g='';
  list.innerHTML=rows.map((r,n)=>(r.g!==g?'<li class="pal-g" aria-hidden="true">'+(g=r.g)+'</li>':'')+'<li role="option" data-n="'+n+'" id="po-'+n+'" aria-selected="'+(n===sel)+'"><span class="pal-l">'+r.label+'</span><span class="k">'+h(r.hint||'')+'</span></li>').join('')||'<li class="faint pal-none">'+(q.value.trim()?'No matches':'Type to search')+'</li>';
  q.setAttribute('aria-activedescendant',rows.length?'po-'+sel:'')}
function pickList(){const t=q.value.trim().replace(/^@/,'').toLowerCase();
  const rows=mode==='from'?(B()?B().members:[]).flatMap(u=>[{u,agent:false},{u,agent:true}]).filter(x=>x.u.startsWith(t)).map(x=>({g:tr('From'),label:h(who(x.u,x.agent)),pick:{k:'from',v:x.u,agent:x.agent}}))
    :TYPES.filter(x=>x.startsWith(t)).map(x=>({g:tr('Type'),label:h(tr(x)),pick:{k:'type',v:x}}));paint(rows)}
const snip=x=>h(x||'').split('«').join('<mark>').split('»').join('</mark>');
function render(){const my=++run;if(mode){pickList();return}const t=q.value.trim(),kind=chip('kind')&&chip('kind').v,b=B(),scoped=b&&(has('board')||has('from')||has('type'));
  const rows=[];
  if((!kind||kind==='boards'||kind==='actions')&&!scoped&&!has('from')&&!has('type'))
    PALETTE.filter(i=>!t||i.label.toLowerCase().includes(t.toLowerCase())).filter(i=>!kind||(kind==='boards')===(i.hint==='Board')).slice(0,t?8:6)
      .forEach(i=>rows.push({g:i.hint===tr('Board')?tr('Boards'):tr('Actions'),label:h(i.label),hint:i.hint==='Board'?'':i.hint,href:i.href}));
  paint(rows);
  if(kind==='boards'||kind==='actions'||(!t&&!has('from')&&!has('type')))return;
  clearTimeout(timer);timer=setTimeout(async()=>{const more=[];
    try{if(scoped){const p=new URLSearchParams({q:t});const f=chip('from');if(f){p.set('from',f.v);p.set('agent',f.agent?'1':'0')}if(chip('type'))p.set('type',chip('type').v);if(kind==='messages')p.set('in','chat');
        const j=await (await fetch('/api/boards/'+b.id+'/search?'+p)).json();
        if(kind!=='files')(j.entries||[]).forEach(x=>more.push({g:tr('Messages'),label:(x.title?'<b>'+h(x.title)+'</b> ':'')+snip(x.snippet),hint:who(x.author,x.via==='agent')+' · #'+x.seq,act:()=>b.jump(x.seq)}));
        if(kind!=='messages')(j.files||[]).forEach(x=>more.push({g:tr('Files'),label:'<span class="mono">'+h(x.name)+'</span> '+snip(x.snippet),hint:'v'+x.version,act:()=>b.openFile(x.name,x.version)}))}
      else if(t){const j=await (await fetch('/api/boards/search?q='+encodeURIComponent(t))).json();
        (j.hits||[]).filter(x=>kind==='files'?x.kind==='file':kind==='messages'?x.kind==='entry':true).forEach(x=>{const here=b&&x.board===b.id;
          more.push({g:x.kind==='file'?'Files':'Messages',label:(x.kind==='file'?'<span class="mono">'+h(x.name)+'</span> ':'')+snip(x.snippet),hint:x.title+(x.seq?' · #'+x.seq:''),
            act:here?(x.kind==='file'?()=>b.openFile(x.name,x.version):()=>b.jump(x.seq)):null,href:'/b/'+x.board+(x.kind==='file'?'#files':'#e'+x.seq)})})}}catch(e){}
    if(my===run)paint(rows.concat(more))},150)}
function go(i){if(!i)return;if(i.pick){chips=chips.filter(c=>c.k!==i.pick.k);chips.push(i.pick);mode=null;q.value='';paintChips();sel=0;render();q.focus();return}
  pal.close();if(i.href==='#shortcuts'){$('#shortcuts').showModal();return}if(i.act){i.act();return}location.href=i.href}
window.openPalette=(preset)=>{chips=(preset||[]).slice();mode=null;q.value='';sel=0;paintChips();render();if(!pal.open)pal.showModal();q.focus()};
q.addEventListener('input',()=>{sel=0;if(!mode&&q.value.startsWith('@')&&B())mode='from';if(mode&&!q.value&&mode==='from')mode=null;render()});
q.addEventListener('keydown',e=>{if(e.key==='ArrowDown'){sel=Math.min(sel+1,items.length-1);paint(items);e.preventDefault()}
  else if(e.key==='ArrowUp'){sel=Math.max(sel-1,0);paint(items);e.preventDefault()}else if(e.key==='Enter'){go(items[sel]);e.preventDefault()}
  else if(e.key==='Backspace'&&!q.value&&(mode||chips.length)){if(mode)mode=null;else chips.pop();paintChips();render();e.preventDefault()}});
list.addEventListener('mousedown',e=>{const li=e.target.closest('[data-n]');if(li){e.preventDefault();go(items[+li.dataset.n])}});
pChips.addEventListener('click',e=>{const b=e.target.closest('[data-pchip]');if(!b)return;chips.splice(+b.dataset.pchip,1);paintChips();render();q.focus()});
pFilt.addEventListener('click',e=>{const b=e.target.closest('[data-popt]');if(!b)return;const k=b.dataset.popt;
  if(k==='from'||k==='type'){mode=k;q.value='';sel=0;render();q.focus();return}chips.push({k,v:b.dataset.v||null});paintChips();render();q.focus()});
// The phone menu (a drawer): opens from the menu button; closes with its ✕, the dimmed page beside it, a swipe back to
// the left or Esc, and focus goes back to the button (jxn #2223). It's never kept open across a reload or a Back.
let navFrom=null;const navNarrow=matchMedia('(max-width:860px)');
function navSet(on){const app=$('#app');if(!app)return;const changed=app.classList.contains('nav-open')!==on;app.classList.toggle('nav-open',on);const mb=$('[data-nav]');mb?.setAttribute('aria-expanded',String(on));
  const sb=$('#sidebar');if(sb)sb.inert=navNarrow.matches&&!on;if(!changed)return;
  if(on){navFrom=document.activeElement;$('.nav-x')?.focus({preventScroll:true})}else{const f=navFrom&&document.contains(navFrom)?navFrom:mb;navFrom=null;if(app.contains(document.activeElement)||document.activeElement===document.body)f?.focus?.({preventScroll:true})}}
document.addEventListener('click',e=>{if(e.target.closest('[data-palette]'))openPalette();if(e.target.closest('[data-nav]'))navSet(!$('#app')?.classList.contains('nav-open'));else if(e.target.closest('[data-nav-close]'))navSet(false)});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&$('#app')?.classList.contains('nav-open')&&!$('dialog[open]')){e.preventDefault();navSet(false)}});
// Connect an agent (the menu's link, vedu #2241): this page's Connect dialog when it has one, else Account's, opened by
// its #connect.
document.addEventListener('click',e=>{const a=e.target.closest('[data-connect]'),d=$('dialog#connect');if(!a||!d)return;e.preventDefault();navSet(false);if(!d.open)d.showModal()});
if(location.hash==='#connect'){const d=$('dialog#connect');if(d&&!d.open)d.showModal()}
{let sx=0,sy=0,on=false;const sb=$('#sidebar');
  sb?.addEventListener('touchstart',e=>{const t=e.touches[0];sx=t.clientX;sy=t.clientY;on=$('#app')?.classList.contains('nav-open')},{passive:true});
  sb?.addEventListener('touchend',e=>{const t=e.changedTouches[0],dx=t.clientX-sx,dy=t.clientY-sy;if(on&&(document.dir==='rtl'?dx>50:dx<-50)&&Math.abs(dx)>Math.abs(dy)*1.5)navSet(false)},{passive:true})}
navNarrow.addEventListener('change',()=>navSet(false));navSet(false);addEventListener('pageshow',()=>navSet(false));
let g=false,gt;
document.addEventListener('keydown',e=>{
  if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();pal.open?pal.close():openPalette();return}
  const t=e.target;if(e.metaKey||e.ctrlKey||e.altKey||t.closest('input,textarea,select,[contenteditable]')||$('dialog[open]'))return;
  const k=e.key.toLowerCase();
  if(g){g=false;clearTimeout(gt);const to={b:'/',i:'/inbox',a:'/approvals',m:'/me',p:'/people',o:window.OPS?'/_ops':null}[k];if(to){location.href=to;e.preventDefault()}return}
  if(k==='g'){g=true;gt=setTimeout(()=>g=false,900);return}
  if(k==='/'){e.preventDefault();openPalette();return}
  if(e.key==='?'){$('#shortcuts').showModal();return}
  if(k==='c'){const c=$('#composer-text');if(c){e.preventDefault();c.focus();return}const n=$('#new-board');if(n){e.preventDefault();n.showModal();$('#title')?.focus()}return}
  if(k==='i'){const b=$('[data-open="invite"]');if(b){e.preventDefault();b.click()}return} // same as clicking Invite (loads the members)
  if(k==='n'&&!e.shiftKey){e.preventDefault();nextNeed();return}
  if(window.boardKeys)window.boardKeys(e,k);
});
// N: the next thing that needs you, on any board (Conductor notes, #1276): approvals waiting on you first, then unread
// mentions, replies, decisions and people-only messages for you, then contact and friend requests; oldest first. It
// opens where it is (marking that inbox item read, so the next N goes on); nothing waiting says so.
const NN_KINDS=['mention','reply','decision','people_only','contact_request','friend_request'];let nnBusy=false;
async function nextNeed(){if(nnBusy)return;nnBusy=true;try{
  const get=u=>fetch(u,{cache:'no-store'}).then(r=>r.ok?r.json():{}).catch(()=>({}));const [ap,ib]=await Promise.all([get('/api/approvals'),get('/api/inbox')]);
  const at=(i)=>i.board_id&&i.seq>0?'/b/'+i.board_id+'#e'+i.seq:null,items=ib.items||[];
  // An approval opens on the Approvals page, at the request (where you decide it: ↵ approves, ⌫ denies).
  const list=[...(ap.approvals||[]).filter(a=>a.status==='pending').sort((x,y)=>x.created_at-y.created_at).map(a=>({url:'/approvals#'+a.id})),
    ...items.filter(i=>!i.read_at&&NN_KINDS.includes(i.kind)).sort((x,y)=>x.created_at-y.created_at).map(i=>({url:/request$/.test(i.kind)?'/people':at(i),id:i.id})).filter(x=>x.url)];
  const here=location.pathname+location.hash,next=list.find(x=>x.url!==here);
  if(!next){toast(list.length?tr('That’s the only thing waiting on you'):tr('Nothing needs you right now'));return}
  if(next.id)await fetch('/api/inbox/read',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ids:[next.id]})}).catch(()=>{});
  const [path,hash]=next.url.split('#');if(path===location.pathname&&hash){location.hash=hash}else location.href=next.url}
  finally{nnBusy=false}}
window.nextNeed=nextNeed;
if(new URLSearchParams(location.search).get('new')==='1'){const n=$('#new-board');n&&n.showModal()}
})();
`;

const MARK_UNREAD_JS = `
document.addEventListener('click',async e=>{const b=e.target.closest('[data-mark-unread]');if(!b)return;e.preventDefault();const id=b.dataset.markUnread;b.disabled=true;try{const r=await fetch('/api/boards/'+encodeURIComponent(id)+'/unread',{method:'POST'});const j=await r.json();if(!r.ok)throw Error(j.error||'Could not mark unread');location.href=location.pathname==='/b/'+id?'/chats':location.href}catch(err){b.disabled=false;alert(err.message)}});
`;

// The app pages' shell script (sidebar, inbox badge, live counts, mark unread, pins), the same on every page: served as
// /shell.js (index.ts), hashed and cached for good, and run right after the page's own script, as when it was inline.
// Report-a-bug's capture+send lives in its own file (/bug.js), not in every page's shell.js (web-budget: it only
// runs when the button is clicked). The shell's click injects it once; BUG_JS self-runs for that first click.
export const BUG_PAGE_JS = BUG_JS;
export const BUG_JS_SRC = `/bug.js?v=${fnv(BUG_PAGE_JS)}`;
export const SHELL_PAGE_JS = SHELL_JS + INBOX_JS + LIVE_JS + MARK_UNREAD_JS + PINS_JS;
export const SHELL_JS_SRC = `/shell.js?v=${fnv(SHELL_PAGE_JS)}`;
