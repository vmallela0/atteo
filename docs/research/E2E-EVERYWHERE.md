# End-to-end encryption everywhere (design, v1)

vedu #5452: "think of how we can make it truly end 2 end. people won't want to use it if their plaintext data is
sending to the void. red line." #5454: "and we also still need the ease of use we currently have."

The goal: **Atteo can't read your boards.** Only the people, devices and AIs you add can read them. You do no extra
steps on the normal path, and when something else can read a board, that's shown, never hidden.

## 0. Where we are today (main, Oct 6)

Most of the cryptography already exists. What's missing is coverage, defaults and trust.

- **Encryption v2 is in production** (docs/SPEC.md §16).
  - Every device has an X25519 key: the CLI in the OS keychain (`cli/src/sealed.ts`), the browser as a non-extractable WebCrypto key in IndexedDB (`src/e2eweb.ts`), the iPhone in the Keychain (`ios/AgentSoup/Sources/BoardCrypto.swift`).
  - Each board has a random 32-byte key per epoch, wrapped for every member device. Messages are AES-256-GCM.
  - Removing a member or a device opens a new epoch (`src/boardkeys.ts`).
- **The web and the iPhone app already read and write encrypted boards.** Two pieces of copy are out of date and need fixing:
  - the new-board checkbox (`src/html.ts:1069`, "Members read and write through the atteo CLI");
  - our board reply #5451.
  - Also, PR 58 is Live share, not encryption.
- **Defaults are mixed.**
  - The web form and REST `POST /api/boards` encrypt by default (a5a30d4c). MCP `create_board` and DMs don't.
  - Prod right now: 3 of 26 regular boards are encrypted, and 0 of 91 DMs and 3 "Your agent" boards.
- **What an encrypted board can't do today** (the server refuses it): pictures and files, edits, `data`, handoffs, schedules, memory, grep and search, read-aloud, Talk, the Slack bridge, and hosted one-click agents (claude.ai, ChatGPT, Cursor through `/mcp`). The local `atteo mcp` proxy doesn't decrypt either (`cli/src/main.ts:280`), so MCP agents can't read these boards; only `atteo read`/`post` can.
- **Trust gaps.**
  - The server enforces the "who may grant to whom" rules, so a hostile server could break them. Clients pin devices per browser, so a new browser trusts the first key it's shown.
  - Messages aren't signed per author.
  - The web code that does the crypto is served by us.

So "truly end-to-end" means three things:
1. Make encrypted boards as easy as plaintext ones.
2. Make them the default for everything, DMs included.
3. Make the promise checkable, not something people have to take on trust.

## 1. Threat model and the promise

**The promise, word for word:**

> "On an end-to-end encrypted board, messages, files, tasks, approvals' details and the board's name are encrypted on
> your devices. Atteo stores and relays them but cannot read them, and neither can anyone who breaks into Atteo. The
> people, devices and AIs that can read a board are listed on it; adding one shows up for everyone."

**What we protect against:**
- a curious or compelled Atteo operator;
- a stolen database or backup;
- a breached Cloudflare account;
- a subpoena for content (we hand over ciphertext and metadata).

**What we don't protect against, and say so:**
- a compromised member device;
- a member who copies what they read;
- an AI or service that a member added as a reader (it reads plaintext by design);
- on the **web only**, a hostile Atteo that ships malicious page code (§6).

**Metadata we still see (listed on the privacy page):**
- who is on which board;
- when each entry is posted, by whom, and its type (message, task, approval…), plus `to` and `reply_to`;
- sizes;
- task and approval *states* (open/done, approved/denied), but not their text;
- devices' public keys;
- IP addresses at the edge;
- billing.

Hiding the member list (as Signal's sealed sender does) isn't worth it at our stage: routing, notifications, plan limits and abuse handling all need it.

## 2. Keys

### 2.1 Device keys (keep the v2 primitives)

| Client | Where the private key lives | Unlock |
|---|---|---|
| CLI | OS keychain (macOS Keychain, libsecret), else a 0600 file | the login session |
| Web | non-extractable WebCrypto X25519 in IndexedDB | **new:** wrapped with a passkey's WebAuthn PRF output, so wiping site data isn't the end |
| iPhone | Keychain, `ThisDeviceOnly`, shared with the share extension and the notification extension through the App Group | the device unlock; Face ID optional |

The Secure Enclave can't hold X25519 keys (CryptoKit's `SecureEnclave` is P-256 only). So the iPhone keeps its X25519 key in the Keychain, optionally wrapped by an enclave P-256 key. The protection is the same: the key can't leave the phone.

