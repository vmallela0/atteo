// Design system: tokens, base styles, components and the shared client script.
// Minimal and quiet (in the spirit of Vercel Geist / Linear): neutral grays, one ink color for primary actions,
// hairline borders, Geist type, light + dark, works down to phone width.

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

/* surfaces */
.card{border:1px solid var(--line);border-radius:var(--r);background:var(--bg);box-shadow:var(--shadow)}
.card.pad{padding:20px}
.section-title{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 14px}
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
.av.sm{width:22px;height:22px;font-size:10px}.av.lg{width:40px;height:40px;font-size:15px}
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
.copy pre{margin:0;padding:12px 84px 12px 14px;white-space:pre-wrap;word-break:break-all;line-height:1.55;color:var(--ink)}
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
.entry .body pre{background:var(--bg-subtle);border:1px solid var(--line);border-radius:8px;padding:10px 12px;overflow-x:auto;margin:8px 0;white-space:pre}
.entry .body code{background:var(--bg-hover);padding:1px 5px;border-radius:4px}
.entry .body pre code{background:none;padding:0}
.entry .body a{color:var(--accent)}
.entry .refs{margin-top:6px;font-size:12.5px;color:var(--faint)}
.entry .refs a:hover{color:var(--ink)}
.entry.flash-in{animation:flashin 1.6s ease-out}
.entry .rbadge{display:none;height:18px;font-size:11px}
.entry.retracted>.grow>.body,.entry.retracted>.grow>.file{text-decoration:line-through;text-decoration-color:var(--faint);opacity:.55}
.entry.retracted>.grow>.meta .rbadge{display:inline-flex}
.entry .retract{margin-left:auto;opacity:0;transition:opacity .12s}
.entry:hover .retract,.entry .retract:focus-visible,.entry .retract.danger{opacity:1}
@keyframes flashin{from{background:color-mix(in srgb,var(--accent) 9%,transparent)}to{background:transparent}}
.entry:target{background:color-mix(in srgb,var(--accent) 6%,transparent);border-radius:8px}
.replies{margin:10px 0 0;padding-left:14px;border-left:2px solid var(--line)}
.replies:empty{display:none}
.replies .entry{border-top:0;padding:10px 0 0}
.file{margin-top:8px;border:1px solid var(--line);border-radius:8px;overflow:hidden}
.file .fh{display:flex;align-items:center;gap:10px;padding:9px 12px;background:var(--bg-subtle)}
.file pre{margin:0;max-height:420px;overflow:auto;padding:12px;border-top:1px solid var(--line);white-space:pre;font-size:12px}
.sum h3{font-size:12px;font-weight:500;color:var(--muted);text-transform:none;margin:22px 0 8px;display:flex;justify-content:space-between}
.sum h3:first-child{margin-top:0}
.sum ul{list-style:none;margin:0;padding:0}
.sum li a{display:flex;gap:8px;padding:6px 8px;margin:0 -8px;border-radius:6px;font-size:13px;line-height:1.45}
.sum li a:hover{background:var(--bg-hover)}
.sum li .n{color:var(--faint);flex:none;font-variant-numeric:tabular-nums}
.sum .none{font-size:13px;color:var(--faint)}
.waiting{border:1px solid color-mix(in srgb,var(--q) 40%,var(--line));background:color-mix(in srgb,var(--q) 6%,var(--bg));border-radius:var(--r-sm);padding:10px 12px;margin-bottom:6px}
.composer{margin-top:20px}
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
@media(max-width:860px){.app{grid-template-columns:1fr}.sidebar{position:fixed;inset:0 auto 0 0;width:260px;z-index:40;transform:translateX(-100%);transition:transform .2s;box-shadow:var(--shadow-lg)}
  .app.nav-open .sidebar{transform:none}.menu-btn{display:inline-flex}.content{padding:20px 16px 80px}.topbar{padding:0 12px}}
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
.palette input{border:0;border-bottom:1px solid var(--line);border-radius:0;height:48px;padding:0 16px;font-size:15px;box-shadow:none!important}
.palette ul{list-style:none;margin:0;padding:6px;max-height:50vh;overflow:auto}
.palette li{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:7px;cursor:pointer;font-size:13.5px;color:var(--text)}
.palette li[aria-selected=true]{background:var(--bg-hover);color:var(--ink)}
.palette li .k{margin-left:auto;color:var(--faint);font-size:12px}
.palette .foot{display:flex;gap:14px;padding:8px 14px;border-top:1px solid var(--line);font-size:12px;color:var(--faint)}
.entry.sel{background:var(--bg-subtle);box-shadow:-12px 0 0 var(--bg-subtle),12px 0 0 var(--bg-subtle)}

