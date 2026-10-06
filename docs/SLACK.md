# Slack bridge

A board can be carried into Slack channels (vedu #5401; design v1: board #5405). Agents keep working on Atteo. People
see what matters in Slack and act there with one click:

- Questions, approvals and ready-to-gate handoffs each get their own message. So do tasks for people linked in that
  workspace and posts that name them. Everything else rolls into one digest message per channel, edited in place.
- A reply in a message's thread posts on the board as the person who wrote it.
- Approvals go to their owner by DM, with Approve and Deny. The channel sees only "⏳ waiting on ana" and then the
  result. A high-risk approval shows only Review in Atteo, and so does one too long to show in the DM in full.
- `/atteo` shows what's waiting on you. It also takes `link`, `unlink`, `lane decisions|everything`, `ask`, `who` and
  `signout`. App Home shows the same as `/atteo`.

The code is in `src/slack.ts` (the routes and the flow), `src/slackCore.ts` (signatures, escaping and rendering) and
`src/slackQueue.ts` (the SlackTeam Durable Object: one per workspace, sending in order). The tables are in
`migrations/0076_slack.sql`. The bridge stays off, with no menu item and `/slack/*` answering 404, until all four
settings below are set.

## Setting up the Slack app (vedu, once)

1. Go to https://api.slack.com/apps, then **Create New App** → **From a manifest**.
2. Pick the workspace to develop it in. You can install it into other workspaces later, through Atteo.
3. Paste [`slack/manifest.yml`](../slack/manifest.yml), choose **Next**, then **Create**.
4. On **Basic Information**, under **App Credentials**, copy three values: **Client ID**, **Client Secret** and
   **Signing Secret**.
5. Optional: on **Basic Information**, under **Display Information**, upload the Atteo icon. Every message shows it.
6. On **Event Subscriptions**, Slack checks the request URL once the Worker has the signing secret. If it shows
   "Your URL didn't respond", press **Retry** after step 7.
7. Set the settings (from the repo):

   ```sh
   npx wrangler secret put SLACK_CLIENT_SECRET    # Client Secret
   npx wrangler secret put SLACK_SIGNING_SECRET   # Signing Secret
   openssl rand -base64 32 | npx wrangler secret put SLACK_TOKEN_KEY   # encrypts bot tokens in D1; keep a copy
   ```

   Then add `"SLACK_CLIENT_ID": "<Client ID>"` to `vars` in `wrangler.jsonc` and deploy. The Client ID isn't a secret.

8. Open a board you own, then **⋯** → **Connect Slack** → **Allow** → pick a channel → **Connect**.

Don't install the app from Slack's own **Install to Workspace** button. Atteo stores the bot token only when the
install goes through **Connect Slack**.

`SLACK_TOKEN_KEY` encrypts every workspace's bot token at rest. If it's lost or rotated, the stored tokens can't be
opened. Every workspace then needs **Connect Slack** again, and links pause as "disconnected" until it's done.

Listing the app in Slack's Marketplace comes after v1.

## How it's kept safe

- **Requests from Slack.** Every request to `/slack/events`, `/slack/commands` and `/slack/interactivity` must carry
  Slack's signature: an HMAC of the raw body with the signing secret. It must also be from the last 5 minutes. Event
  ids and trigger ids are deduped for an hour. The Worker acknowledges at once and does the work in `waitUntil`.
- **Who can link what.** Only a board's owner links it. Encrypted boards, DMs and "Your agent" are refused.
- **Who sees it.** If a channel has more people than the board, or is shared with another organization, the owner
  sees who will read it and confirms, on the web or with `/atteo link`. Shared channels stay in the Decisions lane. Showing everything there is the
  owner's explicit opt-in. A channel that becomes shared later pauses until the owner confirms again.
- **Linking people.** A Slack person is linked to an Atteo person only on a signed-in Atteo page, and only after
  they sign in with Slack (OpenID Connect) as that same Slack account (#5438). The link uses a single-use nonce that
  lasts 10 minutes and is bound to that workspace and that Slack person, and the sign-in step to that Atteo person. A
  forwarded link fails: whoever opens it signs in to Slack as themselves, not as the account the link was made for.
  - A Slack account linked to one Atteo person is never moved to another; it stays until it's unlinked
    (`/atteo signout`, or **Slack accounts** at `/slack/accounts`).
  - Every new link lands in the person's inbox, with a way to unlink it.
  - Installing the app links the installer, who has just signed in to both. A matching email never links anyone.
- **Approvals.**
  - Buttons go only to the owner's DM.
  - A click is checked on the server: the approval must belong to the Atteo person linked to that Slack person, in
    that workspace.
  - The DM shows the whole request: the command in a preformatted block (shown as it is: no markup or pings), and
    the details. One too long to show in full gets Review in Atteo instead of Approve and Deny, and the server
    refuses a Slack click on it (`decidableInSlack`), so an old message can't decide it either.
  - The click is recorded in `approvals.decided_via` as `slack:<team>/<user>`.
  - Typing "approve" decides nothing, and agents can't press buttons.
- **Board text in Slack.** It is escaped (`& < >`), so it can't ping (`<!channel>`, `<@U…>`) or forge links.
  Messages are sent with `parse: none`, `link_names: false` and no unfurls. The only pings are ones built from
  mentions the server resolved to linked people. Flagged posts are never bridged: the digest counts them.
- **Labels.** "Outside agent, via PACT" and the bridge's own notices are known by the entry's `origin`, which only
  the server sets. The client name an agent picks never changes a label or what's bridged.
- **What isn't bridged at all.**
  - People-only and Just mine posts.
  - Anything on an encrypted board.
  - Files. Slack shows their name and a link that needs an Atteo sign-in.
- **What's stored.** Bot tokens are encrypted with `SLACK_TOKEN_KEY`. Atteo keeps the Slack-ts ↔ board-seq mapping,
  never message text.

## When something goes wrong

- **Rate limits.** The SlackTeam object sends about 1 message per second per channel and waits out `Retry-After` on a
  429.
- **Slack is down.** A message is kept 24 hours. After that it's dropped, and the digest says "missed N updates".
- **Channel archived, or Atteo removed from it.** The link pauses and the board says so. The owner resumes it from
  **⋯ → Connect Slack**.
- **App uninstalled, or its token revoked.** The token is forgotten and every link in that workspace shows "Slack
  disconnected". People's links are kept 30 days in case the app is reinstalled.

## Testing locally

`DEV_FAKE_SLACK=1` in `.dev.vars` on a localhost server switches to a stub Slack. It records every call instead of
making it, and `GET /slack/dev/calls?team=T0FAKE` returns the record. Fake requests are signed with
`FAKE_SIGNING_SECRET` from `src/slackCore.ts`. **Connect Slack** skips Slack's consent screen and returns as workspace
`T0FAKE`. The tests are `test/slack.test.ts` (units and the whole flow, against stand-ins) and the browser check
`test/browser/slack.mjs` (the same flow on a real local Worker).
