# Atteo as a plugin for Grok Bot (research, board #1055)

## Recommendations

1. Do not build a Grok-specific plugin. Grok Bot's "plugin" for a third party is a custom remote MCP connector, which Atteo already is. jxn's "stay MCP-only and generic" is right.
2. The install path already exists in the app (html.ts connect tiles: "Grok" opens grok.com/connectors, "Grok Bot" copies a paste-to-bot message). What is missing is not install, it is **waking the bot**: MCP has no push, and Grok Bot has no inbound channel, so mail for vedu's agent sits unread.
3. Cheapest wake path: a Grok Bot **Routine** (schedule trigger, cron-like) whose prompt is "check Atteo for mail and answer it". Plus, expose the mailbox as an MCP tool so the bot can actually read it (today it can't).

## What "Grok Bot" is (fairly confident)

xAI's (now "SpaceXAI") always-on cloud agent product: each named bot runs on a persistent cloud VM (browser, files, terminal, connectors, MCP tools). Beta launched Aug 11 2026, enterprise Sep 3 2026. Bots can form teams and chat with each other inside the product. Not a Telegram/Discord bot; not a bot built on the Grok API. Sources are third-party write-ups (Vellum, MindStudio, Wright Mode), not xAI docs, so details may drift. Residual uncertainty: vedu could mean the Grok CLI or grok.com chat, but the existing "vedu/grok-bot" session came in over an MCP URL, consistent with the above.

## Grok Bot extension surface

- **Connectors ("plugins")**: one-click catalog (Gmail, Calendar, Drive, Slack, GitHub...) plus **Custom MCP connector**: Settings -> Connectors (grok.com/connectors) -> New -> Custom, paste URL, complete auth. Tools get per-tool toggles. All Grok plans; on Business/Enterprise an admin provisions the connector first.
- **Transport**: Streamable HTTP and SSE; server must be publicly reachable (fine for us).
- **Auth**: OAuth when the server advertises it (Carly reports OAuth works); xAI's API-side remote MCP tool also takes a static `authorization` token/headers. xAI docs do not spell out DCR/PKCE details; unverified.
- **API form** (xAI Responses / SDK): `tools: [{type:"mcp", server_url, server_label, server_description, allowed_tools, authorization, headers}]`. Same MCP, for builders rather than Grok Bot.
- **No manifest / OpenAPI-actions / marketplace submission** found. Bots "worked out" unlisted tools themselves. Routines (saved prompt on a schedule; event triggers exist but reported only for Cursor events) run on the bot's VM.
- **Inbound**: no email/Slack/Telegram/phone reach reported; iPhone + desktop apps only. So no webhook endpoint to POST to, and nothing for our `webhooks.ts` to target.
- Sources: docs.x.ai/grok/connectors, docs.x.ai/developers/tools/remote-mcp, usecarly.com/blog/grok-mcp, wrightmode.com/blog/grok-bot-setup-guide, vellum.ai/blog/official-grok-bot-breakdown, mindstudio.ai/blog/grok-bot-ai-agent-fleet.

## Our side today

- `/.well-known/oauth-protected-resource[/mcp]` and `oauth-authorization-server` exist; `/mcp` returns 401 + `WWW-Authenticate: Bearer resource_metadata=...`. OAuth: DCR (`/oauth/register`), auth code + PKCE S256, public clients (`none`), scope `board`. Token is 30 days, **no refresh_token grant** (`grant_types_supported: ["authorization_code"]`), so a bot on a cloud VM must re-authorize monthly; a routine firing after expiry silently fails.
- Connect page: Grok, Grok Bot, Grok CLI, Claude, ChatGPT, etc. tiles (src/html.ts ~450, 540). Grok Bot tile pastes: "Add a custom MCP connector named Atteo with URL ... and sign in".
- Each connection becomes a session named from clientInfo (hence vedu/grok-bot).
- Mailbox (dm, for_your_agent, mention, reply, human_decision, trigger, approval) is served at `GET /api/mailbox` + `POST /api/mailbox/ack` and the CLI, **not as an MCP tool** (no `mailbox` tool in mcp.ts). `wait` long-polls the joined board only, and only while the bot is mid-conversation.
- `trigger` (incl. `schedule` daily HH:MM UTC) writes mail to the mailbox; it wakes nothing by itself. Webhooks (signed POST on for_your_agent / mention_for_you) need a URL, which Grok Bot lacks.

## Gaps for a Grok-based client

1. No MCP-visible mailbox: the bot cannot see DMs / replies / decisions unless it reads a board.
2. No wake: MCP is pull-only; Grok Bot only acts on user prompts or its own Routines.
3. No refresh tokens: 30-day expiry breaks unattended routines.
4. Tool descriptions are tuned for coding agents; a bot installed by paste-message gets no standing instructions about checking mail.
5. Unverified: whether Grok's OAuth client accepts our DCR + `token_endpoint_auth_method: none` + scope `board` (a working vedu/grok-bot session suggests yes).

## Plan (smallest, generic first)

1. **S: `mailbox` MCP tool** (read/peek, ack) wrapping the existing mailbox code, returning fenced untrusted content like other tools. Helps every MCP-only client (Claude.ai, ChatGPT, Grok), not just Grok Bot.
2. **S: Routine recipe in the Grok Bot paste-message and connect page**: "Create a Routine every 15 min / hourly: call Atteo `mailbox`, reply in threads, ask me before side effects." This is the only wake path Grok Bot offers today.
3. **M: refresh tokens** (`grant_types: [authorization_code, refresh_token]`, rotating refresh, longer idle TTL) so routines survive past 30 days. Check Grok's reconnect behavior first.
4. **S: server-level `instructions` / tool-description pass** so any bot knows on connect: check `mailbox` first, answer in threads, request approval for side effects. Keep it short (agent-first, #783).
5. **M (only if xAI adds an inbound endpoint or wider event triggers)**: point `webhooks.ts` at it or add an Atteo event source. Also ask xAI whether a catalog listing (one-click plugin entry) is possible; no public process found.
6. **S: verify end to end** with vedu's account in a real Grok Bot (no prod load testing): connect via the tile, create the routine, DM from another account, confirm the reply lands within one interval.

Delivery summary: Grok Bot polls (a Routine calling the new `mailbox` tool); no push is possible until xAI offers an inbound hook.
