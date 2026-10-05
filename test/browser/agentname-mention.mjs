// @mentioning an agent by the name its person gave it (jxn #1659): the @ menu offers the name, it's a chip in the
// composer, the sent message shows it as that agent's mention right away and after a reload, and the agent's mailbox
// gets it. Developer and Everyday. Also a one-letter name ("v", like vedu's agent), which mustn't eat "@vedu".
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": process.env.ADMIN_KEY || "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
let fails = 0; const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
for (const [mode, name] of [["developer", "HAL"], ["everyday", "v"]]) {
  const run = Date.now().toString(36).slice(-4), P = `nm${run}`, V = `vn${run}`;
  for (const u of [P, V]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true", display: { mode } });
  const board = (await ops("boards", { user: P, title: `Agent names ${run}` })).board.id; await ops("members", { board, user: V });
  const ckP = (await ops("sessions", { user: P })).cookie, ckV = (await ops("sessions", { user: V })).cookie, tokV = (await ops("tokens", { user: V })).token;
  const pr = await fetch(`${BASE}/api/me/profile`, { method: "POST", headers: { "content-type": "application/json", cookie: ckV }, body: JSON.stringify({ agent_name: name }) });
  check(pr.ok, `${mode}: ${V} names their agent "${name}"`);
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } }); const [k, ...v] = ckP.split(";")[0].split("="); await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage(); const errors = []; p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${BASE}/b/${board}`); await p.waitForTimeout(800);
  const ta = p.locator("#composer-text"); await ta.click(); await ta.type("@" + name.slice(0, 1)); await p.waitForTimeout(300);
  const opts = await p.locator("#mention-menu li[role=option]").allInnerTexts();
  const at = opts.findIndex((t) => t.split("\n").some((l) => l.startsWith(`${name} · ${V}'s agent`)));
  check(at >= 0, `${mode}: the @ menu offers "${name} · ${V}'s agent" (${JSON.stringify(opts.map((t) => t.replace(/\n/g, " ")))})`);
  for (let i = 0; i < at; i++) await p.keyboard.press("ArrowDown");
  await p.keyboard.press("Enter"); await ta.type(`can you look ${run}`);
  check((await ta.inputValue()).startsWith(`@${name} can you look`), `${mode}: picking it writes "@${name}" (${await ta.inputValue()})`);
  check(JSON.stringify(await p.locator(".composer .chip.agent").allInnerTexts()) === JSON.stringify([`@${name}`]), `${mode}: "@${name}" is an agent chip in the composer`);
  // Typed by hand next to the person's handle: the name is a chip, "@vedu" stays the person.
  await ta.fill(`@${name} and @${V} both ${run}`); await p.waitForTimeout(150);
  const chips = await p.evaluate(() => [...document.querySelectorAll(".composer .chip")].map((c) => (c.classList.contains("agent") ? "agent:" : "person:") + c.textContent));
  check(JSON.stringify(chips) === JSON.stringify([`agent:@${name}`, `person:@${V}`]), `${mode}: typed by hand, "@${name}" is the agent and "@${V}" the person (${JSON.stringify(chips)})`);
  // A longer word that starts with the name isn't the name: "@HALo" / "@vo" is no chip (opus-d, #1687).
  await ta.fill(`@${name}o and @${name}_x ${run}`); await p.waitForTimeout(150);
  check((await p.locator(".composer .chip").count()) === 0, `${mode}: "@${name}o" and "@${name}_x" aren't chips`);
  await ta.fill(`@${name} can you look ${run}`); await p.keyboard.press("Enter");
  const sent = p.locator("#thread>.entry", { hasText: `can you look ${run}` }).last(); await sent.waitFor({ timeout: 8000 }); await p.waitForTimeout(600);
  const chipNow = async () => sent.locator(`.body .mention.agent[data-user="${V}"]`).innerText().catch(() => "");
  check((await chipNow()) === `@${name}`, `${mode}: the sent message shows "@${name}" as ${V}'s agent right away`);
  await p.reload(); await p.waitForTimeout(800);
  check((await chipNow()) === `@${name}`, `${mode}: …and after a reload`);
  let mail = [];
  for (let i = 0; i < 30 && !mail.some((m) => (m.text || "").includes(`can you look ${run}`)); i++) { mail = (await (await fetch(`${BASE}/api/mailbox?peek=1`, { headers: { authorization: `Bearer ${tokV}` } })).json()).mail ?? []; await p.waitForTimeout(150) }
  check(mail.some((m) => (m.text || "").includes(`can you look ${run}`) && m.kind === "for_your_agent"), `${mode}: ${V}'s agent gets it in its mailbox`);
  // An agent's @ of itself (vedu #2630): highlighted like any mention, live and after a reload, though it reaches no one.
  // The stale-read rule (rest-parity): the agent acks the board before posting.
  await fetch(`${BASE}/api/boards/${board}/entries?after=0&ack=1`, { headers: { authorization: `Bearer ${tokV}` } });
  const sp = await fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { authorization: `Bearer ${tokV}`, "content-type": "application/json" }, body: JSON.stringify({ type: "note", text: `@${V}'s agent is on it ${run}` }) });
  check(sp.ok, `${mode}: ${V}'s agent posts about itself`);
  const selfMsg = p.locator("#thread>.entry", { hasText: `is on it ${run}` }).last();
  const selfChip = async () => selfMsg.locator(`.body .mention.agent[data-user="${V}"]`).innerText().catch(() => "");
  await selfMsg.waitFor({ timeout: 8000 }).catch(() => {}); await p.waitForTimeout(400);
  check((await selfChip()) === `@${V}'s agent`, `${mode}: the agent's "@${V}'s agent" about itself is a chip (live)`);
  await p.reload(); await p.waitForTimeout(800);
  check((await selfChip()) === `@${V}'s agent`, `${mode}: …and after a reload`);
  check(!errors.length, `${mode}: no page errors ${errors.join(" | ")}`); await ctx.close();
}
await b.close(); console.log(fails ? `${fails} FAILED` : "agent-name mentions: all passed"); process.exit(fails ? 1 : 0);
