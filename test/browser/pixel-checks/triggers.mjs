// Browser check (#1010): board settings, Triggers, against the real /triggers API: list, add (a task containing "bug" → my agent; a daily schedule → a session),
// pause/resume and delete your own; someone else's shows without controls; phones and desktop, light and dark.
import { SHOTS_DIR } from "../lib/shots.mjs";
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { BASE, CHROME, ops, ctxFor } from "./fixture.mjs";
const OUT = `${SHOTS_DIR}/triggers/`; mkdirSync(OUT, { recursive: true });
let fails = 0; const check = (ok, m) => { console.log(`${ok ? "✓" : "✗"} ${m}`); if (!ok) fails++; };
const run = Date.now().toString(36).slice(-4), A = `tia${run}`, B = `tob${run}`;
for (const u of [A, B]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true" });
const board = (await ops("boards", { user: A, title: "Triage" })).board.id; await ops("members", { board, user: B });
const ckA = (await ops("sessions", { user: A })).cookie, ckB = (await ops("sessions", { user: B })).cookie;
const api = (ck, path = "", init = {}) => fetch(`${BASE}/api/boards/${board}/triggers${path}`, { ...init, headers: { cookie: ck, "content-type": "application/json" } }).then((r) => r.json());
const other = (await api(ckB, "", { method: "POST", body: JSON.stringify({ on: "question", match: {}, wake: { user: B }, prompt: "Answer questions about the API.", enabled: true }) })).trigger;
if (!other) throw new Error("could not add the other person's trigger");
const b = await chromium.launch({ executablePath: CHROME });
// The four sizes run side by side, each as its own member of the board (their own triggers, so one size's adds and
// deletes never show up in another's "mine").
await Promise.all([[390, "light"], [320, "dark"], [1280, "dark"], [1280, "light"]].map(([w, scheme], i) => size(w, scheme, i)));
async function size(w, scheme, i) {
  const A = `tia${run}${i}`;
  await ops("users", { name: A, email: `${A}@example.com`, verified: "true" }); await ops("members", { board, user: A });
  const ckA = (await ops("sessions", { user: A })).cookie;
  const tag = `${w} ${scheme}`;
  const ctx = await ctxFor(b, ckA, w, scheme, 900); const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
  const mineNow = async () => ((await api(ckA)).triggers || []).filter((t) => t.created_by === A);
  p.on("dialog", (d) => d.accept());
  await p.goto(`${BASE}/b/${board}`); await p.waitForTimeout(500);
  await p.click('.actions [data-open="invite"]:not([data-goto])'); await p.waitForTimeout(500);
  await p.locator("#acc-triggers").scrollIntoViewIfNeeded();
  check(await p.locator(`#trg-list [data-trg="${other.id}"]`).isVisible(), `${tag}: someone else's trigger is listed`);
  check(!(await p.locator(`#trg-list [data-trg="${other.id}"] [data-trg-do]`).count()), `${tag}: …without Pause / Delete`);
  check((await p.locator(`#trg-list [data-trg="${other.id}"]`).innerText()).includes(`${B}'s agent`), `${tag}: …saying whose agent it wakes`);
  await p.selectOption("#trg-on", "task"); await p.fill("#trg-text", "bug"); await p.fill("#trg-prompt", "Triage the new bug: reproduce it, label it, ask in its thread.");
  await p.click('#trg-new [type="submit"]');
  const listed = async (n) => { for (let k = 0; k < 80 && (await mineNow()).length < n; k++) await p.waitForTimeout(100); };
  await listed(1);
  let mine = await mineNow(); const t1 = mine.find((t) => t.on === "task");
  check(t1 && t1.match.text === "bug" && t1.match.task === "created" && t1.wake.user === A && !t1.wake.session, `${tag}: Add saves {on:task, match:{text:bug, task:created}, wake:{user:${A}}}`);
  await p.selectOption("#trg-on", "schedule");
  check(await p.locator("#trg-at").isVisible() && !(await p.locator("#trg-text").isVisible()), `${tag}: "Every day at" swaps the text box for a time`);
  await p.fill("#trg-at", "08:30"); await p.fill("#trg-prompt", "Post a standup: what changed since yesterday."); await p.click('#trg-new [type="submit"]'); await listed(2);
  mine = await mineNow(); const t2 = mine.find((t) => t.on === "schedule");
  check(t2 && t2.match.at === "08:30", `${tag}: …and saves match:{at:"08:30"}`);
  const row = p.locator(`#trg-list [data-trg="${t1.id}"]`);
  check((await row.innerText()).includes('a new task containing “bug”'), `${tag}: the new trigger reads "When a new task containing “bug”…"`);
  const m = await p.evaluate(() => { const d = document.getElementById("invite"), r = d.getBoundingClientRect(); const out = [...d.querySelectorAll("#acc-triggers *")].filter((x) => { const q = x.getBoundingClientRect(); return q.width && q.right > r.right - 1; }).map((x) => x.className || x.tagName); return { out, sw: d.scrollWidth, cw: d.clientWidth }; });
  check(!m.out.length && m.sw <= m.cw, `${tag}: nothing in Triggers runs past the dialog ${m.out.slice(0, 3).join(",")}`);
  await p.locator("#acc-triggers").screenshot({ path: `${OUT}triggers-${w}-${scheme}.png` });
  await row.locator('[data-trg-do="pause"]').click(); await row.locator('[data-trg-do="resume"]').waitFor({ timeout: 8000 }).catch(() => {});
  check((await mineNow()).find((x) => x.id === t1.id)?.enabled === false && (await row.innerText()).includes("Paused") && await row.locator('[data-trg-do="resume"]').isVisible(), `${tag}: Pause pauses it (Resume shows)`);
  for (const t of [t1, t2]) { await p.locator(`#trg-list [data-trg="${t.id}"] [data-trg-do="delete"]`).click(); await p.locator(`#trg-list [data-trg="${t.id}"]`).waitFor({ state: "detached", timeout: 8000 }).catch(() => {}); }
  check(!(await mineNow()).length && !(await row.count()), `${tag}: Delete removes them`);
  check(!errs.length, `${tag}: no page errors ${errs.join(" | ")}`);
  await ctx.close();
}
// Without the API (a 404), there's no Triggers section.
{ const ctx = await ctxFor(b, ckA, 390, "light"); const p = await ctx.newPage();
  await p.route(/\/triggers$/, (r) => r.fulfill({ status: 404, json: { error: "not found" } }));
  await p.goto(`${BASE}/b/${board}`); await p.waitForTimeout(400); await p.click('.actions [data-open="invite"]:not([data-goto])'); await p.waitForTimeout(400);
  check(!(await p.locator("#acc-triggers").isVisible()) && await p.locator("#acc-members").isVisible(), "no API yet (404): no Triggers section at all"); await ctx.close(); }
await b.close(); console.log(fails ? `${fails} FAILED` : "all trigger checks passed"); process.exit(fails ? 1 : 0);
