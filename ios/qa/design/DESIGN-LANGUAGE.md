# Atteo design language (mobile first)

Consensus of vedu's agent and jxn's agent for jxn's #894, merging #896, #895 and #897. It builds on the iMessage / WhatsApp / Instagram / Telegram research in `lively/RESEARCH.md`, the proposal in `lively/PROPOSAL.md`, and the prototype (`lively/prototype.html`, posted as #803). This is a language, not a change list: nothing here is built yet.

## The one feeling: momentum
Atteo should feel like **your agents are building for you, and you can watch it happen**. The hero of the app is the agents' output, not chatter. You open it to see what moved, decide what needs you, and nudge.

## Five principles

1. **Speed is the aesthetic.**
   - Everything is optimistic: a send appears instantly, 🤔→✅ flip the moment they happen, and a tick lands as the agent ticks.
   - Nothing waits on a spinner. Launch is instant from cache.
   - Motion is springy and short, 200–250 ms (Linear and iMessage are the benchmarks).
2. **Show work, not chatter.**
   - Agents' output is the hero: task rings filling as items tick, and change cards showing what shipped (commits, files, version).
   - Work in progress shows as the 🤔 receipt line, which becomes ✅ when done, plus a Live Activity. There's no "typing" or "working" bubble for agents: jxn removed agent typing in #777.
   - A short daily recap: "Your agents did 7 things today", tappable.
3. **You're the decider.**
   - One inbox for everything that needs you: approvals, human decisions, @you.
   - Swipe to approve or deny with a haptic, one thumb, in bottom sheets.
   - Approvals also work from the notification.
4. **People talk, agents report.**
   - People get bubbles in their own colour, grouped, with a tail on the last one.
   - Agents get full-width cards with mono details and a session chip (`claude-2`, `scout`) next to "vedu's agent", so long output never gets squeezed into a bubble.
   - You can always tell a person from an agent at a glance.
5. **Reward outcomes, never time spent.**
   - Celebrate real events: about 1 s of confetti on "Shipped to production", a tick that pops, a ring that completes.
   - No streaks, no guilt counters, no "seen" pressure.
   - Effects respect Reduce Motion and have an off switch.

## Look
- **Calm, warm, technical.** Warm paper and clay (Bright), ink (Dark), and System that follows the phone. One accent per person; clay is the brand.
- **The Pebble motif:** the person's half is their colour, the agent's half is ink or bone. It's used for agent avatars and chips.
- **Type:** Geist for UI and Geist Mono for code, versions and session chips.
- **Density:** comfortable by default on the phone, compact on desktop web. Cards are dense, conversation is airy.

## Seamless, one thumb
- Swipe right to reply, double-tap for ❤️, hold for the reaction tray plus Reply.
- Tap @agents to see who's live.
- A Live Activity (Dynamic Island / lock screen) while an agent works on something you asked for.
- Push notifications with action buttons (Approve / Deny / Reply).

## Web
- Desktop stays dense and powerful: the log, diffs, files, several boards.
- Below about 600 px the web uses the phone's layout (bubbles for people, cards for agents).
- Both share one set of tokens (`lively/PROPOSAL.md`) and one reaction and receipt language.

## Suggested order (when we build)
1. Bright tokens plus the theme picker (both apps).
2. People bubbles and agent cards with session chips.
3. Motion pack: send spring, reaction pop, ticking task rings, shipped celebration.
4. Inbox for decisions and approvals, with swipe and notification actions.
5. Live Activity for an agent working on your request.
6. Daily recap.
