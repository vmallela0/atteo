// Browser check (#852, vedu #722): phone widths, light and dark, nothing pushed off the edge, rows line up.
import { SHOTS_DIR } from "../lib/shots.mjs";
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { BASE, CHROME, fixture, ctxFor } from "./fixture.mjs";
const OUT = `${SHOTS_DIR}/after/`; mkdirSync(OUT, { recursive: true });
const only = process.argv[2] ? process.argv[2].split(",") : null;
const f = await fixture();
let fails = 0; const check = (ok, m) => { console.log(`${ok ? "✓" : "✗"} ${m}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: CHROME });
const R = (el) => { const r = el.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; };
const run = (name) => !only || only.includes(name);
for (const [w, scheme] of [[320, "light"], [320, "dark"], [360, "light"], [390, "dark"], [430, "light"]]) {
  const ctx = await ctxFor(b, f.ckA, w, scheme); const tag = `${w} ${scheme}`;
  const page = async (path) => { const p = await ctx.newPage(); p.errs = []; p.on("pageerror", (e) => p.errs.push(e.message)); await p.goto(BASE + path); await p.waitForTimeout(500); return p; };
  if (run("header")) { const p = await page(`/b/${f.board}`);
    const m = await p.evaluate(`(${R})&&(()=>{const R=${R};const h=document.querySelector(".bp-head"),t=document.querySelector(".bp-title"),av=[...document.querySelectorAll(".bp-meta .av")],tabs=document.querySelector(".bp-tabs");return{head:R(h),title:R(t),lastAv:R(av[av.length-1]),tabs:R(tabs),h1:R(document.getElementById("board-title"))}})()`);
    check(m.title.r <= m.head.r && m.tabs.r <= m.head.r, `${tag}: board header rows fit the screen (title ${m.title.r}, tabs ${m.tabs.r} ≤ ${m.head.r})`);
    check(m.lastAv.r <= m.head.r, `${tag}: every member avatar shows (${m.lastAv.r} ≤ ${m.head.r})`);
    check(m.h1.w >= 100, `${tag}: the board name keeps room (${m.h1.w}px)`);
    check(!p.errs.length, `${tag}: no page errors ${p.errs.join(" | ")}`);
    await p.locator(".bp-head").screenshot({ path: `${OUT}header-${w}-${scheme}.png` }); await p.close(); }
  if (run("account")) { const p = await page(`/me`);
    const m = await p.evaluate(`(()=>{const R=${R};const t=document.querySelector(".tbl"),w=t.closest(".list"),btn=t.querySelector("button");return{wrap:R(w),tbl:R(t),btn:R(btn),used:t.querySelector(".sm-only")&&getComputedStyle(t.querySelector(".sm-only")).display}})()`);
    check(m.tbl.r <= m.wrap.r + 1 && m.btn.r <= m.wrap.r, `${tag}: Agent connections fit, Revoke on screen (${m.btn.r} ≤ ${m.wrap.r})`);
    check(m.used === "inline", `${tag}: "used …" moves under the connection's name`);
    await p.evaluate(() => document.querySelector(".tbl").scrollIntoView({ block: "center" }));
    await p.locator(".tbl").screenshot({ path: `${OUT}account-${w}-${scheme}.png` }); await p.close(); }
  if (run("connect")) { const p = await page(`/me`);
    await p.click('[data-open="connect"]'); await p.waitForTimeout(300);
    const m = await p.evaluate(`(()=>{const R=${R};const t=document.querySelector("#connect .tabs");return{tabs:R(t),btns:[...t.children].map(R),dlg:R(document.getElementById("connect"))}})()`);
    check(m.btns.every((x) => x.h === m.btns[0].h && x.h <= 40), `${tag}: Connect tabs are one line each (${m.btns.map((x) => x.h).join("/")}px tall)`);
    check(m.tabs.r <= m.dlg.r, `${tag}: …and the tab row stays inside the dialog`);
    await p.locator("#connect").screenshot({ path: `${OUT}connect-${w}-${scheme}.png` });
    await p.click('#connect [data-ctab="url"]'); await p.waitForTimeout(150);
    const vis = await p.evaluate(`(()=>{const t=document.querySelector('#connect [data-ctab="url"]'),c=t.parentElement,a=t.getBoundingClientRect(),b=c.getBoundingClientRect();return t.getAttribute("aria-selected")==="true"&&a.left>=b.left-1&&a.right<=b.right+1})()`);
    check(vis, `${tag}: the MCP URL tab can be chosen and is in view`);
    await p.close(); }
  if (run("members")) { const p = await page(`/b/${f.board}`);
    await p.click('.topbar [data-open="invite"]:not([data-goto])'); await p.waitForSelector("#acc-members .acc-row"); await p.waitForTimeout(200);
    const rows = await p.evaluate(`(()=>{const R=${R};return[...document.querySelectorAll("#acc-members .acc-row")].map(r=>{const s=r.querySelectorAll("select");return{row:R(r),name:R(r.querySelector(".grow")),s1:R(s[0]),s2:R(s[1])}})})()`);
    check(rows.length === 3, `${tag}: three members listed`);
    check(rows.every((x) => x.s1.t === x.s2.t && x.s1.t >= x.name.b - 1), `${tag}: role and end date sit side by side under the name`);
    check(rows.every((x) => Math.abs(x.s1.l - (w <= 360 ? x.row.l : x.name.l)) <= 1 && x.s2.r <= x.row.r), `${tag}: …lined up with the ${w <= 360 ? "row" : "name"}, inside the row`);
    check(await p.evaluate(`[...document.querySelectorAll("#acc-members select")].every(s=>{const c=document.createElement("canvas").getContext("2d"),cs=getComputedStyle(s);c.font=cs.fontSize+" "+cs.fontFamily;return c.measureText(s.options[s.selectedIndex].text).width<=s.clientWidth-parseFloat(cs.paddingLeft)-parseFloat(cs.paddingRight)+1})`), `${tag}: each select shows its whole value`);
    await p.locator("#acc-members").screenshot({ path: `${OUT}members-${w}-${scheme}.png` }); await p.close(); }
  if (run("files")) { const p = await page(`/b/${f.board}`);
    await p.click('[aria-controls="panel-docs"]'); await p.waitForSelector("#doc-items .doc-item"); await p.waitForTimeout(200);
    const m = await p.evaluate(`(()=>{const R=${R};return{items:[...document.querySelectorAll("#doc-items .doc-item")].map(a=>({a:R(a),name:R(a.children[0]),meta:R(a.children[1])})),view:document.getElementById("doc-view").innerText.trim()}})()`);
    check(m.items.length === 2 && m.items.every((x) => x.meta.h <= x.name.h + 2 && x.meta.r <= x.a.r), `${tag}: each file's version and size stay on its line (${m.items.map((x) => x.meta.h).join("/")}px)`);
    check(w > 800 || m.view === "Pick a file to open it.", `${tag}: the empty viewer says to pick a file ("${m.view.slice(0, 30)}")`);
    await p.screenshot({ path: `${OUT}files-${w}-${scheme}.png` }); await p.close(); }
  if (run("touch")) for (const [path, act] of [[`/b/${f.board}`, "#info-btn"], [`/b/${f.board}#tasks`, '[aria-controls="panel-tasks"]'], ["/", null]]) { const p = await page(path);
    if (act) { await p.click(act); await p.waitForTimeout(400); }
    const m = await p.evaluate(`(()=>{const out={n:0,miss:[],comp:[]};for(const b of document.querySelectorAll(".btn")){const r=b.getBoundingClientRect();if(!r.width||r.top<60||r.bottom>innerHeight-8||b.closest("dialog:not([open]),.sidebar")||!b.checkVisibility({visibilityProperty:true})||b.closest(".layout.info-open>.conv"))continue;
      if(b.closest(".composer")){out.comp.push(Math.round(r.height)+":"+getComputedStyle(b,"::after").content);continue}
      const x=r.left+r.width/2,mid=document.elementFromPoint(x,r.top+r.height/2);if(!mid||mid.closest(".btn")!==b)continue;/* covered (under an open sheet): not tappable now */const up=document.elementFromPoint(x,r.top+r.height/2-20+0.5),dn=document.elementFromPoint(x,r.top+r.height/2+19.5);out.n++;
      const sheetOver=!b.closest(".aside")&&((up&&up.closest(".aside"))||(dn&&dn.closest(".aside")));/* the open Board info sheet overlapping a header button is fine */if(!sheetOver&&!(up&&up.closest(".btn")===b&&dn&&dn.closest(".btn")===b))out.miss.push((b.innerText||b.getAttribute("aria-label")||"").trim().slice(0,16)+" "+Math.round(r.height))}return out})()`);
    check(m.n > 0 && !m.miss.length, `${tag} ${path.replace(f.board, "B")}: ${m.n} buttons take a 40px-tall tap ${m.miss.join(" | ")}`);
    check(m.comp.every((x) => x.endsWith("none")), `${tag}: composer buttons keep their own size (${m.comp.join(" ")})`);
    if (path === "/") await p.screenshot({ path: `${OUT}boards-${w}-${scheme}.png` });
    if (act === "#info-btn") await p.screenshot({ path: `${OUT}info-${w}-${scheme}.png` });
    if (act && act.includes("tasks")) { const t = await p.evaluate(`(()=>{const R=${R};return{i:R(document.getElementById("kb-new-text")),b:R(document.querySelector(".kb-new .btn"))}})()`);
      check(t.i.t === t.b.t && t.i.h === t.b.h, `${tag}: task Add button lines up with its box (${t.b.h} vs ${t.i.h})`);
      await p.screenshot({ path: `${OUT}tasks-${w}-${scheme}.png` }); }
    await p.close(); }
  if (run("log")) { const p = await page(`/b/${f.board}`);
    await p.click('[aria-controls="panel-log"]'); await p.waitForTimeout(400);
    const m = await p.evaluate(`(()=>{const R=${R};const wrap=document.querySelector("#panel-log .list");return{wrap:R(wrap),sw:wrap.scrollWidth,cw:wrap.clientWidth,rows:[...document.querySelectorAll("#log-body tr.ev")].map(tr=>{const c=tr.children;return{tr:R(tr),time:R(c[0]),seq:R(c[1]),who:R(c[2]),type:R(c[3]),sum:R(c[5]),sumText:c[5].innerText.trim().length}})}})()`);
    check(m.sw <= m.cw + 1, `${tag}: the Log doesn't scroll sideways (${m.sw} ≤ ${m.cw})`);
    check(m.rows.length > 5 && m.rows.every((x) => Math.abs(x.who.t + x.who.h / 2 - (x.time.t + x.time.h / 2)) <= 2 && x.time.r <= x.tr.r && x.seq.r <= x.time.l), `${tag}: line one is who, #, time, inside the row`);
    check(m.rows.every((x) => x.sum.t >= x.who.b - 1 && x.sum.r <= x.tr.r && x.sum.w > 120 && Math.abs(x.type.t + x.type.h / 2 - (x.sum.t + x.sum.h / 2)) <= 3), `${tag}: line two is the type and a readable summary (≥120px)`);
    await p.screenshot({ path: `${OUT}log-${w}-${scheme}.png` }); await p.close(); }
  if (run("cards")) { const p = await page(`/b/${f.board}`);
    const m = await p.evaluate(`(()=>{const R=${R};return[...document.querySelectorAll("#thread .tk")].map(t=>{const b=[...t.querySelectorAll(":scope>.btn")].map(R);return{tk:R(t),b,st:R(t.querySelector(".tk-st"))}})})()`);
    check(m.length >= 1 && m.every((x) => x.b.every((y) => y.t === x.b[0].t && Math.abs(y.t + y.h / 2 - (x.st.t + x.st.h / 2)) <= 2 && y.r <= x.tk.r)), `${tag}: task/decision cards keep their buttons on the status line (${m.length} cards)`);
    await p.close(); }
  if (run("info")) { const p = await page(`/b/${f.board}`);
    await p.click("#info-btn"); await p.waitForTimeout(400);
    const m = await p.evaluate(`(()=>{const R=${R};const rows=[...document.querySelectorAll("#board-info .sum li a")].filter(a=>a.querySelector(".avs")).map(a=>({a:R(a),avs:R(a.querySelector(".avs")),one:R(a.querySelector(".one"))}));
      const mem=[...document.querySelectorAll("#board-info .sum li>.row")].filter(r=>r.querySelector(".av-wrap")).map(r=>{const l=r.lastElementChild;const range=document.createRange();range.selectNodeContents(l.matches(".btn")?l.firstChild||l:l);const tr=range.getBoundingClientRect();return{row:R(r),textR:Math.round(tr.right),fs:getComputedStyle(l.matches(".btn")?l:l).fontSize}});return{rows,mem}})()`);
    check(m.rows.length >= 3 && m.rows.every((x) => x.one.l - x.avs.l <= 44 && x.one.l - x.avs.l === m.rows[0].one.l - m.rows[0].avs.l), `${tag}: info rows: titles line up right after the avatars (${m.rows.map((x) => x.one.l - x.avs.l).join("/")}px)`);
    check(m.mem.length === 3 && m.mem.every((x) => Math.abs(x.textR - m.mem[0].textR) <= 2), `${tag}: Members: Remove and last seen end at the same edge (${m.mem.map((x) => x.textR).join("/")})`);
    await p.screenshot({ path: `${OUT}info-${w}-${scheme}.png` }); await p.close(); }
  await ctx.close();
}
await b.close(); console.log(fails ? `${fails} FAILED` : "all phone-layout checks passed"); process.exit(fails ? 1 : 0);
