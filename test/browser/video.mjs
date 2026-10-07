// Videos play in the chat (jxn #6161): a video posted to a board shows as a <video> player in the thread, plays in place,
// and the file endpoint serves it inline with byte ranges (206), which Safari needs to play at all and every browser
// needs to seek. Other files keep their download card. The clip is recorded in the page (WebM: Playwright's Chromium has
// no H.264), so this runs anywhere.
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": process.env.ADMIN_KEY || "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-5), U = `vid${run}`;
await ops("users", { name: U, email: `${U}@example.com`, verified: "true" });
const board = (await ops("boards", { user: U, title: "Videos" })).board.id;
const cookie = (await ops("sessions", { user: U })).cookie;
let fails = 0;
const check = (ok, m) => { console.log(`${ok ? "✓" : "✗"} ${m}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
const [k, ...v] = cookie.split(";")[0].split("=");
await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
const p = await ctx.newPage(), errors = [];
p.on("pageerror", (e) => errors.push(e.message));
await p.goto(`${BASE}/b/${board}`);
// A 1.5 s clip from a canvas, then posted the way the web posts a file (raw body), and a PDF beside it.
const sent = await p.evaluate(async (board) => {
  const c = Object.assign(document.createElement("canvas"), { width: 320, height: 180 }), g = c.getContext("2d");
  const rec = new MediaRecorder(c.captureStream(30), { mimeType: "video/webm" }), parts = [];
  rec.ondataavailable = (e) => parts.push(e.data);
  let f = 0; const draw = setInterval(() => { g.fillStyle = `hsl(${f++ * 9},70%,50%)`; g.fillRect(0, 0, 320, 180); }, 33);
  rec.start(); await new Promise((r) => setTimeout(r, 1500)); rec.stop(); await new Promise((r) => (rec.onstop = r)); clearInterval(draw);
  const clip = new Blob(parts, { type: "video/webm" });
  const up = (name, body) => fetch(`/api/boards/${board}/upload?name=${encodeURIComponent(name)}`, { method: "POST", body }).then((r) => r.status);
  return { size: clip.size, video: await up("clip.webm", clip), pdf: await up("notes.pdf", new Blob(["%PDF-1.4\n%\n"])) };
}, board);
check(sent.video === 201 && sent.pdf === 201 && sent.size > 1000, `posted a ${sent.size}-byte clip and a PDF (${sent.video}, ${sent.pdf})`);
await p.reload();
const vid = p.locator("#thread video[data-vid]");
await vid.first().waitFor({ timeout: 10000 }).catch(() => {});
check(await vid.count() === 1, "the clip shows as a player in the thread");
check(await p.locator('#thread figure.vid a[data-save][download="clip.webm"]').count() === 1, "with its Save link under it");
check(await p.locator('#thread .file a[download="notes.pdf"]').count() === 1 && await p.locator("#thread video").count() === 1, "the PDF keeps its download card");
// It plays in place: metadata loads, and time moves once it's playing.
const played = await p.evaluate(async () => {
  const v = document.querySelector("#thread video[data-vid]");
  v.muted = true;
  if (v.readyState < 1) await new Promise((r) => v.addEventListener("loadedmetadata", r, { once: true }));
  await v.play();
  await new Promise((r) => setTimeout(r, 700));
  return { w: v.videoWidth, h: v.videoHeight, t: v.currentTime, error: v.error?.code ?? null };
});
check(played.w === 320 && played.h === 180 && played.t > 0.2 && played.error === null, `it plays in the chat (${played.w}×${played.h}, ${played.t.toFixed(2)} s in)`);
// The endpoint: the video inline with its type and byte ranges; the PDF still only as a download.
const res = await p.evaluate(async (board) => {
  const src = `/api/boards/${board}/image?name=clip.webm`;
  const whole = await fetch(src), part = await fetch(src, { headers: { range: "bytes=0-99" } }), past = await fetch(src, { headers: { range: "bytes=99999999-" } });
  const pdf = await fetch(`/api/boards/${board}/image?name=notes.pdf`);
  const h = (r, k) => r.headers.get(k);
  return { type: h(whole, "content-type"), disp: h(whole, "content-disposition"), ranges: h(whole, "accept-ranges"), partStatus: part.status, partRange: h(part, "content-range"), partLen: (await part.arrayBuffer()).byteLength, past: past.status, pdfType: h(pdf, "content-type"), pdfDisp: h(pdf, "content-disposition") };
}, board);
check(res.type === "video/webm" && res.disp === "inline" && res.ranges === "bytes", `the clip is served inline as ${res.type}, with byte ranges`);
check(res.partStatus === 206 && /^bytes 0-99\/\d+$/.test(res.partRange || "") && res.partLen === 100 && res.past === 416, `a range answers 206 (${res.partRange}), past the end 416`);
check(res.pdfType === "application/octet-stream" && /^attachment/.test(res.pdfDisp || ""), "the PDF is still only a download");
check(!errors.length, `no page errors${errors.length ? ` (${errors[0]})` : ""}`);
await b.close();
console.log(fails ? `${fails} FAILED` : "video: all passed");
process.exit(fails ? 1 : 0);
