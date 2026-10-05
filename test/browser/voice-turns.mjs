// When Atteo answers in a voice call (vedu #2460; display.voice_turns, vedu's agent #2466): quick = the service's turn
// detection, as before; pause = the page ends your turn after pause_ms of quiet following speech; tap = it waits for
// Done (or the play/pause key), no wake word. Talking over Atteo still stops it. The voice service is the stand-in
// WebSocket from voice-chat.mjs; the microphone is a tone the test turns on and off; the session's voice_turns and
// pause_ms are set on its response. BASE, ADMIN_KEY, PW_CHROME.
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": process.env.ADMIN_KEY || "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), P = `vt${run}`;
await ops("users", { name: P, email: `${P}@example.com`, verified: "true", display: { mode: "developer" } });
const board = (await ops("boards", { user: P, title: `Turns ${run}` })).board.id;
const ck = (await ops("sessions", { user: P })).cookie;
let fails = 0; const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const FAKE = `(()=>{const Real=window.WebSocket;window.__talk={sent:[],opened:0};
  window.WebSocket=function(url,protocols){if(!String(url).startsWith('wss://api.x.ai'))return new Real(url,protocols);
    const ws={url,protocols,readyState:0,send(m){window.__talk.sent.push(JSON.parse(m))},close(){if(this.readyState===3)return;this.readyState=3;setTimeout(()=>this.onclose&&this.onclose({}),0)}};
    window.__talk.ws=ws;window.__talk.opened++;window.__talk.emit=e=>{if(ws.onmessage)ws.onmessage({data:JSON.stringify(e)})};setTimeout(()=>{ws.readyState=1;ws.onopen&&ws.onopen({})},50);return ws};
  Object.assign(window.WebSocket,{CONNECTING:0,OPEN:1,CLOSING:2,CLOSED:3});
  window.__ms={};const ms=navigator.mediaSession;if(ms){const set=ms.setActionHandler.bind(ms);ms.setActionHandler=(k,f)=>{window.__ms[k]=f;return set(k,f)}}
  // The microphone: a tone the test switches on (talking) and off (quiet).
  // A hum the test can raise (a noisy room) under the voice; window.__level sets how loud talking is.
  navigator.mediaDevices.getUserMedia=async()=>{const ac=new AudioContext(),o=ac.createOscillator(),g=ac.createGain(),h=ac.createOscillator(),hg=ac.createGain(),d=ac.createMediaStreamDestination();g.gain.value=0;hg.gain.value=window.__humStart||0;o.frequency.value=220;h.frequency.value=60;o.connect(g);g.connect(d);h.connect(hg);hg.connect(d);o.start();h.start();window.__level=0.4;window.__voice=(on)=>{g.gain.value=on?window.__level:0};window.__hum=(v)=>{hg.gain.value=v};return d.stream};})()`;
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined, args: ["--autoplay-policy=no-user-gesture-required"] });
async function call(turns, pauseMs, hum = 0) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 860 } });
  const [k, ...v] = ck.split(";")[0].split("="); await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage(); p.errors = []; p.on("pageerror", (e) => p.errors.push(e.message));
  await p.addInitScript(`window.__humStart=${hum};`); await p.addInitScript(FAKE);
  await p.route("**/api/app/voice/**", async (route) => {
    const req = route.request(), headers = { ...req.headers(), "x-dev-fake-voice": "1" };
    if (req.url().endsWith("/voice/session") && turns) { const r = await route.fetch({ headers }); const j = await r.json(); j.voice_turns = turns; j.pause_ms = pauseMs; if (turns !== "quick") j.session.turn_detection = null; return route.fulfill({ response: r, json: j }); }
    return route.continue({ headers });
  });
  await p.goto(`${BASE}/b/${board}`); await p.waitForTimeout(700);
  await p.locator(".bp-head [data-talk]").click();
  await p.waitForFunction(() => window.__talk.sent.length > 0 && window.atteoTalk.state()?.ready, null, { timeout: 10000 }).catch(() => {}); // connected (slow when the machine is busy)
  await p.waitForTimeout(300);
  return { ctx, p };
}
const sent = (p) => p.evaluate(() => window.__talk.sent.map((x) => x.type).filter((t) => t !== "input_audio_buffer.append"));
const voice = (p, on) => p.evaluate((on) => window.__voice(on), on);
const st = (p) => p.locator("#talk-st").innerText();
const count = (a, t) => a.filter((x) => x === t).length;

