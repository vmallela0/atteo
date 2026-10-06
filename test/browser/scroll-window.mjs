// A bounded conversation on a long board (jxn #1365, on rail-cap for #1366/#1367): ~400 messages; far ones become
// placeholders, so the page holds a bounded number of messages; jumps, links, #refs, the rail and threads bring back
// what they need; new messages ease in, never push you when you're scrolled up, and the pill counts them.
import { chromium } from "playwright-core";
import { until, stable } from "./lib/wait.mjs";
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), P = `sw${run}`, V = `sv${run}`;
for (const u of [P, V]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true", display: { mode: "developer" } });
const board = (await ops("boards", { user: P, title: `Window ${run}` })).board.id; await ops("members", { board, user: V });
const ckP = (await ops("sessions", { user: P })).cookie, ckV = (await ops("sessions", { user: V })).cookie;
const post = async (ck, text, reply_to) => { const r = await fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { "content-type": "application/json", cookie: ck }, body: JSON.stringify(reply_to ? { text, reply_to } : { text }) }); const j = await r.json(); return j.entry?.seq ?? j.seq; };
const N = 400, words = "the quick brown fox jumps over a lazy dog while agents talk about the retry limit and the release plan".split(" ");
const line = (i) => Array.from({ length: 6 + (i * 7) % 40 }, (_, k) => words[(i + k) % words.length]).join(" ");
const S = {}; // named seqs
// The messages are independent except for the replies and #ref. Create independent runs concurrently, bounded so the
// local Worker isn't flooded; returned seqs keep every named assertion exact even if requests finish out of order.
const seeds = Array.from({ length: N - 3 }, (_, x) => x + 1).map((i) => {
  if (i === 40) return ["forYou", `@${P} this one is for you ${run}`];
  if (i === 100) return ["root", `Thread root ${run}: what should the retry limit be?`];
  if (i === 20) return ["target", `Ref target ${run}: the old decision`];
  if (i >= 34 && i <= 39) return [null, "```mermaid\nflowchart TD\n A[Start " + i + "] --> B[Plan] --> C[Build] --> D[Ship]\n```"]; // grow when drawn (#4648)
  return [null, `message ${i}: ${line(i)}${i % 9 === 0 ? "\n\n" + line(i + 3) + "\n" + line(i + 5) : ""}`];
});
for (let i = 0; i < seeds.length; i += 20) await Promise.all(seeds.slice(i, i + 20).map(async ([key, text]) => { const seq = await post(ckV, text); if (key) S[key] = seq; }));
[S.kid1, S.kid2, S.ref] = await Promise.all([
  post(ckV, `First answer: three ${run}`, S.root), post(ckV, `Late answer: five ${run}`, S.root), post(ckV, `See #${S.target} for the old decision`),
]);
let fails = 0; const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
async function open(path = "", opts = {}) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, ...opts }); const [k, ...v] = ckP.split(";")[0].split("="); await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage(); p.errors = []; p.on("pageerror", (e) => p.errors.push(e.message)); p.seen = [];
  p.on("request", (r) => { if (r.url().endsWith("/seen") && r.method() === "POST") try { p.seen.push(JSON.parse(r.postData()).seq) } catch {} });
  await p.goto(`${BASE}/b/${board}${path}`); await until(() => p.evaluate(() => document.querySelectorAll("#thread>.entry").length > 0 && document.querySelectorAll("#thread>.ghost").length > 0));
  await stable(() => p.evaluate(() => { const sc = document.getElementById("thread-scroll"); return [sc.scrollTop, sc.scrollHeight, document.querySelectorAll("#thread>.entry").length]; })); return { ctx, p };
}
const stats = (p) => p.evaluate(() => ({ live: document.querySelectorAll("#thread>.entry").length, ghosts: document.querySelectorAll("#thread>.ghost").length, more: !!document.getElementById("load-earlier"), first: +document.querySelector("#thread>[data-seq]")?.dataset.seq }));
const centred = (p, seq) => p.evaluate((s) => { const el = document.getElementById("e" + s), sc = document.getElementById("thread-scroll"); if (!el) return 1e9; const r = el.getBoundingClientRect(), q = sc.getBoundingClientRect(); return Math.abs((r.top + r.bottom) / 2 - (q.top + q.bottom) / 2) }, seq);
// A jump has landed once its message is a real one near the middle of the view (or after 6 s, and the check says how far off).
const landed = (p, seq, off = 100) => p.waitForFunction(({ s, off }) => { const el = document.getElementById("e" + s), sc = document.getElementById("thread-scroll"); if (!el || !el.classList.contains("entry")) return false; const r = el.getBoundingClientRect(), q = sc.getBoundingClientRect(); return Math.abs((r.top + r.bottom) / 2 - (q.top + q.bottom) / 2) < off; }, { s: seq, off }, { timeout: 6000, polling: 100 }).then(() => stable(() => centred(p, seq), 3000, 300), () => {});
const jumpTo = async (p, seq) => { await p.evaluate((s) => window.BOARD_CTX.jump(s), seq); await landed(p, seq); };

