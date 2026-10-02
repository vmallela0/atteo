// Design system: tokens, base styles, components and the shared client script.
// Minimal and quiet (in the spirit of Vercel Geist / Linear): neutral grays, one ink color for primary actions,
// hairline borders, Geist type, light + dark, works down to phone width.

import { highlightMentions, type Mention } from "./mentions";
import { esc } from "./util";

export const CSS = `
:root{
  --bg:#ffffff;--bg-subtle:#fafafa;--bg-hover:#f4f4f5;--line:#ebebeb;--line-strong:#dcdcdc;
  --ink:#0a0a0a;--text:#171717;--muted:#6b6b6b;--faint:#9a9a9a;--on-ink:#ffffff;
  --accent:#0062d1;--ok:#16a34a;--warn:#c2410c;--danger:#dc2626;
  --q:#d97706;--claim:#16a34a;--decision:#7c3aed;--task:#0284c7;--artifact:#737373;--note:#a3a3a3;
  --shadow:0 1px 2px rgba(0,0,0,.04),0 4px 16px rgba(0,0,0,.04);--shadow-lg:0 12px 48px rgba(0,0,0,.12);
  --av-l:92%;--av-c:32%;--av-s:65%;
  --r:10px;--r-sm:7px;
  color-scheme:light;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --bg:#0a0a0a;--bg-subtle:#111111;--bg-hover:#1a1a1a;--line:#232323;--line-strong:#2e2e2e;
  --ink:#ededed;--text:#ededed;--muted:#a1a1a1;--faint:#6f6f6f;--on-ink:#0a0a0a;
  --accent:#4ea1ff;--ok:#3ecf75;--warn:#fb923c;--danger:#f87171;
  --q:#fbbf24;--claim:#4ade80;--decision:#a78bfa;--task:#38bdf8;--artifact:#a3a3a3;--note:#737373;
  --shadow:0 1px 2px rgba(0,0,0,.4);--shadow-lg:0 12px 48px rgba(0,0,0,.6);
  --av-l:22%;--av-c:78%;--av-s:40%;
  color-scheme:dark;
}}
*{box-sizing:border-box}
/* Scrollbars: thin and quiet (Linear/Slack-like), one per scrolling pane. Chrome and Safari use the ::-webkit
   rules (Chrome ignores them once scrollbar-width is set, so that's Firefox-only); darker while the pane is hovered. */
:root{--sb:color-mix(in srgb,var(--muted) 35%,transparent);--sb-hover:color-mix(in srgb,var(--muted) 70%,transparent)}
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track,::-webkit-scrollbar-corner{background:transparent}
::-webkit-scrollbar-thumb{background:var(--sb);border-radius:6px}
:hover::-webkit-scrollbar-thumb{background:var(--sb-hover)}
@supports not selector(::-webkit-scrollbar){*{scrollbar-width:thin;scrollbar-color:var(--sb) transparent}*:hover{scrollbar-color:var(--sb-hover) transparent}}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:13.5px/1.5 "Geist",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;font-feature-settings:"ss01","cv11"}
a{color:inherit;text-decoration:none}
a.link{color:var(--accent)}a.link:hover{text-decoration:underline}
code,pre,.mono{font-family:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
h1,h2,h3{color:var(--ink);font-weight:600;letter-spacing:-.02em;margin:0}
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
.brand{display:flex;align-items:center;gap:9px;font-weight:600;letter-spacing:-.01em;color:var(--ink)}
.brand svg{display:block}
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
.btn.primary{background:var(--ink);border-color:var(--ink);color:var(--on-ink)}
.btn.primary:hover{opacity:.88}
.btn.ghost{border-color:transparent;background:transparent;color:var(--muted)}.btn.ghost:hover{color:var(--ink);background:var(--bg-hover)}
.btn.danger{color:var(--danger)}
.btn.sm{height:26px;padding:0 9px;font-size:12.5px}.btn.lg{height:40px;padding:0 18px;font-size:14.5px}
.btn[disabled]{opacity:.5;cursor:default}
.btn:focus-visible,.input:focus-visible,a:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.input{height:32px;width:100%;padding:0 12px;border:1px solid var(--line-strong);border-radius:var(--r-sm);background:var(--bg);color:var(--text);font:inherit;
  transition:border-color .15s,box-shadow .15s}
.input:focus{outline:none;border-color:var(--faint);box-shadow:0 0 0 3px color-mix(in srgb,var(--faint) 22%,transparent)}
textarea.input{height:auto;min-height:84px;padding:10px 12px;resize:vertical;line-height:1.5}
select.input{appearance:none;padding-right:30px;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23888' fill='none' stroke-width='1.4'/%3E%3C/svg%3E");
  background-repeat:no-repeat;background-position:right 11px center}
label.lbl{display:block;font-size:13px;font-weight:500;color:var(--ink);margin:0 0 6px}
.hint{font-size:12.5px;color:var(--muted);margin-top:6px}
.field+.field{margin-top:16px}
.seg{display:inline-flex;padding:2px;border:1px solid var(--line);border-radius:8px;background:var(--bg-subtle)}
.seg input{display:none}.seg label{padding:4px 10px;border-radius:6px;font-size:13px;color:var(--muted);cursor:pointer}
.seg input:checked+label{background:var(--bg);color:var(--ink);box-shadow:var(--shadow);font-weight:500}
@media(max-width:480px){.composer .seg label{padding:4px 7px;font-size:12.5px}.composer .bar{flex-wrap:nowrap;gap:6px}}

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
.t-question{color:var(--q)}.t-claim{color:var(--claim)}.t-decision{color:var(--decision)}.t-task{color:var(--task)}.t-artifact{color:var(--artifact)}.t-note{color:var(--note)}
.type span:not(.dot){color:var(--muted)}

/* avatars */
.av{--h:220;width:28px;height:28px;flex:none;border-radius:50%;display:inline-grid;place-items:center;font-size:11.5px;font-weight:600;letter-spacing:.01em;
  background:hsl(var(--h) var(--av-s) var(--av-l));color:hsl(var(--h) 55% var(--av-c));user-select:none}
.av.sm{width:22px;height:22px;font-size:10px}.av.xs{width:18px;height:18px;font-size:8px;flex:none}.av.lg{width:40px;height:40px;font-size:15px}
.av.agent{border-radius:7px;position:relative}
.av{position:relative;overflow:hidden}
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
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) dialog{background:#141414;border-color:var(--line-strong)}}
dialog .hd{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:20px 22px 0}
dialog .bd{padding:16px 22px 22px}
dialog[open]{animation:pop .16s ease-out}
@keyframes pop{from{opacity:0;transform:translateY(6px) scale(.985)}to{opacity:1;transform:none}}

/* flash / toast */
.flash{padding:12px 14px;border-radius:var(--r-sm);border:1px solid var(--line);background:var(--bg-subtle);font-size:13.5px}
.flash.ok{border-color:color-mix(in srgb,var(--ok) 35%,var(--line))}
.flash.err{border-color:color-mix(in srgb,var(--danger) 40%,var(--line));color:var(--danger)}
#toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%) translateY(20px);opacity:0;pointer-events:none;
  background:var(--ink);color:var(--on-ink);padding:9px 14px;border-radius:8px;font-size:13px;transition:all .2s;z-index:50}
#toast.show{opacity:1;transform:translateX(-50%)}

/* board */
.board-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:28px}
.crumbs{font-size:13px;color:var(--muted);margin-bottom:8px}.crumbs a:hover{color:var(--ink)}
.layout{display:grid;gap:28px;grid-template-columns:minmax(0,1fr)}
@media(min-width:960px){.layout{grid-template-columns:minmax(0,1fr) 300px}.aside{position:sticky;top:64px;align-self:start;max-height:calc(100vh - 84px);overflow-y:auto;overflow-x:hidden;padding-right:4px}}
.thread{display:flex;flex-direction:column}
.entry{display:flex;gap:12px;padding:16px 0;border-top:1px solid var(--line)}
.thread>.entry:first-child{border-top:0;padding-top:4px}
.entry .meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px;line-height:20px}
.entry .who{font-weight:600;color:var(--ink)}
.entry .to{color:var(--muted)}
.entry .when,.entry .seq{color:var(--faint);font-size:12.5px}
.entry .seq:hover{color:var(--ink)}
.entry .body{margin-top:3px;color:var(--text);word-wrap:break-word;overflow-wrap:anywhere}
.entry .body p+p{margin-top:8px}
.body ul,.body ol{margin:6px 0;padding-left:20px}.body li{margin:2px 0}
.body .md-h{margin:12px 0 4px;font-size:14px;color:var(--ink)}.body .md-h:first-child{margin-top:0}
.entry .body pre{background:var(--bg-subtle);border:1px solid var(--line);border-radius:8px;padding:10px 12px;overflow-x:auto;margin:8px 0;white-space:pre}
.entry .body code{background:var(--bg-hover);padding:1px 5px;border-radius:4px}
.entry .body pre code{background:none;padding:0}
.entry .body a{color:var(--accent)}
.entry .refs{margin-top:6px;font-size:12.5px;color:var(--faint)}
.entry .refs a:hover{color:var(--ink)}
.entry.flash-in{animation:flashin 1.6s ease-out}
.entry .rbadge{display:none;height:18px;font-size:11px}
.entry .fbadge{height:18px;font-size:11px;color:var(--warn);border-color:color-mix(in srgb,var(--warn) 40%,var(--line))}
.entry.retracted>.grow>.body,.entry.retracted>.grow>.file{text-decoration:line-through;text-decoration-color:var(--faint);opacity:.55}
.entry.retracted>.grow>.meta .rbadge{display:inline-flex}
.entry .acts{margin-left:auto;display:inline-flex;gap:2px;opacity:0;transition:opacity .12s}
.entry:hover .acts,.entry .acts:focus-within,.entry .acts:has(.danger){opacity:1}
/* Retract takes no room in the header line, so narrow screens don't get a blank line under every entry. Touch
   screens have no hover: there it appears on the entry you opened (tap its #number). */
.entry{position:relative}
@media(hover:hover){.entry .acts{position:absolute;top:12px;right:0;background:var(--bg)}}
@media(hover:none){.entry .acts{display:none}.entry:target>.grow>.meta .acts,.entry.sel>.grow>.meta .acts{display:inline-flex;opacity:1}}
/* "Replying to …" above the composer: the reply goes to that agent (or mentions that person). */
.replying{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--muted);padding:2px 2px 8px}
.replying[hidden]{display:none}
.replying b{color:var(--text);font-weight:550}
.replying .x{margin-left:auto}
@keyframes flashin{from{background:color-mix(in srgb,var(--accent) 9%,transparent)}to{background:transparent}}
.entry:target{background:color-mix(in srgb,var(--accent) 6%,transparent);border-radius:8px}
.replies{margin:10px 0 0;padding-left:14px;border-left:2px solid var(--line)}
.replies:empty{display:none}
.replies .entry{border-top:0;padding:10px 0 0}
.file{margin-top:8px;border:1px solid var(--line);border-radius:8px;overflow:hidden}
.file .fh{display:flex;align-items:center;gap:10px;padding:9px 12px;background:var(--bg-subtle)}
.file pre{margin:0;max-height:420px;overflow:auto;padding:12px;border-top:1px solid var(--line);white-space:pre;font-size:12px}
.t-change{color:var(--accent)}
/* Members & access */
dialog.access-dlg{width:min(640px,calc(100vw - 24px))}
.acc-sec{padding:14px 0;border-top:1px solid var(--line)}.acc-sec:first-child{border-top:0;padding-top:0}
.acc-sec h3{font-size:12.5px;font-weight:600;color:var(--ink);margin:0 0 8px}.acc-sec summary{cursor:pointer}
.acc-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.acc-sel{width:auto;height:30px;font-size:12.5px;padding:0 8px}
.cn-list{list-style:none;margin:4px 0 0;padding:0;display:flex;flex-direction:column;gap:10px}.cn-list li>.copy{margin-top:5px}
.doc-code{margin:0;font-size:12.5px;line-height:1.55;white-space:pre-wrap;word-break:break-word}
@media (max-width:640px){.pfp{flex-wrap:wrap}.pfp>.row:last-child{flex-basis:100%;justify-content:flex-start}}
.acc-url{font-size:12px;height:30px}.acc-to{position:relative;min-width:200px}.acc-to .input{width:100%}
.acc-sug{position:absolute;left:0;right:0;top:calc(100% + 4px);z-index:5;list-style:none;margin:0;padding:4px;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--bg);box-shadow:var(--shadow-lg)}
.acc-sug[hidden]{display:none}.acc-sug li{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;font-size:13px;cursor:pointer;min-width:0}
.acc-sug li[aria-selected="true"],.acc-sug li:hover{background:var(--bg-hover)}
.acc-list{list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column;gap:8px}
.sum h3 .linkish,.linkish{border:0;background:none;padding:0;font:inherit;font-size:12px;color:var(--accent);cursor:pointer}.linkish:hover{text-decoration:underline}
/* view-only members: nothing that writes */
.ro .composer,.ro [data-qr],.ro [data-rx-add],.ro [data-reply],.ro .rx-add,.ro [data-tk],.ro [data-review],.ro .kb-new,.ro #doc-new,.ro #doc-edit{display:none!important}
.ro .rx-chip{pointer-events:none}
/* threads: replies fold into "N replies" under their message; the thread opens in a side panel (an overlay on phones) */
#thread>.entry>.grow>.replies{display:none}
.thr-sum{display:inline-flex;align-items:center;gap:8px;margin-top:6px;padding:3px 10px 3px 4px;border:1px solid transparent;border-radius:8px;background:none;font:inherit;font-size:12.5px;color:var(--accent);cursor:pointer}
.thr-sum:hover{border-color:var(--line);background:var(--bg-subtle)}.thr-sum .faint{color:var(--faint)}
.thr-sum .avs .av{width:20px;height:20px;font-size:8.5px}
.thread-pane{display:flex;flex-direction:column;min-height:0;border-left:1px solid var(--line);padding:0 0 12px 16px;background:var(--bg)}
.thread-pane[hidden]{display:none}
.tp-head{display:flex;align-items:center;gap:8px;padding:10px 0 8px;border-bottom:1px solid var(--line)}
.tp-scroll{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:4px 4px 8px 0}
.tp-scroll .entry{padding:12px 0}.tp-scroll .acts{display:none}
.tp-count{padding:6px 0;border-bottom:1px solid var(--line)}
.tp-composer{flex:none;margin-top:6px}.tp-composer .bar{display:flex;align-items:center;gap:8px;padding:8px 10px;border-top:1px solid var(--line)}
.tp-scroll .refs{display:none}.tp-composer textarea{border:0;border-radius:var(--r) var(--r) 0 0;box-shadow:none;min-height:44px;resize:none}
@media(min-width:960px){.bp-panel>.layout.thread-open{grid-template-columns:minmax(0,1fr) 380px}.layout.thread-open>.aside{display:none}.layout.thread-open .info-btn{display:none}}
@media(max-width:959px){.layout.thread-open>.thread-pane{position:absolute;inset:0;z-index:9;padding-left:0;border-left:0}}
.entry.hit{background:color-mix(in srgb,var(--warn) 9%,transparent);border-radius:8px;box-shadow:inset 3px 0 0 var(--warn)}
/* a task in the conversation: status, priority, who it's for / who holds it, and Claim · Done · Open */
.tk{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px;padding:6px 6px 6px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg-subtle);font-size:12.5px}
.tk[hidden]{display:none}
.tk-st{display:inline-flex;align-items:center;gap:6px;font-weight:500;color:var(--ink)}.tk-st .dot{width:8px;height:8px;border-radius:50%;background:var(--muted)}
.st-doing .dot{background:var(--accent)}.st-blocked .dot,.st-stopped .dot{background:var(--warn)}.st-done .dot{background:var(--ok)}
.cl-asserted{color:var(--muted);font-weight:400}.cl-evidenced .dot{background:var(--task)}.cl-verified{color:var(--ok)}.cl-verified .dot{background:var(--ok)}.cl-disputed{color:var(--danger)}.cl-disputed .dot{background:var(--danger)}
.cl-ev a{color:var(--muted);text-decoration:underline;text-decoration-color:var(--line-strong);text-underline-offset:2px}.cl-ev a:hover{color:var(--ink)}
.cl-f{display:flex;gap:6px;flex-basis:100%}.cl-f[hidden]{display:none}.cl-f .input{flex:1;height:28px;font-size:12.5px}
.badge.stale{height:18px;font-size:11px;color:var(--warn);border-color:color-mix(in srgb,var(--warn) 40%,var(--line))}
.st-done{color:var(--muted)}.tk-who{color:var(--muted)}
/* reactions: chips under a message; the add button shows on hover (always on touch screens) */
.rx{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.rx.has{margin-top:6px}
.rx-chip{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 8px;border-radius:999px;border:1px solid var(--line);background:var(--bg-subtle);color:var(--text);font:inherit;font-size:12.5px;cursor:pointer}
.rx-chip:hover{border-color:var(--line-strong)}
.rx-chip.on{border-color:color-mix(in srgb,var(--accent) 55%,var(--line));background:color-mix(in srgb,var(--accent) 10%,var(--bg))}
.rx-chip .e{font-size:14px;line-height:1}.rx-chip .c{font-variant-numeric:tabular-nums;color:var(--muted)}.rx-chip.on .c{color:var(--accent)}
.rx-add{display:none;align-items:center;height:24px;padding:0 7px;border-radius:999px;border:1px dashed var(--line-strong);background:none;color:var(--muted);font:inherit;font-size:13px;cursor:pointer}
.rx-add span{font-size:11px;margin-left:1px}.rx-add:hover{color:var(--ink);border-style:solid}
.rx.has .rx-add{display:inline-flex} /* with no reactions yet, "☺+" lives in the message's hover actions */
.rx-pick{position:fixed;z-index:50;display:flex;gap:2px;padding:4px;border-radius:999px;border:1px solid var(--line);background:var(--bg);box-shadow:var(--shadow-lg)}
.rx-pick[hidden]{display:none}
.rx-tip{position:fixed;z-index:50;display:flex;align-items:center;gap:10px;max-width:280px;padding:8px 12px;border-radius:10px;background:var(--ink);color:var(--on-ink);font-size:12.5px;line-height:1.35;box-shadow:var(--shadow-lg);pointer-events:none}
.rx-tip[hidden]{display:none}.rx-tip .big{font-size:24px;line-height:1}.rx-tip .faint{color:color-mix(in srgb,var(--on-ink) 65%,transparent)}
.entry .acts .rx-q{width:28px;padding:0;justify-content:center;font-size:14px}
.rx-pick button{width:32px;height:32px;border:0;border-radius:50%;background:none;font-size:18px;cursor:pointer;line-height:1}.rx-pick button:hover{background:var(--bg-hover)}
/* images: inline in the conversation (real proportions, capped), full size in a lightbox; attachments in the composer */
.img{margin:8px 0 0}.img-open{display:block;padding:0;border:0;background:none;cursor:zoom-in;max-width:100%}
.img img{display:block;max-width:min(100%,440px);max-height:340px;width:auto;height:auto;border-radius:8px;border:1px solid var(--line);background:var(--bg-subtle)}
.img figcaption{margin-top:4px}
dialog.lightbox{padding:0;border:0;background:transparent;box-shadow:none;max-width:min(96vw,1600px);max-height:92vh;cursor:zoom-out}
dialog.lightbox::backdrop{background:rgba(0,0,0,.78)}
dialog.lightbox img{display:block;max-width:min(96vw,1600px);max-height:92vh;width:auto;height:auto;border-radius:8px}
.attachments{display:flex;gap:8px;flex-wrap:wrap;padding:10px 12px 0}
.attachments[hidden]{display:none}
.att{position:relative;display:block}
.att img{display:block;height:64px;width:auto;max-width:140px;object-fit:cover;border-radius:7px;border:1px solid var(--line)}
.att-x{position:absolute;top:-6px;right:-6px;width:18px;height:18px;border-radius:50%;border:1px solid var(--line-strong);background:var(--bg);color:var(--muted);font-size:10px;line-height:1;cursor:pointer;display:grid;place-items:center;padding:0}
.att-x:hover{color:var(--ink)}
.att.file{display:flex;flex-direction:column;justify-content:center;gap:2px;height:64px;max-width:180px;padding:0 12px;border:1px solid var(--line);border-radius:7px;background:var(--bg-subtle)}
.att-name{font-size:12px;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.doc-bin{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px;border:1px dashed var(--line-strong);border-radius:8px}
.composer .attach{width:30px;padding:0;justify-content:center;color:var(--muted)}.composer .attach:hover{color:var(--ink)}
.conv.drop .composer{box-shadow:0 0 0 2px var(--accent)}
.doc-img img{display:block;max-width:100%;height:auto;border-radius:8px;border:1px solid var(--line);background:var(--bg-subtle)}
/* read receipts: a ring on your latest message, filling green as people and agents see it; a dot on each @mention */
.entry.has-rd>.grow{padding-right:24px}
.rd{position:absolute;right:0;bottom:12px;width:16px;height:16px;display:grid;place-items:center;cursor:default;outline-offset:2px}
.rd svg{display:block}.rd .t{fill:none;stroke:var(--line-strong);stroke-width:2}.rd .p{fill:none;stroke:var(--ok);stroke-width:2;stroke-linecap:round;transition:stroke-dasharray .3s}
.rd.all .t{fill:var(--ok);stroke:var(--ok)}.rd .ck{fill:none;stroke:var(--bg);stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.rd-pop{display:none;position:absolute;right:0;bottom:22px;z-index:6;min-width:150px;max-width:240px;padding:8px 10px;border-radius:8px;background:var(--ink);color:var(--on-ink);
  font-size:12px;line-height:18px;box-shadow:var(--shadow-lg);flex-direction:column;white-space:nowrap}
.rd:hover .rd-pop,.rd:focus .rd-pop{display:flex}
.rd.down .rd-pop{bottom:auto;top:22px}
.rd-pop b{font-weight:600;margin-bottom:2px}.rd-pop .y::before{content:"✓ ";color:var(--ok)}.rd-pop .n{opacity:.6}.rd-pop .n::before{content:"○ "}
.entry .body .mention{position:relative}
/* the dot takes the mention's own colour: an outline until they've seen it, filled once they have */
.entry .body .mention{--dot:var(--accent)}.entry .body .mention.me{--dot:var(--warn)}
.entry .body .mention::after{content:"";position:absolute;top:-3px;right:-3px;width:6px;height:6px;border-radius:50%;box-shadow:0 0 0 1.5px var(--bg);
  border:1.5px solid var(--dot);background:var(--bg);box-sizing:border-box}
.entry .body .mention.seen::after{background:var(--dot)}
/* change cards: a git change as a card (branch → base, CI, PR, commits, files, reviews, diff on demand) */
.chg{margin-top:8px;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--bg)}
.chg-h{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 12px;background:var(--bg-subtle);color:var(--muted);font-size:13px}
.chg-br{color:var(--ink);font-size:12px;padding:1px 6px;border-radius:5px;background:var(--bg-hover);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chg-pr{color:var(--accent);font-weight:500;font-size:12.5px}.chg-pr:hover{text-decoration:underline}
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
.chg [data-review][aria-pressed=true]{box-shadow:inset 0 0 0 1px var(--accent)}
.chg [data-review][hidden],.chg-rc[hidden],.chg-diff[hidden]{display:none}
.chg-rc{display:flex;gap:8px;padding:0 12px 10px}.chg-rc .input{height:30px}
.chg-diff{margin:0;padding:8px 0;border-top:1px solid var(--line);background:var(--bg-subtle);font-size:12px;line-height:1.5;overflow-x:auto;white-space:pre}
.chg-diff span{display:block;padding:0 12px;min-width:max-content;min-height:1.5em}
.chg-diff .da{background:color-mix(in srgb,var(--ok) 13%,transparent)}.chg-diff .dd{background:color-mix(in srgb,var(--danger) 12%,transparent)}
.chg-diff .dk{color:var(--accent)}.chg-diff .dh{color:var(--ink);font-weight:600}
.sum h3{font-size:12px;font-weight:500;color:var(--muted);text-transform:none;margin:22px 0 8px;display:flex;justify-content:space-between}
.sum h3:first-child{margin-top:0}
.sum ul{list-style:none;margin:0;padding:0}
.sum li a{display:flex;gap:8px;padding:6px 8px;margin:0 -8px;border-radius:6px;font-size:13px;line-height:1.45}
.sum li a:hover{background:var(--bg-hover)}
.sum li .n{color:var(--faint);flex:none;font-variant-numeric:tabular-nums}
.sum li .one{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sum li a{align-items:center}.sum li .avs{flex:none;width:40px}.sum li .avs .av{width:18px;height:18px;font-size:8px;margin-left:-6px}.sum li .avs .av:first-child{margin-left:0}

.sum .none{font-size:13px;color:var(--faint)}
.waiting{border:1px solid color-mix(in srgb,var(--q) 40%,var(--line));background:color-mix(in srgb,var(--q) 6%,var(--bg));border-radius:var(--r-sm);padding:10px 12px;margin-bottom:6px}
.composer{margin-top:20px;position:relative}
.mention{color:var(--accent);font-weight:500;background:color-mix(in srgb,var(--accent) 9%,transparent);padding:0 3px;border-radius:4px;white-space:nowrap}
.mention.agent{border:1px dashed color-mix(in srgb,var(--accent) 45%,transparent);padding:0 3px}
/* Takes real space (border, not an outline ring), so it never overlaps the text or the mention next to it. */
.mention.me{color:var(--ink);background:color-mix(in srgb,var(--warn) 22%,transparent);border:1px solid color-mix(in srgb,var(--warn) 45%,transparent);padding:0 3px;margin:0 1px}
/* The highlight extends 12px beyond the entry on both sides (content stays put), so its bar never sits on the avatar. */
.entry.for-you{margin-left:-12px;margin-right:-12px;padding-left:12px;padding-right:12px;background:color-mix(in srgb,var(--warn) 6%,transparent);box-shadow:inset 3px 0 0 color-mix(in srgb,var(--warn) 70%,transparent);border-radius:8px;animation:foryou 1.6s ease-out 1}
.entry.for-you .rd{right:12px}
@keyframes foryou{from{background:color-mix(in srgb,var(--warn) 18%,transparent)}}
.mention-menu{position:absolute;left:12px;bottom:calc(100% - 6px);z-index:5;width:min(280px,calc(100% - 24px));list-style:none;margin:0;padding:6px;
  border:1px solid var(--line);border-radius:10px;background:var(--bg);box-shadow:var(--shadow-lg)}
.mention-menu li{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:7px;cursor:pointer;font-size:13px;color:var(--text)}
.mention-menu li[aria-selected=true]{background:var(--bg-hover);color:var(--ink)}
.mention-menu li .k{margin-left:auto;color:var(--faint);font-size:12px}
.mention-menu .hint{padding:4px 8px 2px;font-size:11.5px;color:var(--faint);cursor:default}
.composer .bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 12px;border-top:1px solid var(--line)}
.composer textarea{border:0;border-radius:var(--r) var(--r) 0 0;box-shadow:none;min-height:72px}
.composer textarea:focus{box-shadow:none}


/* app shell (Linear-style): sidebar + top bar + content */
.app{display:grid;grid-template-columns:232px minmax(0,1fr);min-height:100vh}
.sidebar{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;gap:2px;padding:10px 8px;border-right:1px solid var(--line);background:var(--bg-subtle);overflow:auto}
.sidebar .ws{display:flex;align-items:center;gap:9px;padding:6px 8px 10px;font-weight:600;color:var(--ink)}
.sidebar .search{display:flex;align-items:center;gap:8px;height:30px;margin:0 0 8px;padding:0 9px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--faint);cursor:pointer;font:inherit;font-size:13px;text-align:left}
.sidebar .search:hover{border-color:var(--line-strong);color:var(--muted)}
.sidebar .search kbd{margin-left:auto}
.side-link{display:flex;align-items:center;gap:9px;height:30px;padding:0 9px;border-radius:6px;color:var(--muted);font-size:13px}
.side-link:hover{background:var(--bg-hover);color:var(--ink)}
.side-link[aria-current]{background:var(--bg-hover);color:var(--ink);font-weight:500}
.side-link svg{flex:none;opacity:.85}
.side-link .count{margin-left:auto;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:var(--accent);color:#fff;font-size:11px;font-weight:600;display:inline-flex;align-items:center;justify-content:center}
.side-link .count[hidden]{display:none}
.inbox{list-style:none;margin:0;padding:4px}
.legal h2{font-size:15px;margin:18px 0 6px}.legal p{font-size:13.5px;line-height:1.6;color:var(--text)}
.entry.pending{opacity:.6}.entry.pending .body{white-space:pre-wrap}.entry.pending.failed .faint{color:var(--danger)}
.pres{width:8px;height:8px;border-radius:50%;background:var(--line-strong,var(--line));display:inline-block}.pres.on{background:var(--ok)}
/* People and profiles */
.ppl-h{font-size:13px;font-weight:600;color:var(--ink);margin:28px 0 8px}.ppl-h .faint{font-weight:400}
.ppl-find{position:relative;margin-top:16px}.ppl-res{position:absolute;left:0;right:0;top:38px;z-index:5;box-shadow:var(--shadow-lg);margin:0;padding:0;list-style:none}.ppl-res[hidden]{display:none}
.ppl-pres{gap:6px}.ppl-note{margin-top:10px}.ppl-blocked{margin-top:20px}.ppl-blocked summary{cursor:pointer}.ppl-blocked .list{margin-top:8px}
.prof{display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap}
.prof-av{position:relative;flex:none}.prof-av .av.lg{width:64px;height:64px;font-size:22px}
.prof-agent{position:absolute;right:-6px;bottom:-6px;border-radius:7px;box-shadow:0 0 0 3px var(--bg)}
.prof-name{font-size:20px;line-height:1.25}.prof-pres{gap:6px;margin-top:8px}.prof-bio{margin:10px 0 0;font-size:13.5px;color:var(--text)}.prof-act{gap:6px;flex:none}
/* hover cards */
.hcard{position:fixed;z-index:60;width:280px;padding:14px;border:1px solid var(--line);border-radius:12px;background:var(--bg);box-shadow:var(--shadow-lg)}
.hcard[hidden]{display:none}.hcard .av.lg{width:40px;height:40px;font-size:15px}
.hc-name{font-weight:600;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.hc-pres{gap:6px;margin-top:10px}.hc-bio{margin:8px 0 0;font-size:12.5px;color:var(--muted)}.hc-act{gap:6px;margin-top:12px}
/* approvals: risk shows as the card's left edge and its badge */
.approval{padding:16px 18px;border-left:3px solid var(--line)}.approval.risk-medium{border-left-color:var(--warn)}.approval.risk-high{border-left-color:var(--danger)}
.ap-hd{display:flex;gap:12px;align-items:flex-start}.ap-title{font-size:15px;font-weight:600;line-height:1.35;margin:0 0 3px}
.approval.risk-medium .ap-risk{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 40%,var(--line))}.approval.risk-high .ap-risk{color:var(--danger);border-color:color-mix(in srgb,var(--danger) 40%,var(--line))}
.ap-details{max-height:280px;overflow:auto;margin:12px 0 0;padding:10px 12px;border-radius:8px;background:var(--bg-subtle);border:1px solid var(--line);font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.ap-form{display:flex;gap:6px;margin-top:12px}
.ap-sub{font-size:13px;font-weight:600;margin:28px 0 8px}
.ap-done{padding:0;list-style:none;margin:0}.ap-done>li+li{border-top:1px solid var(--line)}
.ap-row summary{display:flex;gap:10px;align-items:center;padding:9px 14px;cursor:pointer;list-style:none;font-size:13px}.ap-row summary::-webkit-details-marker{display:none}
.ap-row summary:hover{background:var(--bg-hover)}.ap-row>p,.ap-row>pre{margin:0 14px 12px}.ap-row>pre{margin-top:0}
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
.bc-emoji{font-size:18px;line-height:1}
.bc-dot{width:10px;height:10px;border-radius:3px;background:hsl(var(--h) 55% 55%);flex:none}
.bc-unread{font-size:11px;font-weight:600;color:#fff;background:var(--accent);border-radius:9px;padding:1px 7px;white-space:nowrap}
.bc-edit{opacity:0;transition:opacity .12s}
.bcard:hover .bc-edit,.bc-edit:focus-visible{opacity:1}
@media(hover:none){.bc-edit{opacity:1}}
.bc-desc{margin:0;font-size:13px;color:var(--muted);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:2.6em}
.bc-tags{display:flex;flex-wrap:wrap;gap:4px}
.tag{font-size:11.5px;color:var(--muted);background:var(--bg-hover);border-radius:5px;padding:1px 6px}
.bc-links{display:flex;flex-wrap:wrap;gap:10px;font-size:12px}
.bc-foot{gap:8px;align-items:center;margin-top:auto}
mark{background:color-mix(in srgb,var(--warn) 30%,transparent);color:inherit;border-radius:2px;padding:0 1px}
/* Tasks board */
.kcard{cursor:pointer}
.task-dlg{width:min(720px,calc(100vw - 32px))}
.task-dlg .td-title{font-size:15px;font-weight:600}
.td-fields{gap:10px;flex-wrap:wrap;margin-bottom:10px}
.td-fields label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted)}
.td-body{width:100%;min-height:220px;font-size:12.5px;line-height:1.5}
.td-hist{margin:6px 0 0;padding-left:16px}
.kanban-head{gap:10px;padding:12px 0;align-items:center;flex:none}
.kb-new{gap:6px;margin:0}.kb-new .input{width:240px}
.kanban{display:grid;grid-template-columns:repeat(4,minmax(220px,1fr));gap:12px;overflow-x:auto;align-items:start;padding-bottom:6px}
.kcol{background:var(--bg-subtle,var(--bg-hover));border:1px solid var(--line);border-radius:10px;padding:8px;min-height:120px;transition:border-color .1s,background .1s}
.kcol.over{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 6%,var(--bg))}
.kcol h3{font-size:12.5px;font-weight:600;color:var(--ink);margin:2px 4px 8px}
.kcards{display:flex;flex-direction:column;gap:6px}
.kcard{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px 10px;cursor:grab;display:flex;flex-direction:column;gap:4px}
.kcard:hover{border-color:color-mix(in srgb,var(--ink) 25%,var(--line))}
.kcard.dragging{opacity:.5}
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
.side-label{font-size:11.5px;font-weight:500;color:var(--faint);padding:14px 9px 4px;display:flex;justify-content:space-between;align-items:center}
.side-label a{color:var(--faint)}.side-label a:hover{color:var(--ink)}
.side-board .bdot{width:8px;height:8px;border-radius:3px;flex:none;background:hsl(var(--h) 55% 55%)}
.sidebar .me{margin-top:auto;border-top:1px solid var(--line);padding-top:8px}
.topbar{position:sticky;top:0;z-index:10;height:48px;display:flex;align-items:center;gap:12px;padding:0 20px;border-bottom:1px solid var(--line);
  background:color-mix(in srgb,var(--bg) 85%,transparent);backdrop-filter:saturate(180%) blur(10px);-webkit-backdrop-filter:saturate(180%) blur(10px)}
.topbar .crumbs{margin:0;display:flex;align-items:center;gap:8px;min-width:0;font-size:13px}
.topbar .crumbs .cur{color:var(--ink);font-weight:500}
.topbar .actions{margin-left:auto;display:flex;gap:8px;align-items:center}
.content{max-width:1120px;margin:0 auto;padding:28px 24px 96px}
.content.narrow{max-width:760px}
.menu-btn{display:none}
@media(max-width:860px){.app{grid-template-columns:1fr}.sidebar{position:fixed;inset:0 auto 0 0;width:260px;z-index:40;transform:translateX(-100%);transition:transform .2s,box-shadow .2s}
  .app.nav-open .sidebar{transform:none;box-shadow:var(--shadow-lg)}.menu-btn{display:inline-flex}.content{padding:20px 16px 80px}.topbar{padding:0 12px}}
kbd{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 4px;border:1px solid var(--line-strong);border-bottom-width:2px;
  border-radius:4px;font:500 10.5px/1 "Geist Mono",ui-monospace,monospace;color:var(--muted);background:var(--bg)}

/* tabs */
.tabs{display:flex;gap:2px;border-bottom:1px solid var(--line);margin-bottom:18px}
.tabs button{font:inherit;font-size:13px;background:none;border:0;border-bottom:2px solid transparent;margin-bottom:-1px;padding:8px 10px;color:var(--muted);cursor:pointer}
.tabs button:hover{color:var(--ink)}.tabs button[aria-selected=true]{color:var(--ink);border-bottom-color:var(--ink);font-weight:500}
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
.palette input{border:0;border-radius:0;height:48px;padding:0 4px;font-size:15px;box-shadow:none!important}
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
.palette .pal-l{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.palette .pal-l mark{background:color-mix(in srgb,var(--warn) 28%,transparent);color:inherit;border-radius:3px;padding:0 1px}
.palette li .k{flex:none;white-space:nowrap}
.palette li{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:7px;cursor:pointer;font-size:13.5px;color:var(--text)}
.palette li[aria-selected=true]{background:var(--bg-hover);color:var(--ink)}
.palette li .k{margin-left:auto;color:var(--faint);font-size:12px}
.palette .foot{display:flex;gap:14px;padding:8px 14px;border-top:1px solid var(--line);font-size:12px;color:var(--faint)}
.entry.sel{background:var(--bg-subtle);box-shadow:-12px 0 0 var(--bg-subtle),12px 0 0 var(--bg-subtle)}

/* inline board title rename */
.title-edit{display:flex;align-items:center;gap:6px;min-width:0}
.title-edit h1{cursor:text;border-radius:6px;padding:0 4px;margin-left:-4px}
.title-edit h1:hover{background:var(--bg-hover)}
.title-edit .pencil{opacity:0;transition:opacity .12s}
.title-edit:hover .pencil,.title-edit .pencil:focus-visible{opacity:1}
.title-input{font-size:22px;font-weight:600;letter-spacing:-.02em;height:40px;max-width:640px}

/* shared documents */
.docs{display:grid;gap:20px;grid-template-columns:minmax(0,1fr)}
@media(min-width:860px){.docs{grid-template-columns:220px minmax(0,1fr)}}
.doc-item{display:flex;justify-content:space-between;gap:8px;padding:6px 8px;margin:0 -8px;border-radius:6px;font-size:13px}
.doc-item:hover,.doc-item.on{background:var(--bg-hover)}
.doc-body{font-size:14px}.doc-body p+p{margin-top:10px}
/* board page: the header and tabs stay put; the thread, sidebar, log and docs each scroll on their own */
.content.full{max-width:1160px;height:calc(100vh - 48px);height:calc(100dvh - 48px);padding:6px 20px 0;display:flex;flex-direction:column;overflow:hidden}
.bp-banner{flex:none;display:flex;align-items:center;gap:12px;margin:6px 0;padding:8px 12px}
.bp-head{flex:none;display:flex;align-items:flex-end;flex-wrap:wrap;gap:0 20px;border-bottom:1px solid var(--line)}
.bp-title{flex:1 1 320px;min-width:0;display:flex;align-items:center;gap:14px;padding:6px 0 7px}
.bp-head h1{font-size:17px;line-height:26px;margin:0;min-width:0}
.bp-head .title-edit{min-width:0;flex:0 1 auto}
.bp-meta{gap:10px;flex-wrap:nowrap;min-width:0;white-space:nowrap}
.bp-tabs{display:flex;align-items:flex-end;gap:8px;flex:none}
.bp-tabs .tabs{border-bottom:0;margin-bottom:0}
.bp-tabs .tabs button{padding:7px 10px}
/* the sidebar toggle sits in the board area, top right: over the sidebar's corner, or the thread's when it's hidden */
.bp-panel .info-btn{display:inline-flex;position:absolute;top:8px;right:0;z-index:7;width:30px;padding:0;justify-content:center;color:var(--muted);background:var(--bg)}
.info-btn svg{flex:none}
.info-btn:hover,.info-btn[aria-expanded=true]{color:var(--ink)}
.info-btn .fill{opacity:0;transition:opacity .12s}.info-btn[aria-expanded=true] .fill{opacity:.35}
.info-btn .count{position:absolute;top:-3px;right:-4px;min-width:15px;height:15px;padding:0 4px;border-radius:999px;background:var(--q);color:var(--on-ink);font-size:10px;font-weight:600;display:inline-grid;place-items:center;line-height:1}
.bp-panel{flex:1;min-height:0;display:flex;flex-direction:column}
.bp-panel>.layout{flex:1;min-height:0;grid-template-rows:minmax(0,1fr);position:relative;gap:20px}
@media(min-width:960px){.bp-panel>.layout{grid-template-columns:minmax(0,1fr) 280px}.bp-panel>.layout.info-collapsed{grid-template-columns:minmax(0,1fr)}.layout.info-collapsed>.aside{display:none}
  .layout.info-collapsed>.conv{width:100%;max-width:820px;margin:0 auto} /* a readable measure even with the sidebar hidden */}
.bp-panel .aside{position:static;align-self:stretch;max-height:none;min-height:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;padding:44px 4px 16px 8px;margin-left:-8px}
.layout.info-collapsed .rail{top:44px} /* clear of the toggle when it sits over the thread */
.conv{display:flex;flex-direction:column;min-height:0;min-width:0}
.thread-wrap{flex:1;min-height:0;position:relative;display:flex}
.thread-scroll{flex:1;min-width:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;padding:8px 22px 8px 0;scrollbar-width:none}
.thread-scroll::-webkit-scrollbar{display:none} /* the rail stands in for its scrollbar */
.rail{position:absolute;top:8px;bottom:8px;right:0;width:16px;cursor:pointer;touch-action:none}
.rail i{position:absolute;right:3px;width:8px;height:2px;margin-top:-1px;border-radius:1px;background:color-mix(in srgb,var(--muted) 16%,transparent);transition:background .12s,width .12s}
.rail i.on{background:var(--muted);width:10px}
.rail:hover i{background:var(--sb)}.rail:hover i.on{background:var(--ink)}
.rail-tip{position:absolute;right:22px;z-index:5;max-width:min(360px,70%);padding:5px 9px;margin-top:-13px;border-radius:7px;background:var(--ink);color:var(--on-ink);
  font-size:12px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;box-shadow:var(--shadow-lg)}
.rail-tip[hidden]{display:none}
.new-pill{position:absolute;left:50%;bottom:12px;transform:translateX(-50%);z-index:4;box-shadow:var(--shadow-lg);border-radius:999px}
.new-pill[hidden],.info-btn .count[hidden],.info-btn[hidden]{display:none}
.conv .composer{flex:none;margin:6px 0 max(12px,env(safe-area-inset-bottom))}
.conv .composer textarea{min-height:48px;max-height:30vh;resize:none}
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
#panel-log>p{flex:none;margin:8px 0 14px}
#panel-docs .docs{flex:1;min-height:0;padding:16px 0 14px;grid-template-rows:minmax(0,1fr)}
.doc-list{min-height:0;overflow-y:auto;overflow-x:hidden;padding:0 8px;margin:0 -8px} /* room for the items' hover background */
.doc-view{min-height:0;overflow-y:auto;overflow-x:hidden}
.doc-view.editing{display:flex;flex-direction:column;overflow:hidden} /* only the editor scrolls */
.doc-view.editing #doc-text{flex:1;min-height:200px;resize:none}
@media(max-width:959px){
  .bp-panel .aside{display:none}
  .layout.info-open>.aside{display:block;position:absolute;inset:0;z-index:6;background:var(--bg);padding:44px 2px 16px}
  .bp-panel .rail{top:44px}
  .layout.info-open>.conv{visibility:hidden} /* only the open panel's scrollbar shows */
}
@media(max-width:859px){
  .content.full{padding:4px 12px 0}
  .bp-head{flex-direction:column;align-items:stretch}
  .bp-title{flex:none;gap:10px;padding:4px 0 0}
  .bp-names,.bp-count{display:none}
  .bp-tabs .tabs button{padding:7px 8px}
  #panel-docs .docs{grid-template-rows:auto minmax(0,1fr)}
  .doc-list{max-height:22vh}
}

/* agent connect card + presence */
.agent-card{display:flex;align-items:center;gap:12px;padding:14px 16px;border:1px solid var(--line);border-radius:var(--r);background:var(--bg-subtle);margin-bottom:20px;font-size:13.5px}
.agent-card b{color:var(--ink)}
.agent-card.cta{border-color:color-mix(in srgb,var(--accent) 45%,var(--line));background:color-mix(in srgb,var(--accent) 7%,var(--bg));flex-wrap:wrap}
.agent-card.cta .btn{flex:none}
.aside .agent-card{flex-direction:column;align-items:stretch;position:relative}
.aside .agent-card .btn.sm.card-x{position:absolute;top:6px;right:6px;width:24px;height:24px;padding:0;justify-content:center;color:var(--muted)}.agent-card .card-x:hover{color:var(--ink)}
.aside .agent-card .grow>b{padding-right:22px}
.aside .agent-card.ok{flex-direction:row;align-items:center}
.aside .agent-card.cta .btn{width:100%}
.agent-card.ok .dot{color:var(--ok);width:9px;height:9px;flex:none}
.agent-live{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;color:var(--ok);white-space:nowrap}
.agent-live::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;box-shadow:0 0 0 3px color-mix(in srgb,var(--ok) 20%,transparent)}

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
  .hide-sm{display:none!important}}
`;

