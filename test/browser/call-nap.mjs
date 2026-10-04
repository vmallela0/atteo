// Talk to Atteo stands by between turns (jxn #2071, #2078, #2081; claude #2080, #2089; task #2083), and the composer's
// one mic sits where Post is. The voice service and the mic are faked like voice-chat.mjs (DEV_FAKE_VOICE=1 + the
// x-dev-fake-voice header; a stand-in WebSocket); the media keys by holding on to the page's Media Session handlers;
// read-aloud by answering /api/app/tts with a short WAV. BASE, ADMIN_KEY, PW_CHROME.
// Covers: standby after quiet (session settled, mic released, "Standing by"), no standby while someone talks or a yes
// waits, the media play key and the Talk button waking it with the last lines, pause standing it by, a message for you
// read in standby (TTS) and in the call (Atteo), People only and Just mine never reaching the voice agent (live, recap,
// read_board, opus-d #2094), the cap as a standby, End from standby; the composer's mic: alone
// when the box is empty, Post once there's text or a file, hold to talk, tap to toggle, Enter, no read-aloud button,
// and the same at 390px.
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": process.env.ADMIN_KEY || "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), P = `cn${run}`, V = `cv${run}`, W = `cw${run}`; // W: a second caller (sessions are rate-limited per person)
for (const u of [P, V, W]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true", display: { mode: "developer" } });
const board = (await ops("boards", { user: P, title: `Nap ${run}` })).board.id; await ops("members", { board, user: V }); await ops("members", { board, user: W });
const ckP = (await ops("sessions", { user: P })).cookie, ckV = (await ops("sessions", { user: V })).cookie, ckW = (await ops("sessions", { user: W })).cookie;
let fails = 0; const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const postPriv = (ck, body) => fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { "content-type": "application/json", cookie: ck }, body: JSON.stringify(body) }).then((r) => r.json());
const postAs = (ck, text) => fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { "content-type": "application/json", cookie: ck }, body: JSON.stringify({ text }) }).then((r) => r.json());
const wav = (sec) => { const n = Math.round(8000 * sec), b = Buffer.alloc(44 + n); b.write("RIFF", 0); b.writeUInt32LE(36 + n, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(8000, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write("data", 36); b.writeUInt32LE(n, 40); b.fill(128, 44); return b; };
const FAKE = `(()=>{const Real=window.WebSocket;window.__talk={sent:[],opened:0,all:[]};
  window.WebSocket=function(url,protocols){if(!String(url).startsWith('wss://api.x.ai'))return new Real(url,protocols);
    const ws={url,protocols,readyState:0,send(m){window.__talk.sent.push(JSON.parse(m))},close(){if(this.readyState===3)return;this.readyState=3;setTimeout(()=>this.onclose&&this.onclose({}),0)}};
    window.__talk.ws=ws;window.__talk.all.push(ws);window.__talk.opened++;window.__talk.emit=e=>{if(ws.onmessage)ws.onmessage({data:JSON.stringify(e)})};setTimeout(()=>{ws.readyState=1;ws.onopen&&ws.onopen({})},50);return ws};
  Object.assign(window.WebSocket,{CONNECTING:0,OPEN:1,CLOSING:2,CLOSED:3});
  window.__ms={};const ms=navigator.mediaSession;if(ms){const set=ms.setActionHandler.bind(ms);ms.setActionHandler=(k,f)=>{window.__ms[k]=f;return set(k,f)}}
  // Dictation's recognizer, faked: it records what the page asks of it.
  window.__sr=[];class FakeSR{constructor(){this.calls=[];window.__sr.push(this)}start(){this.calls.push('start')}stop(){this.calls.push('stop');setTimeout(()=>this.onend&&this.onend(),10)}abort(){this.calls.push('abort');setTimeout(()=>this.onend&&this.onend(),10)}}
  window.SpeechRecognition=window.webkitSpeechRecognition=FakeSR;})()`;
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
async function page(path, { width = 1280, session, tts, ck = ckP } = {}) {
  const ctx = await b.newContext({ viewport: { width, height: 860 }, permissions: ["microphone"] }); const [k, ...v] = ck.split(";")[0].split("="); await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage(); p.errors = []; p.on("pageerror", (e) => p.errors.push(e.message)); p.ends = []; p.tts = [];
  await p.addInitScript(FAKE);
  await p.route("**/api/app/voice/**", async (route) => {
    const req = route.request(), headers = { ...req.headers(), "x-dev-fake-voice": "1" };
    if (req.url().endsWith("/session/end")) p.ends.push(JSON.parse(req.postData() || "{}"));
    if (req.url().endsWith("/voice/session") && session) return session(route, headers);
    return route.continue({ headers });
  });
  await p.route("**/api/app/tts", (route) => { p.tts.push(JSON.parse(route.request().postData() || "{}")); return tts ? tts(route) : route.fulfill({ status: 200, contentType: "audio/wav", body: wav(0.4) }); });
  await p.goto(`${BASE}${path}`); await p.waitForTimeout(900); return { ctx, p };
}
const sent = (p) => p.evaluate(() => window.__talk.sent);
const emit = (p, e) => p.evaluate((e) => window.__talk.emit(e), e);
const st = (p) => p.locator("#talk-st").innerText();
const live = (p) => p.evaluate(() => window.__talk.ws?.readyState);

// 1. Standby, waking, messages for you.
{ const { ctx, p } = await page(`/b/${board}`);
  await p.evaluate(() => { window.__talkNapMs = 1500; });
  await p.locator(".bp-head [data-talk]").click(); await p.waitForTimeout(600);
  check(await live(p) === 1 && /Listening/.test(await st(p)), "the call connects and listens");
  check(await p.evaluate(() => navigator.mediaSession.playbackState) === "playing" && typeof (await p.evaluate(() => typeof window.__ms.play)) === "string" && await p.evaluate(() => typeof window.__ms.play === "function" && typeof window.__ms.pause === "function"), "it takes the media keys (play and pause) while the call is up");
  await p.locator("#talk-cc").selectOption("all");
  // You talk for longer than the standby wait: it stays up.
  await emit(p, { type: "input_audio_buffer.speech_started" }); await p.waitForTimeout(2200);
  check(await live(p) === 1, "no standby while you're talking");
  await emit(p, { type: "input_audio_buffer.speech_stopped" });
  await emit(p, { type: "conversation.item.input_audio_transcription.completed", transcript: `What did vedu say ${run}?` });
  await emit(p, { type: "response.created", response: { id: "r1" } });
  await emit(p, { type: "response.output_audio_transcript.done", response_id: "r1", transcript: "Vedu said the deploy passed." });
  await emit(p, { type: "response.done", response: { id: "r1" } });
  // A read-back waiting for your yes holds it up too (for a while).
  await emit(p, { type: "response.function_call_arguments.done", name: "post_to_my_agent", call_id: "c1", arguments: JSON.stringify({ text: "hold on" }) });
  await p.waitForTimeout(2200);
  check(await live(p) === 1 && await p.locator("#talk-ok").isVisible(), "no standby while a yes is waiting");
  await p.locator("#talk-ok button", { hasText: "No" }).click(); await p.waitForTimeout(300);
  await emit(p, { type: "response.created", response: { id: "r1b" } }); await emit(p, { type: "response.done", response: { id: "r1b" } });
  // Then quiet: standby.
  await p.waitForTimeout(2300);
  const mic = await p.evaluate(() => window.atteoTalk.state().mic?.getTracks().map((t) => t.readyState));
  check(await live(p) === 3 && p.ends.length === 1 && p.ends[0].seconds >= 4, `quiet for the standby wait: the session ends and is settled (${p.ends[0]?.seconds}s)`);
  check(JSON.stringify(mic) === '["ended"]', `…and the mic is released (${JSON.stringify(mic)})`);
  check(/Standing by/.test(await st(p)) && await p.locator("#talk-wake").isVisible() && !(await p.locator("#talk-mic").isVisible()) && await p.locator("dialog.talk").isVisible() && /End/.test(await p.locator("#talk-end").innerText()), `the sheet stays up and says so: "${await st(p)}", with Talk and End`);
  check(await p.evaluate(() => navigator.mediaSession.playbackState) === "paused", "the media session shows it paused");
  // A message for you while it stands by: read with read-aloud (from: true, so it says who wrote it), not the paid line.
  const opened0 = await p.evaluate(() => window.__talk.opened);
  const m1 = await postAs(ckV, `@${P} the build is green ${run}`); await p.waitForTimeout(400);
  check(p.tts.length === 1 && p.tts[0].board === board && p.tts[0].seq === m1.entry?.seq && p.tts[0].from === true && /Reading you a new message/.test(await st(p)), `a message for you is read aloud in standby (tts ${JSON.stringify(p.tts[0])}, "${await st(p)}")`);
  check((await p.locator("#talk-caps").innerText()).includes(`New message from ${V}`), "…with a line in the captions");
  await p.waitForTimeout(1200);
  check(/Standing by/.test(await st(p)) && await p.evaluate(() => window.__talk.opened) === opened0, `then it stands by again, still off the paid line ("${await st(p)}")`);
  await postAs(ckV, `not for anyone ${run}`); await p.waitForTimeout(800);
  check(p.tts.length === 1, "a message that isn't for you isn't read");
  // The media play key wakes it, with the last lines.
  await p.evaluate(() => window.__ms.play()); await p.waitForTimeout(600);
  const s2 = await sent(p), rec = s2.filter((x) => x.type === "conversation.item.create" && x.item?.role === "user").map((x) => x.item.content[0].text).find((t) => /resumed/.test(t)) || "";
  check(await p.evaluate(() => window.__talk.opened) === opened0 + 1 && await live(p) === 1 && /Listening/.test(await st(p)), "the play key wakes it: a fresh session, listening");
  check(rec.includes(`You: What did vedu say ${run}?`) && rec.includes("Atteo: Vedu said the deploy passed.") && rec.includes(`Message: ${V}: @${P} the build is green ${run}`) && /other people's words/.test(rec), `…told the last lines, messages marked as other people's words (${JSON.stringify(rec.slice(0, 160))})`);
  check(await p.evaluate(() => navigator.mediaSession.playbackState) === "playing", "the media session shows it playing again");
  // A message for you while it's live: Atteo reads it in the call.
  const n0 = (await sent(p)).length;
  await postAs(ckV, `@${P} lunch at noon ${run}`); await p.waitForTimeout(500);
  const s3 = (await sent(p)).slice(n0), item = s3.find((x) => x.type === "conversation.item.create")?.item.content[0].text || "";
  check(item.includes(`${V}: @${P} lunch at noon ${run}`) && /not my request/.test(item) && s3.some((x) => x.type === "response.create") && p.tts.length === 1, `live: the message goes to Atteo to read, not read-aloud (${JSON.stringify(item.slice(0, 120))})`);
  await emit(p, { type: "response.created", response: { id: "r2" } }); await emit(p, { type: "response.done", response: { id: "r2" } });
  // Pause stands it by; the Talk button wakes it.
  await p.evaluate(() => window.__ms.pause()); await p.waitForTimeout(400);
  check(await live(p) === 3 && p.ends.length === 2 && /Standing by/.test(await st(p)), "the pause key stands it by at once");
  await p.locator("#talk-wake").click(); await p.waitForTimeout(500);
  check(await live(p) === 1 && /Listening/.test(await st(p)) && await p.evaluate(() => window.__talk.opened) === opened0 + 2, "tapping Talk wakes it");
  // The call button on the header wakes it too.
  await p.evaluate(() => window.__ms.pause()); await p.waitForTimeout(300);
  await p.evaluate(() => document.querySelector(".bp-head [data-talk]").click()); await p.waitForTimeout(500);
  check(await live(p) === 1 && await p.evaluate(() => window.__talk.opened) === opened0 + 3, "so does the call button");
  // End from standby: nothing more to settle, the keys let go.
  await p.evaluate(() => window.__ms.pause()); await p.waitForTimeout(300); const e0 = p.ends.length;
  await p.locator("#talk-end").click(); await p.waitForTimeout(400);
  check(p.ends.length === e0 && /Ended/.test(await st(p)) && /Close/.test(await p.locator("#talk-end").innerText()) && await p.evaluate(() => navigator.mediaSession.playbackState) === "none", `End from standby ends the call ("${await st(p)}")`);
  await postAs(ckV, `@${P} after the call ${run}`); await p.waitForTimeout(600);
  check(p.tts.length === 1, "after the call, messages aren't read");
  await p.locator("#talk-end").click(); await p.waitForTimeout(200);
  check(!(await p.locator("dialog.talk").isVisible()), "Close puts the sheet away");
  check(!p.errors.length, `no page errors ${p.errors.join(" | ")}`); await ctx.close(); }

// 1b. People only and Just mine never reach the voice agent (opus-d #2094): not in the live call, not in the recap, not
// from read_board. In standby our own read-aloud still reads a People only message for you.
{ const { ctx, p } = await page(`/b/${board}`, { ck: ckW });
  await p.evaluate(() => { window.__talkNapMs = 1500; });
  await p.locator(".bp-head [data-talk]").click(); await p.waitForTimeout(600);
  const n0 = (await sent(p)).length;
  const po1 = await postPriv(ckV, { text: `@${W} secret plan po-live-${run}`, people_only: true, to_people: [W] }); await p.waitForTimeout(800);
  check(po1.entry?.seq && await p.locator(`#e${po1.entry.seq} .badge.po`).count() === 1 && !JSON.stringify((await sent(p)).slice(n0)).includes(`po-live-${run}`), "live: a People only message for you isn't sent to the voice agent");
  await p.waitForTimeout(2200); // quiet: standby, where read-aloud (our server) reads it
  check(/Standing by|Reading/.test(await st(p)) && p.tts.some((x) => x.seq === po1.entry.seq), `standby: it's read to you with read-aloud (${JSON.stringify(p.tts)})`);
  await p.waitForTimeout(800);
  const own = await postPriv(ckW, { text: `just mine note own-${run}`, own: true });
  await postPriv(ckV, { text: `@${W} another secret po-nap-${run}`, people_only: true, to_people: [W] }); await p.waitForTimeout(1500);
  await p.evaluate(() => window.__ms.play()); await p.waitForTimeout(700);
  const all = JSON.stringify(await sent(p));
  check(!all.includes(`po-nap-${run}`) && !all.includes(`po-live-${run}`), "the wake's recap carries no People only text");
  const n1 = (await sent(p)).length;
  await emit(p, { type: "response.function_call_arguments.done", name: "read_board", call_id: "rb1", arguments: JSON.stringify({ since: 0 }) }); await p.waitForTimeout(800);
  const out = (await sent(p)).slice(n1).find((x) => x.item?.call_id === "rb1")?.item.output || "";
  check(out.includes(`not for anyone ${run}`) && !out.includes(`po-live-${run}`) && !out.includes(`po-nap-${run}`) && !out.includes(`own-${run}`) && own.entry?.audience === "own", `read_board hands over the board without People only or Just mine (${out.length} chars)`);
  await p.locator("#talk-end").click(); await p.waitForTimeout(300);
  check(!p.errors.length, `no page errors ${p.errors.join(" | ")}`); await ctx.close(); }

// 2. The session's cap is a standby, not the end.
{ const { ctx, p } = await page(`/b/${board}`, { session: async (route, headers) => { const r = await route.fetch({ headers }); const j = await r.json(); j.max_seconds = 2; route.fulfill({ response: r, json: j }); } });
  await p.evaluate(() => { window.__talkNapMs = 60000; });
  await p.locator(".bp-head [data-talk]").click(); await p.waitForTimeout(3500);
  check(/That’s this session’s time\. Standing by/.test(await st(p)) && await live(p) === 3 && p.ends.length === 1 && await p.locator("#talk-wake").isVisible(), `the cap stands it by: "${await st(p)}"`);
  await ctx.close(); }

// 2b. Out of read-aloud in standby: the device's voice reads it, and the sheet says so.
{ const { ctx, p } = await page(`/b/${board}`, { ck: ckW, tts: (route) => route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: "You've used this month's read-aloud allowance", fallback: "device" }) }) });
  await p.evaluate(() => { window.__talkNapMs = 800; window.__said = []; speechSynthesis.speak = (u) => { window.__said.push(u.text); setTimeout(() => u.onend && u.onend(), 900); }; speechSynthesis.cancel = () => {}; });
  await p.locator(".bp-head [data-talk]").click(); await p.waitForTimeout(1800);
  check(/Standing by/.test(await st(p)), "standing by");
  await postAs(ckV, `@${W} out of read-aloud ${run}`); await p.waitForTimeout(500);
  check(p.tts.length === 1 && (await p.evaluate(() => window.__said)).some((t) => t.startsWith(`${V}. `) && t.includes(`out of read-aloud ${run}`)) && /device voice/.test(await st(p)), `out of read-aloud: the device voice reads it and the sheet says so ("${await st(p)}")`);
  await p.waitForTimeout(900);
  check(/Standing by/.test(await st(p)), "then it stands by again");
  check(!p.errors.length, `no page errors ${p.errors.join(" | ")}`); await ctx.close(); }