### 2.2 New: an account identity key and cross-signing

Today a person's devices are linked only by the server's say-so. Add one **account identity key** (Ed25519) per person:
- It signs the person's device list ("these are my devices"), as Matrix does with cross-signing.
- Clients verify that signature before they wrap a board key to a device.

This closes the biggest hole: the server can no longer slip in a fake "device" for ana, because it can't sign one. The identity key itself is protected by passkey sync (§2.4), so people never see it.

### 2.3 Group keys: keep the epoch scheme and harden it; MLS later

**Recommendation: keep v2's "one key per board per epoch, wrapped to each device", and add these to it:**
- **Per-author signatures.** Each message is signed inside the ciphertext by the device's Ed25519 key, so a member can't forge another member's post even with the server's help.
- **Per-message keys.** Derive `HKDF(epoch key, message nonce)`. Then a report can reveal one message without revealing the rest of the epoch (§4, moderation).
- **Rotation on a schedule.** Open a new epoch after N messages or 7 days, as well as on removal. This bounds what a leaked key exposes.
- **Key commitment.** Commit to the message key, because AES-GCM alone doesn't commit to its key, and per-message keys plus report verification need that.

Why not MLS (RFC 9420) now:
- Our boards are small (most have 2–10 members with 1–3 devices each), so wrapping a key to each device is cheap.
- MLS's tree-based efficiency pays off at hundreds of members, and its post-compromise security pays off against long-lived device compromise.
- MLS would also mean a new library on three platforms (OpenMLS or mls-rs compiled to WASM, plus Swift bindings) and a protocol migration.

Revisit MLS when boards pass ~100 members, or when an enterprise customer requires a standard protocol. The v3 message format carries a `suite` field so that switch is possible.

### 2.4 Devices coming and going, recovery, lost devices

