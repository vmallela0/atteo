// E2E Phase 0 (vedu #5452): every board says at the top of its conversation whether it's end-to-end encrypted or
// readable by Atteo's servers, and one tap explains it and lists who can read it (members' agents, Slack channels). The
// explainer is a real modal: opaque and the topmost thing on screen, over an empty board's buttons and over messages
// alike. Plain and sealed boards, empty and with messages, light and dark, desktop and phone. The new-board checkbox
// says what works on encrypted boards today. No page errors. BASE, ADMIN_KEY.
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE = (process.env.BASE || "http://localhost:8787").replace(/\/$/, "");
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": process.env.ADMIN_KEY || "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), A = `pv${run}`, B = `pw${run}`;
for (const u of [A, B]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true" });
const mk = async (title, encrypted) => (await ops("boards", { user: A, title: `${title} ${run}`, ...(encrypted ? { encrypted: true } : {}) })).board.id;
const boards = { "plain-empty": await mk("Plain", false), "plain-full": await mk("Busy", false), "sealed-empty": await mk("Sealed", true), "sealed-full": await mk("Vault", true) };
for (const id of Object.values(boards)) await ops("members", { board: id, user: B });
const tokB = (await ops("tokens", { user: B })).token;
const api = (path, body) => fetch(`${BASE}${path}`, { method: "POST", headers: { authorization: `Bearer ${tokB}`, "content-type": "application/json" }, body: JSON.stringify(body) });
// B's agent shows up on the plain boards: a session on them.
const sid = (await (await api("/api/sessions", { suggest: "scout", client: "Claude Code" })).json()).session?.id;
for (const id of [boards["plain-empty"], boards["plain-full"]]) await api(`/api/sessions/${sid}/boards`, { board: id });
// Messages under the dialog: plain notes, and on the sealed board envelopes this browser can't open (they still render).
for (let i = 1; i <= 12; i++) await api(`/api/boards/${boards["plain-full"]}/entries`, { type: "note", text: `Status update ${i}: the migration is ${i * 8}% done and the checks are green.` });
for (let i = 1; i <= 8; i++) await api(`/api/boards/${boards["sealed-full"]}/sealed`, { payload: JSON.stringify({ v: 1, recipients: [{ kid: "k", wrap: "AAAA" }], ct: "AAAA", iv: "AAAA" }) });

let fails = 0;
const check = (ok, m) => { console.log(`${ok ? "✓" : "✗"} ${m}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const ck = (await ops("sessions", { user: A })).cookie.split(";")[0];
const [k, ...v] = ck.split("=");
const errors = [];
const shots = [];
for (const [w, h, size] of [[1280, 860, "desktop"], [390, 844, "phone"]]) {
  for (const scheme of ["light", "dark"]) {
    const ctx = await b.newContext({ viewport: { width: w, height: h }, colorScheme: scheme });
    await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
    const p = await ctx.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    for (const [name, id] of Object.entries(boards)) {
      const tag = `${name} ${size} ${scheme}`, sealed = name.startsWith("sealed");
      await p.goto(`${BASE}/b/${id}`);
      const badge = p.locator(".e2e-badge").first();
      if (!sealed) {
        // A regular board shows no badge at the top of its conversation (vedu #6553).
        await p.locator("#thread").waitFor({ timeout: 8000 }).catch(() => {});
        check((await p.locator(".privacy-note, .e2e-badge").count()) === 0, `${tag}: no "Readable by Atteo's servers" badge`);
        continue;
      }
      await badge.waitFor({ timeout: 8000 }).catch(() => {});
      const label = await badge.innerText().catch(() => "");
      check(sealed ? label.includes("End-to-end encrypted") : label.includes("Readable by Atteo's servers"), `${tag}: the conversation starts with "${label.trim()}"`);
      await badge.click();
      const dlg = p.locator("#privacy-info");
      await dlg.waitFor({ state: "visible", timeout: 4000 }).catch(() => {});
      await p.waitForFunction(() => { const d = document.getElementById("privacy-info"); return d?.open && d.getAnimations().every((a) => a.playState !== "running"); }, null, { timeout: 3000 }).catch(() => {});
      // A real modal: in the top layer, opaque, and what's under its middle (and its text) is the dialog itself.
      const top = await p.evaluate(() => {
        const d = document.getElementById("privacy-info"), r = d.getBoundingClientRect();
        const at = (x, y) => document.elementFromPoint(x, y)?.closest("dialog") === d;
        const texts = [...d.querySelectorAll("p, li, h2")].map((el) => el.getBoundingClientRect()).filter((q) => q.width && q.height);
        const bg = getComputedStyle(d).backgroundColor, a = /rgba\([^)]*,\s*([\d.]+)\)/.exec(bg);
        return { modal: d.matches(":modal"), center: at(r.left + r.width / 2, r.top + r.height / 2), text: texts.every((q) => at(q.left + Math.min(20, q.width / 2), q.top + q.height / 2)), opaque: !a || +a[1] === 1, opacity: getComputedStyle(d).opacity, bg, inView: r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight + 1 };
      });
      check(top.modal && top.center && top.text, `${tag}: the dialog is the topmost element at its center and over each line of its text (modal ${top.modal}, center ${top.center}, text ${top.text})`);
      check(top.opaque && top.opacity === "1", `${tag}: …and opaque (${top.bg}, opacity ${top.opacity})`);
      check(top.inView, `${tag}: …and fits on screen`);
      const t = await dlg.innerText().catch(() => "");
      if (sealed) {
        check(/can't read them/.test(t) && /still sees the board's name/.test(t) && /Not available here yet/.test(t) && /Members' devices/.test(t), `${tag}: explained honestly: what's encrypted, what Atteo still sees, what doesn't work yet, readers are members' devices`);
      } else {
        check(/isn't end-to-end encrypted/.test(t) && /Atteo staff don't look at boards/.test(t) && /Atteo's servers/.test(t), `${tag}: explains it with the staff promise, and lists Atteo's servers as a reader`);
        check(t.includes(B), `${tag}: the readers list names the agent on the board`);
      }
      check((await dlg.locator('a[href="/privacy"]').count()) === 1, `${tag}: …with a link to the privacy policy`);
      check(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${tag}: no sideways page scroll`);
      const path = `${SHOTS_DIR}/privacy-badge-${name}-${size}-${scheme}.png`;
      await p.screenshot({ path });
      shots.push(path);
      await p.keyboard.press("Escape");
      check(await dlg.evaluate((d) => !d.open).catch(() => false), `${tag}: Escape closes it`);
    }
    if (size === "desktop" && scheme === "light") {
      await p.goto(`${BASE}/`);
      const copy = await p.evaluate(() => document.querySelector('#new-board input[name="encrypted"]')?.closest("label")?.innerText ?? "");
      check(/Works on the web, in the app and in the atteo CLI/.test(copy) && !/through the atteo CLI;/.test(copy), `the new-board checkbox says what works today (${JSON.stringify(copy.slice(0, 80))})`);
    }
    await ctx.close();
  }
}
check(!errors.length, `no page errors${errors.length ? `: ${errors.slice(0, 2).join(" | ")}` : ""}`);
await b.close();
console.log(`screenshots: ${SHOTS_DIR}/privacy-badge-*.png (${shots.length})`);
console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
