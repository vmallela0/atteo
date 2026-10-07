// jxn's site pages (#5977) are Claude Design exports: a self-unpacking bundle whose page HTML is one JSON string (the
// "__bundler/template" script). This fills them in place, so a new export or a new tool/command is one command away:
//   node landing/jxn-pages/build.mjs                  rebuild the served pages in landing/jxn-pages/
//   node landing/jxn-pages/build.mjs ~/faq.html …     take fresh exports (each names its page in fromHash; the home page
//                                                     is the one with a "Hero", and goes to landing/landing-jxn.html)
// It is safe to run again on its own output. What it does to every page:
//   - links between the pages ("faq.html") point at the real paths (/faq);
//   - the tab title the runtime leaves as "atteo · {{ title }}" is filled in;
//   - on phones, a page's "contents" column goes above its text instead of squeezing it (#5995);
// and with the live text (jxn #5998), so these pages can't say something the app doesn't:
//   - privacy: the policy the app publishes (LEGAL.privacy in src/html.ts);
//   - developers: "the 5 verbs" (developersBody in landing/src/developers.ts) and every MCP tool and CLI
//     command from MCP_TOOLS and CLI_COMMANDS there, which test/developers.test.ts keeps in step with the code.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { CLI_COMMANDS, MCP_TOOLS, developersBody } from "../src/developers.ts";

const DIR = new URL("./", import.meta.url);
const PAGES = ["developers", "faq", "support", "privacy", "terms"];
const TEMPLATE = /(<script type="__bundler\/template">)([\s\S]*?)(<\/script>)/;

// The export's own inline styles, so what's added looks like the rest of the page.
const S = {
  h2: "margin:0;scroll-margin-top:96px;font:400 clamp(26px,2.6vw,32px)/1.15 'STIX Two Text',Georgia,serif;letter-spacing:-.015em",
  h3: "margin:0;font:500 14px/1.3 'JetBrains Mono',monospace;color:#0E0E0E",
  p: "margin:0;font:14.5px/1.75 'JetBrains Mono',monospace;color:#3A3935;text-wrap:pretty",
  muted: "margin:0;font:13px/1.6 'JetBrains Mono',monospace;color:#8C8A84",
  code: "padding:1px 5px;border-radius:3px;background:#F4F2EE;font:13px/1 'JetBrains Mono',monospace;color:#0E0E0E",
  pre: "border-radius:6px;background:#0E0E0E;color:#E5E5E5;padding:14px 18px;font:13px/1.8 'JetBrains Mono',monospace;overflow-x:auto;white-space:pre",
  prompt: "color:#5FD068",
  a: "text-decoration:underline;text-underline-offset:3px",
  strong: "color:#0E0E0E",
  section: "display:flex;flex-direction:column;gap:16px",
  li: "display:grid;grid-template-columns:14px minmax(0,1fr);gap:8px;font:14.5px/1.75 'JetBrains Mono',monospace;color:#3A3935",
  nav: 'sc-camel-on-click="{{ jump }}" style="color:#5A5853" style-hover="color:#0E0E0E"',
};
const PHONE_CSS = `/* jxn-pages: contents above the text on phones */
@media (max-width:720px){div:has(> div > nav[aria-label="contents"]){grid-template-columns:minmax(0,1fr)!important;gap:28px!important}nav[aria-label="contents"]{position:static!important;flex-flow:row wrap!important;gap:8px 18px!important}nav[aria-label="contents"] > span{flex-basis:100%}}
`;

const slug = (s) => s.toLowerCase().replace(/&amp;/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const inline = (h) => h
  .replace(/<b>/g, `<strong style="${S.strong}">`).replace(/<\/b>/g, "</strong>")
  .replace(/<code>/g, `<code style="${S.code}">`)
  .replace(/<a href="([^"]*)">/g, (_, href) => `<a href="${href}" style="${S.a}">`);

/** Swap the part of `t` between `start` and `end` (both kept), which must each occur once after `from`. */
function between(t, from, start, end, inner) {
  const f = t.indexOf(from);
  const a = t.indexOf(start, f);
  const b = t.indexOf(end, a + start.length);
  if (f < 0 || a < 0 || b < 0) throw new Error(`can't find ${JSON.stringify(start)} in ${JSON.stringify(from)}`);
  return t.slice(0, a + start.length) + inner + t.slice(b);
}