/* landing */
.hero{text-align:center;padding:64px 0 40px}
.hero h1{font-size:clamp(34px,6vw,56px);letter-spacing:-.045em;line-height:1.05;margin:18px auto 16px;max-width:760px}
.hero p.lead{font-size:17px;color:var(--muted);max-width:560px;margin:0 auto 28px}
.preview{max-width:760px;margin:24px auto 0;text-align:left;padding:8px 24px 16px}
.steps{display:grid;gap:16px;margin-top:72px}
@media(min-width:760px){.steps{grid-template-columns:repeat(3,1fr)}}
.steps .card{padding:20px}.steps .k{font-size:12px;color:var(--faint);margin-bottom:10px}
.stat{font-size:28px;font-weight:600;letter-spacing:-.03em;color:var(--ink)}
.grid4{display:grid;gap:12px;grid-template-columns:repeat(2,1fr)}@media(min-width:760px){.grid4{grid-template-columns:repeat(4,1fr)}}
.footer{max-width:1180px;margin:0 auto;padding:24px 20px 40px;color:var(--faint);font-size:12.5px;border-top:1px solid var(--line)}
@media(max-width:640px){main{padding:28px 16px 80px}.nav .in{padding:0 16px}.nav .links{display:none}h1{font-size:24px}.list .item{padding:12px 14px}
  .hide-sm{display:none!important}}
`;

const LOGO = `<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><rect x="1" y="1" width="18" height="18" rx="5" fill="var(--ink)"/>
<circle cx="7" cy="10" r="2.2" fill="var(--on-ink)"/><circle cx="13" cy="10" r="2.2" fill="var(--on-ink)" opacity=".55"/></svg>`;

export interface Viewer {
  name: string;
  email: string;
  display_name: string | null;
  admin: boolean;
}

export function page(
  title: string,
  body: string,
  opts: { viewer?: Viewer | null; nav?: "boards" | "admin" | "me" | null; narrow?: boolean; script?: string; status?: number; headers?: HeadersInit } = {},
): Response {
  const v = opts.viewer;
  const link = (href: string, label: string, key: string) => `<a href="${href}"${opts.nav === key ? ' aria-current="page"' : ""}>${label}</a>`;
  const nav = `<header class="nav"><div class="in">
<a class="brand" href="/">${LOGO}<span>Agent Board</span></a>
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
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(LOGO.replace(/var\(--ink\)/g, "#0a0a0a").replace(/var\(--on-ink\)/g, "#fff"))}">
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

export function avatar(name: string, size: "" | "sm" | "lg" = ""): string {
  return `<span class="av ${size}" style="--h:${hue(name)}" title="${esc(name)}">${esc(initials(name))}</span>`;
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
export function renderText(text: string): string {
  const out: string[] = [];
  const parts = text.split(/```[^\n]*\n?([\s\S]*?)```/g);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      out.push(`<pre><code>${esc(part.replace(/\n$/, ""))}</code></pre>`);
      return;
    }
    const paras = part.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    for (const p of paras) out.push(`<p>${inline(p)}</p>`);
  });
  return out.join("");
}

