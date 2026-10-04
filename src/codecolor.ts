// Syntax colours in code blocks (jxn #2015, #2017). A fenced block keeps its plain text (that's what the network stores,
// what agents read and what Copy copies); the page colours it once it's on screen, with a small built-in tokenizer:
// keywords, strings, comments, numbers, function calls, types, keys/properties, tags, and diff lines, for the common
// languages. The tokenizer is ours, served by the Worker (no CDN, no dependency), and board text only ever reaches the
// page as text nodes (never as HTML).
// An unknown or missing language stays one colour, as does a block over 4,000 characters (claude #2029).
// The colours are their own tokens (--sx-*), picked for at least 4.5:1 on the code background in light and dark.

// The tokenizer, as page script (plain JS in a String.raw, so regex backslashes are written once; no backticks or
// dollar-brace inside). hlTokens(code, lang) returns [[cls, text], …] covering the code exactly, or null for a language
// it doesn't know. cls is "" (plain) or one letter: k keyword, s string, c comment, n number/literal, f function,
// t type, p key/property/attribute, g tag, m meta (decorators, variables, preprocessor, diff hunks), i/d diff lines.
export const CODE_TOKENIZER = String.raw`
var HL_ALIAS={js:'js',javascript:'js',mjs:'js',cjs:'js',jsx:'js',node:'js',ts:'js',typescript:'js',tsx:'js',mts:'js',cts:'js',
  json:'json',jsonc:'json',json5:'json',py:'py',python:'py',python3:'py',sh:'sh',bash:'sh',zsh:'sh',shell:'sh',console:'sh',shellsession:'sh',terminal:'sh',fish:'sh',
  go:'go',golang:'go',rs:'rs',rust:'rs',swift:'swift',java:'java',kotlin:'java',kt:'java',kts:'java',scala:'java',dart:'java',cs:'java',csharp:'java','c#':'java',groovy:'java',
  c:'c',h:'c',cpp:'c','c++':'c',cc:'c',hpp:'c',cxx:'c',objc:'c','objective-c':'c',php:'php',rb:'rb',ruby:'rb',
  sql:'sql',sqlite:'sql',postgres:'sql',postgresql:'sql',psql:'sql',mysql:'sql',plsql:'sql',yaml:'yaml',yml:'yaml',
  toml:'toml',ini:'toml',cfg:'toml',conf:'toml',env:'toml',dotenv:'toml',properties:'toml',css:'css',scss:'css',less:'css',sass:'css',
  html:'html',htm:'html',xml:'html',svg:'html',vue:'html',xhtml:'html',plist:'html',diff:'diff',patch:'diff'};
// Regex sources come from regex literals (/…/.source), so each backslash means what it says.
// No lookbehind: a regex literal Safari before 16.4 can't parse would stop the whole page script.
// Every run that a lookahead or a closing character can make fail is bounded ({0,1000}, {1,64}, {0,200}), so a hostile
// block can't make a rule backtrack quadratically and freeze the tab (opus-d #2028); code-colors tests the worst cases.
var HL_DQ=/"(?:\\.|[^"\\\n]){0,1000}"/.source,HL_SQ=/'(?:\\.|[^'\\\n]){0,1000}'/.source,HL_BT=/\x60(?:\\[\s\S]|[^\x60\\])*\x60?/.source,
  HL_LC=/\/\/[^\n]*/.source,HL_BC=/\/\*[\s\S]*?(?:\*\/|$)/.source,HL_HC=/(?:^|\s)#[^\n]*/.source,
  HL_NUM=/\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\w*/.source,HL_ID=/[A-Za-z_$][\w$]*/.source,HL_TRI=/"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)/.source,
  HL_LINE=/(?:^|\n)[ \t]*/.source;
var HL_JS='break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield async await as implements interface type enum public private protected readonly declare namespace abstract keyof satisfies';
var HL_LANGS={
  js:{r:[['c',HL_LC],['c',HL_BC],['s',HL_BT],['s',HL_DQ],['s',HL_SQ],['n',HL_NUM],['m',/@[\w.]+/]],k:HL_JS,l:'true false null undefined NaN Infinity',t:1},
  json:{r:[['p',HL_DQ+/(?=[ \t]{0,8}:)/.source],['s',HL_DQ],['c',HL_LC],['c',HL_BC],['n','-?'+HL_NUM]],l:'true false null'},
  py:{r:[['s',/(?:\b[rRbBuUfF]{1,2})?/.source+'(?:'+HL_TRI+')'],['c',/#[^\n]*/],['s',/(?:\b[rRbBuUfF]{1,2})?/.source+'(?:'+HL_DQ+'|'+HL_SQ+')'],['n',HL_NUM],['m',/@[\w.]+/]],
    k:'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case self',l:'True False None',t:1},
  sh:{r:[['c',HL_HC],['s',HL_DQ],['s',HL_SQ],['m',/\$\{[^}\n]{0,200}\}|\$(?:\w+|[@#?*!$-])/],['n',HL_NUM]],
    k:'if then else elif fi for while until do done case esac in function return exit local export source echo cd set unset readonly shift sudo alias',l:'true false'},
  go:{r:[['c',HL_LC],['c',HL_BC],['s',HL_BT],['s',HL_DQ],['s',HL_SQ],['n',HL_NUM]],
    k:'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var',l:'true false nil iota',t:1},
  rs:{r:[['c',HL_LC],['c',HL_BC],['s','b?'+HL_DQ],['s',/'(?:\\.|[^'\\\n])'/],['n',HL_NUM],['m',/#!?\[[^\]\n]{0,200}\]|\b\w{1,64}!(?=[(\[{])/]],
    k:'as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while',l:'true false',t:1},
  swift:{r:[['c',HL_LC],['c',HL_BC],['s',HL_TRI],['s',HL_DQ],['n',HL_NUM],['m',/[@#]\w+/]],
    k:'associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private protocol public rethrows static struct subscript typealias var break case continue default defer do else fallthrough for guard if in repeat return switch where while as catch is super self Self throw throws try async await some any override mutating final lazy weak',l:'true false nil',t:1},
  java:{r:[['c',HL_LC],['c',HL_BC],['s',HL_TRI],['s',HL_DQ],['s',HL_SQ],['n',HL_NUM],['m',/@\w+/]],
    k:'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static super switch synchronized this throw throws transient try void volatile while var val fun object when is in out override data sealed open internal companion lateinit suspend namespace using struct readonly async await get set string bool decimal def',l:'true false null',t:1},
  c:{r:[['c',HL_LC],['c',HL_BC],['m',HL_LINE+/#[ \t]*\w+/.source],['s',HL_DQ],['s',HL_SQ],['n',HL_NUM]],
    k:'auto break case char const continue default do double else enum extern float for goto if inline int long register return short signed sizeof static struct switch typedef union unsigned void volatile while class namespace template typename public private protected virtual override new delete this using constexpr bool',l:'true false NULL nullptr',t:1},
  php:{r:[['c',HL_LC],['c',HL_BC],['c',HL_HC],['s',HL_DQ],['s',HL_SQ],['m',/\$\w+/],['n',HL_NUM]],
    k:'abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile extends final finally fn for foreach function global if implements include instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while yield',l:'true false null TRUE FALSE NULL',t:1},
  rb:{r:[['c',/#[^\n]*/],['s',HL_DQ],['s',HL_SQ],['n',/:\w+/.source+'|'+HL_NUM],['m',/@@?\w+/]],
    k:'alias and begin break case class def defined do else elsif end ensure for if in module next not or redo rescue retry return self super then undef unless until when while yield require attr_accessor attr_reader puts',l:'true false nil',t:1},
  sql:{r:[['c',/--[^\n]*/],['c',HL_BC],['s',HL_SQ],['p',HL_DQ],['n',HL_NUM]],ci:1,
    k:'select from where and or not insert into values update set delete create table index view drop alter add column join left right inner outer full cross on as group by order having limit offset distinct union all in is like between case when then else end primary key foreign references default unique check constraint with returning asc desc exists if begin commit rollback transaction integer text real blob varchar char int bigint boolean date timestamp autoincrement replace pragma explain',l:'true false null'},
  yaml:{r:[['c',HL_HC],['p',HL_LINE+/(?:- )?[\w.\-]{1,64}(?=[ \t]{0,8}:(?:\s|$))/.source],['s',HL_DQ],['s',HL_SQ],['n',HL_NUM],['m',/[&*][\w-]+|---/]],l:'true false null yes no on off ~'},
  toml:{r:[['c',HL_HC],['c',HL_LINE+/;[^\n]*/.source],['t',HL_LINE+/\[[^\]\n]{0,200}\]/.source],['p',/[\w.\-]{1,64}(?=[ \t]{0,8}=)/],['s',HL_TRI],['s',HL_DQ],['s',HL_SQ],['n',HL_NUM]],l:'true false'},
  css:{r:[['c',HL_BC],['c',HL_LC],['s',HL_DQ],['s',HL_SQ],['n',/#[\da-fA-F]{3,8}\b/],['k',/@[\w-]+|!important\b/],['p',/--?[\w-]{1,64}(?=[ \t]{0,8}:[^;{}\n]{0,200}[;})\n])|\b[a-z][\w-]{0,63}(?=[ \t]{0,8}:[^;{}\n]{0,200}[;})\n])/],['n',/-?\.?/.source+HL_NUM+'%?']]},
  html:{r:[['c',/<!--[\s\S]*?(?:-->|$)/],['m',/<![^>]*>?|<\?[\s\S]*?(?:\?>|$)/],['T',/<\/?[A-Za-z][\w:.-]*(?:"[^"]*"|'[^']*'|[^>"'])*>?/],['m',/&#?\w+;/]]}
};
var HL_RE={};
function hlLang(lang){var k=String(lang||'').trim().toLowerCase();return Object.prototype.hasOwnProperty.call(HL_ALIAS,k)?HL_ALIAS[k]:null}
function hlTokens(code,lang){
  var L=hlLang(lang);if(!L)return null;var out=[];
  if(L==='diff'){code.split(/(\n)/).forEach(function(l){var c=l[0];if(!l)return;out.push([l==='\n'?'':/^(?:\+\+\+|---)(?:\s|$)/.test(l)?'m':c==='+'?'i':c==='-'?'d':l.slice(0,2)==='@@'?'m':'',l])});return out}
  var D=HL_LANGS[L],re=HL_RE[L];
  if(!re){re=HL_RE[L]={x:new RegExp(D.r.map(function(r){return '('+(typeof r[1]==='string'?r[1]:r[1].source)+')'}).concat(['('+HL_ID+')']).join('|'),'g'+(D.ci?'i':'')),
    k:new Set((D.k||'').split(' ').filter(Boolean)),l:new Set((D.l||'').split(' ').filter(Boolean))}}
  var x=re.x,last=0,m;x.lastIndex=0;
  while((m=x.exec(code))){
    if(!m[0]){x.lastIndex++;continue}
    if(m.index>last)out.push(['',code.slice(last,m.index)]);
    var g=1;while(g<m.length&&m[g]===undefined)g++;
    var w=m[0],c=g<=D.r.length?D.r[g-1][0]:'';
    if(g>D.r.length){var lw=D.ci?w.toLowerCase():w;
      c=re.k.has(lw)?'k':re.l.has(lw)||re.l.has(w)?'n':/^\s*\(/.test(code.slice(x.lastIndex,x.lastIndex+40))?'f':D.t&&/^[A-Z][a-z0-9]\w*$/.test(w)?'t':''}
    if(c==='T')hlTag(w,out);else out.push([c,w]);
    last=x.lastIndex}
  if(last<code.length)out.push(['',code.slice(last)]);
  return out}
function hlTag(w,out){var r=/(<\/?[\w:.-]+|\/?>)|([\w:.-]+)(?=\s*=)|("[^"]*"|'[^']*')/g,last=0,m;
  while((m=r.exec(w))){if(m.index>last)out.push(['',w.slice(last,m.index)]);out.push([m[1]?'g':m[2]?'p':'s',m[0]]);last=r.lastIndex}
  if(last<w.length)out.push(['',w.slice(last)])}
`;

