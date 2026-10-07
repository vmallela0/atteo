// The source of og.png (the 1200×630 share image): the hero of jxn's landing page (landing-jxn.html), captured as visitors see
// it — the ring of agents, the headline, the line under it and the install bar (#5992). The page is laid out at 1333×700 (the
// card's ratio) and scaled to 1200×630, so the headline still reads at iMessage's thumbnail size; the page's chrome (the nav, the
// scroll rail) and the message lines gliding along the ring are hidden, so it reads as a card rather than a screenshot (#6009).
// Its agent favicons come from Google's favicon service, as /landing/icons does in the worker; a logo the export references
// but doesn't carry leaves its tile empty rather than broken.
// When it changes, bump ?v= on og.png in landing/src/index.ts so link previews re-fetch it. Regenerate from the repo root:
//   node landing/og.mjs        (CHROMIUM=<path to chrome> if playwright-core can't find one)
import http from "node:http";
import fs from "node:fs";
import { chromium } from "playwright-core";

const html = fs.readFileSync("landing/landing-jxn.html");
const missing = new Set();

const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  if (path === "/") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(html);
  }
  const icon = /^\/landing\/icons\/([a-z.]+)\.png$/.exec(path)?.[1];
  if (icon) {
    const r = await fetch(`https://www.google.com/s2/favicons?domain=${icon}&sz=64`);
    res.writeHead(r.status, { "content-type": "image/png" });
    return res.end(Buffer.from(await r.arrayBuffer()));
  }
  missing.add(path);
  res.writeHead(404);
  res.end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

const width = 1333, scale = 1200 / width;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM });
const page = await browser.newPage({ viewport: { width, height: Math.round(630 / scale) }, deviceScaleFactor: scale });
await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(2500); // the ring's entrance animation
await page.evaluate(() => {
  for (const img of document.images) if (img.complete && img.naturalWidth === 0) img.parentElement.style.visibility = "hidden";
  for (const e of document.querySelectorAll("header nav, body *")) {
    if (e.matches("header nav") || getComputedStyle(e).position === "fixed") e.style.visibility = "hidden";
  }
  // The ring is the faint path; the dark one is a message mid-flight, caught half-drawn.
  for (const path of document.querySelectorAll("section svg path")) {
    const [r, g, b] = getComputedStyle(path).stroke.match(/\d+/g)?.map(Number) ?? [255, 255, 255];
    if (r + g + b < 300) path.style.visibility = "hidden";
  }
});
await page.screenshot({ path: "landing/og.png" });
await browser.close();
server.close();
if (missing.size) console.log("not in the export (tiles left empty):", [...missing].join(" "));
