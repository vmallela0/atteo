// Pasted rich text shows as text (vedu #5225): files a Mac pasted as RTF/RTFD, named like 'rich text with attachments
// -RTFD- data' (-2, -3…), render as one quoted "Pasted text" block, a line per file, never as file cards. The words come
// from ?format=text and are set as text (markup in them stays text); each line keeps a download link to its original.
// A file whose bytes hold no RTF shows its name. Messages that arrive live fill in too.
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), A = `rtf${run}`;
await ops("users", { name: A, email: `${A}@example.com`, verified: "true" });
const board = (await ops("boards", { user: A, title: "Pasted" })).board.id;
const cookie = (await ops("sessions", { user: A })).cookie;
let fails = 0; const check = (ok, m) => { console.log(`${ok ? "✓" : "✗"} ${m}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const ctx = await b.newContext({ viewport: { width: 1100, height: 800 } }); const [k, ...v] = cookie.split(";")[0].split("="); await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
const p = await ctx.newPage(); const errors = []; p.on("pageerror", (e) => errors.push(e.message));
await p.goto(`${BASE}/b/${board}`); await p.waitForSelector("#composer-text");

// A real flat RTFD from AppKit (444 bytes, like the ones in #5225), a Cocoa RTF with emoji and accents, one with markup
// in its words, and one that isn't RTF at all.
const FLAT = "cnRmZAAAAAADAAAAAgAAAAcAAABUWFQucnRmAQAAAC5pAQAAKwAAAAEAAABhAQAAe1xydGYxXGFuc2lcYW5zaWNwZzEyNTJcY29jb2FydGYyOTA3Clxjb2NvYXRleHRzY2FsaW5nMFxjb2NvYXBsYXRmb3JtMHtcZm9udHRibFxmMFxmbmlsXGZjaGFyc2V0MCBIZWx2ZXRpY2FOZXVlO30Ke1xjb2xvcnRibDtccmVkMjU1XGdyZWVuMjU1XGJsdWUyNTU7fQp7XCpcZXhwYW5kZWRjb2xvcnRibDs7fQpccGFyZFx0eDU2MFx0eDExMjBcdHgxNjgwXHR4MjI0MFx0eDI4MDBcdHgzMzYwXHR4MzkyMFx0eDQ0ODBcdHg1MDQwXHR4NTYwMFx0eDYxNjBcdHg2NzIwXHBhcmRpcm5hdHVyYWxccGFydGlnaHRlbmZhY3RvcjAKClxmMFxmczI2IFxjZjAgZGVwbG95IGlzIGdyZWVuIFx1YzBcdTk5ODkgXAptZXJnaW5nIG5vd30BAAAAIwAAAAEAAAAHAAAAVFhULnJ0ZhAAAABqJMVqtgEAAAAAAAAAAAAA";
const COCOA = "{\\rtf1\\ansi\\ansicpg1252\\cocoartf2907{\\fonttbl\\f0\\fnil\\fcharset0 HelveticaNeue;}{\\colortbl;\\red255\\green255\\blue255;}\n\\f0\\fs26 \\cf0 Ship the caf\\'e9 fix today \\uc0\\u55357 \\u56960 \\\n\\\nSecond paragraph.}";
const HOSTILE = "{\\rtf1\\ansi <img src=x id=pwn> and <b>bold</b>}";
const N = "rich text with attachments -RTFD- data";
const post = (files, text = "") => p.evaluate(async ([board, files, text]) => {
  const fd = new FormData(); if (text) fd.append("text", text);
  for (const f of files) fd.append("file", new File([f.b64 ? Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0)) : f.text], f.name, { type: "application/octet-stream" }));
  return (await fetch(`/api/boards/${board}/upload`, { method: "POST", body: fd })).ok;
}, [board, files, text]);
check((await post([{ name: N, b64: FLAT }, { name: `${N}-2`, text: COCOA }, { name: `${N}-3`, text: HOSTILE }, { name: `${N}-4`, text: "\x9a\x11 not rich text at all" }])), "four pasteboard files post as one message");
await p.reload(); await p.waitForSelector("#thread .entry blockquote.pasted");

const e1 = p.locator("#thread .entry", { has: p.locator("blockquote.pasted") }).first();
await p.waitForFunction(() => document.querySelectorAll("#thread .pasted-t.ok,#thread .pasted-t.na").length >= 4, null, { timeout: 8000 }).catch(() => {});
const lines = await e1.locator(".pasted-t").evaluateAll((els) => els.map((e) => ({ t: e.textContent, ok: e.classList.contains("ok") })));
check((await e1.locator("blockquote.pasted").count()) === 1 && lines.length === 4, `one quoted block with a line per file (${lines.length})`);
check((await e1.locator(".pasted-h").textContent()) === "Pasted text", "it's labelled Pasted text");
check(lines[0]?.ok && lines[0].t === "deploy is green ✅\nmerging now", `a flat RTFD shows its words with its line break (${JSON.stringify(lines[0]?.t)})`);
check(lines[1]?.ok && lines[1].t === "Ship the café fix today 🚀\n\nSecond paragraph.", `Cocoa RTF: accents, emoji and paragraphs (${JSON.stringify(lines[1]?.t)})`);
check(lines[2]?.ok && lines[2].t === "<img src=x id=pwn> and <b>bold</b>" && (await p.locator("#pwn").count()) === 0 && (await e1.locator(".pasted b, .pasted img").count()) === 0, "markup in the words stays text");
check(!lines[3]?.ok && lines[3]?.t === `${N}-4`, `bytes with no RTF show the file's name (${JSON.stringify(lines[3]?.t)})`);
check((await e1.locator(".file, .mchips, .mcap").count()) === 0, "no file cards");
check(!/Shared 4 files/.test((await e1.locator(".body").textContent()) || ""), "no 'Shared 4 files' caption over the quote");
const dl = await e1.locator("a.pasted-dl").evaluateAll((as) => as.map((a) => [a.getAttribute("download"), a.getAttribute("href")]));
check(dl.length === 4 && dl[1][0] === `${N}-2` && /\/image\?name=rich%20text/.test(dl[1][1]), "each line links to download its original");
const orig = await p.evaluate(async (h) => { const r = await fetch(h); return [r.headers.get("content-type"), r.headers.get("content-disposition")]; }, dl[1][1]);
check(orig[0] === "application/octet-stream" && /^attachment/.test(orig[1] || ""), "the original is still served only as a download");
const st = await p.evaluate(async (h) => (await fetch(h + "&format=text")).status, dl[3][1]);
check(st === 422, `?format=text on bytes with no RTF is 422 (${st})`);
const font = await e1.locator(".pasted-t").first().evaluate((el) => [getComputedStyle(el).fontSize, getComputedStyle(el.closest(".entry").querySelector(".body") || document.body).fontSize]);
check(font[0] === font[1] || parseFloat(font[0]) >= 13, `the words are at normal text size (${font.join(" vs ")})`);
await e1.screenshot({ path: `${SHOTS_DIR}/pasted-rtf.png` });

// A pasted file in a message that arrives live (no reload) fills in too, and a lone one is the same block.
check((await post([{ name: `${N}-5`, text: "{\\rtf1\\ansi Live one \\u9989 }" }])), "a single pasted file posts");
const live = await p.waitForFunction(() => [...document.querySelectorAll("#thread .pasted-t.ok")].some((e) => e.textContent === "Live one ✅"), null, { timeout: 8000 }).then(() => true).catch(() => false);
check(live, "a live-arriving message's pasted text fills in");

check(errors.length === 0, `no page errors ${errors.join(" | ")}`);
await b.close(); console.log(fails ? `${fails} FAILED` : "all pasted-rtf checks passed");
process.exit(fails ? 1 : 0);