// 1. pause: the page answers after a pause, not between words.
{ const { ctx, p } = await call("pause", 800);
  check((await p.evaluate(() => window.__talk.sent[0]?.session?.turn_detection)) === null, "pause: the session has no server turn detection");
  await voice(p, true); await p.waitForTimeout(500);
  check(/Listening/.test(await st(p)) && await p.locator("dialog.talk.hearing").count() === 1, `talking: it's hearing you ("${await st(p)}")`);
  await voice(p, false); await p.waitForTimeout(500);
  if (process.env.DBG) console.log(await p.evaluate(() => { const s = window.atteoTalk.state(); return JSON.stringify({ talking: s.talking, said: s.said, hearing: s.hearing, turns: s.turns, lv: Date.now() - s.lastVoice, thinking: s.thinking }); }));
  check(count(await sent(p), "input_audio_buffer.commit") === 0 && await p.locator("dialog.talk.waiting").count() === 1 && /answers when you pause/.test(await st(p)), `a short gap: still your turn, with the waiting ring ("${await st(p)}")`);
  await voice(p, true); await p.waitForTimeout(400); await voice(p, false); await p.waitForTimeout(400);
  check(count(await sent(p), "input_audio_buffer.commit") === 0, "going on within the pause keeps the turn open");
  await p.waitForTimeout(800);
  const s1 = await sent(p);
  check(count(s1, "input_audio_buffer.commit") === 1 && s1.indexOf("response.create") > s1.indexOf("input_audio_buffer.commit") && /Thinking/.test(await st(p)), `after the pause: one turn ends (commit, then response.create) and it's thinking ("${await st(p)}")`);
  check(!(await p.locator("#talk-done").isVisible()), "pause mode has no Done button");
  // Talking over Atteo still stops it.
  await p.evaluate(() => { const pcm = btoa(String.fromCharCode(...new Uint8Array(48000))); window.__talk.emit({ type: "response.created", response: { id: "r1" } }); window.__talk.emit({ type: "response.output_audio.delta", response_id: "r1", item_id: "i1", delta: pcm }); });
  await p.waitForTimeout(300); await voice(p, true); await p.waitForTimeout(500); await voice(p, false);
  check(count(await sent(p), "response.cancel") === 1, "talking over Atteo cancels its answer");
  check(!p.errors.length, `no page errors ${p.errors.join(" | ")}`); await ctx.close(); }

// 1b. A quiet voice in a humming room (iOS Safari's processed mic runs low): the threshold follows the room's floor.
{ const { ctx, p } = await call("pause", 800, 0.02); // the room hums from the start, as rooms do
  const shared = await p.evaluate(() => { const t = window.atteoTalk.call(), s = window.atteoTalk.state(); return { same: !!t.ac && t.ac === s.ac, state: t.ac && t.ac.state }; });
  check(shared.same && shared.state === "running", `the call's AudioContext is made in the tap and shared by its session (${JSON.stringify(shared)})`);
  await p.evaluate(() => { window.__level = 0.06; }); await p.waitForTimeout(1500);
  check(await p.locator("dialog.talk.hearing").count() === 0, "a steady hum isn't taken for talking");
  await voice(p, true); await p.waitForTimeout(600);
  check(await p.locator("dialog.talk.hearing").count() === 1, "a quiet voice over it is");
  await voice(p, false); await p.waitForTimeout(1300);
  check(count(await sent(p), "input_audio_buffer.commit") === 1, "and the pause after it ends the turn, hum and all");
  check(!p.errors.length, `no page errors ${p.errors.join(" | ")}`); await ctx.close(); }