function inline(s: string): string {
  const chunks = s.split(/(`[^`\n]+`)/g);
  return chunks
    .map((c, i) => {
      if (i % 2 === 1) return `<code>${esc(c.slice(1, -1))}</code>`;
      let h = esc(c);
      h = h.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
      h = h.replace(/\bhttps?:\/\/[^\s<>"')]+[^\s<>"').,;:!?]/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
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
  search: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>`,
  menu: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M2 4h12M2 8h12M2 12h12"/></svg>`,
  plus: `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>`,
};

export interface SideBoard {
  id: string;
  title: string;
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
    status?: number;
  },
): Response {
  const v = opts.viewer;
  const cur = (k: string) => (opts.active === k ? ' aria-current="page"' : "");
  const sideBoards = opts.boards
    .map((b) => `<a class="side-link side-board" href="/b/${esc(b.id)}"${cur(b.id)}><span class="bdot" style="--h:${hue(b.id)}"></span><span class="truncate">${esc(b.title)}</span></a>`)
    .join("");
  const paletteItems = [
    ...opts.boards.map((b) => ({ label: b.title, hint: "Board", href: `/b/${b.id}` })),
    { label: "New board", hint: "C", href: "/?new=1" },
    { label: "All boards", hint: "G B", href: "/" },
    { label: "Account and agent connections", hint: "G M", href: "/me" },
    { label: "Keyboard shortcuts", hint: "?", href: "#shortcuts" },
  ];
  const body = `<div class="app" id="app">
<aside class="sidebar" aria-label="Navigation">
  <a class="ws" href="/">${LOGO}<span>Agent Board</span></a>
  <button class="search" type="button" data-palette>${ICON.search}<span>Search or jump to…</span><kbd>⌘K</kbd></button>
  <a class="side-link" href="/"${cur("boards")}>${ICON.boards}<span>Boards</span></a>
  <a class="side-link" href="/me"${cur("me")}>${ICON.me}<span>Account</span></a>
  <div class="side-label"><span>Your boards</span><a href="/?new=1" title="New board (C)" aria-label="New board">${ICON.plus}</a></div>
  ${sideBoards || `<p class="xs faint" style="padding:2px 9px">No boards yet</p>`}
  <div class="me"><a class="side-link" href="/me">${avatar(v.name, "sm")}<span class="truncate">${esc(v.name)}</span></a>
  <button class="side-link" style="width:100%;border:0;background:none;cursor:pointer;font:inherit" type="button" data-open="shortcuts"><kbd>?</kbd><span>Shortcuts</span></button></div>
</aside>
<div class="grow" style="min-width:0">
  <header class="topbar"><button class="btn ghost sm menu-btn" type="button" data-nav aria-label="Menu">${ICON.menu}</button>
    <nav class="crumbs" aria-label="Breadcrumb">${opts.crumbs}</nav><div class="actions">${opts.actions ?? ""}</div></header>
  <div class="content${opts.narrow ? " narrow" : ""}">${opts.body}</div>
</div></div>
<dialog class="palette" id="palette" aria-label="Command palette"><input class="input" id="palette-q" placeholder="Search boards and actions…" autocomplete="off">
<ul id="palette-list" role="listbox"></ul><div class="foot"><span><kbd>↑</kbd> <kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span></div></dialog>
<dialog id="shortcuts"><div class="hd"><h2>Keyboard shortcuts</h2><button class="btn ghost sm" data-close aria-label="Close">✕</button></div>
<div class="bd"><dl class="kv">
<dt><kbd>⌘K</kbd> <kbd>/</kbd></dt><dd>Search or jump to a board</dd>
<dt><kbd>C</kbd></dt><dd>New board, or write on the current board</dd>
<dt><kbd>I</kbd></dt><dd>Invite someone to the current board</dd>
<dt><kbd>1</kbd> <kbd>2</kbd></dt><dd>Conversation / Log</dd>
<dt><kbd>J</kbd> <kbd>K</kbd></dt><dd>Move down / up through entries</dd>
<dt><kbd>↵</kbd></dt><dd>Open the selected entry's details</dd>
<dt><kbd>G</kbd> then <kbd>B</kbd> <kbd>M</kbd></dt><dd>Go to Boards / Account</dd>
<dt><kbd>?</kbd></dt><dd>This list</dd></dl></div></dialog>
<script>window.PALETTE=${JSON.stringify(paletteItems).replace(/</g, "\\u003c")};${v.admin ? "window.OPS=1;" : ""}</script>`;
  return rawPage(title, body, (opts.script ?? "") + SHELL_JS, opts.status);
}

function rawPage(title: string, body: string, script: string, status = 200): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(LOGO.replace(/var\(--ink\)/g, "#0a0a0a").replace(/var\(--on-ink\)/g, "#fff"))}">
<style>${CSS}</style></head><body>${body}
<div id="toast" role="status" aria-live="polite"></div>
<script>${CLIENT_JS}${script}</script></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

const SHELL_JS = `
(()=>{
const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)];
const pal=$('#palette'),q=$('#palette-q'),list=$('#palette-list');let sel=0,items=[];
function render(){const t=q.value.toLowerCase().trim();items=PALETTE.filter(i=>!t||i.label.toLowerCase().includes(t));sel=Math.min(sel,Math.max(0,items.length-1));
  list.innerHTML=items.map((i,n)=>'<li role="option" data-n="'+n+'" aria-selected="'+(n===sel)+'"><span class="truncate">'+i.label.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))+'</span><span class="k">'+i.hint+'</span></li>').join('')||'<li class="faint">No matches</li>'}
function go(i){if(!i)return;pal.close();if(i.href==='#shortcuts'){$('#shortcuts').showModal();return}location.href=i.href}
window.openPalette=()=>{q.value='';sel=0;render();pal.showModal();q.focus()};
q.addEventListener('input',()=>{sel=0;render()});
q.addEventListener('keydown',e=>{if(e.key==='ArrowDown'){sel=Math.min(sel+1,items.length-1);render();e.preventDefault()}
  else if(e.key==='ArrowUp'){sel=Math.max(sel-1,0);render();e.preventDefault()}else if(e.key==='Enter'){go(items[sel]);e.preventDefault()}});
list.addEventListener('click',e=>{const li=e.target.closest('[data-n]');li&&go(items[+li.dataset.n])});
document.addEventListener('click',e=>{if(e.target.closest('[data-palette]'))openPalette();if(e.target.closest('[data-nav]'))$('#app').classList.toggle('nav-open')});
let g=false,gt;
document.addEventListener('keydown',e=>{
  if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();pal.open?pal.close():openPalette();return}
  const t=e.target;if(e.metaKey||e.ctrlKey||e.altKey||t.closest('input,textarea,select,[contenteditable]')||$('dialog[open]'))return;
  const k=e.key.toLowerCase();
  if(g){g=false;clearTimeout(gt);const to={b:'/',m:'/me',o:window.OPS?'/_ops':null}[k];if(to){location.href=to;e.preventDefault()}return}
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
