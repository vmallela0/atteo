// Browser check (#avatars): stacked initials avatars show every letter (no "MO" read as "MC"); the first avatar sits on top.
// Usage: node avstack.mjs <label>   (screenshots go to avs-<label>-*.png)
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const OUT = `${SHOTS_DIR}/`, label = process.argv[2] || "after";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), A = `mo${run}`, B = `mp${run}`, C = `md${run}`;
for (const u of [A, B, C]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true" });
const tokB = (await ops("tokens", { user: B })).token, tokC = (await ops("tokens", { user: C })).token;
const board = (await ops("boards", { user: A, title: `Stacks ${run}` })).board.id; await ops("members", { board, user: B }); await ops("members", { board, user: C });
const mcp = async (tok, name, args) => (await (await fetch(`${BASE}/mcp?board=${board}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json()).result.content[0].text;
await mcp(tokB, "read", {}); await mcp(tokC, "read", {});
await mcp(tokB, "post", { type: "decision", text: `We ship the landing separately, @${A} @${C}.` });
await mcp(tokC, "read", {}); await mcp(tokC, "post", { type: "note", text: "Agreed.", reply_to: 1 });
await mcp(tokB, "post", { type: "task", text: `Web: tidy the stacks\n- [ ] one` });
await mcp(tokB, "post", { type: "question", text: `@${A} which region?` });
let fails = 0; const check = (ok, m) => { console.log(`${ok ? "✓" : "✗"} ${m}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
for (const scheme of ["light", "dark"]) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: scheme, deviceScaleFactor: 3 });
  const ck = (await ops("sessions", { user: A })).cookie; const [k, ...v] = ck.split(";")[0].split("=");
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage(); const errors = []; p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${BASE}/b/${board}`); await p.waitForTimeout(900);
  // for each stack: is every avatar's initials box uncovered by its right-hand neighbour?
  const res = await p.evaluate(() => [...document.querySelectorAll(".avs")].filter((s) => s.offsetParent && s.children.length > 1).map((s) => {
    const avs = [...s.querySelectorAll(":scope > .av")], out = [];
    for (let i = 0; i < avs.length; i++) {
      const a = avs[i], r = a.getBoundingClientRect(), z = +getComputedStyle(a).zIndex || 0;
      const rng = document.createRange(); rng.selectNodeContents(a); const t = [...rng.getClientRects()].find((x) => x.width > 2) || rng.getBoundingClientRect();
      let covered = 0;
      for (let j = 0; j < avs.length; j++) { if (j === i) continue; const o = avs[j].getBoundingClientRect(), oz = +getComputedStyle(avs[j]).zIndex || 0; const above = oz > z || (oz === z && j > i); if (!above) continue; const ov = Math.max(0, Math.min(t.right, o.right) - Math.max(t.left, o.left)); covered = Math.max(covered, ov); }
      out.push({ text: a.textContent.trim(), covered: +covered.toFixed(1) });
    }
    return { where: s.closest(".bp-head") ? "header" : s.closest(".sum") ? "side panel" : s.closest(".entry") ? "message" : "other", out };
  }));
  for (const st of res) for (const a of st.out) if (a.text) check(a.covered < 1, `${scheme} ${st.where}: "${a.text}" letters uncovered (${a.covered}px hidden)`);
  const fit = await p.evaluate(() => [...document.querySelectorAll(".sum li .avs")].map((s) => { const last = [...s.querySelectorAll(".av")].pop().getBoundingClientRect(), t = s.parentElement.querySelector(".one")?.getBoundingClientRect(); return { n: s.querySelectorAll(".av").length, room: t ? Math.round(t.left - last.right) : 99 }; }));
  check(fit.some((f) => f.n === 3), `a side-panel row has a stack of three (${JSON.stringify(fit)})`);
  check(fit.every((f) => f.room >= 4), "every side-panel stack ends before its title");
  check(res.some((s) => s.where === "header") && res.some((s) => s.where === "side panel"), "found stacks in the header and the side panel");
  await p.locator(".bp-title").screenshot({ path: `${OUT}avs-${label}-${scheme}-header.png` });
  await p.locator("#board-info").screenshot({ path: `${OUT}avs-${label}-${scheme}-side.png` }); // #sum lays its parts out in the rail (display: contents, jxn #4860)
  const tight = await p.evaluate(() => { const s = document.querySelector(".bp-head .avs"); const [a, n] = s.querySelectorAll(".av"); const im = document.createElement("img"); im.className = "av-img"; a.append(im); const m = getComputedStyle(n).marginLeft; im.remove(); return m; });
  check(tight === "-7px", `a picture avatar keeps the tight stack (next one at ${tight})`);
  check(errors.length === 0, `no page errors ${errors.join(" | ")}`);
  await ctx.close();
}
await b.close(); console.log(fails ? `${fails} FAILED` : "all avatar-stack checks passed"); process.exit(fails ? 1 : 0);