// Soup bowl with steam: the app mark (themed) and the favicon (fixed colors).
const LOGO = `<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><rect x="1" y="1" width="18" height="18" rx="5" fill="var(--ink)"/>
<path d="M4.2 10.4h11.6a5.8 5.8 0 0 1-11.6 0z" fill="var(--on-ink)"/>
<path d="M7.9 8.3c-1-1 1-1.8 0-3M12.1 8.3c-1-1 1-1.8 0-3" stroke="var(--on-ink)" stroke-width="1.3" fill="none" stroke-linecap="round" opacity=".7"/></svg>`;

export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#0a0a0a"/>
<path d="M6.5 16.5h19a9.5 9.5 0 0 1-19 0z" fill="#fafafa"/>
<path d="M12.5 13.2c-1.6-1.6 1.6-2.9 0-4.8M19.5 13.2c-1.6-1.6 1.6-2.9 0-4.8" stroke="#f59e0b" stroke-width="2" fill="none" stroke-linecap="round"/></svg>`;

export interface Viewer {
  name: string;
  email: string;
  display_name: string | null;
  admin: boolean;
  via?: "agent" | "person"; // "agent" when the request came with a personal token (scripts, CLI, other agents)
}

export function page(
  title: string,
  body: string,
  opts: { viewer?: Viewer | null; nav?: "boards" | "admin" | "me" | null; narrow?: boolean; script?: string; status?: number; headers?: HeadersInit } = {},
): Response {
  const v = opts.viewer;
  const link = (href: string, label: string, key: string) => `<a href="${href}"${opts.nav === key ? ' aria-current="page"' : ""}>${label}</a>`;
  const nav = `<header class="nav"><div class="in">
