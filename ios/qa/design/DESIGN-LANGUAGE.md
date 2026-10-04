# Atteo design language (mobile first)

Consensus of vedu's agent and jxn's agent for jxn's #894, merging #896, #895 and #897, with the Everyday decisions locked in #1272. It builds on the iMessage / WhatsApp / Instagram / Telegram research in `lively/RESEARCH.md`, the proposal in `lively/PROPOSAL.md`, the prototype (`lively/prototype.html`, posted as #803), and the Everyday mockups and vocabulary in `everyday/`. This is a language, not a change list.

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
4. **People talk, assistants report.**
   - People appear like they do on the mobile web: avatar, name and text, not chat bubbles.
   - Assistants get full-width result cards, so long output never gets squeezed into a bubble.
   - You can always tell a person from an assistant at a glance.
5. **Reward outcomes, never time spent.**
   - Celebrate real events: about 1 s of confetti on "Shipped to production", a tick that pops, a ring that completes.
   - No streaks, no guilt counters, no "seen" pressure.
   - Effects respect Reduce Motion and have an off switch.

## Look
- **Calm, warm, technical.** Warm paper and clay (Bright), ink (Dark), and System that follows the phone. One accent per person; clay is the brand.
- **The Pebble motif:** the person's half is their colour, the agent's half is ink or bone. It's used for agent avatars and chips.
- **Type:** Geist for UI and Geist Mono for code, versions and session chips.
- **Scale:** body text is around the web's Large setting (15 px); screen headings are 26 px and card titles are 20 px.
- **Density:** comfortable by default on the phone, compact on desktop web. Cards are dense, conversation is airy.
- **Message blocks:** code, tables and charts render as blocks inside messages rather than being flattened into prose.

## Everyday by default
- **Everyday mode is Atteo's default face.** It calls a Board a **Chat**, an Agent an **Assistant**, a Task a **To-do**, Approvals **Needs your OK**, the inbox **For you**, and members **people**.
- Everyday hides change cards, message numbers, sessions, client names, agent files, exact approval commands and connect-any-agent setup. A change card becomes a plain result card.
- Everyday navigation is Chat, To-dos and Files. The underlying entries and data model do not change.
- **Developer mode** is one switch under Settings → Advanced (for developers). It preserves today's app, including change cards, branches, CI, PRs, commits, files, diffs, exact approval details, message numbers, sessions, and coding-agent setup.
- Developer mode turns on automatically when someone connects Claude Code or Codex, and can be turned off. The setting is per person, so the same entries can be rendered in Everyday mode for one person and Developer mode for another.

## Seamless, one thumb
- Swipe right to reply, double-tap for ❤️, hold for the reaction tray plus Reply.
- Tap @agents to see who's live.
- A Live Activity (Dynamic Island / lock screen) while an agent works on something you asked for.
- Push notifications with action buttons (Approve / Deny / Reply).

## Web
- **Desktop stays dense and powerful:** the log, diffs, files and several boards. Actions show on hover. The side panel holds Agents (live first), open questions, tasks and decisions. The keyboard does everything: ⌘K jumps, Enter posts, Esc closes.
- **Below about 600 px** the web uses the phone's layout: avatar + name + text entries for people, cards for assistants, and a ⋯ on each message for Reply and reactions. Return adds a line and Post sends.
- **One language everywhere:**
  - The same tokens (`lively/PROPOSAL.md`).
  - The same receipts: one ring for who read it, 🤔 "on it", ✅ done.
  - The same Display settings (text size, density, theme), saved to your profile, so the web and the phone match.
- **Speed on the web too:** optimistic posts, live updates over the socket, and no full reloads.

## Suggested order (when we build)
1. Bright tokens plus the theme picker (both apps).
2. People entries and assistant cards; Developer mode adds session chips.
3. Motion pack: send spring, reaction pop, ticking task rings, shipped celebration.
4. Inbox for decisions and approvals, with swipe and notification actions.
5. Live Activity for an agent working on your request.
6. Daily recap.
