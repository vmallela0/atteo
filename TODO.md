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