<a class="brand" href="/">${LOGO}<span>Agent Soup</span></a>
${v ? `<nav class="links">${link("/", "Boards", "boards")}</nav>` : ""}
<div class="right">${
    v
      ? `<a href="/me" class="row" title="Account">${avatar(v.name)}<span class="small hide-sm">${esc(v.name)}</span></a>`
      : `<a class="btn sm primary" href="/auth/login">Sign in</a>`
  }</div></div></header>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/favicon.svg">
<style>${CSS}</style></head><body>${nav}
<main${opts.narrow ? ' class="narrow"' : ""}>${body}</main>
<div id="toast" role="status" aria-live="polite"></div>
<script>${CLIENT_JS}${opts.script ?? ""}</script></body></html>`;
  const headers = new Headers(opts.headers);
  headers.set("content-type", "text/html; charset=utf-8");
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
  return `<span class="av ${size}${agent ? " agent" : ""}" style="--h:${hue(name)}" title="${esc(agent ? `${name}'s agent` : name)}">${esc(initials(name))}<img class="av-img" src="${esc(src)}" alt="" loading="lazy" onerror="this.remove()" onload="this.classList.add('ok')"></span>`;
}

export function avatarStack(names: string[], max = 5): string {
  const shown = names.slice(0, max).map((n) => avatar(n, "sm")).join("");
  const more = names.length > max ? `<span class="xs muted" style="margin-left:6px">+${names.length - max}</span>` : "";
  return `<span class="avs">${shown}</span>${more}`;
}

export function typeTag(type: string): string {
  return `<span class="type t-${esc(type)}"><span class="dot"></span><span>${esc(type)}</span></span>`;
}

export function copyField(id: string, text: string): string {
  return `<div class="copy"><pre class="mono" id="${id}">${esc(text)}</pre><button type="button" class="btn sm" data-copy="${id}">Copy</button></div>`;
}

/** Relative time rendered on the server and kept fresh by the client script. */
export function when(ts: number): string {
  return `<time class="when" datetime="${new Date(ts).toISOString()}" data-ts="${ts}" title="${new Date(ts).toUTCString()}">${relTime(ts)}</time>`;
}

export function relTime(ts: number, now = Date.now()): string {
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)}d ago`;
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Small, safe markdown subset for entry bodies: fenced code, inline code, **bold**, http(s) links, paragraphs.
 * Everything is escaped first; only these constructs are turned back into tags.
 */
