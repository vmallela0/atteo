// atteo.dev's Core Web Vitals, measured in the lab and kept "good" (#3541, #3152 item 1): /, /guide and /faq on the
// landing Worker, on a phone the way Lighthouse's mobile run sees one (4x slower CPU, slow 4G: 150 ms RTT, 1.6 Mbps
// down) and on a desktop. LCP ≤ 2.5 s and CLS ≤ 0.1 are Google's "good"; INP needs a person's input, so TBT (long tasks
// past 50 ms after first paint) stands in for it as in Lighthouse, ≤ 200 ms. FCP is printed, not budgeted. On the phone each
// page loads three times and the median counts (the desktop is far inside, once is enough). The fonts are the app's (/fonts/*, which the landing forwards): answered
// from src/fonts with the time slow 4G would take to send them, since a routed answer skips the network's throttle.
// It runs against the LANDING Worker, like landing-look.mjs:
//   npx wrangler dev -c landing/wrangler.jsonc --port 8798 --inspector-port 9237 --var APP_ORIGIN:http://127.0.0.1:9
//   LANDING=http://localhost:8798 node test/browser/landing-vitals.mjs
import { chromium } from "playwright-core";
import { readFileSync, existsSync } from "node:fs";
const BASE = (process.env.LANDING || "http://localhost:8798").replace(/\/$/, "");
const FONTS = new URL("../../src/fonts/", import.meta.url);
const GOOD = { lcp: 2500, cls: 0.1, tbt: 200 };
const SLOW_4G = { latency: 150, down: (1.6 * 1024 * 1024) / 8, up: (750 * 1024) / 8 };
const PROFILES = [
  { name: "phone", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, cpu: 4, net: SLOW_4G, runs: 3 },
  { name: "desktop", viewport: { width: 1350, height: 940 }, isMobile: false, hasTouch: false, cpu: 1, net: null, runs: 1 },
];
// "/" and /faq are jxn's pages, plain HTML since #6003 (they were ~770 KB bundles unpacked by script: phone LCP 3.1 s).
const PAGES = ["/", "/guide", "/faq"];

// In the page from its first byte: the largest paint, the layout shifts no input caused, long tasks and first paint.
const OBSERVE = () => {
  const v = (window.__cwv = { lcp: 0, cls: 0, longs: [], fcp: 0 });
  const on = (type, f) => { try { new PerformanceObserver((l) => l.getEntries().forEach(f)).observe({ type, buffered: true }); } catch {} };
  on("largest-contentful-paint", (e) => (v.lcp = e.startTime));
  on("layout-shift", (e) => { if (!e.hadRecentInput) v.cls += e.value; });
  on("longtask", (e) => v.longs.push([e.startTime, e.duration]));
  on("paint", (e) => { if (e.name === "first-contentful-paint") v.fcp = e.startTime; });
};

// The meter's own check: a 300 ms task and a block pushed in above the page after first paint must show as TBT and CLS.
const SPOIL = () => setTimeout(() => { const t = performance.now(); while (performance.now() - t < 300); const d = document.createElement("div"); d.style.height = "400px"; document.body.prepend(d); }, 300);

const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
let fails = 0; const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function measure(prof, path, spoil) {
  const ctx = await browser.newContext({ viewport: prof.viewport, isMobile: prof.isMobile, hasTouch: prof.hasTouch });
  await ctx.addInitScript(OBSERVE);
  if (spoil) await ctx.addInitScript(SPOIL);
  const p = await ctx.newPage(), errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.route(/\/fonts\/[^/?]+/, async (route) => {
    const f = new URL(route.request().url()).pathname.split("/").pop(), file = new URL(f, FONTS);
    if (!existsSync(file)) return route.fulfill({ status: 404, body: "" });
    const body = readFileSync(file);
    if (prof.net) await new Promise((r) => setTimeout(r, prof.net.latency + (body.length / prof.net.down) * 1000));
    await route.fulfill({ status: 200, contentType: "font/woff2", body });
  });
  const cdp = await ctx.newCDPSession(p);
  await cdp.send("Network.enable");
  if (prof.net) await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: prof.net.latency, downloadThroughput: prof.net.down, uploadThroughput: prof.net.up });
  if (prof.cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: prof.cpu });
  await p.goto(`${BASE}${path}`, { waitUntil: "load", timeout: 60000 });
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(1000); // a beat after load: late shifts and long tasks still count
  const v = await p.evaluate(() => window.__cwv);
  await ctx.close();
  const tbt = v.longs.filter(([s]) => s >= v.fcp).reduce((t, [, d]) => t + Math.max(0, d - 50), 0);
  return { lcp: v.lcp, cls: v.cls, tbt, fcp: v.fcp, errors };
}

{
  const m = await measure(PROFILES[1], "/faq", true);
  check(m.tbt >= 200 && m.cls > GOOD.cls, `the meter sees a 300 ms task and a pushed-down page (TBT ${Math.round(m.tbt)} ms, CLS ${m.cls.toFixed(3)})`);
}
for (const prof of PROFILES) {
  for (const path of PAGES) {
    const runs = [];
    for (let i = 0; i < prof.runs; i++) runs.push(await measure(prof, path));
    const m = Object.fromEntries(["lcp", "cls", "tbt", "fcp"].map((k) => [k, median(runs.map((r) => r[k]))]));
    const tag = `${prof.name} ${path}`;
    console.log(`  ${tag}: LCP ${Math.round(m.lcp)} ms · CLS ${m.cls.toFixed(3)} · TBT ${Math.round(m.tbt)} ms · FCP ${Math.round(m.fcp)} ms`);
    check(m.lcp > 0 && m.lcp <= GOOD.lcp, `${tag}: LCP ≤ ${GOOD.lcp} ms (${Math.round(m.lcp)})`);
    check(m.cls <= GOOD.cls, `${tag}: CLS ≤ ${GOOD.cls} (${m.cls.toFixed(3)})`);
    check(m.tbt <= GOOD.tbt, `${tag}: TBT ≤ ${GOOD.tbt} ms (${Math.round(m.tbt)})`);
    const errs = runs.flatMap((r) => r.errors);
    check(!errs.length, `${tag}: no page errors ${errs.join(" | ")}`);
  }
}
await browser.close(); console.log(fails ? `${fails} FAILED` : "landing vitals: all good"); process.exit(fails ? 1 : 0);
