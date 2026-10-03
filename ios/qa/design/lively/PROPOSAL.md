# Proposal: Atteo Bright, and a livelier chat (#764)

Research: `RESEARCH.md`. Prototype: `prototype.html`. Open it in a browser and use the Bright/Dark toggle. URL params: `?theme=dark&screen=list|thread&t=end`. Screenshots are in this folder (`proto-*.png`, plus `proto-sequence.gif`).

**The idea in one line:** keep Atteo's calm structure, but make the board feel like a conversation (bubbles, colour, faces) and make *work moving* the thing you watch and celebrate.

## 1. Theme: Bright (new), next to Dark (today's)

A theme picker in both apps: **System · Bright · Dark**.
- **iOS** is hard-wired to dark today (`AgentSoupApp.swift:14`, `.preferredColorScheme(.dark)`). Make the `Theme.swift` colours dynamic (`Color(UIColor { traits in … })`) and add the picker to Settings.
- **Web** already has a light theme (`src/ui.ts`: pure white, **blue** accent `#0062d1`). Bright replaces it with warm paper and **clay**, so both apps share one brand. Display → Theme keeps its three options, renamed to System / Bright / Dark.

### Tokens (the prototype's `:root`, same shape as `ui.ts`)

| token | Bright | Dark | use |
|---|---|---|---|
| `--bg` | `#FBF7F1` warm paper | `#0A0A0A` | screen |
| `--bg-elev` | `#FFFFFF` | `#161616` | cards, sheets, composer |
| `--bg-sunk` | `#F3EEE6` | `#1C1C1C` | inputs, segmented controls |
| `--line` | `rgba(40,28,16,.08)` | `rgba(255,255,255,.07)` | hairlines |
| `--text` / `--muted` / `--faint` | `#1B1713` / `#6E665E` / `#A1978C` | `#EDEDED` / `#A1A1A1` / `#6F6F6F` | type |
| `--accent` | `#D9785A` clay | `#D9785A` | fills, icons, badges, rings (not body text) |
| `--accent-text` | `#B5502F` (4.7:1 on paper) | `#E8906F` | clay as text: links, "4 replies" |
| `--bubble-you` | gradient `#BD5636 → #AE4A2B`, white text | same | your messages |
| `--bubble-them` | `#FFFFFF` + soft shadow | `#1E1E20` | people |
| `--bubble-agent` | `#F2EEE6` bone + 1px ink hairline | `#17140F` + bone hairline | agents |
| `--chip-agent` | ink `#111113` with bone text | bone `#F2EFE8` with ink text | session chip (`claude-2`) |
| `--p-<person>` / `-soft` | e.g. jxn `#0F7C83` / `#D8F1EF` | `#4CC2C9` / `#0F2526` | name, avatar, **and that person's agents** |
| `--ok` / `--ok-soft` | `#1E9E5A` / `#DAF3E4` | `#3ECF75` / `#12261A` | working, done |
| `--wall-1/2/3` | peach `#FFE6D8`, lilac `#E8E4FF`, mint `#DDF3EA` | near-black tints | the default wallpaper |
| `--read` | `#B5502F` | `#E8906F` | read ticks |

On contrast: white on plain clay `#D9785A` is only 3.1:1, which is why "your" bubble uses the deeper `#BD5636 → #AE4A2B` gradient (4.6 to 5.5:1, measured). Clay stays as the accent for fills, and `--accent-text` is used whenever clay is text. Sender colours are fixed per person (a hash, as `Theme.hue` does today) at higher chroma in Bright. An agent always takes **its owner's colour**, so "jxn" and "jxn's agent" read as a pair.

## 2. The top changes, ranked by impact ÷ effort

Effort is S (≤1 day per app), M (2–4 days) or L. **Exists** means it is already in the app and this change makes it lively.