// 1. Opening and going all the way back: older messages load as you scroll up, the page never holds more than a window.
// (Alone: it measures frame times while scrolling.) Then 2, 3 and 3b, which only read, run side by side with 4's reduced-motion
// pass; 4's pill count comes last, alone.
const t1 = Date.now();
{ const { ctx, p } = await open();
  await until(async () => { const s = await stats(p); return s.live <= 90 && s.ghosts > 0; });
  let s = await stats(p); check(s.live <= 90 && s.ghosts > 0, `opening: ${s.live} messages on the page, ${s.ghosts} placeholders`);
  await p.locator("#thread-scroll").hover({ position: { x: 300, y: 300 } });
  let maxLive = 0, frames = [];
  await p.evaluate(() => { window.__fr = []; let t0 = performance.now(); const f = (t) => { window.__fr.push(t - t0); t0 = t; if (window.__fr.length < 4000) requestAnimationFrame(f) }; requestAnimationFrame(f) });
  for (let i = 0; i < 160 && (s.more || s.first > 1); i++) { await p.mouse.wheel(0, -900); await p.waitForTimeout(90); if (i % 8 === 0) { s = await stats(p); maxLive = Math.max(maxLive, s.live) } }
  await stable(() => stats(p)); s = await stats(p); maxLive = Math.max(maxLive, s.live);
  // The last wheel's smooth-scroll animation can still be running. Chrome carries its tail over to the next jump, which
  // moved the view a few px after the jumps below (#3660's trail: scrollTop 12377 → 12368 over 130ms, before any
  // placeholder came back). Wait until the thread has had no scroll for 300ms.
  await p.evaluate(() => new Promise((done) => { const sc = document.getElementById("thread-scroll"); let t = setTimeout(fin, 300); const on = () => { clearTimeout(t); t = setTimeout(fin, 300); }; function fin() { sc.removeEventListener("scroll", on); done(); } sc.addEventListener("scroll", on); setTimeout(fin, 3000); }));
  frames = await p.evaluate(() => window.__fr.slice(5).sort((a, b) => a - b));
  const p95 = frames[Math.floor(frames.length * 0.95)] || 0;
  check(!s.more && s.first === 1, `scrolling up loads older messages on its own, back to #1 (first on page #${s.first})`);
  check(maxLive <= 130, `the page held at most ${maxLive} messages while scrolling through ${N}`);
  check(s.live + s.ghosts >= N - 2, `every message is on the page or a placeholder (${s.live} + ${s.ghosts})`);
  check(p95 < 70, `scrolling stays smooth: 95% of frames under ${Math.round(p95)}ms`);
  check(await p.locator(`#e${S.forYou}`).count() === 1, `the message for you stays on the page however far you scroll`);
  // Placeholders coming back don't move what you're looking at: land among them, then watch the message at the top of the view
  // (messages below it in view can still settle to their real heights, as off-screen ones always have since rail-cap).
  for (const f of [0.3, 0.6]) {
    const a0 = await p.evaluate((f) => { const sc = document.getElementById("thread-scroll"); sc.scrollTop = sc.scrollHeight * f; const q = sc.getBoundingClientRect();
      const el = [...document.getElementById("thread").children].find((x) => x.getBoundingClientRect().bottom > q.top); return { seq: el.dataset.seq, ghost: el.classList.contains("ghost"), y: el.getBoundingClientRect().top } }, f);
    await p.evaluate((s) => { window.__trail = []; const t0 = performance.now(); const sc = document.getElementById("thread-scroll"); const tick = () => { const el = document.getElementById("e" + s) || document.getElementById("g" + s); window.__trail.push([Math.round(performance.now() - t0), el && Math.round(el.getBoundingClientRect().top), el?.className.split(" ")[0], Math.round(sc.scrollTop), Math.round(sc.scrollHeight), document.querySelectorAll("#thread>.ghost").length, document.querySelectorAll("#thread>.entry").length]); if (window.__trail.length < 400 && !window.__trailStop) requestAnimationFrame(tick); }; window.__trailStop = false; tick(); }, a0.seq);
    const look = (s) => p.evaluate((s) => { const el = document.getElementById("e" + s) || document.getElementById("g" + s); return el && { y: el.getBoundingClientRect().top, live: el.classList.contains("entry"), ghosts: [...document.querySelectorAll("#thread>.ghost")].filter((g) => { const r = g.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight }).length } }, s);
    // Settled: it and what's in view are real, the page has nothing left to bring back within its 1.5-screen band (a fill
    // above the view is what could still move it), and it then holds still for 400ms.
    const band = () => p.evaluate(() => { const sc = document.getElementById("thread-scroll"), q = sc.getBoundingClientRect(), H = sc.clientHeight;
      return [...document.querySelectorAll("#thread>.ghost")].filter((g) => { const r = g.getBoundingClientRect(); return r.bottom > q.top - 1.5 * H && r.top < q.bottom + 1.5 * H }).length });
    await until(async () => { const a = await look(a0.seq); return a && a.live && a.ghosts === 0 && (await band()) === 0; }, 8000); await stable(() => look(a0.seq), 4000, 400);
    const a1 = await p.evaluate((s) => { const el = document.getElementById("e" + s) || document.getElementById("g" + s); return el && { y: el.getBoundingClientRect().top, live: el.classList.contains("entry"), ghosts: [...document.querySelectorAll("#thread>.ghost")].filter((g) => { const r = g.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight }).length } }, a0.seq);
    // If it moved, print what the page did meanwhile (ms, its top, entry/ghost, scrollTop, scrollHeight, placeholders, messages).
    if (!(a1 && Math.abs(a1.y - a0.y) <= 3) || process.env.TRAIL) { const tr = await p.evaluate(() => { window.__trailStop = true; return window.__trail; }); let prev = ""; for (const x of tr) { const k = JSON.stringify(x.slice(1)); if (k !== prev) console.log("  trail", f, JSON.stringify(x)); prev = k; } }
    check(a0.ghost && a1 && a1.live && a1.ghosts === 0 && Math.abs(a1.y - a0.y) <= 3, `landing among placeholders at ${f * 100}%: they come back and #${a0.seq} stays put (${Math.round(a0.y)} → ${a1 ? Math.round(a1.y) : "gone"})`);
  }
  check(!p.errors.length, `no page errors ${p.errors.join(" | ")}`); await ctx.close(); }

