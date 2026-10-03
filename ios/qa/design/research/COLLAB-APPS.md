# What Slack, Lark and Teams can teach Atteo

Research for request #606 (2026-10-03). Atteo already has boards with typed entries, threads, reactions, mentions, tasks with auto-ticking checklists, approvals and human decisions, E2E boards, read receipts (ring/🤔/✅), typing, the mailbox/dispatcher/headless agents, change cards, files and multi-image messages, display settings, an iPhone app, a CLI and MCP. This list covers only what is not already there.

## 1. Features per app

**Slack**
- Slackbot as an agent: DMs, creates channels, invites people, builds workflows on request.
- Workflow Builder with an AI step (answer, summarize a channel, draft) and a Repeat step over a list.
- Canvas: living docs inside a channel, with a comment-only role for reviewers.
- Lists: structured items with owners, status and dates. Agents can search, create and update them through Slack's MCP server.
- Huddle notes: when a huddle ends, AI posts a canvas with notes, action items and a transcript.
- Code channels and an Agents tab: tag Claude, Codex, Copilot or Devin on a task, and see each agent's status in one place.
- Approvals routed into chat (for example from Salesforce).
- Do Not Disturb, scheduled messages and reminders.

**Lark / Feishu**
- Buzz: an urgent ping that escalates beyond a normal notification until the recipient reads it.
- Topic groups: sub-discussions inside a group so threads don't pile up.
- Base: a no-code database with views, forms and automations. AI fields are in early access.
- Approvals: hundreds of form-based templates with routing.
- Meeting AI: transcript, summary and extracted action items.
- Thread summary and "catch me up" on missed content.
- Pins and a group announcement as the source of truth.
- OKRs linked to the work that serves them.

**Microsoft Teams**
- Copilot recap: summaries, action items, and (fall 2026) a Recap app and video highlights.
- Loop components: a live checklist, table or list embedded in a message, editable in place everywhere it appears.
- Meeting notes built on Loop.
- Planner inside channels. Decisions and action items from meetings sync into it.
- A channel agent that creates and updates tasks, answers questions and writes status reports.
- Approvals app (request, form, approve or reject in chat).
- Agents usable inside meetings and calls, with session memory.
- Notification preview testing, so you can check you won't miss an alert.

## 2. Ranked shortlist for Atteo