| # | Change | Impact | Effort | Status |
|---|---|---|---|---|
| 1 | **Bright theme + picker** (tokens above, both apps) | High | M | New on iOS; web light gets restyled |
| 2 | **Bubbles for everyone, grouped, with tails and sender colour.** iOS already draws *your* messages as bubbles (`BoardsView.swift:799`). Others are rows. Give everyone bubbles: 2px gaps within a run, a tight corner on the sender's side, a tail and avatar on the last bubble only, and the name coloured once per run. Web gets the same in "Comfortable" density, while "Compact" keeps today's rows for desktop power users. | High | M | Partly exists |
| 3 | **Agent bubble = the Pebble's other half.** A bone bubble with an ink hairline, and the session chip (`claude-2`, `scout`) next to the owner-coloured name ("vedu's agent"). The agent's avatar is the Pebble with its owner's colour as the "you" half. You can always tell person from agent at a glance. | High | S (after 2) | New |
| 4 | **"Shipped" celebration** on change cards (`ChangeCard.swift`, web `changeCardHtml`). When a card says *Shipped to production*: a gradient banner with a sheen, about 1s of confetti confined to the card, `Haptic.done()`, and a row of quick reactions (🎉 🚀 🙌 "Nice work"). It plays once per viewer, on first view. Reduce Motion or Settings → Celebrations off turns it into a static banner. | High | S | New |
| 5 | **The working bubble.** The typing indicator, but for agents and with real information: three staggered dots plus "reading `Attachments.swift`" or "running iOS UI tests ▰▰▱". It sits at the bottom of the chat while a session works, and the header says "claude-2 is working" with the breathing `LiveDot`. Uses the existing live-session state. Agents need a short status string if one isn't already reported. | High | M | Partly exists (LiveDot, "On it") |
| 6 | **Reaction pop.** Chips spring in (scale 0 → 1.35 → 1) with a small particle burst, and the bubble bumps. Double-tap = ❤️ (Instagram). Long-press opens a floating tray above the lifted bubble, with Reply. `ReactionChips` and the picker already exist (`ChatExtras.swift`). This is animation plus one gesture. | Med-High | S | Exists |
| 7 | **Task cards that tick.** A progress ring (1/3 → 3/3, clay → green), checkboxes that pop and draw their tick, and a "Done" moment with a light haptic. Small rewards for each step an agent makes. | Med | S | Exists (static) |
| 8 | **Read ticks + spring on send.** Your bubble flies up from the composer on a spring. Under it: ✓ sent, ✓✓ delivered (grey), ✓✓ read (clay). Tap for the existing "Seen by …" list (#735). Ticks show only on your own messages, so they are never a guilt meter for others. | Med | S | Receipts exist |

**Next tier:**
- **Swipe-to-reply polish.** It exists (`SwipeToReply`). Add rubber-banding past the threshold, a reply icon that turns clay and "clicks" with a haptic, and the bubble and tail moving together. Web: drag on touch screens, and a hover Reply button elsewhere.
- **Wallpapers per board.** Paper (default), Dawn, Mint, Lilac, None. Bubbles pick their tint from the wallpaper, as WhatsApp does.
- **The agents row** on Chats: rounded-square avatars with a *rotating* gradient ring while working, and "testing…" under them. It looks like stories, but it is presence. It never expires and has no "seen" pressure.
- **Sounds:** a soft send/receive pair. Off by default on web.
- **Big emoji:** a message that is only 1–3 emoji shows at 40px with no bubble.

## 3. Guardrails ("addictive", the good kind)

- Celebrate **events** (shipped, approved, task done, first reply from a new agent), never keywords or time spent.
- No streaks, no "you haven't posted in 3 days", no counters of others' unread replies, no fake urgency. Badges only count things that are actually for you.
- Every effect has a fallback: Reduce Motion gives instant states, and Settings → **Celebrations** on/off (as Asana does). Effects never block input and never play twice.
- Contrast is AA for all text. Colour is never the only signal: ticks have shapes, agents have chips, working has words.

## 4. Suggested order

1. Tokens + picker, with no layout change. Ship Bright to both apps behind the picker.
2. Bubbles + agent bubble (2, 3) on iOS, then web Comfortable.
3. Motion pack (4, 6, 7, 8): mostly animation, one PR per app.
4. Working bubble (5), once the session status string exists.
5. Wallpapers, agents row, sounds.

**Open questions for vedu/jxn:**
- Should Bright be the *default* for new users? I'd say yes on iOS (it reads friendlier on first open) and System on web.
- Should we keep "Compact" rows on web?
- Should celebrations also fire for "Approved"?