const t2 = Date.now();
// Only newMessages posts, so its two passes go one after the other (the pill counts what arrives while you're scrolled
// up); the jumps, the deep link and the phone only read, so they run beside them.
await Promise.all([jumps(), deepLink(), phone(), newMessages("reduce").then(() => newMessages("no-preference"))]);
const t4 = Date.now();
// 2. Jumps to messages that aren't on the page: search's jump, a #ref chip, a link, the rail and a thread.
async function jumps() { const { ctx, p } = await open();
  await jumpTo(p, 5);
  check((await p.locator("#e5.entry").count()) === 1 && (await centred(p, 5)) < 120, `a jump to #5 (never loaded) brings it in, centred (${Math.round(await centred(p, 5))}px off)`);
  await jumpTo(p, S.ref);
  await jumpTo(p, 200);
  check((await centred(p, 200)) < 120, `a jump to #200 lands centred (${Math.round(await centred(p, 200))}px off)`);
  // Centering can finish before ghostSoon's deferred eviction; wait for the cap and the specific placeholders.
  await until(async () => (await stats(p)).live <= 130 && (await p.locator("#g8").count()) === 1 && (await p.locator(`#g${S.target}`).count()) === 1);
  let s = await stats(p); check(s.live <= 130, `after jumping around, ${s.live} messages on the page`);
  check((await p.locator(`#g8`).count()) === 1 && (await p.locator(`#g${S.target}`).count()) === 1, `messages left behind became placeholders (#8, #${S.target})`);
  await jumpTo(p, S.ref);
  await p.locator(`#e${S.ref} a.ref`).first().click(); await landed(p, S.target, 140);
  check((await p.locator(`#e${S.target}.entry`).count()) === 1 && (await centred(p, S.target)) < 140, `a #ref chip jumps to #${S.target}, brought back from a placeholder`);
  // A message that stays on the page (it's for you) while its neighbours became placeholders: the jump lands on it and it
  // stays in the middle as they come back around it, though the diagrams above it draw (and grow) a moment after they do
  // (it used to be carried off as they filled in, jxn #4648).
  await jumpTo(p, S.ref);
  await until(() => p.evaluate((s) => !!document.getElementById("e" + s) && !!document.getElementById("g" + (s - 1)) && !!document.getElementById("g" + (s + 1)), S.forYou), 8000);
  const ghostsNear = await p.evaluate((s) => !!document.getElementById("g" + (s - 1)) && !!document.getElementById("g" + (s + 1)), S.forYou);
  await p.evaluate((s) => window.BOARD_CTX.jump(s), S.forYou);
  const settled = () => p.evaluate(() => { const sc = document.getElementById("thread-scroll"), q = sc.getBoundingClientRect(); return [...document.querySelectorAll("#thread>.ghost")].filter((g) => { const r = g.getBoundingClientRect(); return r.bottom > q.top && r.top < q.bottom }).length; });
  await until(async () => (await settled()) === 0, 8000); await stable(() => centred(p, S.forYou), 3000, 300);
  const off = Math.round(await centred(p, S.forYou));
  check(ghostsNear && off < 120, `a jump to #${S.forYou} among placeholders lands and stays in the middle as they come back (${off}px off)`);
  // The thread's root and late reply: "2 replies" counts a reply that's a placeholder, and the overlay brings both back.
  await jumpTo(p, S.root);
  await until(async () => /2 replies/.test(await p.locator(`#e${S.root} .thr-sum`).innerText()) && (await p.locator(`#g${S.kid2}`).count()) === 1);
  const sum = await p.locator(`#e${S.root} .thr-sum`).innerText().catch(() => "");
  check(/2 replies/.test(sum) && (await p.locator(`#g${S.kid2}`).count()) === 1, `"2 replies" counts the late reply while it's a placeholder ("${sum.replace(/\s+/g, " ").trim()}")`);
  await p.locator(`#e${S.root} .thr-sum`).click(); await p.locator("dialog.thr-dlg", { hasText: "Late answer" }).waitFor({ timeout: 6000 }).catch(() => {});
  const dl = await p.locator("dialog.thr-dlg").innerText().catch(() => "");
  check(dl.includes("First answer") && dl.includes("Late answer"), `the thread overlay brings back every reply`);
  await p.keyboard.press("Escape"); await until(() => p.evaluate(() => !document.querySelector("dialog.thr-dlg[open]")), 3000);
  // The rail: clicking near its top goes there and the messages come back.
  const rb = await p.locator("#rail").boundingBox(); await p.mouse.click(rb.x + rb.width / 2, rb.y + rb.height * 0.04);
  const inView = () => p.evaluate(() => { const sc = document.getElementById("thread-scroll"), q = sc.getBoundingClientRect(); const els = [...document.querySelectorAll("#thread>.entry,#thread>.ghost")].filter((x) => { const r = x.getBoundingClientRect(); return r.bottom > q.top && r.top < q.bottom }); return { n: els.length, ghosts: els.filter((x) => x.classList.contains("ghost")).length, seq: +els[0]?.dataset.seq } });
  await until(async () => { const v = await inView(); return v.n > 0 && v.ghosts === 0 && v.seq < 60; }, 5000); await stable(inView, 3000, 150);
  const near = await inView();
  check(near.n > 0 && near.ghosts === 0 && near.seq < 60, `the rail goes back to the start (#${near.seq} at the top) and what's in view is real messages`);
  check(!p.errors.length, `no page errors ${p.errors.join(" | ")}`); await ctx.close(); }

