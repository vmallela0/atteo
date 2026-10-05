// Page-specific CSS that used to ship as inline <style> blocks (CSP style-src, docs/security/csp.md #3).
// Served as /fy.css, /guide.css, /ask.css, /docs.css on those pages only — not folded into /app.css (web-budget).
export const FY_CSS = `
.fy{font-size:15px;line-height:1.45;padding-bottom:84px}
.fy-hi h1{font-size:26px;line-height:1.2;letter-spacing:-.025em;font-weight:650}
.fy .lede{color:var(--muted);font-size:15px;margin-top:4px}
.fy a.link,.fy button.link{color:var(--accent);font:inherit;font-weight:500;font-size:13.5px;background:none;border:0;padding:0;cursor:pointer}
.fy .btn.xl{height:46px;padding:0 18px;font-size:15px;border-radius:10px}
.fy .nc{--k:var(--q);position:relative;margin-top:16px;border:1px solid var(--line);border-radius:14px;background:var(--bg);box-shadow:var(--shadow);padding:15px 16px 16px 19px;overflow:hidden}
.fy .nc::before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--k)}
.fy .nc .type{display:flex;align-items:center;gap:6px;font-size:13.5px;font-weight:500;color:color-mix(in srgb,var(--k) 72%,var(--ink))}.fy .nc .type b{color:var(--muted);font-weight:500}
.fy .nc .tt{font-size:20px;line-height:1.25;font-weight:600;color:var(--ink);letter-spacing:-.015em;margin-top:6px;overflow-wrap:anywhere}
.fy .nc .who{display:flex;align-items:center;gap:8px;margin-top:8px;font-size:13.5px;color:var(--muted);min-width:0}.fy .nc .who>span{min-width:0;overflow-wrap:anywhere}
.fy .nc .who b{color:var(--text);font-weight:500}.fy .nc .who a{color:var(--text);text-decoration:underline;text-decoration-color:var(--line-strong);text-underline-offset:2px}.fy .nc .who a:hover{text-decoration-color:currentColor}
.fy .nc .det{margin-top:12px;padding:10px 12px;border-radius:10px;background:var(--bg-subtle);border:1px solid var(--line);font-size:14px;color:var(--text)}
.fy .nc .det .ln{display:flex;justify-content:space-between;gap:12px;min-width:0}.fy .nc .det .ln+.ln{margin-top:3px}
.fy .nc .det .ln span{min-width:0;overflow-wrap:anywhere}.fy .nc .det .ln span:first-child:not(.one){color:var(--muted);flex:none}.fy .nc .det .ln span:last-child:not(.one){text-align:right}
.fy .nc .acts{display:flex;gap:10px;margin-top:14px}.fy .nc .acts .btn{flex:1;min-width:0}
.fy .stack-edge{height:7px;margin:0 10px;border:1px solid var(--line);border-top:0;border-radius:0 0 12px 12px;background:var(--bg)}
.fy .stack-edge+.stack-edge{margin:0 20px;height:6px}
.fy .fy-more{text-align:right;margin:6px 2px 0}
.fy .list{border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--bg)}
.fy .fy-quick{margin-top:14px}
.fy .nrow{--k:var(--accent);display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px;padding:12px 14px 12px 16px;position:relative;border-top:1px solid var(--line)}
.fy .nrow:first-child{border-top:0}
.fy .nrow::before{content:"";position:absolute;left:0;top:10px;bottom:10px;width:3px;border-radius:0 3px 3px 0;background:var(--k)}
.fy .nrow.k-decide{--k:var(--decision)}.fy .nrow.k-reply{--k:var(--accent)}
.fy .nrow .grow{flex:1 1 180px}
.fy .nrow .tt{display:block;font-size:15px;font-weight:550;color:var(--ink);line-height:1.3;overflow-wrap:anywhere}.fy .nrow a.tt:hover{text-decoration:underline}
.fy .nrow .sub{font-size:13px;color:var(--muted);margin-top:1px;overflow-wrap:anywhere}
.fy .nrow .fy-acts{display:flex;gap:8px;flex:none;margin-left:auto}.fy .nrow .btn{height:32px;font-size:14px}
.fy .nrow.voted .fy-acts{color:var(--ok);font-size:13.5px;font-weight:500}
.fy .sec{display:flex;align-items:baseline;justify-content:space-between;margin:22px 2px 10px}
.fy .sec h2{font-size:13.5px;font-weight:600;letter-spacing:0}.fy .sec h2 .faint{font-weight:400}
.fy .done-i{display:flex;gap:12px;align-items:flex-start;padding:10px 14px;border-top:1px solid var(--line)}
.fy .done-i:first-child{border-top:0}.fy .done-i:hover{background:var(--bg-subtle)}
.fy .done-i.more{display:none}.fy .fy-done.all .done-i.more{display:flex}
.fy .ck{width:22px;height:22px;border-radius:50%;background:var(--ok);color:var(--bg);display:grid;place-items:center;flex:none;margin-top:1px}.fy .ck svg{width:12px;height:12px}
.fy .done-i .tt{display:block;font-size:15px;color:var(--ink);line-height:1.35;overflow-wrap:anywhere}
.fy .done-i .sub{display:block;font-size:12.5px;color:var(--faint);margin-top:1px}
.fy .fy-empty{margin-top:16px;padding:36px 20px}
.fy-askwrap{position:fixed;left:232px;right:0;bottom:0;z-index:15;padding:28px 24px 16px;pointer-events:none;
  background:linear-gradient(to bottom,transparent,var(--bg) 55%)}
/* Ask your assistant is the board's chat composer (jxn #4462): its card, border and corners, its mic and send buttons. */
.fy-ask{pointer-events:auto;width:100%;max-width:712px;margin:0 auto;display:flex;align-items:center;gap:8px;padding:10px 12px 10px 16px}
.fy-ask input{flex:1;border:0;outline:0;background:transparent;color:var(--ink);font:inherit;font-size:15px;min-width:0}
.fy-ask input::placeholder{color:var(--faint)}
.fy-toast{pointer-events:auto;max-width:712px;margin:0 auto 10px;display:flex;align-items:center;justify-content:center;gap:12px;font-size:13.5px;
  width:max-content;padding:9px 14px;border-radius:8px;background:var(--ink);color:var(--on-ink);box-shadow:var(--shadow-lg)}
.fy-toast .link{color:var(--on-ink);text-decoration:underline;font-weight:600}
.fy-askwrap{display:flex;flex-direction:column-reverse}
#toast{bottom:96px}
@media(max-width:860px){.fy-askwrap{left:0;padding:24px 12px 12px}.fy-hi h1{font-size:24px}}
@media(max-width:380px){.fy .nc{padding:14px 13px 14px 16px}.fy .nc .tt{font-size:18px}.fy .btn.xl{padding:0 10px}}
`;

