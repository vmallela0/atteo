// The read-aloud voice picker (#1742; vedu #1717, #1718): Account → Display shows "Read-aloud voice" only when read aloud
// is on, with the server's voices and the saved one selected; choosing one saves display.voice (both TTS status routes
// then report it as voice_default); Play reads a sample in that voice, one /api/app/tts request per voice (a second Play
// reuses it). Read aloud's status and audio are stubbed in the page (no xAI key locally). Off: no picker. No page errors.
// Usage: BASE=http://localhost:8787 node voice-picker.mjs
import { chromium } from "playwright-core";
const BASE = (process.env.BASE || "http://localhost:8787").replace(/\/$/, "");
const KEY = process.env.ADMIN_KEY || "ci-admin-key";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": KEY, "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-5), P = `vp${run}`;
await ops("users", { name: P, email: `${P}@example.com`, verified: "true", display: { xai_ok: true } }); // Play needs the OK to use xAI (#4386)
const cookie = (await ops("sessions", { user: P })).cookie.split(";")[0];
const prefs = async () => (await (await fetch(`${BASE}/api/app/prefs`, { headers: { cookie } })).json()).prefs;
let fails = 0;
const check = (ok, m) => { console.log(`${ok ? "✓" : "✗"} ${m}`); if (!ok) fails++; };
const until = async (f, ms = 6000) => { const t = Date.now(); for (;;) { const v = await f(); if (v || Date.now() - t > ms) return v; await new Promise((r) => setTimeout(r, 150)); } };
// A tiny valid WAV (0.05s of silence), so Audio.play() has something real to play.
const wav = (() => { const n = 1102, b = Buffer.alloc(44 + n * 2); b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(22050, 24); b.writeUInt32LE(44100, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40); return b; })();
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined, args: ["--autoplay-policy=no-user-gesture-required"] });
const errors = [];
const open = async (enabled) => {
  const ctx = await b.newContext({ viewport: { width: 1200, height: 900 } });
  const [k, ...v] = cookie.split("=");
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  const plays = [];
  await p.route("**/api/app/tts/status", async (r) => {
    const real = await (await fetch(`${BASE}/api/app/tts/status`, { headers: { cookie } })).json().catch(() => ({}));
    r.fulfill({ json: { ...real, enabled, voices: ["eve", "ara", "leo", "rex", "sal"], voice_default: (await prefs()).display.voice } });
  });
  await p.route("**/api/app/tts", (r) => { plays.push(JSON.parse(r.request().postData() || "{}")); r.fulfill({ status: 200, contentType: "audio/wav", body: wav }); });
  await p.goto(`${BASE}/me`);
  await p.waitForTimeout(500);
  return { ctx, p, plays };
};

check((await prefs()).display.voice === "eve", "Eve is the default voice");
let { ctx, p, plays } = await open(true);
check(await p.locator("#dp-voice").isVisible() && await p.locator("#dp-voice-l").isVisible(), "read aloud on: the picker shows");
const opts = await p.locator("#dp-voice option").evaluateAll((os) => os.map((o) => o.textContent));
check(JSON.stringify(opts) === JSON.stringify(["Eve", "Ara", "Leo", "Rex", "Sal"]) && (await p.locator("#dp-voice").inputValue()) === "eve", `the voices, Eve selected (${opts.join(", ")})`);
await p.locator("#dp-voice").selectOption("leo");
check(await until(async () => (await prefs()).display.voice === "leo" && "ok"), "choosing Leo saves display.voice");
const st = await (await fetch(`${BASE}/api/app/tts/status`, { headers: { cookie } })).json();
check(st.voice_default === "leo", `…and read aloud uses it when nothing's named (voice_default ${st.voice_default})`);
check(((await p.locator("#toast").textContent()) || "").includes("Voice saved"), "says so");
await p.locator("#dp-voice-play").click();
check(await until(async () => plays.length === 1 && "ok", 3000) && plays[0].voice === "leo" && typeof plays[0].text === "string" && plays[0].text.length > 5, `Play reads a sample in Leo (${JSON.stringify(plays[0])})`);
await p.waitForTimeout(300);
await p.locator("#dp-voice-play").click();
await p.waitForTimeout(400);
check(plays.length === 1, "a second Play reuses the sample (no new request)");
await p.locator("#dp-voice").selectOption("ara");
await until(async () => (await prefs()).display.voice === "ara" && "ok");
await p.locator("#dp-voice-play").click();
check(await until(async () => plays.length === 2 && plays[1].voice === "ara" && "ok", 3000), "another voice gets its own sample");
await p.reload();
await p.waitForTimeout(500);
check((await p.locator("#dp-voice").inputValue()) === "ara", "after a reload Ara is still selected");
await ctx.close();
({ ctx, p } = await open(false));
check(await p.locator("#dp-voice").isHidden() && await p.locator("#dp-voice-l").isHidden(), "read aloud off: no picker");
await ctx.close();
check(errors.length === 0, `no page errors (${errors.join(" | ")})`);
await b.close();
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
