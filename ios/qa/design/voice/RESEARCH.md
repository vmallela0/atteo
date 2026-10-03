# Atteo Voice: talk to your agents, hands-free (research for #1069)

This is research only. No app code changed. Date: 2026-10-03. The ask, paraphrasing vedu and jxn in #1069: "One AirPod in all day. You talk, the agents build in the background. A model in front tells talking-to-Atteo apart from talking to people. It blips when it's ready, you say 'go ahead', and it speaks. SEAMLESS."

## Recommendations

1. **The listening runs on the phone, and the cloud only joins when you're talking to Atteo.** Apple's on-device speech stack (SpeechDetector VAD, then SpeechTranscriber, iOS 26) listens all day for $0. An addressee check decides whether each utterance was meant for Atteo, and only then does a cloud voice model open. Every vendor bills either connected minutes or audio tokens, so streaming a whole day's audio costs $0.30/hr (Gemini, listening only) to $3–4.80/hr (connected-minute vendors) of wear, against cents for a gated day.
2. **v1 addressee detection: a soft wake word plus a directed-speech classifier, with the blip as the safety net.** Starting an utterance with "Atteo, …" always routes it. Without the name, a small model scores the transcript plus context (am I mid-exchange, was the last blip under 30 s ago, is someone else talking) and decides. Because Atteo only blips and never just starts talking, a false positive costs one soft blip, not an interruption. Hold-to-talk (AirPods press or an on-screen button) always works.
   **Later:** use a vendor's own directed-speech filter (Gemini Live "proactive audio") as a second opinion, plus speaker verification so it only acts on *your* voice. If the heuristics plateau, add a multi-signal classifier (audio + ASR confidence + text), as in Apple's research.
3. **v1 voice front: Gemini 3.8 Live, with GPT-Live-1 as the A/B.** Gemini is about 5x cheaper per spoken minute ($0.005/min in, $0.018/min out). It has non-blocking function calls (so agents work while it keeps talking), opt-in proactive audio, and a free tier for prototyping. GPT-Live-1 has the best turn-taking (OpenAI reports about 0.8 s) and a "client delegation" mode that is exactly "Claude behind a voice front". But it costs $3 per *connected* hour, so it suits short sessions only. Grok Voice is the same $3/hr flat rate and is OpenAI-compatible, so it's a cheap swap if we want it.
4. **Claude stays the brain.** The voice front only handles turn-taking. Its single real tool is "post to the board for my agents" (plus read, mailbox and recap). The Claude agents that already watch the board do the work in the background, and their results come back through `mailbox`, where the front summarizes them aloud. The text brain costs pennies; audio is the bill.
5. **v0 needs no vendor at all (1–2 days, S).** Push-to-talk in the app transcribes on-device and posts to the board as you, addressed to "@vedu's agent". When the agent's reply lands on the existing board socket, the app reads it aloud with on-device TTS. That tests the core loop (speak, agents work, hear the result) before we pay for anything.
6. **iOS facts that shape the plan:**
   - Recording **cannot start from the background**: the user has to start "Listening" with the app in the foreground. After that, the `audio` background mode keeps it alive, and a Live Activity shows the state and pauses or resumes it.
   - The orange mic dot is always on while listening.
   - Pressing the AirPods stem can mute and unmute through `AVAudioApplication` (iOS 17+). To test: this likely requires the voice-chat session mode.
   - A nod for "go ahead" is possible with `CMHeadphoneMotionManager`, but whether it works in the background is untested.
   - None of v0 or v1 needs the paid developer account. Push, CarPlay and TestFlight do.

---

## 1. The experience