// 2c. A dropped line stands by; a refused wake (the rate limit, the month's minutes) stands by with the server's words.
{ let n = 0; const msg = "Too many voice sessions: try again in a minute.";
  const { ctx, p } = await page(`/b/${board}`, { ck: ckW, session: (route, headers) => (++n === 2 ? route.fulfill({ status: 429, json: { error: msg } }) : route.continue({ headers })) });
  await p.evaluate(() => { window.__talkNapMs = 60000; });
  await p.locator(".bp-head [data-talk]").click(); await p.waitForTimeout(600);
  await p.evaluate(() => window.__talk.ws.close()); await p.waitForTimeout(300);
  check(/The voice connection closed\. Standing by/.test(await st(p)) && p.ends.length === 1 && await p.locator("#talk-wake").isVisible(), `a dropped line stands by ("${await st(p)}")`);
  await p.locator("#talk-wake").click(); await p.waitForTimeout(500);
  check((await st(p)).startsWith(msg + " Standing by") && await p.evaluate(() => window.__talk.opened) === 1 && await p.locator("#talk-wake").isVisible(), `a refused wake stands by with the reason ("${await st(p)}")`);
  await p.locator("#talk-wake").click(); await p.waitForTimeout(500);
  check(await live(p) === 1 && /Listening/.test(await st(p)), "and Talk tries again");
  await p.locator("#talk-end").click(); await p.waitForTimeout(300);
  check(!p.errors.length, `no page errors ${p.errors.join(" | ")}`); await ctx.close(); }

