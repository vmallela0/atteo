// Pasting rich text (vedu #5209): Notes, Pages, TextEdit or a web page hand the browser their pasteboard types as
// "files" too (Safari names them like 'rich text with attachments -RTFD- data'). Those must never attach: the words
// paste as text (the browser's own paste, not prevented), and only real pictures in the selection attach. A plain
// file paste (Finder, a screenshot) still attaches as before. Covers the composer and the bug report box.
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), A = `paste${run}`;
await ops("users", { name: A, email: `${A}@example.com`, verified: "true" });
const board = (await ops("boards", { user: A, title: "Paste" })).board.id;
const cookie = (await ops("sessions", { user: A })).cookie;
let fails = 0; const check = (ok, m) => { console.log(`${ok ? "✓" : "✗"} ${m}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }); const [k, ...v] = cookie.split(";")[0].split("="); await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
const p = await ctx.newPage(); const errors = []; p.on("pageerror", (e) => errors.push(e.message));
await p.goto(`${BASE}/b/${board}`); await p.waitForSelector("#composer-text");

// Dispatches a paste on `sel` with the given types and files; says whether the page stopped the browser's own paste.
const paste = (sel, spec) => p.evaluate(async ([sel, spec]) => {
  const dt = new DataTransfer();
  for (const [type, data] of Object.entries(spec.types || {})) dt.setData(type, data);
  for (const f of spec.files || []) {
    let body = f.text;
    if (f.png) { const c = document.createElement("canvas"); c.width = 40; c.height = 30; c.getContext("2d").fillRect(0, 0, 40, 30); body = await new Promise((r) => c.toBlob(r, "image/png")); }
    dt.items.add(new File([body], f.name, { type: f.type }));
  }
  const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
  document.querySelector(sel).dispatchEvent(ev);
  return ev.defaultPrevented;
}, [sel, spec]);
const atts = () => p.evaluate(() => [...document.querySelectorAll("#attachments .att")].map((a) => a.querySelector("img")?.alt || a.querySelector(".att-name")?.textContent));
const clear = () => p.evaluate(() => { for (const x of document.querySelectorAll("#attachments [data-att-rm]")) x.click(); });
const blob = (n) => ({ name: n, type: "application/octet-stream", text: "{\\rtf1\\ansi What does Atteo store?}" });
const words = "What does Atteo store?\nWho can read a board?";

// 1) Notes-style: text/plain + text/html + text/rtf and four RTFD blobs → nothing attaches, the words paste.
let prevented = await paste("#composer-text", { types: { "text/plain": words, "text/html": "<p>What does Atteo store?</p>", "text/rtf": "{\\rtf1 x}" }, files: [blob("rich text with attachments -RTFD- data"), blob("rich text with attachments -RTFD- data-2")] });
await p.waitForTimeout(300);
check(!prevented, "rich text: the browser's own paste goes ahead, so the words land as text");
check((await atts()).length === 0, `rich text: no pasteboard blobs attach (${JSON.stringify(await atts())})`);

// 2) Safari can hand only text/plain beside the blobs: their names alone mark them.
prevented = await paste("#composer-text", { types: { "text/plain": words }, files: [blob("rich text with attachments -RTFD- data-3")] });
await p.waitForTimeout(300);
check(!prevented && (await atts()).length === 0, "RTFD blobs named by their pasteboard type never attach, even with only text/plain");

// 3) Rich text with a picture in it: the picture attaches, the words still paste.
prevented = await paste("#composer-text", { types: { "text/plain": words, "text/html": "<p>Q</p><img src=x>" }, files: [blob("rich text with attachments -RTFD- data"), { name: "diagram.png", type: "image/png", png: true }] });
await p.waitForSelector("#attachments:not([hidden]) .att", { timeout: 8000 }).catch(() => {});
const got = await atts();
check(!prevented && got.length === 1 && /diagram/.test(got[0] || ""), `rich text with a picture: only the picture attaches, words paste (${JSON.stringify(got)})`);
await clear();

// 4) A plain file paste (Finder, a screenshot tool): attaches as before, and the browser's paste is stopped.
prevented = await paste("#composer-text", { files: [{ name: "notes.md", type: "text/markdown", text: "# Notes\n" }] });
await p.waitForSelector("#attachments:not([hidden]) .att", { timeout: 8000 }).catch(() => {});
check(prevented && (await atts()).length === 1, `a plain file paste still attaches (${JSON.stringify(await atts())})`);
await clear();

// 5) The bug report box follows the same rule.
await p.evaluate(() => document.querySelector("[data-bug]")?.click());
const bug = await p.waitForSelector("#bug-text", { timeout: 8000 }).then(() => true).catch(() => false);
if (bug) {
  const pics = () => p.evaluate(() => document.querySelectorAll("#bug [data-bug-rm]").length);
  prevented = await paste("#bug-text", { types: { "text/plain": words, "text/html": "<p>Q</p>" }, files: [blob("rich text with attachments -RTFD- data")] });
  await p.waitForTimeout(300);
  check(!prevented && (await pics()) === 0, "bug report: rich text pastes as words, no blob attaches");
} else check(true, "bug report box not on this page (skipped)");

check(errors.length === 0, `no page errors ${errors.join(" | ")}`);
await p.screenshot({ path: `${SHOTS_DIR}/paste-rich.png` });
await b.close(); console.log(fails ? `${fails} FAILED` : "all paste-rich checks passed");
process.exit(fails ? 1 : 0);
