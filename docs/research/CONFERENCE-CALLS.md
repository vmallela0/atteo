# Conference calls: N people + Atteo on one call

This note is research only. No product code changes.

The question is not "can we make a room?" — it is "what is the cheapest, least surprising way to add a shared room while keeping Atteo as one participant that only speaks when addressed?"

## What the repo does today

At the moment, the repo's voice path is person-only:

- `POST /api/app/voice/session` returns a short-lived xAI Grok Voice realtime client secret and a `session.update` payload.
- The app does **not** proxy audio; the client connects directly to xAI's websocket.
- The current voice caps in `wrangler.jsonc` are:
  - `VOICE_MONTHLY_MINUTES = 60`
  - `VOICE_GLOBAL_MONTHLY_MINUTES = 600`

That means the current monthly budget envelope is already very tight:

- xAI voice at $0.08/min works out to **$4.80 per person per month** at the current 60-minute cap.
- The global 600-minute cap is **$48/month** of xAI voice spend if fully consumed.

So any conference-room design has to keep the media layer close to free, because the voice model itself already uses up the budget quickly.

## The room model we want

For a call with N people plus Atteo, the clean mental model is:

1. Everyone joins one shared room.
2. Each human publishes one audio track.
3. Atteo is one more participant, but it should only become audible when the room has addressed it.
4. The room controller decides when to forward a turn to the voice model.
5. When Atteo answers, its audio goes back into the room as one participant's output track.

The important part is that **Atteo should not be continuously "talking" to the model just because the room is open**. If the room is live for 30 minutes but only 3 minutes are actually directed at Atteo, the model cost should stay close to those 3 minutes.

## Cloudflare Realtime SFU

Cloudflare Realtime SFU is the lower-level WebRTC primitive:

- Cloudflare handles the SFU / TURN path.
- The app handles signaling, permissions, session state, and track discovery.
- Pricing is based on data sent from Cloudflare to clients: **$0.05/GB egress**, with the first **1,000 GB/month free**.
- Published traffic into Cloudflare is free; only downstream egress is billed.

### Why it fits this repo

This repo already lives on Cloudflare Workers + Durable Objects. That means:

- signaling can stay in the same control plane as boards and approvals;
- a shared room can reuse the app's existing auth and board membership checks;
- the SFU cost stays separate from the voice model cost, which is exactly what we want when the model is already the dominant line item.

### Cost shape

For planning, a narrowband voice stream is cheap. Using a rough 24-32 kbps Opus assumption, one forwarded audio stream is on the order of **$0.00001 per stream-minute** at Cloudflare's $0.05/GB egress price.

That means:

- the room layer is effectively **sub-cent per minute** even for several participants;
- the total scales mostly with the number of listeners receiving a stream, not with an extra vendor room fee;
- the cost floor is still tiny compared with xAI's **$0.08/min** voice model price.

So if we want the cheapest media plane, Cloudflare SFU wins by a lot.

## LiveKit

LiveKit is the more opinionated room stack:

- it gives you a ready-made room / participant / agent model;
- it is easier when you want a full meeting SDK, built-in agent patterns, and room lifecycle primitives;
- the tradeoff is that the pricing is no longer just network egress.

From LiveKit's pricing docs:

- WebRTC participant minutes are metered per connected participant minute.
- Agent sessions are metered separately.
- On the Ship tier, the published unit prices are **$0.0005/min per WebRTC participant** and **$0.01/min per agent session**.

### Cost shape

If we have N humans plus Atteo in one room, and Atteo is connected for the whole call, the room floor on LiveKit is roughly:

`N * $0.0005/min + $0.01/min`

before any model spend, recordings, or inference.

Examples on Ship pricing:

- 3 humans + Atteo: `3 * 0.0005 + 0.01 = $0.0115/min`
- 5 humans + Atteo: `5 * 0.0005 + 0.01 = $0.0125/min`
- 10 humans + Atteo: `10 * 0.0005 + 0.01 = $0.0150/min`