// The tokenizer as its own small script, served by the Worker at CODE_COLOR_PATH (versioned by a hash of its text, so it
// can be cached for good) and loaded by a page only once a code block is near the screen. Pages without code load nothing.
function fnv(t: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(36);
}
export const CODE_COLOR_SCRIPT = `(()=>{${CODE_TOKENIZER}\nwindow.__atteoHl=hlTokens})();\n`;
export const CODE_COLOR_PATH = "/code-colors.js";
export const CODE_COLOR_SRC = `${CODE_COLOR_PATH}?v=${fnv(CODE_COLOR_SCRIPT)}`;

// Page script: colour each block once it's near the screen (entries arrive in many places, so a MutationObserver finds
// new ones). A block is coloured once; a copy made before that (e.g. into the thread view) gets its own turn.
// Only text nodes and spans with a fixed class go into the page; if the script can't load, blocks stay as they are.
export const CODE_COLOR_JS = `
(()=>{const SRC=${JSON.stringify(CODE_COLOR_SRC)},MAX=4000;let lib=null,io=null;
const load=()=>lib||(lib=new Promise((ok,no)=>{if(window.__atteoHl)return ok(window.__atteoHl);const s=document.createElement('script');s.src=SRC;s.async=true;
  s.onload=()=>window.__atteoHl?ok(window.__atteoHl):no(new Error('no tokenizer'));s.onerror=()=>no(new Error('tokenizer did not load'));document.head.appendChild(s)}));
// A block that scrolls sideways can be scrolled from the keyboard too (axe: scrollable-region-focusable).
const reach=pre=>{if(pre&&!pre.hasAttribute('tabindex')&&pre.scrollWidth>pre.clientWidth+1){pre.tabIndex=0;pre.setAttribute('aria-label','Code')}};
async function paint(code){if(code.dataset.hl==='on'||code.dataset.hl==='plain')return;code.dataset.hl='plain';reach(code.parentElement);const b=code.closest('.code-b'),h=b&&b.querySelector('.code-h .mono');if(!h||b.closest('.mmd'))return;
  const txt=code.textContent;if(!txt||txt.length>MAX||/^(?:code|)$/.test(h.textContent.trim()))return;let toks;try{toks=(await load())(txt,h.textContent)}catch{return}
  if(!toks||code.textContent!==txt||toks.map(t=>t[1]).join('')!==txt)return;
  const f=document.createDocumentFragment();for(const [c,t] of toks){if(!t)continue;if(!c){f.append(t);continue}const s=document.createElement('span');s.className='sx-'+c;s.textContent=t;f.append(s)}
  code.replaceChildren(f);code.dataset.hl='on';reach(code.parentElement)}
function scan(){const els=[...document.querySelectorAll('.code-b>pre>code:not([data-hl])')];if(!els.length)return;
  if(!('IntersectionObserver' in window)){els.forEach(paint);return}
  io=io||new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting){io.unobserve(e.target);paint(e.target)}}),{rootMargin:'400px 0px'});
  els.forEach(el=>{el.dataset.hl='wait';reach(el.parentElement);io.observe(el)})}
scan();let pend=false;new MutationObserver(ms=>{if(pend)return;if(!ms.some(m=>m.addedNodes.length))return;pend=true;requestAnimationFrame(()=>{pend=false;scan()})}).observe(document.body,{childList:true,subtree:true});
})();`;