function privacy(t) {
  const src = readFileSync(new URL("../../src/html.ts", import.meta.url), "utf8");
  const body = /privacy: \{[\s\S]*?body: `([\s\S]*?)`,/.exec(src)?.[1];
  if (!body || body.includes("${")) throw new Error("LEGAL.privacy's body not found in src/html.ts");
  const updated = /<p class="st-updated">([^<]*)<\/p>/.exec(body)[1];
  const sections = [...body.replace(/<!--[\s\S]*?-->/g, "").matchAll(/<h2>([\s\S]*?)<\/h2>([\s\S]*?)(?=<h2>|$)/g)].map(([, h, rest]) => {
    const id = slug(h);
    const blocks = [...rest.matchAll(/<p>([\s\S]*?)<\/p>|<ul>([\s\S]*?)<\/ul>/g)].map(([, p, ul]) => p !== undefined
      ? `<p style="${S.p}">${inline(p)}</p>`
      : `<ul style="margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:12px">${[...ul.matchAll(/<li>([\s\S]*?)<\/li>/g)].map(([, li]) => `<li style="${S.li}"><span style="color:#A9A69F">–</span><span>${inline(li)}</span></li>`).join("")}</ul>`);
    return { id, title: h.toLowerCase(), html: `<section style="${S.section}"><h2 id="${id}" style="${S.h2}">${h.toLowerCase()}</h2>${blocks.join("")}</section>` };
  });
  const from = '<sc-if value="{{ is_privacy }}"';
  t = between(t, from, ">Last updated ", "</p>", updated.replace(/^Last updated /, ""));
  t = between(t, from, '<span style="color:#A9A69F">contents</span>\n', "</nav>", sections.map((s) => `            <a href="#${s.id}" data-to="${s.id}" ${S.nav}>${s.title}</a>\n`).join("") + "          ");
  return between(t, from, '<div style="min-width:0;max-width:760px;display:flex;flex-direction:column;gap:56px">', "</div>\n        </div>\n      </div>\n      </sc-if>", sections.map((s) => s.html).join("\n"));
}

function developers(t) {
  // "The 5 verbs", from the live page, in the export's styles; it goes first, like there.
  const live = /<section id="five-verbs">([\s\S]*?)<\/section>/.exec(developersBody())[1];
  let response = false;
  const verbs = live
    .replace(/<h2>([\s\S]*?)<\/h2>/, (_, h) => `<h2 id="five-verbs" style="${S.h2}">${h.toLowerCase()}</h2>`)
    .replace(/<h3>/g, `<h3 style="${S.h3}">`)
    .replace(/<div id="(verb-[a-z]+)">/g, (_, id) => `<div id="${id}" style="display:flex;flex-direction:column;gap:10px;padding:18px;border:1px solid #E4E1D9;border-radius:10px">`)
    .replace(/<p class="mut">([\s\S]*?)<\/p>|<p>|<pre><code>([\s\S]*?)<\/code><\/pre>/g, (m, mut, pre) => {
      if (mut !== undefined) { response = true; return `<p style="${S.muted}">${mut}</p>`; }
      if (pre === undefined) return `<p style="${S.p}">`;
      const lines = response ? pre : pre.split("\n").map((l) => `<span style="${S.prompt}">$ </span>${l}`).join("\n");
      response = false;
      return `<div style="${S.pre}">${lines}</div>`;
    });
  const section = `<section style="${S.section}">${inline(verbs)}</section>\n`;
  const from = '<sc-if value="{{ is_developers }}"';
  t = t.replace(/<section style="[^"]*"><h2 id="five-verbs"[\s\S]*?<\/section>\n/, "");
  const fits = t.indexOf("<section", t.indexOf(from));
  t = t.slice(0, fits) + section + t.slice(fits);
  t = t.replace(/<a href="#five-verbs" [^>]*>[^<]*<\/a>\n {12}/, "");
  const nav = t.indexOf('<a href="#fits"', t.indexOf(from));
  t = t.slice(0, nav) + `<a href="#five-verbs" data-to="five-verbs" ${S.nav}>${/<h2>([\s\S]*?)<\/h2>/.exec(live)[1].toLowerCase()}</a>\n            ` + t.slice(nav);
  // Every MCP tool and CLI command, as the export's logic reads them: one "name|meaning|extra" line each.
  const mcp = MCP_TOOLS.map(([name, desc, actions]) => `${name}|${desc}|${actions ? actions.join(", ") : ""}`).join("\n");
  const cli = CLI_COMMANDS.map(([command, desc, example]) => `${command}|${desc}|${example}`).join("\n");
  for (const [name, data] of [["MCP", mcp], ["CLI", cli]]) {
    const re = new RegExp(`(\\n  ${name} = )"(?:[^"\\\\]|\\\\.)*"`);
    if (!re.test(t)) throw new Error(`${name} list not found`);
    t = t.replace(re, (_, lead) => lead + JSON.stringify(data));
  }
  return t;
}

// The home page (landing-jxn.html): its agent favicons come from /landing/icons (proxied from Google's favicon service in
// landing/src/index.ts, so visitors never contact Google), and on phones the install command stays on one line, cut off
// with a fade, with copy and cli beside it (#6031, #6074, #6139). His icon network already frames the text there.
const LANDING_PHONE_CSS = `<style data-phone>/* landing on phones (#6031, #6074, #6139): the install command on one line, faded where it's cut off, copy and cli beside it */
@media (max-width:720px){
div:has(> button[aria-haspopup]){flex-wrap:nowrap!important}
div:has(> button[aria-haspopup]) > div{flex:1 1 0!important;min-width:0!important}
div:has(> button[aria-haspopup]) span[style*="overflow"]{-webkit-mask-image:linear-gradient(90deg,#000 80%,transparent);mask-image:linear-gradient(90deg,#000 80%,transparent)}
}
</style>
`;
function landing(t) {
  t = t.replace(/https:\/\/www\.google\.com\/s2\/favicons\?domain=([a-z0-9.-]+)&amp;sz=64/g, "/landing/icons/$1.png")
    .replace("FAV = d => 'https://www.google.com/s2/favicons?domain=' + d + '&sz=64';", "FAV = d => '/landing/icons/' + d + '.png';");
  if (/google\.com\/s2/.test(t)) throw new Error("a Google favicon URL is left in the landing page");
  return t.includes("<style data-phone>") ? t : t.replace("</helmet>", () => LANDING_PHONE_CSS + "</helmet>");
}

export function build(html) {
  const [, open, json, close] = TEMPLATE.exec(html) ?? [];
  if (!json) throw new Error("not a bundled export: no __bundler/template");
  let t = JSON.parse(json);
  if (t.includes('data-screen-label="Hero"')) return { page: "landing", out: html.replace(TEMPLATE, () => `${open}\n${JSON.stringify(landing(t)).replace(/<\//g, "<\\u002F")}\n  ${close}`) };
  const page = /fromHash\(\) \{ return '([a-z]+)'; \}/.exec(t)?.[1];
  if (!PAGES.includes(page)) throw new Error(`unknown page ${page}`);
  const title = new RegExp(`${page}: '([^']*)'`).exec(t)[1];
  for (const p of PAGES) t = t.replaceAll(`href="${p}.html"`, `href="/${p}"`);
  t = t.replace("<title>atteo · {{ title }}</title>", `<title>atteo · ${title}</title>`);
  if (!t.includes("/* jxn-pages: contents")) t = t.replace("html{scroll-behavior:smooth}\n", (m) => m + PHONE_CSS);
  if (page === "privacy") t = privacy(t);
  if (page === "developers") t = developers(t);
  const out = html.replace(TEMPLATE, () => `${open}\n${JSON.stringify(t).replace(/<\//g, "<\\u002F")}\n  ${close}`)
    .replace("<title>atteo · {{ title }}</title>", `<title>atteo · ${title}</title>`);
  return { page, out };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const inputs = process.argv.slice(2);
  for (const file of inputs.length ? inputs : [...PAGES.map((p) => new URL(`${p}.html`, DIR).pathname), new URL("../landing-jxn.html", DIR).pathname]) {
    let html;
    try { html = readFileSync(file, "utf8"); } catch { if (!inputs.length) continue; throw new Error(`can't read ${file}`); }
    const { page, out } = build(html);
    const to = page === "landing" ? new URL("../landing-jxn.html", DIR) : new URL(`${page}.html`, DIR);
    writeFileSync(to, out);
    console.log(`${to.pathname.split("/landing/").pop()} ← ${file}`);
  }
}