That is still not huge, but it is **much** higher than Cloudflare SFU for the media layer, and it introduces a second per-minute meter that is unrelated to the voice model.

## How xAI should join

If we use either room stack, xAI should be treated as **one participant**, not as a hidden server-side sidecar.

The rule should be:

- **not addressed** → xAI stays muted / not forwarded audio;
- **addressed** → the controller forwards the turn to xAI;
- **reply** → xAI publishes one answer track back into the room.

That gives us two important properties:

1. xAI only bills for the turns that matter, instead of wall-clock room time.
2. The room can still feel like a normal conference call, with Atteo appearing as a participant who can answer when spoken to.

Practically, this means the room controller needs an addressee check before it forwards audio to xAI. The check can be simple at first:

- explicit wake phrase or name mention;
- turn-taking state;
- "reply to Atteo" button or gesture for ambiguous cases.

The point is to keep xAI from hearing the whole room unless the room actually intends it to respond.

## Cost estimate vs the current voice caps

The current caps in `wrangler.jsonc` imply:

- **60 minutes/person/month**;
- **600 minutes global/month**.

At xAI's current voice price of **$0.08/min**, that means:

- per-person cap value: `60 * 0.08 = $4.80/month`;
- global cap value: `600 * 0.08 = $48/month`.

That gives us a useful way to think about the room:

- If the room is mostly a media transport problem, Cloudflare SFU keeps the transport cost well below the existing voice budget.
- If we use LiveKit, the room transport floor is still small in absolute terms, but it is no longer negligible compared with the current per-user voice cap.
- If xAI is connected for the whole meeting, xAI remains the dominant cost.

In other words:

- **Cloudflare SFU**: media cost is effectively background noise;
- **LiveKit**: media cost is visible but still modest;
- **xAI**: still the main per-minute spend unless we aggressively gate turns.

## Recommendation

Use **Cloudflare Realtime SFU** for the shared room, and keep xAI as a gated participant that only receives directed turns.

Why:

1. **It matches the existing architecture.** The repo already runs on Cloudflare Workers and Durable Objects, so signaling and room control can live alongside the existing board model.
2. **It keeps the media layer cheap.** Cloudflare SFU bills by egress, which is far cheaper than per-participant room metering for this use case.
3. **It preserves the right unit of billing.** xAI should be the expensive part only when Atteo is actually addressed.
4. **It keeps the design honest.** Atteo is one participant in the room, not a hidden background process silently consuming audio.

I would only pick LiveKit if the priority changed from "best fit for this repo and cheapest media plane" to "fastest way to buy a full meeting SDK with built-in room ergonomics."

## Sources

### Repo grounding

- `wrangler.jsonc` — current voice caps (`VOICE_MONTHLY_MINUTES`, `VOICE_GLOBAL_MONTHLY_MINUTES`)
- `docs/APP_API.md` — current xAI realtime voice session shape and `session.update` flow
- `src/voice.ts` — direct xAI client-secret minting and the current xAI websocket path

### Vendor claims

- Cloudflare Realtime overview: https://developers.cloudflare.com/realtime/
- Cloudflare Realtime SFU pricing: https://developers.cloudflare.com/realtime/sfu/platform/pricing/
- Cloudflare TURN/SFU product page: https://www.cloudflare.com/products/turn-sfu/
- LiveKit pricing: https://livekit.com/pricing
- LiveKit billing docs: https://docs.livekit.io/deploy/admin/billing/
- LiveKit quotas and limits: https://docs.livekit.io/deploy/admin/quotas-and-limits/
- xAI voice pricing: https://docs.x.ai/developers/pricing
- xAI speech-to-speech docs: https://docs.x.ai/developers/models/realtime-api
- xAI voice overview: https://docs.x.ai/developers/model-capabilities/audio/voice