// 3. The composer: one mic, where Post is.
for (const width of [1280, 390]) {
  const { ctx, p } = await page(`/b/${board}`, { width, ck: ckW });
  const geo = () => p.evaluate(() => { const bar = document.querySelector(".composer .bar").getBoundingClientRect(), r = (s) => { const e = document.querySelector(s); if (!e || !e.offsetParent) return null; const g = e.getBoundingClientRect(); return { l: Math.round(g.left), r: Math.round(bar.right - g.right), t: Math.round(g.top - bar.top), w: Math.round(g.width), h: Math.round(g.height) } }; return { mic: r("#mic-btn"), post: r(".composer .post-btn"), doc: document.documentElement.scrollWidth } });
  let g = await geo();
  check(g.mic && !g.post && g.mic.r <= 14 && g.doc <= width, `${width}px, empty box: only the mic, at the bar's right where Post goes (${JSON.stringify(g)})`);
  check(await p.locator("#aloud-btn").count() === 0 && await p.locator("#voice-pill").count() === 0, `${width}px: no separate read-aloud button or bar`);
  await p.locator("#composer-text").fill("hello"); await p.waitForTimeout(100); g = await geo();
  check(!g.mic && g.post && g.post.r <= 14, `${width}px, typed: Post in its place (${JSON.stringify(g)})`);
  await p.locator("#composer-text").fill(""); await p.waitForTimeout(100);
  await p.locator("#attach-input").setInputFiles({ name: "n.txt", mimeType: "text/plain", buffer: Buffer.from("x") }); await p.waitForTimeout(300); g = await geo();
  check(g.post, `${width}px: a file with no text still shows Post (${JSON.stringify(g)})`);
  if (width === 1280) {
    await p.evaluate(() => document.querySelectorAll(".att .x, .att button").forEach((x) => x.click())); await p.waitForTimeout(200);
    const calls = () => p.evaluate(() => window.__sr.map((r) => r.calls.join(",")));
    const box = await p.locator("#mic-btn").boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 2;
    // Hold to talk: down starts it, up after a hold stops it.
    await p.mouse.move(x, y); await p.mouse.down(); await p.waitForTimeout(150);
    check(JSON.stringify(await calls()) === '["start"]' && await p.locator("#mic-btn.on").count() === 1, "pressing the mic starts dictation at once");
    await p.waitForTimeout(500); await p.mouse.up(); await p.waitForTimeout(100);
    check(JSON.stringify(await calls()) === '["start,stop"]', `letting go after a hold stops it gently (${JSON.stringify(await calls())})`);
    // A tap: it keeps listening; the next tap stops it.
    await p.locator("#mic-btn").click(); await p.waitForTimeout(150);
    check((await calls())[1] === "start" && await p.locator("#mic-btn.on").count() === 1, "a quick tap starts it and it keeps listening");
    await p.locator("#mic-btn").click(); await p.waitForTimeout(150);
    check((await calls())[1] === "start,stop" && await p.locator("#mic-btn.on").count() === 0, "the next tap stops it");
    // The keyboard: Enter toggles.
    await p.locator("#mic-btn").focus(); await p.keyboard.press("Enter"); await p.waitForTimeout(100);
    check((await calls())[2] === "start", "Enter starts it");
    await p.keyboard.press("Enter"); await p.waitForTimeout(100);
    check((await calls())[2] === "start,stop", "Enter again stops it");
    // While listening with words in the box, the mic stays (red) and Post shows beside it.
    await p.locator("#mic-btn").click(); await p.waitForTimeout(100);
    await p.evaluate(() => { const r = window.__sr.at(-1); r.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: "hello from my voice" }], { isFinal: true })] }); }); await p.waitForTimeout(100); g = await geo();
    check(g.mic && g.post && (await p.locator("#composer-text").inputValue()) === "hello from my voice", `dictating: the words land, the mic stays to stop it, and Post shows (${JSON.stringify(g)})`);
    await p.locator("#mic-btn").click(); await p.waitForTimeout(100);
    // A live call has the mic.
    await p.evaluate(() => { window.__talkNapMs = 60000; }); await p.locator("#composer-text").fill(""); await p.locator(".bp-head [data-talk]").click(); await p.waitForTimeout(600);
    await p.evaluate(() => document.querySelector("dialog.talk").close()); await p.waitForTimeout(200);
    check(await live(p) === 3, "closing the sheet ends the call");
  }
  check(!p.errors.length, `${width}px: no page errors ${p.errors.join(" | ")}`); await ctx.close();
}
await b.close(); console.log(fails ? `${fails} FAILED` : "call standby + composer mic: all passed"); process.exit(fails ? 1 : 0);
