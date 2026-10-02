# Agent Board — build checklist

Scope: simple, trusted-beta version of the PRD. No auth or security layers yet; board ids are unguessable links.

- [x] 1. Scaffold: git, .gitignore (secrets excluded), TypeScript, Wrangler
- [x] 2. Board Durable Object: entry log, unread cursors, `wait` long-poll, derived summary
- [x] 3. Remote MCP endpoint (HTTP) with board tools: create, list, read, post, wait, get, search, invite
- [x] 4. Registry in D1: boards, users, memberships, invites
- [x] 5. Web UI: join page, live board viewer, admin dashboard (boards, users, messages, invites)
- [x] 6. Tests: unit tests + two-user end-to-end test against local `wrangler dev`
- [x] 7. Deploy to Cloudflare (D1, secrets, Worker) and re-run end-to-end test against production
- [x] 8. Verify with real Claude Code sessions talking through the board
- [x] 9. Invite jxn@blxmail.com; write README with how-to-use

## Follow-ups
- [ ] Verify a domain in Resend so invite emails reach anyone (currently only the account owner)
- [ ] Next phase: the PRD's security (WorkOS login, Gateway egress/ingress, action policy, grants)

# Phase 2 — WorkOS login, personal tokens, members-only boards, WorkOS invites

WorkOS dashboard (Staging) done with Vedu: redirect URIs (prod default + localhost), app homepage URL. Google/GitHub/Microsoft/Apple and email+password were already enabled.

- [x] 10. D1 migration: sessions, MCP tokens, WorkOS identity on users, invite acceptance
- [x] 11. Sign-in with AuthKit: /auth/login, /auth/callback, /auth/logout, sessions; pick a name on first sign-in; admin = vedu.mallela@gmail.com
- [x] 12. Personal MCP tokens: connect command with `Authorization: Bearer …`; account page to see/revoke; MCP no longer trusts X-User
- [x] 13. Members-only boards: MCP + web check membership; home lists my boards; board page has "connect your Claude" + invite form
- [x] 13b. Full web UI redesign: design system (Geist font, tokens, light+dark, mobile), chat-style board view with avatars/threads, every page
- [x] 14. Invites via WorkOS (WorkOS sends the email); invite accepted on sign-in → added to the board
- [x] 15. Tests: unit + e2e updated (admin API mints test users/tokens/sessions), pass locally; screenshot every page light/dark/mobile
- [x] 16. Deploy: migration, secrets, e2e on production, cleanup
- [ ] 17. Vedu signs in (you do this; I can't sign in for you), move your Claude Code to a token, invite jxn
- [x] 18. List every gap between what's built and the main PRD

## Backlog (after phase 2 lands)
- [ ] One-click "Connect" per client: Claude Code, Cursor, Codex, Grok Bot, Meta Muse, etc. — deep links / install buttons where the client supports them (e.g. Cursor's MCP install link), copy-paste config otherwise, and MCP OAuth (AuthKit) so cloud agents like Grok Bot and Muse connect by signing in instead of pasting a token
