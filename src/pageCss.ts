// Page-specific stylesheets for the public pages (SITE_CSS), Guide, Ask and Docs. For you keeps its nonced inline sheet (web-budget).
export const GUIDE_CSS = `
.gd-q{display:block;width:100%;height:42px;margin:0 0 8px;padding:0 16px;border:1px solid var(--st-line);border-radius:999px;background:transparent;color:var(--st-ink);font:15px var(--font-ui)}
.gd-q::placeholder{color:var(--st-muted)}
.gd-q:focus{outline:none;border-color:var(--st-ink)}
.gd-sec,.gd-item{scroll-margin-top:24px}
.gd-label{margin:48px 0 -20px;font-size:13px;font-weight:600;color:var(--st-muted)}
.gd-doc.one .gd-label{display:none}
.gd-item h2 a{margin-inline-start:10px;font:400 18px var(--font-ui);color:var(--st-muted);text-decoration:none;opacity:0}
.gd-item:hover h2 a,.gd-item h2 a:focus{opacity:1}
.gd-pager{display:flex;gap:24px;margin-top:56px;padding-top:20px;border-top:1px solid var(--st-line)}
.gd-doc:not(.one) .gd-pager{display:none}
.st-doc .gd-pager a{display:flex;flex-direction:column;gap:2px;max-width:48%;color:var(--st-ink);font-size:16px;font-weight:500;text-decoration:none}
.gd-pager a span{font-size:13px;font-weight:400;color:var(--st-muted)}
.gd-pager a:hover span{color:var(--st-ink)}
.st-doc .gd-pager .next{margin-inline-start:auto;text-align:end}

.st-doc .gd-agents{margin:40px 0 0;font-size:14px;color:var(--st-muted)}
`;

export const ASK_CSS = `
.ask{display:flex;flex-direction:column;align-items:center;text-align:center;max-width:520px;margin:0 auto;padding:8px 0 24px}
.ask-who{display:flex;align-items:center;gap:7px;font-size:14px;color:var(--muted)}
.ask-mic{position:relative;width:200px;height:200px;margin:22px 0 8px;border:0;background:none;cursor:pointer;border-radius:50%;color:var(--on-fill)}
.ask-mic::before,.ask-mic::after{content:"";position:absolute;inset:0;border-radius:50%;background:var(--cta);opacity:.08;transition:transform .3s}
.ask-mic::after{inset:18px;opacity:.14}
.ask-mic .core{position:absolute;inset:44px;border-radius:50%;background:var(--cta);display:flex;align-items:center;justify-content:center;box-shadow:0 8px 28px color-mix(in srgb,var(--cta) 35%,transparent);transition:transform .15s}
.ask-mic:hover .core{transform:scale(1.03)}.ask-mic:focus-visible{outline:2px solid var(--accent);outline-offset:4px}
.ask.listening .ask-mic::before{animation:askPulse 1.6s ease-in-out infinite}.ask.listening .ask-mic::after{animation:askPulse 1.6s ease-in-out .3s infinite}
@keyframes askPulse{50%{transform:scale(1.08)}}
.ask-wave{display:flex;gap:4px;align-items:center;height:22px;visibility:hidden}.ask.listening .ask-wave{visibility:visible}
.ask-wave i{width:4px;border-radius:2px;background:var(--cta);height:6px;animation:askWave 1s ease-in-out infinite}
.ask-wave i:nth-child(2n){animation-delay:.15s}.ask-wave i:nth-child(3n){animation-delay:.3s}.ask-wave i:nth-child(5n){animation-delay:.45s}
@keyframes askWave{50%{height:20px}}
@media (prefers-reduced-motion:reduce){.ask-mic::before,.ask-mic::after,.ask-wave i{animation:none!important}}
.ask-said{font-size:26px;line-height:1.25;font-weight:600;color:var(--ink);margin:14px 0 0;min-height:1.25em;overflow-wrap:anywhere;letter-spacing:-.01em}
.ask-said .mid{color:var(--faint)}
.ask-status{font-size:14px;color:var(--muted);margin-top:10px;min-height:1.4em}
.ask-answer{width:100%;text-align:left;margin-top:18px}.ask-answer .card{padding:14px 16px}
.ask-answer .hd{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted);margin-bottom:6px}.ask-answer .hd .grow{flex:1}
.ask-answer .tx{font-size:15.5px;line-height:1.5;color:var(--text);white-space:pre-wrap;overflow-wrap:anywhere}
.ask-type{display:flex;gap:8px;width:100%;margin-top:18px}.ask-type .input{flex:1;height:44px;font-size:16px}
.ask-try{width:100%;text-align:left;margin-top:26px}.ask-try h2{font-size:13.5px;font-weight:500;color:var(--muted);margin:0 2px 8px}
.ask-s{display:flex;align-items:center;gap:12px;width:100%;min-height:48px;padding:10px 14px;margin-bottom:8px;border:1px solid var(--line);border-radius:12px;background:var(--bg);color:var(--ink);font:inherit;font-size:15px;text-align:left;cursor:pointer}
.ask-s:hover{background:var(--bg-hover)}.ask-s svg{flex:none;color:var(--muted)}
.ask-foot{margin-top:18px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap}
.ask.typing .ask-mic,.ask.typing .ask-wave{display:none}
@media (max-width:600px){.ask-mic{width:170px;height:170px;margin-top:10px}.ask-mic .core{inset:38px}.ask-said{font-size:23px}}
`;

