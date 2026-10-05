// The board's log from the web (#3401): board info's "This board" downloads it as JSON Lines, the lines `atteo export`
// writes (#3378): one entry per line, oldest first, reactions on each. A member's file holds only what they can see
// (another's Just mine message isn't in it). 1280 for the owner, 390 for the other member, no sideways scroll. The
// encrypted board's download is checked in e2e-web.mjs. BASE, ADMIN_KEY, PW_CHROME.
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": process.env.ADMIN_KEY || "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), A = `xa${run}`, B = `xb${run}`;
for (const u of [A, B]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true" });
const board = (await ops("boards", { user: A, title: `Export ${run}` })).board.id;
await ops("members", { board, user: B });
const ck = {}; for (const u of [A, B]) ck[u] = (await ops("sessions", { user: u })).cookie;
const api = (u, path, body) => fetch(`${BASE}${path}`, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", cookie: ck[u] }, body: body ? JSON.stringify(body) : undefined });
const post = async (u, body) => { const j = await (await api(u, `/api/boards/${board}/entries`, body)).json(); const s = j.entry?.seq; if (!s) throw new Error(`post failed: ${JSON.stringify(j).slice(0, 200)}`); return s; };
const e1 = await post(A, { text: `first ${run}` });
const e2 = await post(B, { text: `second ${run}`, reply_to: e1 });
const mine = await post(A, { text: `just mine ${run}`, own: true });
const e3 = await post(A, { text: `third ${run} <b>"quoted"</b>` });
await api(B, `/api/boards/${board}/entries/${e1}/react`, { emoji: "👍" });

let fails = 0; const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const open = async (u, viewport) => {
  const ctx = await b.newContext({ viewport, acceptDownloads: true }); const [k, ...v] = ck[u].split(";")[0].split("=");
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage(), errors = []; p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${BASE}/b/${board}`); return { p, errors };
};
// Members & access → This board → Download the log; the saved file, read back as lines.
const download = async (p, phone) => {
  if (phone) await p.locator("#info-btn").click();
  await p.locator('[data-open="invite"]').first().click(); await p.locator("#log-export").waitFor();
  const [dl] = await Promise.all([p.waitForEvent("download"), p.locator("#log-export").click()]);
  const text = await readFile(await dl.path(), "utf8");
  return { name: dl.suggestedFilename(), text, lines: text.split("\n").filter(Boolean).map((l) => JSON.parse(l)) };
};

// The owner, desktop: everything, oldest first, as the entries API has it.
const D = await open(A, { width: 1280, height: 860 });
const d = await download(D.p);
const seqs = d.lines.map((e) => e.seq);
check(new RegExp(`^atteo-${board}-\\d{4}-\\d{2}-\\d{2}\\.jsonl$`).test(d.name), `it saves as a dated .jsonl file (${d.name})`);
check(d.text.endsWith("\n") && d.text.split("\n").length === d.lines.length + 1, "one JSON object per line, newline-terminated");
check([e1, e2, mine, e3].every((s) => seqs.includes(s)) && seqs.every((s, i) => !i || s > seqs[i - 1]), `every entry, oldest first (${seqs.join(" ")})`);
const one = d.lines.find((e) => e.seq === e1), two = d.lines.find((e) => e.seq === e2), three = d.lines.find((e) => e.seq === e3);
check(one?.text === `first ${run}` && one.author === A && typeof one.ts === "number", "a line is the entry: text, author, time");
check(two?.reply_to === e1 && one?.reactions?.some((r) => r.emoji === "👍" && r.users?.includes(B)), `replies and reactions ride along (${JSON.stringify(one?.reactions)})`);
check(three?.text === `third ${run} <b>"quoted"</b>`, "the text is as written (JSON-escaped, not HTML)");
const st = await D.p.locator("#log-export-st").innerText();
check(st === `${d.lines.length} entries`, `the status says how many (${st})`);
const api0 = await (await api(A, `/api/boards/${board}/entries?after=0&limit=500`)).json();
check(JSON.stringify(api0.entries.map((e) => e.seq)) === JSON.stringify(seqs), "the same entries as the API, the CLI's source");

// The other member, phone: not A's Just mine message.
const M = await open(B, { width: 390, height: 844 });
const m = await download(M.p, true);
const mseqs = m.lines.map((e) => e.seq);
check([e1, e2, e3].every((s) => mseqs.includes(s)) && !mseqs.includes(mine) && !m.text.includes(`just mine ${run}`), `phone: B's file leaves out A's Just mine message (${mseqs.join(" ")})`);
check(await M.p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "phone: no sideways scroll");
check(!D.errors.length && !M.errors.length, `no page errors ${[...D.errors, ...M.errors].join(" | ")}`);
await b.close(); console.log(fails ? `${fails} FAILED` : "board export: all passed"); process.exit(fails ? 1 : 0);
