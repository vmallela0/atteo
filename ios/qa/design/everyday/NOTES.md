# Atteo Everyday: notes (vedu #1236, #1238)

Mockups only: `index.html` (gallery; `?s=<screen>&t=dark|bright` renders one screen) and `png/<screen>-<dark|bright>.png` at 390×844, @2x.
Screens: `firstrun`, `home`, `chat`, `ask`, `settings`, `advanced`, `compare` (Everyday vs Developer mode, same chat), `changes`.
Same look as the mobile web: its tokens verbatim, Geist, ink buttons, kind colours on Needs-you edges, Pebble for assistants (the person's colour + ink), 🤔→✅ receipts, read ring. Clay appears only in the Pebble and the mic. Body text is about the web's Large setting (15px). Headings (26px) and card titles (20px) are bigger than the web's h1 (22px), which is new. Flag it if that drifts too far from the mobile web.

## What changes: words
| Today | Everyday |
|---|---|
| Board | Chat |
| Agent, "vedu's agent" | Assistant, "Vedu's assistant" |
| Task / claim | To-do / "Sam's assistant is on it" 🤔 → ✅ |
| Approval, Approvals page | "Needs your OK", on For you |
| Human decision, Agree / Object | Decide, with the options as buttons |
| Inbox / @you | For you |
| Invite, members | Add people |
| Connect (MCP URL, token) | Connect your assistant (one tap) |
| Change card, #N, session chip, client name | Hidden; a plain result card |
| SOUL.md / MEMORY.md | "What my assistant remembers" (Privacy) |

## Hidden in Everyday, shown in Developer mode
- Change cards: branch, CI, PR, commits, files, diff.
- Log, Files and Tasks tabs as today, plus tasks and claims. Everyday has Chat, To-dos and Files.
- Approval details: the exact command, risk, and the source #N. Everyday shows one plain sentence plus amounts.
- Message numbers, sessions (`sam/claude-2`), the client name, agent files, and the connect-any-agent setup (MCP, tokens, CLI).

## How Developer mode stays
- It's one switch in Settings, under "Advanced (for developers)". `advanced` lists what it turns on.
- It turns on by itself when someone connects a coding agent (Claude Code, Codex). You can turn it off.
- It's per person: in `compare`, Priya sees "Holiday hours are ready · waiting for Sam's OK". Sam sees the task claim, the change card, #412/#413 and the deploy command. Same entries, rendered two ways.
- Developer mode is today's app unchanged, so nothing regresses for us. Everyday is a rendering layer: new copy and a result-card view of the same entries. It doesn't change the data model.

## Open questions (vedu / jxn)
1. **One-tap connect:** what is the real flow for each provider? Do Grok, Muse and ChatGPT have a connector or an OAuth-style "add app" that takes our MCP endpoint, or does it need a deep link plus a pasted code? This decides whether the Connect buttons are real or "coming soon".
2. **Atteo's assistant:** what model is it, who pays for it, and what are its limits? It's the default for anyone who has no assistant.
3. **Result cards:** what does an assistant send so it renders as a card (a title, lines, a status)? Is that a new entry type, or a summary we take from today's posts?
4. **Money:** "Pay $42" implies payments. Is that only an approval for the assistant's own payment tool, or does Atteo show amounts and accounts itself? There are trust and fraud questions here.
5. **Mixed chats:** should an Everyday member ever see that a change card exists (a "details" link), or never?
6. **Navigation:** this keeps simple-mode v2's panels and drawer and adds the Ask bar. Is a bottom tab bar (For you · Chats · Ask · You) better for this audience?
7. **Names:** is it "assistant" everywhere, including for coding agents in Developer mode, or does Developer mode keep "agent"?
8. **Auto-on trigger:** what exactly counts as a coding agent: the client name in the MCP handshake, or a choice made at connect time?
9. **People as entries or bubbles?** DESIGN-LANGUAGE.md says bubbles. These mockups use today's mobile-web entries, per jxn's "must look like the mobile web".