/** Markdown-ish text to HTML. `mentions` (the entry's stored mentions) are highlighted; other "@x" stays plain. */
export function renderText(text: string, mentions?: Mention[] | null): string {
  const out: string[] = [];
  const parts = text.split(/```[^\n]*\n?([\s\S]*?)```/g);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      out.push(`<pre><code>${esc(part.replace(/\n$/, ""))}</code></pre>`);
      return;
    }
    const paras = part.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    for (const p of paras) out.push(block(p, mentions));
  });
  return out.join("");
}

/** One paragraph-sized block: headings (#–###), bullet and numbered lists, or a paragraph. */
function block(p: string, mentions?: Mention[] | null): string {
  const lines = p.split("\n");
  const out: string[] = [];
  let list: { kind: "ul" | "ol"; items: string[] } | null = null;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join("\n"), mentions)}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.kind}>${list.items.map((i) => `<li>${inline(i, mentions)}</li>`).join("")}</${list.kind}>`);
    list = null;
  };
  for (const line of lines) {
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
  flushPara();
  flushList();
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
        .map((t, j) => highlightMentions(t, mentions) + (j < urls.length ? `<a href="${urls[j]}" target="_blank" rel="noopener noreferrer">${urls[j]}</a>` : ""))
        .join("");
      return h.replace(/\n/g, "<br>");
    })
    .join("");
}

// ---------- client script (shared by every page) ----------

const CLIENT_JS = `
(()=>{
const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)];
window.toast=(m)=>{const t=$('#toast');t.textContent=m;t.classList.add('show');clearTimeout(t._h);t._h=setTimeout(()=>t.classList.remove('show'),1800)};
document.addEventListener('click',e=>{
  const c=e.target.closest('[data-copy]');
  if(c){navigator.clipboard.writeText($('#'+c.dataset.copy).innerText).then(()=>toast('Copied to clipboard'));return}
  const o=e.target.closest('[data-open]');if(o){const d=$('#'+o.dataset.open);d&&d.showModal();const f=d&&d.querySelector('input,textarea');f&&f.focus();return}
  const x=e.target.closest('[data-close]');if(x){x.closest('dialog').close();return}
});
$$('dialog').forEach(d=>d.addEventListener('click',e=>{if(e.target===d)d.close()}));
function rel(ts){const s=Math.max(0,(Date.now()-ts)/1000);if(s<45)return'just now';if(s<3600)return Math.round(s/60)+'m ago';if(s<86400)return Math.round(s/3600)+'h ago';if(s<604800)return Math.round(s/86400)+'d ago';return new Date(ts).toISOString().slice(0,10)}
window.refreshTimes=()=>$$('time[data-ts]').forEach(t=>t.textContent=rel(+t.dataset.ts));setInterval(refreshTimes,30000);
// Forms marked data-api post JSON to their action and show the reply in [data-result].
document.addEventListener('submit',async e=>{
  const f=e.target.closest('form[data-api]');if(!f)return;e.preventDefault();
  const b=f.querySelector('button[type=submit],button:not([type])'),r=f.querySelector('[data-result]');
  b&&(b.disabled=true);
  try{
    const res=await fetch(f.action,{method:f.dataset.method||'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(f)))});
    const j=await res.json().catch(()=>({error:'Request failed ('+res.status+')'}));
    if(f.dataset.done&&res.ok&&window[f.dataset.done]){window[f.dataset.done](j,f)}
    else if(r){r.hidden=false;r.className='flash '+(res.ok?'ok':'err');r.textContent=j.message||j.error||'Done'}
    if(res.ok&&f.dataset.reset!==undefined)f.reset();
  }finally{b&&(b.disabled=false)}
});
})();
`;

// ---------- app shell (signed-in pages) ----------

const ICON = {
  boards: `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="2" y="2" width="5" height="5" rx="1.2"/><rect x="9" y="2" width="5" height="5" rx="1.2"/><rect x="2" y="9" width="5" height="5" rx="1.2"/><rect x="9" y="9" width="5" height="5" rx="1.2"/></svg>`,
  admin: `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M8 1.8l5 2v4c0 3-2.2 5.2-5 6.4C5.2 13 3 10.8 3 7.8v-4z"/></svg>`,
  me: `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="8" cy="5.5" r="2.8"/><path d="M2.8 14c.8-2.6 2.8-4 5.2-4s4.4 1.4 5.2 4"/></svg>`,
  approve: `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M8 1.8l5 2v4c0 3-2.2 5.2-5 6.4C5.2 13 3 10.8 3 7.8v-4z"/><path d="M5.8 8l1.6 1.6 2.9-3"/></svg>`,
  inbox: `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M2 9.5l1.8-6h8.4l1.8 6v3.5H2z"/><path d="M2 9.5h3.5l1 1.5h3l1-1.5H14"/></svg>`,
  search: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>`,
  menu: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M2 4h12M2 8h12M2 12h12"/></svg>`,
  plus: `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>`,
};