1. **Living pinned doc ("source of truth")** (Slack Canvas, Teams Loop, Lark pins). A board-level doc that is edited in place, not appended, and pinned at the top. Agents keep it current (status, decisions, runbook) and people comment or edit. Why it fits: an append-only log is bad at "what is true now", and every agent joining a board needs one page to read first. Effort: M. Builds on: `doc` tool and `atteo doc grep`, the board summary, PROTOCOL.md arriving on join, per-entry edit.
2. **Recaps on demand and on close** (Slack huddle notes, Teams recap, Lark catch-up). "Recap this thread / since I was away" produces one entry: decisions, open questions, who owes what. Why: people return to boards after hours and agents have limited context, so both need a short catch-up. Effort: S. Builds on: the board summary, `read` (new since last read), headless agents, threads.
3. **Scheduled agent check-ins and standups** (Slack scheduled messages and workflows, Teams channel agent status reports). A cron-like entry: "every weekday 9am, @agent posts status from open tasks". Why: turns agents from reactive to proactive without a person prompting them. Effort: M. Builds on: dispatcher, mailbox, headless agents, webhooks, tasks.
4. **Workflow triggers** (Slack Workflow Builder, Lark Base automations). Simple rules: "when a task is created with label bug, mention the triage agent", "when an approval is granted, wake the deploy agent". Why: encodes team habits once and agents obey them. Effort: L. Builds on: signed webhooks, typed entries, the mailbox, the dispatcher. Ship 3 or 4 fixed triggers first, not a builder.
5. **Do-Not-Disturb that agents respect** (Slack DND, Teams notification settings). Quiet hours and focus status per person, readable by agents through `people`/`session`. An agent holds non-urgent pings and batches them for the digest. Why: the agent equivalent of not interrupting someone in a meeting, and it cuts noise as agent volume grows. Effort: S. Builds on: online presence, display settings, `agents` status, push notifications.
6. **Urgent ping with acknowledgement** (Lark Buzz). Mark a message urgent: it bypasses DND once, re-pings until the person (or their agent) acks, then stops. Why: one reliable "this really needs you" path makes the rest of the quiet defaults safe. Effort: S-M. Builds on: read receipts (ring/🤔/✅), mentions, push, DND (#5). Cap at one per person per hour to avoid abuse.
7. **Structured tables agents edit** (Slack Lists with MCP, Lark Base, Teams Planner). A typed "table" entry with columns, rows and views (status, owner, due date) that agents change through MCP/CLI. Why: bugs, leads, release checklists and test matrices are rows, not prose, and agents are better at editing rows than at appending messages. Effort: L. Builds on: tasks and checklists (a table is a generalized task), typed entries, search, E2E encryption (client-side fields).
8. **Approvals with forms** (Teams Approvals, Lark Approvals, Slack approval routing). Extend `request_approval` with fields (amount, environment, diff link), required approvers, and an audit line on the result. Why: agents ask for permission often. Structured requests are faster to decide on a phone and leave a record. Effort: S-M. Builds on: `request_approval`, human decisions, change cards, iPhone approval UI.
9. **Board templates** (Lark Approvals/Base templates, Slack workflow templates). "New board from template": a release board, a bug-triage board, a research board, each with PROTOCOL.md, starter tasks, pinned doc and the recommended triggers. Why: removes the empty-board problem and teaches agents the house rules from the first message. Effort: S. Builds on: create_board, PROTOCOL.md, tasks, docs.
10. **Saved replies and prompt snippets** (Slack and Lark canned replies and shortcuts). Per-person snippets ("/ship-it", "/need-repro") that insert text or dispatch a standing instruction to the person's agent. Why: speeds up phone typing and gives repeatable agent commands. Effort: S. Builds on: composer, `atteo` CLI aliases, mentions.

## 3. Not to copy

- **Huge channel lists with unread badges and a "mentions and reactions" firehose** (Slack, Teams). It trains people to triage notifications all day. Atteo's single-feeling "momentum" works better with a few boards and clear waiting-on-you states.
- **A general chatbot and "Big Mode" research sidebar.** A separate AI surface competes with the board. Agents should answer on the board in a thread so everyone sees the work.
- **Video, huddles and webinars.** Heavy to build and not where agents collaborate. Take only the output (recap, action items), not the meeting.
- **A full OKR / project suite or a Planner clone.** Goal hierarchies are a lot of surface for little agent value. Tasks and tables cover the need.
- **Presence-pressure and engagement features** (typing everywhere, "seen by" lists for every message, aggressive urgent escalation to SMS or calls). Keep escalation opt-in and rate-limited.

## Sources

- [Slack feature drop, Aug 2026](https://slack.com/blog/news/slack-feature-drop-august2026)
- [Slack: agents and AI innovations](https://slack.com/blog/news/ai-innovations-in-slack)
- [Slack May 2026 admin update (Slackbot skills, Agent Kit)](https://vantagepoint.io/blog/sf/slack-may-2026-admin-update-slackbot-skills-agent-kit-deprecations)
- [Slack AI agents and Workflow Builder 2026 guide](https://whysogeek.com/slack-ai-agents-workflow-builder-2026/)
- [Lark Base](https://www.larksuite.com/en_us/product/base)
- [Lark Buzz help article](https://www.larksuite.com/hc/en-US/articles/360024343293-use-the-buzz-feature)
- [Lark plans and feature overview](https://www.larksuite.com/en_us/plans)
- [Lark review (Topics, OKR, approvals)](https://aipmtools.org/project-management/lark)
- [Microsoft Teams: 12 fall 2026 features](https://www.hubsite365.com/en-ww/crm-pages/12-new-features-in-microsoft-teams-fall-2026-f13958d7-4ab8-4dca-90c9-5bde98aaf531.htm)
- [Microsoft Teams: 5 major AI upgrades in 2026](https://www.techrepublic.com/article/news-microsoft-teams-updates-february-2026/)
- [What's new in Microsoft 365 Copilot, Feb 2026](https://techcommunity.microsoft.com/blog/microsoft365copilotblog/what%E2%80%99s-new-in-microsoft-365-copilot--february-2026/4496489)
- [Teams, Planner and core apps changes (OSU IT)](https://it.osu.edu/news/2026/06/29/upcoming-microsoft-updates-key-changes-teams-planner-and-core-apps)

Note: Lark Buzz escalation details and Teams Approvals/Loop behavior come from vendor-summary search results, not the full help pages; verify before design.
