// jxn's pages as plain HTML (#5984, #6003): fast to show and readable by crawlers and link previews, with the copy and
// layout byte for byte what his exports draw (#6001). Each export is opened in Chromium and its finished page kept:
//   node landing/jxn-pages/unbundle.mjs        (after build.mjs; PW_CHROME=<chrome> if Playwright's own isn't installed)
// writes landing/jxn-static/<page>.html, and the export's fonts, images and scripts as files named by their content in
// landing/public/landing/a/ (served as static assets, cached for a year).
// - The site pages (developers, faq, support, privacy, terms, 404) are static: no React, nothing evaluated. The few
//   things their logic did by script come back as small inline scripts (the header on scroll, the CLI filter, the
//   404's path), which the landing CSP allows by hash.
// - The home page (/ and /landing) keeps its logic, which runs the demos, the ring and the picker: the snapshot shows
//   at once, then jxn's own runtime and React load from files, draw the same page and take its place.
// Each output names the sha256 of the export it came from; test/landing-csp.test.ts says when to run this again.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const HERE = new URL("./", import.meta.url);
const OUT = new URL("../jxn-static/", import.meta.url);
const ASSETS = new URL("../public/landing/a/", import.meta.url);
const ASSET_PATH = "/landing/a/";
export const PAGES = {
  landing: { src: new URL("../landing-jxn.html", import.meta.url), path: "/", live: true },
  developers: { src: new URL("developers.html", HERE), path: "/developers" },
  faq: { src: new URL("faq.html", HERE), path: "/faq" },
  support: { src: new URL("support.html", HERE), path: "/support" },
  privacy: { src: new URL("privacy.html", HERE), path: "/privacy" },
  terms: { src: new URL("terms.html", HERE), path: "/terms" },
  404: { src: new URL("404.html", HERE), path: "/jxn-path-marker" }, // its logic would show any path with "404" as /missing-page
};
// The home page's logic names four logos by path (LOGOS, OPTS: "assets/<name>-logo.png"); the export carries them under
// these uuids (the demo uses them by uuid), so they're written out at those paths too (alt-3 #6062).
const NAMED = { "claude-code-logo.png": "83e338cc-481b-46d8-92d1-71b41b055c12", "muse-logo.png": "e118cc6f-e062-401f-940a-0dd0f27ea0fc", "grokbot-logo.png": "d08a343d-9ac4-4aab-9db2-42f28059271c", "dots-logo.png": "6d2a914f-34c2-49e7-979f-d92db93065c6" };
const NAMED_DIR = new URL("../public/assets/", import.meta.url);
const EXT = { "font/woff2": "woff2", "image/png": "png", "image/jpeg": "jpg", "image/svg+xml": "svg", "image/webp": "webp", "text/javascript": "js", "application/javascript": "js" };
export const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** Writes `bytes` under its content hash; returns the URL path it is served at. */
function asset(bytes, mime) {
  const ext = EXT[mime.split(";")[0]];
  if (!ext) throw new Error(`no file type for ${mime}`);
  const name = `${sha256(bytes).slice(0, 16)}.${ext}`;
  writeFileSync(new URL(name, ASSETS), bytes);
  return ASSET_PATH + name;
}

/** The export's resources, by uuid: what the template refers to, as files. */
function manifestAssets(html) {
  const manifest = JSON.parse(/<script type="__bundler\/manifest">([\s\S]*?)<\/script>/.exec(html)[1]);
  const out = {};
  for (const [uuid, e] of Object.entries(manifest)) {
    let bytes = Buffer.from(e.data, "base64");
    if (e.compressed) bytes = require("node:zlib").gunzipSync(bytes);
    out[uuid] = { url: asset(bytes, e.mime), mime: e.mime, bytes };
  }
  return out;
}