export interface SideBoard {
  id: string;
  title: string;
  kind?: string | null; // "direct": a private board between two friends (title "a ↔ b")
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
  },
): Response {
  const v = opts.viewer;
  const cur = (k: string) => (opts.active === k ? ' aria-current="page"' : "");
  const shared = opts.boards.filter((b) => b.kind !== "direct"),
    direct = opts.boards.filter((b) => b.kind === "direct");
  const sideBoards = shared
    .map((b) => `<a class="side-link side-board" href="/b/${esc(b.id)}"${cur(b.id)}><span class="bdot" style="--h:${hue(b.id)}"></span><span class="truncate">${esc(b.title)}</span></a>`)
    .join("");
  // Direct boards read as the person you share them with.
  const sideDirect = direct
    .map((b) => `<a class="side-link side-board" href="/b/${esc(b.id)}"${cur(b.id)}>${avatar(directPeer(b, v.name), "xs")}<span class="truncate">${esc(directPeer(b, v.name))}</span></a>`)
    .join("");
  const paletteItems = [
    ...opts.boards.map((b) => ({ label: b.kind === "direct" ? `${directPeer(b, v.name)} (direct)` : b.title, hint: "Board", href: `/b/${b.id}` })),
    { label: "People and friends", hint: "G P", href: "/people" },
    { label: "New board", hint: "C", href: "/?new=1" },
    { label: "All boards", hint: "G B", href: "/" },
    { label: "Account and agent connections", hint: "G M", href: "/me" },
    { label: "Keyboard shortcuts", hint: "?", href: "#shortcuts" },
  ];
  const body = `<div class="app" id="app">
<aside class="sidebar" aria-label="Navigation">
  <a class="ws" href="/">${LOGO}<span>Agent Soup</span></a>
  <button class="search" type="button" data-palette>${ICON.search}<span>Search or jump to…</span><kbd>⌘K</kbd></button>
  <a class="side-link" href="/inbox"${cur("inbox")}>${ICON.inbox}<span>Inbox</span><span class="count" id="inbox-count" hidden></span></a>
  <a class="side-link" href="/approvals"${cur("approvals")}>${ICON.approve}<span>Approvals</span><span class="count" id="approvals-count" hidden></span></a>
  <a class="side-link" href="/"${cur("boards")}>${ICON.boards}<span>Boards</span></a>
  <a class="side-link" href="/people"${cur("people")}>${ICON.me}<span>People</span></a>
  <div class="side-label"><span>Your boards</span><a href="/?new=1" title="New board (C)" aria-label="New board">${ICON.plus}</a></div>
  ${sideBoards || `<p class="xs faint" style="padding:2px 9px">No boards yet</p>`}
  ${sideDirect ? `<div class="side-label"><span>Direct</span></div>${sideDirect}` : ""}
  <div class="me"><a class="side-link" href="/me">${avatar(v.name, "sm")}<span class="truncate">${esc(v.name)}</span></a>
  <button class="side-link" style="width:100%;border:0;background:none;cursor:pointer;font:inherit" type="button" data-open="shortcuts"><kbd>?</kbd><span>Shortcuts</span></button></div>
</aside>
<div class="grow" style="min-width:0">
  <header class="topbar"><button class="btn ghost sm menu-btn" type="button" data-nav aria-label="Menu">${ICON.menu}</button>
    <nav class="crumbs" aria-label="Breadcrumb">${opts.crumbs}</nav><div class="actions">${opts.actions ?? ""}</div></header>
  <div class="content${opts.narrow ? " narrow" : ""}${opts.full ? " full" : ""}">${opts.body}</div>
</div></div>
<dialog class="palette" id="palette" aria-label="Search">
<div class="pal-in"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/></svg><span class="pal-chips" id="pal-chips"></span><input class="input" id="palette-q" placeholder="Search messages, files, boards and actions…" autocomplete="off" aria-label="Search" aria-controls="palette-list"></div>
<div class="pal-filters" id="pal-filters" aria-label="Filters"></div>
<ul id="palette-list" role="listbox"></ul><div class="foot"><span><kbd>↑</kbd> <kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>⌫</kbd> remove filter</span><span><kbd>esc</kbd> close</span></div></dialog>
<dialog id="shortcuts"><div class="hd"><h2>Keyboard shortcuts</h2><button class="btn ghost sm" data-close aria-label="Close">✕</button></div>
<div class="bd"><dl class="kv">
<dt><kbd>⌘K</kbd> <kbd>/</kbd></dt><dd>Search or jump to a board</dd>
<dt><kbd>C</kbd></dt><dd>New board, or write on the current board</dd>
<dt><kbd>I</kbd></dt><dd>Invite someone to the current board</dd>
<dt><kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> <kbd>4</kbd></dt><dd>Conversation / Log / Files / Tasks</dd>
<dt><kbd>↵</kbd> · <kbd>⇧</kbd> <kbd>↵</kbd></dt><dd>Post · new line</dd>
<dt><kbd>⌘F</kbd></dt><dd>Search this board's messages</dd>
<dt><kbd>@</kbd></dt><dd>Mention a person or their agent</dd>
<dt><kbd>J</kbd> <kbd>K</kbd></dt><dd>Move down / up through entries</dd>
<dt><kbd>↵</kbd></dt><dd>Open the selected entry's details</dd>
<dt><kbd>G</kbd> then <kbd>B</kbd> <kbd>P</kbd> <kbd>M</kbd></dt><dd>Go to Boards / People / Account</dd>
<dt><kbd>?</kbd></dt><dd>This list</dd></dl></div></dialog>
<script>window.PALETTE=${JSON.stringify(paletteItems).replace(/</g, "\\u003c")};${v.admin ? "window.OPS=1;" : ""}</script>`;
  return rawPage(title, body, (opts.script ?? "") + SHELL_JS + INBOX_JS, opts.status);
}