// 2. tap: nothing ends your turn but Done (or the pause key).
{ const { ctx, p } = await call("tap", 800);
  check(await p.locator("#talk-done").isVisible() && await p.locator("#talk-done").isDisabled() && /tap Done/.test(await st(p)), `tap: a Done button, off until you've said something ("${await st(p)}")`);
  await voice(p, true); await p.waitForTimeout(500); await voice(p, false); await p.waitForTimeout(2200);
  check(count(await sent(p), "input_audio_buffer.commit") === 0 && await p.locator("#talk-done").isEnabled() && /tap Done/.test(await st(p)), `a long pause doesn't end it ("${await st(p)}")`);
  await p.locator("#talk-done").click(); await p.waitForTimeout(200);
  let s2 = await sent(p);
  check(count(s2, "input_audio_buffer.commit") === 1 && s2.lastIndexOf("response.create") > s2.indexOf("input_audio_buffer.commit"), "Done ends the turn");
  await p.evaluate(() => { window.__talk.emit({ type: "response.created", response: { id: "r2" } }); window.__talk.emit({ type: "response.done", response: { id: "r2" } }); });
  await voice(p, true); await p.waitForTimeout(500); await voice(p, false); await p.waitForTimeout(300);
  await p.evaluate(() => window.__ms.pause()); await p.waitForTimeout(200);
  s2 = await sent(p);
  check(count(s2, "input_audio_buffer.commit") === 2 && await p.evaluate(() => window.__talk.ws.readyState) === 1, "the pause key ends your turn too, and the call stays up");
  check(!p.errors.length, `no page errors ${p.errors.join(" | ")}`); await ctx.close(); }

// 4. The setting: Account → Display → When Atteo answers saves display.voice_turns, and the next call asks for client
// turns and gets that mode from the server.
{ const ctx = await b.newContext({ viewport: { width: 1280, height: 860 } });
  const [k, ...v] = ck.split(";")[0].split("="); await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage(); p.errors = []; p.on("pageerror", (e) => p.errors.push(e.message));
  await p.route("**/api/app/voice/**", (route) => route.continue({ headers: { ...route.request().headers(), "x-dev-fake-voice": "1" } }));
  await p.goto(`${BASE}/me`); await p.waitForTimeout(800);
  check(await p.locator("#dp-voice_turns").isVisible() && await p.locator("#dp-voice_turns-pause").isChecked(), "Account → Display: When Atteo answers, on After a pause by default");
  await p.locator('label[for="dp-voice_turns-tap"]').click(); await p.waitForTimeout(600);
  const prefs = await p.evaluate(async () => (await (await fetch("/api/app/prefs")).json()).prefs);
  check(prefs?.display?.voice_turns === "tap", `…choosing When I tap Done saves it (${JSON.stringify(prefs?.display?.voice_turns)})`);
  await p.addInitScript(FAKE); await p.goto(`${BASE}/b/${board}`); await p.waitForTimeout(700);
  const reqP = p.waitForRequest((r) => r.url().endsWith("/api/app/voice/session"));
  const resP = p.waitForResponse((r) => r.url().endsWith("/api/app/voice/session"));
  await p.locator(".bp-head [data-talk]").click();
  const [req, res] = await Promise.all([reqP, resP]); const rj = await res.json(); await p.waitForTimeout(600);
  check(JSON.parse(req.postData() || "{}").client_turns === true && rj.voice_turns === "tap" && rj.session.turn_detection === null && await p.locator("#talk-done").isVisible(), `the call asks for client turns and runs tap mode (${rj.voice_turns}, ${JSON.stringify(rj.session.turn_detection)})`);
  await p.locator("#talk-end").click();
  await p.evaluate(() => fetch("/api/app/prefs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ display: { voice_turns: "pause" } }) }));
  check(!p.errors.length, `no page errors ${p.errors.join(" | ")}`); await ctx.close(); }

// 3. quick: the service finds the turns, as before.
{ const { ctx, p } = await call("quick", 0);
  await voice(p, true); await p.waitForTimeout(500); await voice(p, false); await p.waitForTimeout(1200);
  const s3 = await sent(p);
  check(count(s3, "input_audio_buffer.commit") === 0 && !(await p.locator("#talk-done").isVisible()) && await p.locator("dialog.talk.hearing").count() === 0, "quick: the page leaves turns to the service (no commit, no Done)");
  check(!p.errors.length, `no page errors ${p.errors.join(" | ")}`); await ctx.close(); }
await b.close(); console.log(fails ? `${fails} FAILED` : "voice turns: all passed"); process.exit(fails ? 1 : 0);