// 3. A deep link to a message that's not on the page.
async function deepLink() { const { ctx, p } = await open(`#e12`); await landed(p, 12, 200);
  check((await p.locator("#e12.entry").count()) === 1 && (await centred(p, 12)) < 200, `a link to #12 opens there (${Math.round(await centred(p, 12))}px off centre)`);
  check(!p.errors.length, `no page errors ${p.errors.join(" | ")}`); await ctx.close(); }

// 3b. On a phone: the same window, and a jump still lands.
async function phone() { const { ctx, p } = await open("", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await jumpTo(p, 150);
  await until(async () => { const s = await stats(p); return (await centred(p, 150)) < 140 && s.live <= 130 && s.ghosts > 100; });
  const s = await stats(p);
  check((await centred(p, 150)) < 140 && s.live <= 130 && s.ghosts > 100, `phone: a jump to #150 lands (${Math.round(await centred(p, 150))}px off), ${s.live} messages on the page`);
  check(!p.errors.length, `phone: no page errors ${p.errors.join(" | ")}`); await ctx.close(); }

// 4. New messages: ease in at the bottom; scrolled up, they don't push you and the pill counts them.
async function newMessages(motion) {
  const { ctx, p } = await open("", { reducedMotion: motion });
  const seqA = await post(ckV, `arrives at the bottom ${motion}`); await p.waitForSelector(`#e${seqA}`, { timeout: 8000 });
  const anim = await p.evaluate((s) => getComputedStyle(document.getElementById("e" + s)).animationName, seqA);
  // The next pass opens right after this one: mark this message read, so that one opens at the newest rather than at a
  // "New" line above it.
  if (motion === "reduce") { check(!/entryin/.test(anim), `reduced motion: the new message doesn't move (${anim})`); await fetch(`${BASE}/api/boards/${board}/seen`, { method: "POST", headers: { "content-type": "application/json", cookie: ckP }, body: JSON.stringify({ seq: seqA }) }); }
  else {
    await until(() => p.evaluate(() => { const sc = document.getElementById("thread-scroll"); return sc.scrollHeight - sc.scrollTop - sc.clientHeight < 30 }));
    check(/entryin/.test(anim) && (await p.evaluate(() => { const sc = document.getElementById("thread-scroll"); return sc.scrollHeight - sc.scrollTop - sc.clientHeight < 30 })), `at the bottom, a new message eases in and the view follows it (${anim})`);
  }
  if (motion === "no-preference") {
    await p.locator("#thread-scroll").hover({ position: { x: 300, y: 300 } }); for (let i = 0; i < 4; i++) { await p.mouse.wheel(0, -700); await p.waitForTimeout(120) } await stable(() => p.evaluate(() => [document.getElementById("thread-scroll").scrollTop, document.getElementById("new-pill").innerText, document.querySelectorAll("#thread>.entry").length]), 5000, 150);
    const pin0 = await p.locator("#new-pill").innerText();
    const before = await p.evaluate(() => { const sc = document.getElementById("thread-scroll"), q = sc.getBoundingClientRect(); const el = [...document.querySelectorAll("#thread>.entry")].find((x) => x.getBoundingClientRect().top > q.top); return { top: sc.scrollTop, id: el.id, y: el.getBoundingClientRect().top } });
    await post(ckV, "one while you're up"); await p.locator("#new-pill", { hasText: /^1 new message/ }).waitFor({ timeout: 8000 }).catch(() => {});
    const pill1 = await p.locator("#new-pill").innerText();
    await post(ckV, "two while you're up"); await post(ckV, "three while you're up"); await p.locator("#new-pill", { hasText: /^3 new messages/ }).waitFor({ timeout: 8000 }).catch(() => {}); await stable(() => p.evaluate(() => document.getElementById("thread-scroll").scrollTop), 3000, 200);
    const after = await p.evaluate((id) => ({ top: document.getElementById("thread-scroll").scrollTop, y: document.getElementById(id)?.getBoundingClientRect().top }), before.id);
    check(Math.abs(after.top - before.top) <= 2 && Math.abs(after.y - before.y) <= 2, `scrolled up, new messages don't push the conversation (${Math.round(before.y)} → ${Math.round(after.y)})`);
    const pill3 = await p.locator("#new-pill").innerText();
    check(/Jump to latest/.test(pin0) && /^1 new message\b/.test(pill1) && /^3 new messages/.test(pill3), `the pill reads "${pin0}", then "${pill1}", then "${pill3}"`);
    await p.locator("#new-pill").click(); await until(() => p.locator("#thread>.entry", { hasText: "three while you're up" }).isVisible(), 5000);
    check(await p.locator("#thread>.entry", { hasText: "three while you're up" }).isVisible(), `the pill takes you to the newest`);
    const last = await p.evaluate(() => Math.max(...[...document.querySelectorAll("#thread>.entry")].map((x) => +x.dataset.seq)));
    await until(() => Math.max(0, ...p.seen) >= last, 5000); check(Math.max(0, ...p.seen) >= last, `reading to the bottom reports the newest message as seen (#${Math.max(0, ...p.seen)} of #${last})`);
  }
  check(!p.errors.length, `${motion}: no page errors ${p.errors.join(" | ")}`); await ctx.close();
}
await b.close(); console.log(fails ? `${fails} FAILED` : "scroll window: all passed"); process.exit(fails ? 1 : 0);