// Inbox badge on every signed-in page: checks on load, when the tab comes back, and every minute. With permission,
// a new item also shows a browser notification (once per item, across tabs).
const INBOX_JS = `
(()=>{const el=document.getElementById('inbox-count');if(!el)return;const base=document.title;
let seen=0;try{seen=+localStorage.getItem('inbox-seen')||0}catch{}
window.inboxRefresh=async()=>{try{const r=await fetch('/api/inbox/count');if(!r.ok)return;const j=await r.json();
  el.hidden=!j.unread;el.textContent=j.unread>99?'99+':String(j.unread);document.title=(j.unread?'('+j.unread+') ':'')+base;
  const ap=document.getElementById('approvals-count');if(ap){ap.hidden=!j.approvals;ap.textContent=String(j.approvals||'')}
  const l=j.latest;if(l&&l.created_at>seen){if(seen&&'Notification' in window&&Notification.permission==='granted'&&!(document.visibilityState==='visible'&&location.pathname==='/b/'+l.board_id)){
    const ap=l.kind==='approval',who=ap?'Your agent':l.actor_via==='agent'?l.actor+"'s agent":l.actor;
    const n=new Notification(who+(ap?' is asking for your approval':l.kind==='mention'?' mentioned you':l.kind==='reply'?' replied to you':l.kind==='friend_request'?' wants to be friends':l.kind==='friend_accept'?' accepted your request':' wrote to your agent'),{body:l.excerpt,tag:'inbox-'+l.id});
    n.onclick=()=>{window.focus();location.href=ap?'/approvals':l.board_id?'/b/'+l.board_id+'#e'+l.seq:'/people'}}
  seen=l.created_at;try{localStorage.setItem('inbox-seen',String(seen))}catch{}}}catch{}};
inboxRefresh();setInterval(inboxRefresh,60000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)inboxRefresh()})})();`;

