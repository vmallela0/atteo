// The web's type is self-hosted (design language v1 #2508, #2515): pages use Onest for the interface, Enriqueta for
// headlines (Latin pages) and Courier Prime for ids, all from this server's /fonts/*, and no page requests anything from
// another host. Font files are cached for good when their URL carries the version, and unknown names are 404.
// Usage: BASE=http://localhost:8787 node fonts.mjs  (local dev only, ADMIN_KEY=ci-admin-key in .dev.vars)
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": process.env.ADMIN_KEY || "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const u = `fo${Date.now().toString(36).slice(-4)}`;
await ops("users", { name: u, email: `${u}@example.com`, verified: "true", display: { mode: "developer" } });
const board = (await ops("boards", { user: u, title: `Fonts ${u}` })).board.id;
const ck = (await ops("sessions", { user: u })).cookie;
let fails = 0;
const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const f = await fetch(`${BASE}/fonts/onest-latin.woff2?v=1`);
check(f.status === 200 && f.headers.get("content-type") === "font/woff2" && /immutable/.test(f.headers.get("cache-control") || "") && (await f.arrayBuffer()).byteLength > 10_000, "a font file is served, typed and cached for good");
check((await fetch(`${BASE}/fonts/nope.woff2`)).status === 404 && (await fetch(`${BASE}/fonts/constructor`)).status === 404, "unknown font names are 404");
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const ctx = await b.newContext();
const [k, ...v] = ck.split(";")[0].split("=");
await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
const p = await ctx.newPage();
const off = [];
p.on("request", (r) => { const x = r.url(); if (!x.startsWith(BASE) && !x.startsWith("data:") && !x.startsWith("blob:")) off.push(x); });
for (const [path, latin] of [[`/b/${board}`, true], ["/", true], ["/me?lang=ru", true], ["/?lang=ja", false], ["/?lang=ar", false]]) {
  await p.goto(BASE + path);
  await p.waitForTimeout(600);
  const r = await p.evaluate(async () => {
    await document.fonts.ready;
    const fam = (el) => (el ? getComputedStyle(el).fontFamily.split(",")[0].replace(/"/g, "") : "");
    const code = document.createElement("code"); document.body.appendChild(code);
    const out = { body: fam(document.body), h1: fam(document.querySelector("h1")), code: fam(code) };
    code.remove();
    return out;
  });
  check(r.body === "Onest" && r.code === "Courier Prime" && (r.h1 === "" || r.h1 === (latin ? "Enriqueta" : "Onest")), `${path}: Onest text, ${latin ? "Enriqueta" : "interface-stack"} headlines, Courier Prime code (${JSON.stringify(r)})`);
}
check(!off.length, `no request leaves this server (${off.slice(0, 3).join(", ") || "none"})`);
await b.close();
console.log(fails ? `${fails} FAILED` : "fonts: all passed");
process.exit(fails ? 1 : 0);