// What the site pages' logic did by script, without React (the export's own code, cut down to what these pages use).
const SITE_SCRIPT = `(()=>{const h=document.querySelector("[data-hdr]");if(h){const f=()=>{const on=(document.scrollingElement||document.documentElement).scrollTop>8;h.style.background=on?"rgba(255,255,255,.96)":"rgba(255,255,255,0)";h.style.borderBottomColor=on?"#EFEDE8":"rgba(239,237,232,0)"};addEventListener("scroll",f,{passive:true});f()}
const q=document.querySelector('input[type="search"]');if(q){const rows=[...q.nextElementSibling.children];q.addEventListener("input",()=>{const v=q.value.trim().toLowerCase();for(const r of rows)r.hidden=!!v&&!r.textContent.toLowerCase().includes(v)})}
const p=document.getElementById("jxn-path");if(p){const s=decodeURIComponent(location.pathname||"/");p.textContent=/404|atteo[^/]*\\.html$/.test(s)?"/missing-page":s}})();`;

async function snapshot(browser, html, path) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(() => {
    const make = URL.createObjectURL.bind(URL);
    window.__jxnBlobs = {};
    URL.createObjectURL = (b) => { const u = make(b); window.__jxnBlobs[u] = b; return u; };
  });
  await page.route("http://jxn.local/**", (r) => new URL(r.request().url()).pathname === path
    ? r.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html })
    : r.fulfill({ status: 404, body: "" }));
  await page.goto("http://jxn.local" + path, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.getElementById("dc-root")?.children.length > 0);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  const out = await page.evaluate(async () => {
    // Rules the runtime added through the CSSOM (its hover classes) aren't in the markup; write them out.
    for (const s of document.querySelectorAll("style")) if (!s.textContent.trim() && s.sheet?.cssRules.length) s.textContent = [...s.sheet.cssRules].map((r) => r.cssText).join("\n");
    for (const el of document.querySelectorAll("script, noscript, #__bundler_thumbnail, #__bundler_loading, #__bundler_err, x-dc")) el.remove();
    for (const s of document.querySelectorAll("style")) if (!s.textContent.trim() || s.textContent.includes("x-dc{display:none")) s.remove();
    for (const el of document.querySelectorAll("[data-packets]")) el.replaceChildren(); // the ring's packets in flight
    for (const el of document.querySelectorAll("[data-dc-tpl]")) el.removeAttribute("data-dc-tpl");
    for (const el of document.querySelectorAll("[data-sc-name]")) el.removeAttribute("data-sc-name"); // the runtime's name for the page, from its path
    if (!document.querySelector(".sc-placeholder")) for (const s of document.querySelectorAll("style")) if (s.textContent.includes(".sc-placeholder{")) s.remove();
    // The charset and viewport first, then the title the runtime set from script, as an element.
    const title = document.createElement("title");
    title.textContent = document.title;
    document.head.prepend(document.querySelector('meta[charset]'), document.querySelector('meta[name="viewport"]'), title);
    document.documentElement.lang = "en";
    const html = "<!DOCTYPE html>\n" + document.documentElement.outerHTML;
    const blobs = {};
    for (const u of new Set(html.match(/blob:[^"')\s]+/g) || [])) {
      const b = window.__jxnBlobs[u];
      if (!b) continue;
      const bytes = new Uint8Array(await b.arrayBuffer());
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      blobs[u] = { mime: b.type, b64: btoa(bin) };
    }
    return { html, blobs };
  });
  await page.close();
  if (errors.length) throw new Error(`${path}: ${errors[0]}`);
  return out;
}

/** The snapshot with its data: and blob: URLs as files. */
function withFiles({ html, blobs }) {
  for (const [u, b] of Object.entries(blobs)) html = html.replaceAll(u, asset(Buffer.from(b.b64, "base64"), b.mime));
  html = html.replace(/data:([a-z0-9.+\/-]+);base64,([A-Za-z0-9+/=]+)/g, (m, mime, b64) => EXT[mime] ? asset(Buffer.from(b64, "base64"), mime) : m);
  if (/blob:/.test(html)) throw new Error("a blob: URL is left");
  return html;
}

/** The home page: the snapshot first, then jxn's runtime draws the live page from its template and replaces it. */
function live(html, src, files) {
  const template = JSON.parse(/<script type="__bundler\/template">([\s\S]*?)<\/script>/.exec(src)[1]);
  let t = template;
  for (const [uuid, f] of Object.entries(files)) t = t.split(uuid).join(f.url);
  const xdc = /<x-dc(?:\s[^>]*)?>([\s\S]*)<\/x-dc>/.exec(t)[1];
  const logic = /<script type="text\/x-dc" data-dc-script="[^"]*">[\s\S]*?<\/script>/.exec(t)[0];
  const runtime = /<script src="(\/landing\/a\/[0-9a-f]+\.js)"><\/script>/.exec(t)[1];
  const ext = JSON.parse(/<script type="__bundler\/ext_resources">([\s\S]*?)<\/script>/.exec(src)[1]);
  const resources = Object.fromEntries(ext.map((e) => [e.id, files[e.uuid].url]));
  const boot = `window.__resources=${JSON.stringify(resources)};(()=>{const snap=document.getElementById("jxn-snap"),x=document.createElement("x-dc");x.hidden=true;x.innerHTML=JSON.parse(document.getElementById("jxn-tpl").textContent);snap.after(x);new MutationObserver((m,o)=>{const r=document.getElementById("dc-root");if(r&&r.childElementCount){snap.remove();o.disconnect()}}).observe(document.body,{childList:true,subtree:true})})();`;
  // His logic finds its elements by data-* hooks across the document; in the snapshot they're renamed, so the live page's
  // first lookups (the scroll rail, the header) can't land on the copy it is about to replace.
  return html
    .replace(/ data-(board|chat|dot|fill|hdr|hub|node|packets|pct|rail|term)=/g, " data-snap-$1=")
    .replace('<div id="dc-root">', '<div id="jxn-snap">')
    .replace(/<\/body>/, () => `<script type="application/json" id="jxn-tpl">${JSON.stringify(xdc).replace(/</g, "\\u003c")}</script>\n${logic}\n<script>${boot}</script>\n<script src="${runtime}"></script>\n</body>`);
}

export async function unbundle(names = Object.keys(PAGES)) {
  mkdirSync(ASSETS, { recursive: true });
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
  try {
    for (const name of names) {
      const { src, path, live: isLive } = PAGES[name];
      const html = readFileSync(src, "utf8");
      const files = manifestAssets(html);
      if (isLive) {
        mkdirSync(NAMED_DIR, { recursive: true });
        for (const [file, uuid] of Object.entries(NAMED)) writeFileSync(new URL(file, NAMED_DIR), files[uuid].bytes);
      }
      let out = withFiles(await snapshot(browser, html, path));
      if (name === "404") out = out.replace('<span class="sc-interp">/jxn-path-marker</span>', '<span class="sc-interp" id="jxn-path">/missing-page</span>');
      if (/jxn-path-marker/.test(out)) throw new Error("the 404's path isn't where it was");
      out = isLive ? live(out, html, files) : out.replace(/<\/body>/, () => `<script>${SITE_SCRIPT}</script>\n</body>`);
      out = out.replace("<!DOCTYPE html>\n", `<!DOCTYPE html>\n<!-- jxn-static: unbundled from ${sha256(html)} by landing/jxn-pages/unbundle.mjs; don't edit -->\n`);
      writeFileSync(new URL(`${name}.html`, OUT), out);
      console.log(`jxn-static/${name}.html  ${(out.length / 1024).toFixed(0)} KB  (export ${(html.length / 1024).toFixed(0)} KB)`);
    }
  } finally {
    await browser.close();
  }
  // After a full run, files no page refers to any more go.
  if (names.length === Object.keys(PAGES).length) {
    const used = Object.keys(PAGES).map((n) => readFileSync(new URL(`${n}.html`, OUT), "utf8")).join("");
    for (const f of readdirSync(ASSETS)) if (!used.includes(ASSET_PATH + f)) { rmSync(new URL(f, ASSETS)); console.log(`removed ${f}`); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await unbundle(process.argv.slice(2).length ? process.argv.slice(2) : undefined);