function rawPage(title: string, body: string, script: string, status = 200): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/favicon.svg">
<style>${CSS}</style></head><body>${body}
<div id="toast" role="status" aria-live="polite"></div>
<script>${CLIENT_JS}${script}</script></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

const SHELL_JS = `
(()=>{
const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)];
// Search (⌘K everywhere; ⌘F on a board starts with "This board · Messages"): filters show up front like VS Code or Lark,
// and become chips; results mix boards and actions with ranked messages and files (this board, or all your boards).
const pal=$('#palette'),q=$('#palette-q'),list=$('#palette-list'),pChips=$('#pal-chips'),pFilt=$('#pal-filters');
let sel=0,items=[],chips=[],mode=null,run=0,timer=null;
const B=()=>window.BOARD_CTX||null; // on a board page: {id, me, members, jump(seq), openFile(name, version)}
const KINDS=[['messages','Messages'],['files','Files'],['boards','Boards'],['actions','Actions']],TYPES=['question','task','decision','claim','note','change','artifact'];
const h=x=>String(x==null?'':x).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const has=(k,v)=>chips.some(c=>c.k===k&&(v==null||c.v===v)),chip=k=>chips.find(c=>c.k===k);
const who=(u,agent)=>{const me=B()&&B().me;return u===me?(agent?'your agent':'you'):(agent?u+"'s agent":u)};
const label=c=>c.k==='board'?'This board':c.k==='kind'?KINDS.find(k=>k[0]===c.v)[1]:c.k==='type'?'type: '+c.v:'from '+who(c.v,c.agent);
function paintChips(){pChips.innerHTML=chips.map((c,i)=>'<span class="pal-chip">'+h(label(c))+'<button type="button" data-pchip="'+i+'" aria-label="Remove '+h(label(c))+'">✕</button></span>').join('');
  const o=[];if(B()&&!has('board'))o.push(['board','','This board']);if(!has('kind'))KINDS.forEach(([v,l])=>o.push(['kind',v,l]));
  if(B()&&!has('from'))o.push(['from','','From…']);if(!has('type'))o.push(['type','','Type…']);
  pFilt.innerHTML=o.map(x=>'<button type="button" class="pal-opt" data-popt="'+x[0]+'" data-v="'+x[1]+'">'+h(x[2])+'</button>').join('');pFilt.hidden=!o.length}
function paint(rows){items=rows;sel=Math.min(sel,Math.max(0,rows.length-1));let g='';
  list.innerHTML=rows.map((r,n)=>(r.g!==g?'<li class="pal-g" aria-hidden="true">'+(g=r.g)+'</li>':'')+'<li role="option" data-n="'+n+'" id="po-'+n+'" aria-selected="'+(n===sel)+'"><span class="pal-l">'+r.label+'</span><span class="k">'+h(r.hint||'')+'</span></li>').join('')||'<li class="faint pal-none">'+(q.value.trim()?'No matches':'Type to search')+'</li>';
  q.setAttribute('aria-activedescendant',rows.length?'po-'+sel:'')}
function pickList(){const t=q.value.trim().replace(/^@/,'').toLowerCase();
  const rows=mode==='from'?(B()?B().members:[]).flatMap(u=>[{u,agent:false},{u,agent:true}]).filter(x=>x.u.startsWith(t)).map(x=>({g:'From',label:h(who(x.u,x.agent)),pick:{k:'from',v:x.u,agent:x.agent}}))
    :TYPES.filter(x=>x.startsWith(t)).map(x=>({g:'Type',label:h(x),pick:{k:'type',v:x}}));paint(rows)}
const snip=x=>h(x||'').split('«').join('<mark>').split('»').join('</mark>');
function render(){const my=++run;if(mode){pickList();return}const t=q.value.trim(),kind=chip('kind')&&chip('kind').v,b=B(),scoped=b&&(has('board')||has('from')||has('type'));
  const rows=[];
  if((!kind||kind==='boards'||kind==='actions')&&!scoped&&!has('from')&&!has('type'))
    PALETTE.filter(i=>!t||i.label.toLowerCase().includes(t.toLowerCase())).filter(i=>!kind||(kind==='boards')===(i.hint==='Board')).slice(0,t?8:6)
      .forEach(i=>rows.push({g:i.hint==='Board'?'Boards':'Actions',label:h(i.label),hint:i.hint==='Board'?'':i.hint,href:i.href}));
  paint(rows);
  if(kind==='boards'||kind==='actions'||(!t&&!has('from')&&!has('type')))return;
  clearTimeout(timer);timer=setTimeout(async()=>{const more=[];
    try{if(scoped){const p=new URLSearchParams({q:t});const f=chip('from');if(f){p.set('from',f.v);p.set('agent',f.agent?'1':'0')}if(chip('type'))p.set('type',chip('type').v);if(kind==='messages')p.set('in','chat');
        const j=await (await fetch('/api/boards/'+b.id+'/search?'+p)).json();
        if(kind!=='files')(j.entries||[]).forEach(x=>more.push({g:'Messages',label:(x.title?'<b>'+h(x.title)+'</b> ':'')+snip(x.snippet),hint:who(x.author,x.via==='agent')+' · #'+x.seq,act:()=>b.jump(x.seq)}));
        if(kind!=='messages')(j.files||[]).forEach(x=>more.push({g:'Files',label:'<span class="mono">'+h(x.name)+'</span> '+snip(x.snippet),hint:'v'+x.version,act:()=>b.openFile(x.name,x.version)}))}
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
document.addEventListener('click',e=>{if(e.target.closest('[data-palette]'))openPalette();if(e.target.closest('[data-nav]'))$('#app').classList.toggle('nav-open')});
let g=false,gt;
document.addEventListener('keydown',e=>{
  if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();pal.open?pal.close():openPalette();return}
  const t=e.target;if(e.metaKey||e.ctrlKey||e.altKey||t.closest('input,textarea,select,[contenteditable]')||$('dialog[open]'))return;
  const k=e.key.toLowerCase();
  if(g){g=false;clearTimeout(gt);const to={b:'/',m:'/me',p:'/people',o:window.OPS?'/_ops':null}[k];if(to){location.href=to;e.preventDefault()}return}
  if(k==='g'){g=true;gt=setTimeout(()=>g=false,900);return}
  if(k==='/'){e.preventDefault();openPalette();return}
  if(e.key==='?'){$('#shortcuts').showModal();return}
  if(k==='c'){const c=$('#composer-text');if(c){e.preventDefault();c.focus();return}const n=$('#new-board');if(n){e.preventDefault();n.showModal();$('#title')?.focus()}return}
  if(k==='i'){const d=$('#invite');if(d){e.preventDefault();d.showModal();$('#inv-email')?.focus()}return}
  if(window.boardKeys)window.boardKeys(e,k);
});
if(new URLSearchParams(location.search).get('new')==='1'){const n=$('#new-board');n&&n.showModal()}
})();
`;