### Modes (one switch, three levels)
| Mode | How you talk to Atteo | When |
|---|---|---|
| **Hold to talk** (v0, always available) | Hold the on-screen mic, the AirPods stem (once it's wired as the mute toggle, see §4) or the Action Button | Default. Zero ambiguity. |
| **Hands-free** (v1) | Just talk. "Atteo, …" always routes; otherwise the classifier decides | Walking around with one AirPod in |
| **Meeting** (v2) | Atteo listens to everyone in a board meeting and speaks only when it's addressed or has something worth a blip | A call or room with people and agents |

### Turn-taking: blip, then "go ahead"
1. You speak. On-device VAD and ASR produce an utterance and the addressee check scores it.
2. **If it's directed:** the front model builds its reply, but the phone *holds* the audio (or text) instead of playing it. You hear a short **blip** (an earcon with a haptic on the watch or phone). With high confidence plus an explicit "Atteo, …", the reply plays straight away.
3. **"Go ahead"** (or a nod, a stem press, "yeah", "tell me") plays the held reply. **"Later" or silence** for about 20 s parks it as a card on the board, and the blip doesn't repeat.
4. **Barge-in:** if you start talking while it speaks, playback stops immediately and the session listens again.
5. **If it's not directed:** nothing happens and nothing is sent anywhere. The transcript is dropped (or kept on the device for at most N minutes as context, a setting).

This is vendor-agnostic. Every speech-to-speech API streams the reply to the client, and the client decides when to play it. A discarded reply costs its output tokens, which is why the reply is generated as text first when we can (cheaper) and turned into speech after "go ahead".

### Speech becomes work for agents
- The front model has one main action: **`post`** to the right board, as you, in a thread, `to` your agent (or "@jxn's agent"), with the transcript cleaned into a task. For example: "Fix the seen-by tooltip on iOS. Spoken by vedu at 14:02, voice." A voice post carries a 🎙 marker so people can see where it came from.
- It says one short line back ("On it, posted to annex for your agent"), then goes quiet. Agents pick the post up the way they do today (mailbox, `wait`, dispatcher).
- Anything with side effects outside Atteo still goes through **`request_approval`**. The voice reads the ask ("jxn's agent wants to deploy, approve?"), and "approve" or "deny" answers it, with a repeat-back confirmation for anything destructive.

Voice posts follow DESIGN-LANGUAGE.md: they render as the person's bubble with the 🎙 marker, and agent replies render as cards. There is no "working" bubble, only the 🤔 receipt and the Live Activity.

### Results come back by voice
- The phone already holds a live socket per board. When an entry *replies to one of your voice posts*, or mail for you arrives (a decision, @you, an approval), Atteo **blips** rather than speaking unprompted. "Go ahead" reads a 1–2 sentence summary (made by the front model or a small Claude call), never raw logs. For example: "Your agent shipped the tooltip fix, commit c447, needs nothing from you."
- "What did I miss?" calls `recap`, and "anything for me?" calls `mailbox`.
- Quiet rules: no blips during Focus modes unless something needs your decision, at most one blip per minute, and lower-priority results are batched into a "3 updates" blip.

### Meetings (v2)
A "meeting" is a board thread with live voice:
- Each person's phone transcribes **only its own wearer** and posts their lines into the shared thread, so the board itself is the shared context and diarization comes free.
- Agents present in the board can be addressed by name ("Claude, take that one").
- Atteo speaks only when someone addresses it. At the end it posts decisions, tasks and owners as typed entries.

See §6 for the two ways to build this.

### Privacy and mute
- **Always visible:** iOS shows the orange mic dot. On top of that we show a Live Activity or Dynamic Island state: Listening, Heard you (blip pending), Working (N agents), Muted.
- **One-gesture mute:** a stem press through `AVAudioApplication` input mute, the Live Activity button, the Action Button, or saying "Atteo, stop listening". Muting gets a distinct two-tone earcon.
- **What's kept:** audio never leaves the phone unless the utterance was directed, and only then for that session. No audio is stored; the board stores text only. Undirected transcripts are never uploaded.
- **Other people:** two-party-consent laws apply to recording people. Meeting mode shows "Atteo is listening" to every participant and requires each person to opt in on their own phone. Hands-free mode never posts what other people said.

---

## 2. Addressee detection: talking to Atteo, or to a person?

| Approach | How | Pros | Cons | Cost / effort |
|---|---|---|---|---|
| **Hold to talk** | A press or hold starts the utterance | 100% precise, trivially private | Not hands-free | Free / S |
| **Wake word** ("Atteo") | A keyword spotter on the audio, or on the transcript | Predictable, cheap | Feels robotic, and people don't say it mid-thought. Picovoice Porcupine custom words need a paid commercial plan (third-party pricing pages: about $6k/yr startup tier) | Transcript match: free / S. Acoustic spotter: $ / M |
| **Directed-speech classifier** (front model) | Score each utterance from its text plus context: second person ("can you…"), imperative about work, mentions of boards, agents or tasks, prosody, whether we're mid-exchange, whether another voice spoke just before | Natural, and the blip absorbs its errors | Needs tuning, and false positives on "can you pass the salt" | On-device Apple Foundation Models (iOS 26, Apple-Intelligence iPhones; to test) = free. Claude Haiku 4.5 is about $0.001–0.002 per utterance, roughly $0.30/day / M |
| **Vendor proactive audio** | Gemini Live `proactive_audio: true`: "Gemini can proactively decide not to respond if the content is not relevant" | Built in, audio-aware | Opt-in and v1beta (the official docs say it must be enabled; a blog claiming it's on by default for 3.8 Live is unconfirmed). It only works while a cloud session is open, so it isn't an all-day filter | Session cost / S |
| **Speaker verification** (is it the owner's voice?) | Enrol the owner's voice and drop other speakers (Picovoice Eagle, or an open-source ECAPA model in Core ML) | Kills "someone near me said 'can you'" errors | Only tells you *who* spoke, not *whom they spoke to* | M |
| **Speaker diarization** | Separate the voices in a mixed stream | Needed for single-mic meetings | Heavy and error-prone. Not needed when each person's own phone does the capture | L |
| **Gaze / head gestures** | `CMHeadphoneMotionManager`: a nod to confirm, a head shake to dismiss | Great as the "go ahead" *confirm* | Not an addressee signal on its own (people nod at people). Background delivery untested | S–M |
| **Own-voice detection** | AirPods' voice accelerometer knows when the wearer speaks | Ideal signal | **No public API** for third parties (as far as we found) | n/a |

Apple's research frames this exact problem (follow-ups without a trigger phrase) as an LLM over ASR text plus audio embeddings. Multi-modal beat text-only by 38.9% EER. That's a reasonable later-stage target if we have labelled data ([Apple MLR](https://machinelearning.apple.com/research/llm-device-directed-speech-detection), [arXiv 2403.14438](https://arxiv.org/pdf/2403.14438)).

**v1:** hold-to-talk, plus "Atteo, …" spotted in the on-device transcript, plus a text-and-context classifier for follow-ups during a **conversation window** (90 s after the last exchange, nothing needs a name). The blip and "go ahead" step catches the classifier's mistakes.
**Later:** owner speaker verification, then Gemini proactive audio as a second opinion while a session is open, then a fine-tuned multi-signal classifier trained on our own logged "blip ignored" and "go ahead" outcomes (which double as labels).

---

## 3. Voice stack options

**Billing basis matters more than the rate.** "Connected-minute" vendors (GPT-Live-1, Grok Voice, ElevenLabs) bill silence too. Token-billed vendors (Gemini Live, gpt-realtime) bill audio in and out, and gpt-realtime also re-bills the session context on every response (cached at $0.40/1M, which adds up over a long session).

| Option | Type | Latency (claimed) | Listening $/hr | Speaking $/hr | Gated day* | Notes |
|---|---|---|---|---|---|---|
| **Gemini 3.8 Live** (`gemini-3.8-live`, announced Sep 15 2026 per third-party reports) | Cloud speech-to-speech | Sub-second (third-party) | ~$0.30 (in $3/1M, $0.005/min) | ~$1.08 (out $12/1M, $0.018/min) | **~$0.30** + context | Non-blocking function calls; proactive audio opt-in; audio-only sessions 15 min, WebSocket ~10 min with resumption; ephemeral tokens for client connections; free tier. An "Extended Thinking" variant reasons in the background at the same price. |
| **GPT-Live-1** (API Sep 10 2026) | Cloud full-duplex | 0.798 s turn-taking (OpenAI) | $3.00 (connected time) | included | **~$1.50** + warm windows + backend model | Full duplex; "client delegation" hands reasoning to your own model or agent; WebRTC, WebSocket and SIP; explicit turn detection; 12 voices. |
| **gpt-realtime-2.1** / **-mini** | Cloud speech-to-speech | ~1 s (unsourced) | $1.15 / $0.38 | $4.60 / $1.50 | ~$1.15 / ~$0.40 + context re-billing | Semantic VAD, async function calls, **remote MCP in-session** (could point straight at `/mcp`), 128k context, **60 min session cap**. |
| **xAI Grok Voice Agent API** (Dec 2025) | Cloud speech-to-speech | <1 s time to first audio (xAI) | $3.00 flat | included | ~$1.50 + warm windows | OpenAI-Realtime-compatible WebSocket; tools; 3 voices; LiveKit plugin. Remote MCP support unverified. |
| **ElevenLabs Agents** | Cloud cascaded platform | ~1 s (third-party) | $4.80 + LLM | included | ~$2.40 + LLM | Best voices; you bring the LLM (Claude works); the most expensive here. |
| **Deepgram Flux** (STT) + TTS + LLM | Cloud cascaded | Sub-300 ms end-of-turn (Deepgram) | $0.39 | TTS ~$2.40 (Flux TTS $0.045/1k chars) | ~$0.55 + LLM | Built-in end-of-turn detection; also on Cloudflare Workers AI ($0.0077/min, third-party report) next to our Worker. |
| **OpenAI transcription** | Cloud STT | Streaming | $1.02 (gpt-live-transcribe / realtime-whisper) or $0.18 (gpt-4o-mini-transcribe) | n/a | n/a | Only useful if on-device ASR proves too weak. |
| **Apple SpeechAnalyzer + SpeechTranscriber + SpeechDetector** (iOS 26) | **On-device** STT and VAD | ~0.3–0.5 s to first volatile result, warm (third-party, iPhone 16e) | **$0** | n/a | **$0** | Long-form, no 1-minute cap, the model ships with the OS. **Our app targets iOS 18**: bump the target to 26 or use `#available` with an SFSpeechRecognizer fallback. |
| **AVSpeechSynthesizer** (+ Personal Voice) | **On-device** TTS | Instant | n/a | **$0** | $0 | Good enough for v0; robotic next to the cloud voices. Personal Voice needs the user to opt in under Settings > Accessibility, and Apple steers it toward assistive (AAC) apps, so don't build on it. |
| **Claude as the text brain** | Cloud text | ~1 s first token | n/a | n/a | ~$0.05–0.50 | Haiku 4.5 $1/$5, Sonnet 5.5 $2/$10, Opus 5.5 $4/$20 per 1M tokens. **No native realtime audio**, so it sits behind a voice front. |

\*Gated day = wearing it 8 h, about 30 directed minutes (~20 min of you talking, ~10 min of it speaking). The on-device listening layer is free in every row. Agents' own work is billed to their existing subscriptions and isn't counted here.

**Rough cost per hour:**
- *Always streaming to the cloud:* $0.30–4.80/hr of wear, so 8 h costs $2.40–38/day per person.
- *Gated (recommended):* about **$0.30–1.50 per day** with Gemini or GPT-Live-1. That's roughly **$0.04–0.20 per hour worn**, or about **$0.60–3.00 per hour of actual talking**.
- *v0:* $0.

### How a Claude-backed agent works behind a voice front
- The front (Gemini Live or GPT-Live-1) owns the audio: VAD, barge-in, the held reply, short acknowledgements.
- Its tool calls are thin wrappers around Atteo MCP tools: `post` (to the board, `to` an agent, threaded), `mailbox` (results for me), `read` and `recap` (catch up), `approval` (answer a pending ask).
- Gemini's `NON_BLOCKING` calls and GPT-Live-1's client delegation both let the front keep talking while a tool runs.
- The Claude agents already on the board (Claude Code dispatchers, routines) do the real work exactly as they do for typed posts. **Nothing about the agents changes.**
- When a reply lands in `mailbox` or on the board socket, the front, or a one-shot Claude Haiku call, condenses it to a sentence and blips.
- gpt-realtime-2.x can call `/mcp` directly as a remote MCP server. For Gemini and GPT-Live-1 we proxy the few tools through function calls. Remote MCP support in Gemini Live and Grok Voice is unverified.

---

## 4. iOS constraints

| Need | Reality | Paid account? |
|---|---|---|
| All-day mic | `UIBackgroundModes: audio` keeps an **already running** recording alive in the background. Apple DTS: "Apple strictly prevents apps from initiating an AVAudioSession for recording from a completely backgrounded state." So "Start listening" must happen with the app in the foreground. Review guideline 2.5.4 limits background modes to their intended purpose (a recording or voice app is a fit if listening is the visible core feature). Guideline 2.5.14 requires clear consent. Interruptions (calls, Siri, alarms) end the session and need a Resume button. | No (free team builds to a device, but signing expires **every 7 days**, which hurts all-day testing) |
| Battery | Continuous mic plus on-device ASR costs real battery: **unmeasured**, needs profiling. Running only SpeechDetector (VAD) until speech appears, then the transcriber, is the main lever. Avoid keeping a cloud socket open while idle. | n/a |
| Mic indicator | The orange dot shows whenever the mic is live and can't be hidden. Embrace it, and add our own Live Activity state. | n/a |
| AirPods stem press | No general stem-press API. **But** the iOS 17+ `AVAudioApplication.setInputMuteStateChangeHandler` lets the AirPods press toggle *our* mic mute (as in calls), which is our "easy mute". To test: this likely requires the `.voiceChat` / voice-processing session. `MPRemoteCommandCenter` play/pause only arrives while we're the Now Playing app (could map to "go ahead"; untested alongside recording). | No |
| Head gestures (nod = go ahead) | `CMHeadphoneMotionManager` (iOS 14+) streams AirPods head orientation at ~25 Hz, and third-party apps can detect a nod or shake. Apple's own nod-to-answer isn't exposed. Background delivery while recording is **untested** (the known background cut-off is for `CMMotionManager`). Needs `NSMotionUsageDescription`. | No |
| Echo / barge-in | Use `AVAudioSession` `.playAndRecord` + `.voiceChat` mode (voice processing, echo cancellation) so the phone speaker doesn't trigger itself. Less of an issue with AirPods. | No |
| CallKit / LiveKit | CallKit is for real calls; faking a call to stay alive risks rejection. The LiveKit Swift SDK works with the plain `audio` background mode and is the natural transport for v2 rooms. | No (VoIP push needs paid) |
| Live Activity ("Listening / Heard you / Working / Muted") | ActivityKit, started locally from the foreground. Its buttons run `LiveActivityIntent`s (pause, resume, mute, go ahead). `AudioRecordingIntent` requires a Live Activity, and per DTS it can only *manage* a session already started in the app. | Local: no. Updates pushed from the server: **paid** |
| Siri / App Intents / Action Button / Control Center | App Intent "Talk to my agents" opens the app and starts listening. It can be bound to the Action Button, a Control Center control or a Shortcut. "Hey Siri, talk to Atteo" via App Shortcuts. | No |
| CarPlay | iOS 26.4 added a **voice-based conversational app** category (`com.apple.developer.carplay-voice-based-conversation`). Apple approves each request; the app must use the voice control template; no third-party wake word; voice-first. | **Paid** + entitlement request |
| Notifications as the fallback for results | APNs push with Approve / Deny / Reply. | **Paid** |

The project is at iOS 18.0, `DEVELOPMENT_TEAM: ""` and bundle id `com.atteo.app` (`ios/project.yml`). v0 and v1 fit the free team. The paid account becomes necessary for TestFlight to jxn and others, push results, Live Activity push updates, and CarPlay.

---

## 5. Architecture sketch

```
 AirPods mic
     │
 iPhone (always on, free)
   AVAudioSession playAndRecord/voiceChat, background audio
   SpeechDetector (VAD) ──► SpeechTranscriber (on-device text)
                               │
                     addressee check (transcript "Atteo" + classifier
                     on Foundation Models or Haiku, + context window)
              not directed │            │ directed
                drop ◄─────┘            ▼
                            open/keep a voice session (ephemeral token from our Worker)
                                        │
 Vendor (Gemini 3.8 Live | GPT-Live-1)  │  speech in/out, barge-in, tool calls
                                        ▼
 Our Cloudflare Worker  ── /api/voice/token (mints vendor ephemeral token; no vendor key on the phone)
                        ── tools proxied to existing board APIs: post, mailbox, read/recap, approval
                                        │
 Board (Durable Object) ◄───────────────┘   append-only log, threads, mailbox
     │  socket (already in the app)          ▲
     ▼                                       │
 Agents (Claude Code dispatchers, Grok bot, routines) pick up the post, work, reply in thread
     │
 Reply in thread / mail ──► phone socket ──► summarize (front or Haiku) ──► blip ──► "go ahead" ──► speak
```

- **Where the front runs.** The *listening* front (VAD, ASR, addressee check) runs **on the phone**. The *talking* front runs at the **vendor**, connected straight from the phone with an ephemeral token our Worker mints, so audio doesn't hairpin through Cloudflare. The Worker never holds audio. It mints tokens and executes the board tools under the user's own auth, so access rules and untrusted-content fencing stay exactly as they are today.
- **Session lifecycle.**
  - Open on the first directed utterance. If the session isn't warm, the first reply takes ~1–2 s longer to connect, which the blip and hold step hides.
  - Keep it warm for a **conversation window** of about 90 s after the last exchange, then close. This also respects the vendor caps (Gemini 15 min for audio-only, with ~10 min sockets needing resumption; OpenAI 60 min).
  - Carry continuity by passing a short text summary into the next session, not by keeping a socket open.
- **Board reads.** On demand only. An always-on voice client must **never poll** `read` or `mailbox`. We have a daily rows-read cap on the Durable Object, and a prod load test already caused an outage on Oct 2. Results arrive over the board socket the app already holds; `mailbox wait_seconds` is used only inside an active exchange.
- **Cost controls, in order:**
  1. VAD gating.
  2. On-device ASR first.
  3. Addressee check before any network call.
  4. Cloud sessions only for directed speech, with a short warm window.
  5. Text-first replies held until "go ahead" (TTS only what gets played).
  6. A cheap model (Haiku) for summaries.
  7. Per-user daily cloud-minute cap with a spoken "voice minutes used up, switching to the on-device voice".

---

## 6. Phased plan

### v0: push-to-talk loop (1–2 days, **S**)
- **Capture.** A mic button in the board composer. While held: `AVAudioSession` `.playAndRecord` and on-device transcription (SpeechAnalyzer behind `#available(iOS 26)`, otherwise SFSpeechRecognizer with `requiresOnDeviceRecognition`). Add `NSMicrophoneUsageDescription` and `NSSpeechRecognitionUsageDescription`.
- **Post.** On release, call the existing `AppState.send(_:to:replyTo:toSession:type:)`. Text: "@vedu's agent …" plus a 🎙 marker, so agents get it in `mailbox` like any mention.
- **Listen.** Use the board socket the app already has (`API.socket(board:)`). When an entry replies to that voice post, speak a trimmed version with `AVSpeechSynthesizer`, with a "Read replies aloud" toggle.
- **Out of scope:** server changes, vendor keys, background listening.
- **Success:** say it, walk away, hear the agent's answer come back.

### v1: hands-free with addressee detection, blip and go-ahead (2–3 weeks, **M–L**)
- **Listening service.**
  - A "Start listening" control in the app, on the Action Button or in Control Center.
  - Background audio mode, a Live Activity (Listening / Heard you / Working / Muted) and mute through `AVAudioApplication`.
  - SpeechDetector VAD feeding SpeechTranscriber.
  - Requires iOS 26 on the device.
- **Addressee check.** "Atteo" spotted in the transcript, the conversation window, and a classifier (Foundation Models on device if good enough, else Haiku through our Worker).
  - Log "blip ignored" and "go ahead" outcomes as on-device labels.
  - A "Why did you blip?" debug view.
- **Voice front.**
  - New Worker route `/api/voice/token` (mints a Gemini ephemeral token).
  - A tool proxy for post, mailbox, recap, read and approval, reusing the existing handlers.
  - Gemini 3.8 Live with non-blocking calls. GPT-Live-1 behind a flag for an A/B on feel.
- **Blip and go-ahead.**
  - The reply is held until "go ahead", a nod, a stem or Now-Playing press, or a Live Activity button. "Later" parks it as a card.
  - Barge-in cancels playback.
- **Results by voice.** Socket events for replies to voice posts, plus mailbox items while listening, become a summary, then a blip.
- **Must not:** poll the DO, keep idle cloud sockets, or upload undirected transcripts.
- **Exit criteria:**
  - Under 1 false blip per 30 min of normal conversation.
  - Blip within 1.5 s of the end of a directed utterance.
  - A cloud cost of at most about $1 per worn day.

### v2: meetings with several people plus agents (4–6 weeks, **L**)
- **Option A (recommended first): "each phone hears its owner".** Every participant runs v1 listening with speaker verification. Their lines post into one board thread marked as a meeting, and each speaker is labelled by whose phone heard them.
  - Atteo answers when addressed by anyone, with the reply audio played on that person's phone.
  - Agents follow the thread live.
  - Costs: duplicate capture when phones are near each other (dedupe by transcript similarity within ~5 s), and no shared room audio.
- **Option B: a shared room.** A LiveKit room with an agent participant ($0.01/min agent sessions on LiveKit Cloud, plus the voice model) or Cloudflare Realtime.
  - Real shared audio for remote calls, and one voice model hears everyone.
  - Needs diarization or per-track attribution, and costs more.
- **Both options:**
  - A consent banner for every participant.
  - An end-of-meeting post of decisions, tasks with owners and open questions as typed entries.
  - "Catch me up" for latecomers using `recap`.
- **Paid account by now:** TestFlight to jxn and others, push for results, optionally CarPlay (entitlement request).

---

## Sources

**Primary**
- OpenAI API pricing (gpt-realtime-2.1 and mini, transcription models): https://developers.openai.com/api/docs/pricing
- GPT-Live-1 announcement (pricing, delegation, transport, 0.798 s): https://community.openai.com/t/introducing-gpt-live-1-in-the-api/1396471
- Gemini API pricing (`gemini-3.8-live`, per-minute rates): https://ai.google.dev/gemini-api/docs/pricing
- Gemini Live capabilities (proactive audio opt-in, NON_BLOCKING calls, 15 min sessions, ephemeral tokens): https://ai.google.dev/gemini-api/docs/live-api/capabilities
- xAI Grok Voice Agent API ($0.05/min, <1 s, OpenAI-Realtime compatible): https://x.ai/news/grok-voice-agent-api
- Apple DTS on starting a recording from the background / AudioRecordingIntent: https://developer.apple.com/forums/thread/815725
- Background recording must start in the foreground: https://developer.apple.com/forums/thread/770556
- SpeechAnalyzer (WWDC25): https://developer.apple.com/videos/play/wwdc2025/277/
- `AVAudioApplication.setInputMuteStateChangeHandler`: https://developer.apple.com/documentation/avfaudio/avaudioapplication/setinputmutestatechangehandler(_:)
- Personal Voice in third-party apps (WWDC23): https://developer.apple.com/videos/play/wwdc2023/10033/
- Apple ML research, device-directed speech: https://machinelearning.apple.com/research/llm-device-directed-speech-detection , https://arxiv.org/pdf/2403.14438
- Claude model pricing: Anthropic API skill reference (cached 2026-09-25)

**Third-party (treat as approximate)**
- gpt-realtime-2 features (semantic VAD, remote MCP, 60 min cap): https://apidog.com/blog/gpt-realtime-2-api/ , https://dev.to/akaranjkar08/openai-gpt-realtime-2-complete-voice-api-developer-guide-2026-aj6
- gpt-realtime per-minute math: https://www.eesel.ai/blog/gpt-realtime-mini-pricing , https://hackernoon.com/openai-realtime-api-pricing-in-2026-real-world-data-from-4000-measured-sessions
- Gemini 3.8 Live launch and claims: https://www.techrepublic.com/article/news-gemini-3-8-live-models/ , https://www.datacamp.com/blog/gemini-3-8-live
- ElevenLabs Agents $0.08/min: https://www.cloudzero.com/blog/elevenlabs-pricing/ , https://elevenlabs.io/blog/we-cut-our-pricing-for-conversational-ai
- Deepgram Flux pricing and EOT: https://diyai.io/ai-tools/speech-to-text/deepgram-pricing-2026/ , https://deepgram.com/learn/best-speech-to-text-apis-2026
- Cloudflare voice agents / Workers AI rates: https://blog.cloudflare.com/voice-agents/ , https://developers.cloudflare.com/workers-ai/platform/pricing/
- SpeechAnalyzer live-mic latency: https://dev.to/simple_memo/ios-26s-speechanalyzer-on-a-live-mic-the-5-things-the-docs-dont-tell-you-2ng5
- CarPlay voice-conversation apps (iOS 26.4): https://www.macrumors.com/2026/02/18/ios-26-4-carplay-support/ , https://appleinsider.com/articles/26/02/18/ai-agents-are-coming-to-carplay-but-theyre-not-getting-the-keys
- AirPods head motion in third-party apps: https://github.com/tukuyo/AirPodsPro-Motion-Sampler
- Picovoice pricing (Porcupine/Eagle): https://picovoice.ai/pricing/ , https://checkthat.ai/brands/picovoice/pricing
- LiveKit pricing / Swift background audio: https://livekit.com/pricing , https://docs.livekit.io/transport/sdk-platforms/swift/

**Unverified / to test in prototype:** CMHeadphoneMotionManager delivery in the background, battery drain from all-day SpeechAnalyzer, Apple Foundation Models accuracy as a directed-speech classifier, remote MCP in Gemini Live and Grok Voice, MPRemoteCommandCenter events while recording, whether Gemini bills accumulated context per turn in Live sessions.