export const GUIDE_CSS = `
.gd-top{display:flex;flex-direction:column;gap:10px;margin-bottom:14px}
.gd-q{width:100%;max-width:420px}
.gd-jump{display:flex;flex-wrap:wrap;gap:6px}
.gd-jump a{font-size:12.5px;padding:3px 9px;border:1px solid var(--line);border-radius:999px;color:var(--muted);text-decoration:none;background:var(--bg-subtle)}
.gd-jump a:hover{color:var(--ink);border-color:var(--line-strong)}
.gd-sec{margin:22px 0 8px;scroll-margin-top:72px}
.gd-sec h2{font-size:15px;font-weight:600;margin:0 0 8px}
.gd-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px}
.gd-item{padding:12px 14px;scroll-margin-top:72px}
.gd-item h3{font-size:14px;font-weight:600;margin:0 0 4px;display:flex;gap:6px;align-items:baseline}
.gd-item h3 a{color:var(--faint);text-decoration:none;font-weight:400;opacity:0;font-size:12px}
.gd-item:hover h3 a,.gd-item h3 a:focus{opacity:1}
.gd-item p{margin:0;color:var(--muted);font-size:13.5px;line-height:1.5}
.gd-item:target{outline:2px solid var(--focus);outline-offset:1px}
.gd-agents{margin-top:26px;font-size:13px}
@media (max-width:520px){.gd-list{grid-template-columns:1fr}.gd-q{max-width:none}}
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
.docs{max-width:760px;margin:0 auto;padding:20px 16px 48px}
.docs h1{font-size:24px;margin:12px 0 4px}
.docs h2{font-size:17px;margin:26px 0 8px}
.docs h3{font-size:14.5px;margin:16px 0 2px;font-family:var(--font-mono)}
.docs p,.docs li{font-size:14px;line-height:1.55;color:var(--muted);margin:6px 0}
.docs code{font-size:12.5px;background:var(--bg-subtle);border:1px solid var(--line);border-radius:5px;padding:0 4px}
.docs .tool{margin:14px 0;scroll-margin-top:72px}
.docs ul,.docs ol{padding-inline-start:22px}
.docs .jump{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 4px}
.docs .jump a{font-size:12.5px;padding:3px 9px;border:1px solid var(--line);border-radius:999px;color:var(--muted);text-decoration:none;background:var(--bg-subtle)}
.docs .jump a:hover{color:var(--ink);border-color:var(--line-strong)}
`;