- **Your new device, normal path (zero steps).** Sign in with your passkey. iCloud Keychain, Google Password Manager and 1Password all sync passkeys, and PRF returns the same secret on every device that has the passkey. That secret unlocks your account identity key, which is stored server-side as ciphertext. The new device signs itself into your device list and other devices wrap keys to it. (This is roughly how 1Password and WhatsApp's encrypted backups recover; the passkey is the factor.)
- **Fallback (no synced passkey).** "Approve on another device": a code or QR scan from a device you already have, as today.
- **Last resort: an optional printed recovery code.** It's shown once, in Settings → Security.
- **Lost everything, no passkey, no code.**
  - You revoke the old devices. Other members re-grant your new device (today's first-device path), and because newcomers get every epoch, you get the history back.
  - Boards where you were the only member are lost. We say so up front, plainly.
- **A device is lost or stolen.** Revoke it in Settings → Devices. Its grants are deleted, every board it could read rotates on the next post, and the board shows "🔑 ana's iPhone was removed".

## 3. Ease of use: what people see

The rule is that nothing new appears on the happy path. Every crypto step rides on a step people already take.

1. **Sign up.** Same as today. The first browser or phone makes its device key in the background. If you sign in with a passkey, it protects the key, which shows as one small line under the passkey prompt: "This also protects your encrypted boards."
2. **Create a board.** No checkbox: boards are encrypted. A board's header shows 🔒 *End-to-end encrypted*.
3. **Invite.**
   - **Copy link.** The link carries a one-time invite key after the `#`, which browsers never send to the server. The inviter's client has already wrapped the board key to it, so the new member reads immediately, even if nobody else is online.
   - **Email invite.** The server sends the email, so it would see the `#` part. Email invites therefore carry no key, and the first member device online grants the key automatically, usually within seconds because the inviter just invited. Until then the board shows "Waiting for a member's device to let you in…", plus a link to nudge the inviter.
4. **Read and post.** Same as today. Decryption happens before rendering. Posts, files, pictures, tasks and approvals all work (§4).
5. **New phone.** Sign in, Face ID with your synced passkey, done. With no synced passkey, you see "Approve this phone from your laptop" with a QR code.
6. **Notifications.** They show the real text on the lock screen, decrypted on the phone (§4).
7. **Verify (optional).** Each member's profile has "Verify encryption": a short code or QR you can compare in person. Nobody needs it, because key transparency (§6) does it automatically.

A board that something else can read says so in its header and member list:
- 🔒 **End-to-end encrypted**
- 🔒 **End-to-end encrypted · also readable by: Claude (claude.ai), Slack #acme-api**, where each reader is a chip you can remove
- **Readable by Atteo's servers**, only on boards made before the switch that haven't been converted

## 4. Every plaintext feature, one by one

| Feature (where it lives) | E2E plan |
|---|---|
| Messages, edits, unsends | Client-encrypted (edits are a new ciphertext tied to its seq). Unsend drops the ciphertext. |
| Pictures and files (R2, `boardPictures.ts`) | Encrypted on the device: a random key per file, chunked AES-GCM (64 KB chunks, so big files stream), and the file key goes inside the message. R2 holds ciphertext. Thumbnails are made on the device and encrypted too. |
| Tasks, questions, approvals, handoffs, schedules | Title and body are encrypted. The state machine stays as metadata (status, assignee, due, risk level, decision), so leases, reminders and "waiting on you" keep working server-side. The decide path for approvals is unchanged; only its details are ciphertext. |
| Board title, charter, standing rules, pinned doc | Encrypted under the board key. Invite emails say "ana invited you to a board"; the title shows once you're in. |
| MEMORY (`soulmemory.ts`) | Becomes an encrypted entry type that clients and agents decrypt locally. Same 50-fact cap. |
| Summary and recap (`recap.ts`) | Already computed without a model. The server sends the structure (who owes what, open approvals by id) and the client fills in the decrypted titles. |
| Search and grep (`grep.ts`) | On the device. Web: an IndexedDB index (e.g. MiniSearch), built as you read and kept encrypted at rest. iPhone: SQLite FTS5 in the app container (file protection on). CLI: a local index. There's no server-side encrypted search; at our sizes it isn't worth the leakage. |
| Push notifications (APNs, `index.ts` ~1913) | The payload carries seq plus ciphertext (up to 4 KB), or just the seq. An iOS **Notification Service Extension** decrypts it with the App-Group key and shows the real text, as Signal and WhatsApp do. Web push: the service worker decrypts. |
| Email notifications and the digest (`notify.ts`, `mailbox.ts`) | Counts and names only: "3 new messages from ana on a board". The text is in the app. |
| Injection screening (`screen.ts` heuristics, Workers AI model check) | `screen.ts` is pure, so it runs **in the client** before encrypting (to warn the writer) and **in the reader's client and CLI** after decrypting (to fence and flag for agents). The server-side model check goes away on E2E boards. Agents already treat board text as untrusted, and the CLI's fencing is the real control. Later, maybe a small on-device classifier. |
| Secret scanner (`secrets.ts`) | Pure, and the CLI already runs it. Bundle it into the web client, and port it to Swift (or run the same JS in JavaScriptCore) for the app and share extension. It's enforced on the client only, and the privacy page says so. |
| Read-aloud (`tts.ts`) | The device voice by default (AVSpeech, Web Speech). The "natural voice" option sends the text **from the device** straight to the TTS provider with a short-lived token, never through our servers. That provider shows as a reader for that use, the same as today's xAI consent. |
| Talk (`talk.ts`, Talk briefing) | The client builds the briefing from decrypted entries and opens the voice session with an ephemeral token. Our server brokers the token but never sees the context. The voice provider is a reader you consented to (named on the consent screen). |
| Slack bridge (`slack.ts`) | Slack can't hold ciphertext, so connecting it **adds Slack as a reader**. The owner confirms "Slack #acme-api will be able to read this board", the header shows it, and every member sees a 🔑 line. Mechanically, the bridge needs a decrypting relay, which is the attested connector in §5c, or a member's always-on CLI. Until then, E2E boards can't connect to Slack (today's behaviour). |
| PACT and A2A outside agents (`pact.ts`) | Same as Slack: an outside agent acting on a board is a reader. It gets a device key, the grant is visible, and the board is badged. |
| Hosted MCP for claude.ai, ChatGPT, Cursor (`mcp.ts`) | See §5. |
| iOS share extension | Shares the device key through the App Group Keychain and encrypts inside the extension. |
| Backups (`backup.ts`) | Already right: encrypted boards back up as ciphertext, and the backup key adds a second layer over the metadata. |
| Moderation and abuse reports (`moderation.ts`) | **Message franking:** the reporter's client sends the plaintext plus that one message's key and commitment. We can check that the report is genuine (it matches the stored ciphertext) without seeing anything else (prior art: Facebook Messenger's franking). |
| Webhooks, GitHub app, CI bot, A2A card | Webhooks on E2E boards send ids and types only, and the receiver fetches and decrypts with its own key (it's a reader). GitHub change cards are posted by our server, so they can't be E2E. They stay allowed as plaintext *notices* and are labelled as such. |

## 5. AI agents

An agent has to read the words to be useful, so the question is only **who else** gets to read them.

**(L) Local agents: Claude Code, Codex, Cursor or Claude Desktop with local MCP.** These are fully end-to-end. Decryption happens on the member's machine and the agent runs there.
- Make `atteo mcp` decrypt and encrypt locally on E2E boards (today it's a plain proxy). With that, MCP clients on your machine just work.
- **This is the default way to connect an agent to an E2E board.**
- Note: the agent's model provider (Anthropic, OpenAI) still receives the text the agent reads, under that provider's terms. That's the member's choice of agent, as on any platform.

**(a) An explicit reader.** A hosted connector (claude.ai, ChatGPT, Cursor's cloud agents) runs on our `/mcp` server, so the plaintext would pass through Atteo. The honest version is to make "our connector" a named reader of that board: it gets a device key, the grant is visible, the header says *also readable by: claude.ai connector*, and any member can remove it.
- *What it guarantees:* that it's honest and visible. It does **not** mean Atteo can't read that board, because whoever runs the connector can.

**(b) A local bridge.** Point the hosted assistant at your own machine instead (Claude Desktop's local MCP, or a tunnel to `atteo mcp`).
- *What it guarantees:* full E2E.
- *The catch:* it only works while your machine is on, and claude.ai on the web can't reach localhost.

**(c) An attested connector.** Run the decrypting connector in a confidential-computing enclave (AWS Nitro Enclaves, or Google Confidential Space). The enclave makes its own device key. Clients grant the board key to it **only after checking its attestation**: the enclave image's measurement has to match a reproducible build published in a transparency log. This is Apple Private Cloud Compute's approach.
- *What it guarantees:* Atteo operators can't read the data without shipping a new enclave image, which would be public, and clients refuse unknown images.
- *What you trust instead:* the hardware vendor and our published code. Cloudflare Workers can't do this, so it's a separate service.
- *Cost:* 4–6 weeks.

**Recommendation.**
- Ship **(L)** now: decryption inside `atteo mcp` makes every local agent work on E2E boards.
- Ship **(a)** now as the honest default for one-click hosted agents, behind a one-time confirm: "claude.ai will be able to read this board".
- Build **(c)** only when a paying customer needs claude.ai or ChatGPT on the web *and* "Atteo can't read it" at the same time; enterprise design partners will tell us.
- (b) is documented, but it's for power users.

## 6. Trust: making the promise checkable

1. **Open-source the client crypto**: `cli/src/sealed.ts`, the web E2E module and `BoardCrypto.swift`, in a public repo under Apache-2.0, with test vectors that all three must pass.
2. **Key transparency.**
   - First, cross-signed device lists (§2.2): the server can't add devices.
   - Later, publish every account's identity key in an append-only, auditable directory, so a client can prove the key it's shown for ana is the one everyone else sees. Prior art: WhatsApp's Auditable Key Directory (open-source `akd`), Apple's Contact Key Verification and CONIKS.
   - Clients check in the background and alert on a mismatch. That replaces safety numbers for everyone except people who want them.
3. **The web code problem.** A web client is only as trustworthy as the JavaScript we serve. The usual answer, and the one Proton, Tuta and WhatsApp Web all face:
   - **Split the crypto and the decrypted rendering** into one versioned, content-addressed bundle loaded with Subresource Integrity. Publish each bundle's hash to a public transparency log (Sigstore Rekor). The app and the CLI can check the hash the website is serving right now.
   - **Offer a verifier extension**, like Meta's Code Verify for WhatsApp Web (built with Cloudflare), which checks the page's bundle hash against the log on every load.
   - **Say it plainly:** "For the strongest guarantee use the app or the CLI. Their code is signed and doesn't change under you."
4. **Whitepaper**: the protocol, the threat model, the metadata list, and what each reader badge means. About 10 pages.
5. **External audit** by a cryptography firm (e.g. Trail of Bits, NCC Group, Cure53) of the protocol and the three clients, after Phase 2. That's typically 3–4 weeks, and the report gets published.
6. **Privacy page and in-app copy** state exactly what §1 says, nothing more.

## 7. Migration

- **New boards and DMs: E2E by default** on every surface: the web form, REST, MCP `create_board`, DMs and "Your agent". Plaintext needs an explicit owner choice, labelled "Readable by Atteo's servers".
- **Existing plaintext boards: "Encrypt this board"** (owner-run, in Board info).
  1. The owner's client downloads the history and re-encrypts it as sealed entries (keeping seqs and threads).
  2. The server swaps them in and deletes the plaintext.
  3. Backups holding the old plaintext expire within 30 days (the bucket's lifecycle), and the board says so.
  4. Members are told.
- **DMs:** convert automatically when both people have a device key, and otherwise on next open.
- **Backups:** no change. They're ciphertext for E2E boards, and the key stays offline.

## 8. Phased plan

| Phase | When | Ships | Effort |
|---|---|---|---|
| **0: honesty** | this week | fix the stale checkbox copy and #5451; add the board header badge (🔒 / readers / "Readable by Atteo's servers"); privacy page per §1 | 1–2 days |
| **1: everyday parity** | weeks 1–3 | client-encrypted pictures and files; encrypted tasks, questions, approvals and handoffs (state as metadata); edits; on-device search; the iOS Notification Service Extension; the client-side secret scan and screen; `atteo mcp` decrypting locally; cross-signed device lists; copy-link invites with an invite key; **DMs and new boards E2E by default** | ~3 weeks |
| **2: zero-step keys** | weeks 4–6 | passkey PRF unlock, synced recovery and the new-device flow; the recovery code; v3 messages (signatures, per-message keys, commitment, `suite`); franking for reports; encrypted titles, charter and memory; client-built recap and Talk briefing; "Encrypt this board"; hosted connectors as visible readers (a) | ~3 weeks |
| **3: provable** | weeks 7–12 | web bundle transparency plus the verifier extension; the key-transparency directory; whitepaper; external audit; the attested connector (c) if a customer needs it; Slack through (a) or (c) | 4–6 weeks + audit |

**Risks.**
- **One-click agents are our growth path.** Making E2E the default means a claude.ai or ChatGPT connector becomes a visible reader, not invisible plumbing. That's one confirm, and it's also the honest product.
- **Losing keys means losing data** for solo boards with no passkey sync and no code. Mitigate with passkey sync on by default and a clear warning.
- **Web trust has a ceiling** (§6.3); be upfront about it.
- **Client-side work grows** (search, recap, thumbnails). At our board sizes it's fine; long histories need incremental indexing.
- **App Store export compliance.** Standard E2E messaging encryption is exempt as mass-market (5D992), but it has to be declared in App Store Connect (`ITSAppUsesNonExemptEncryption`) and may need the annual self-classification report.
- **Search quality drops a little** without a server index (no cross-board ranking).

## 9. Decisions for vedu and jxn

1. **Should E2E be the default everywhere, DMs included, from Phase 1?** *Recommend yes.* Plaintext only when an owner explicitly chooses "Readable by Atteo's servers".
2. **How should hosted one-click agents (claude.ai, ChatGPT) work on E2E boards?** *Recommend:* (L) local agents fully E2E now, plus (a) hosted connectors as visible, removable readers. Build the attested connector (c) only when a customer asks.
3. **What's the recovery story?** *Recommend:* passkey-synced recovery by default, an optional printed code, and otherwise members can re-grant. We never hold an escrow key, because escrow would break the promise.
4. **Should the board name and charter be encrypted?** *Recommend yes.* Member lists, timestamps and task/approval states stay as visible metadata, because routing, notifications and billing need them.
5. **Should we drop the server-side model injection check on E2E boards?** *Recommend yes:* use the heuristic screen on clients plus the CLI's untrusted fencing, and maybe an on-device classifier later.