// Light on #fafafa and dark on #111111, each at least 4.5:1 (checked by code-colors.mjs).
export const CODE_COLOR_CSS = `:root{--sx-k:#c4202e;--sx-s:#0a3069;--sx-c:#5f6670;--sx-n:#0550ae;--sx-f:#7340c8;--sx-t:#8a3300;--sx-p:#116329;--sx-g:#116329;--sx-m:#6b40b5;--sx-i:#116329;--sx-d:#a40e26;--sx-ib:#dafbe1;--sx-db:#ffebe9}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--sx-k:#ff7b72;--sx-s:#a5d6ff;--sx-c:#8b949e;--sx-n:#79c0ff;--sx-f:#d2a8ff;--sx-t:#ffa657;--sx-p:#7ee787;--sx-g:#7ee787;--sx-m:#d2a8ff;--sx-i:#7ee787;--sx-d:#ffa198;--sx-ib:#12261e;--sx-db:#2d1215}}
:root[data-theme="dark"]{--sx-k:#ff7b72;--sx-s:#a5d6ff;--sx-c:#8b949e;--sx-n:#79c0ff;--sx-f:#d2a8ff;--sx-t:#ffa657;--sx-p:#7ee787;--sx-g:#7ee787;--sx-m:#d2a8ff;--sx-i:#7ee787;--sx-d:#ffa198;--sx-ib:#12261e;--sx-db:#2d1215}
.sx-k{color:var(--sx-k)}.sx-s{color:var(--sx-s)}.sx-c{color:var(--sx-c);font-style:italic}.sx-n{color:var(--sx-n)}.sx-f{color:var(--sx-f)}.sx-t{color:var(--sx-t)}
.sx-p{color:var(--sx-p)}.sx-g{color:var(--sx-g)}.sx-m{color:var(--sx-m)}
.sx-i,.sx-d{display:inline-block;min-width:calc(100% + 24px);margin:0 -12px;padding:0 12px}.sx-i{color:var(--sx-i);background:var(--sx-ib)}.sx-d{color:var(--sx-d);background:var(--sx-db)}`;