export const DOC_CSS = `
.dx .tool{scroll-margin-top:24px}
.st-doc .tool h3{margin:28px 0 6px;font:600 17px/1.4 var(--font-ui);color:var(--st-ink)}
.st-doc .tool p{margin:0}
.dx-on{position:sticky;top:24px;font-size:13px}
.dx-on .st-group{font-size:13px}
.dx-on li a{padding:3px 0}
@media (min-width:861px) and (max-width:1100px){.st-cols.dx{grid-template-columns:200px minmax(0,1fr)}.dx-on{display:none}}
`;

// The public pages' frame and type (board #5110): /guide, /docs, /privacy and /terms (the landing Worker serves /faq and
// /support with the same top bar and footer). Warm paper, ink, hairlines; STIX Two for the wordmark and headings, Onest
// for the rest. Side navs fold into a Contents dropdown on a phone and the top bar's links into a menu, both <details>.
export const SITE_CSS = `
:root{--st-bg:#F5F2EC;--st-ink:#0E0E0E;--st-text:#3A3936;--st-muted:#5A5853;--st-line:#DDD8CE;--st-pill:#CFC9BE;--st-code-bg:#1A1A19;--st-code:#EDEAE3;--st-code-line:#3A3935}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--st-bg:#0E0E0E;--st-ink:#FAFAF7;--st-text:#D6D3CB;--st-muted:#A9A69F;--st-line:#2A2926;--st-pill:#3A3935;--st-code-bg:#1A1918;--st-code:#EDEAE3;--st-code-line:#3A3935}}
:root[data-theme="dark"]{--st-bg:#0E0E0E;--st-ink:#FAFAF7;--st-text:#D6D3CB;--st-muted:#A9A69F;--st-line:#2A2926;--st-pill:#3A3935;--st-code-bg:#1A1918;--st-code:#EDEAE3;--st-code-line:#3A3935}
body.site{display:flex;flex-direction:column;min-height:100vh;background:var(--st-bg);color:var(--st-text);font:16px/1.65 var(--font-ui)}
.st-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.st-bar{border-bottom:1px solid var(--st-line)}
.st-bar .st-in{display:flex;align-items:center;gap:28px;padding:20px 40px}
.st-wm{margin-inline-end:auto;font:600 22px/1 var(--font-head);color:var(--st-ink);letter-spacing:-.01em}
.st-links{display:flex;gap:24px;font-size:14px;line-height:1.2;color:var(--st-muted)}
.st-links a:hover,.st-foot a:hover{color:var(--st-ink)}
.st-links a[aria-current="page"]{color:var(--st-ink);font-weight:500}
.st-pill{padding:6px 14px;border:1px solid var(--st-pill);border-radius:999px;font-size:14px;line-height:1.2;color:var(--st-ink);white-space:nowrap}
.st-pill:hover{border-color:var(--st-ink)}
.st-menu{display:none;position:relative}
.st-menu>summary{display:flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:8px;color:var(--st-ink);cursor:pointer;list-style:none}
.st-menu>summary::-webkit-details-marker{display:none}
.st-menu nav{position:absolute;z-index:10;top:calc(100% + 8px);inset-inline-end:0;display:flex;flex-direction:column;min-width:200px;padding:6px;border:1px solid var(--st-line);border-radius:10px;background:var(--st-bg);box-shadow:var(--shadow-lg)}
.st-menu nav a{padding:10px 12px;border-radius:6px;font-size:15px;color:var(--st-muted)}
.st-menu nav a[aria-current="page"]{color:var(--st-ink);font-weight:500}
.site main.st-main{flex:1;width:100%;max-width:none;margin:0;padding:56px 40px 0}
.st-foot{margin-top:80px;border-top:1px solid var(--st-line)}
.st-foot .st-in{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px 24px;padding:24px 40px;font-size:13px;color:var(--st-muted)}
.st-foot nav{display:flex;gap:20px}
.st-foot a[aria-current="page"]{color:var(--st-ink)}
.st-cols{display:grid;grid-template-columns:220px minmax(0,640px);gap:72px;justify-content:center;align-items:start}
.st-cols.gd{grid-template-columns:220px minmax(0,620px)}
.st-cols.dx{grid-template-columns:200px minmax(0,700px) 160px;gap:56px}
.st-side{position:sticky;top:24px;max-height:calc(100vh - 48px);overflow:auto;font-size:14px;line-height:1.4}
.st-group{display:block;margin:0 0 8px;font-size:14px;font-weight:600;color:var(--st-ink)}
.st-nav ul,.st-nav ol{margin:0 0 24px;padding:0;list-style:none}
.st-nav li a{display:block;padding:4px 0;color:var(--st-muted)}
.st-nav a:hover,.st-nav a[aria-current]{color:var(--st-ink)}
.st-toc{display:none}
.st-toc .privacy .st-group,.st-toc .terms .st-group{display:none}
.st-doc .st-nav ul,.st-doc .st-nav ol{margin:0 0 16px;padding:0}
.st-doc .st-nav li{margin:0;padding:0;font-size:15px;line-height:1.4}
.st-doc .st-nav a{color:var(--st-muted);text-decoration:none}
.st-doc .st-nav a:hover,.st-doc .st-nav a[aria-current]{color:var(--st-ink)}
.st-doc{min-width:0}
.st-doc h1{margin:0 0 16px;font:400 44px/1.15 var(--font-head);color:var(--st-ink);letter-spacing:-.015em}
.st-doc h2{margin:48px 0 12px;font:400 26px/1.25 var(--font-head);color:var(--st-ink);letter-spacing:-.01em;scroll-margin-top:24px}
.st-doc p,.st-doc li{font-size:16px;line-height:1.65;color:var(--st-text)}
.st-doc p{margin:0 0 16px}
.st-doc ul,.st-doc ol{margin:0 0 16px;padding-inline-start:22px}
.st-doc li{margin:0 0 8px;padding-inline-start:4px}
.st-doc a{color:var(--st-ink);text-decoration:underline;text-decoration-color:var(--st-pill);text-decoration-thickness:1px;text-underline-offset:3px}
.st-doc a:hover{text-decoration-color:var(--st-ink)}
.st-doc b,.st-doc strong{font-weight:600;color:var(--st-ink)}
.st-doc code{padding:1px 5px;border:1px solid var(--st-line);border-radius:5px;font-size:14px;color:var(--st-ink)}
.st-crumb{margin:0 0 12px;font-size:13px;color:var(--st-muted)}
.st-crumb a{color:inherit;text-decoration:none}
.st-doc .st-lead{margin:0 0 32px;font-size:17px}
.st-doc .st-updated{margin:-4px 0 8px;font-size:14px;color:var(--st-muted)}
.st-code{position:relative;margin:20px 0}
.st-code pre{margin:0;padding:16px 18px;overflow:auto;border-radius:8px;background:var(--st-code-bg);color:var(--st-code);font:14px/1.6 var(--font-mono)}
.st-code pre code{padding:0;border:0;color:inherit;font:inherit}
.st-code button{position:absolute;top:10px;inset-inline-end:10px;padding:4px 10px;border:1px solid var(--st-code-line);border-radius:999px;background:var(--st-code-bg);color:var(--st-code);font:500 12px/1.3 var(--font-ui);cursor:pointer}
.st-legal.terms{counter-reset:sec}
.st-legal.terms h2{counter-increment:sec}
.st-legal.terms h2::before,.st-nav.terms li a::before{content:counter(sec) ". "}
.st-nav.terms ol{counter-reset:sec}
.st-nav.terms li{counter-increment:sec}
@media (max-width:860px){
  .st-bar .st-in{gap:12px;padding:14px 16px}
  .st-links{display:none}
  .st-menu{display:block}
  .site main.st-main{padding:28px 16px 0}
  .st-cols,.st-cols.gd,.st-cols.dx{grid-template-columns:minmax(0,1fr);gap:0}
  .st-side,.dx-on{display:none}
  .st-toc{display:block;margin:0 0 28px;border:1px solid var(--st-line);border-radius:10px}
  .st-toc>summary{padding:12px 16px;font-size:15px;font-weight:500;color:var(--st-ink);cursor:pointer}
  .st-toc .st-nav{padding:4px 16px 0;font-size:15px}
  .st-toc .st-nav li a{padding:7px 0}
  .st-doc h1{font-size:34px}
  .st-doc h2{margin-top:40px;font-size:24px}
  .st-foot{margin-top:56px}
  .st-foot .st-in{padding:20px 16px}
}
`;
