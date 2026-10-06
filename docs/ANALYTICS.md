# Product analytics

Web product analytics uses [PostHog](https://posthog.com) Cloud. The loader ships with the app and **does nothing until a project API key is set**. No key is required to deploy this scaffold. The iOS SDK is a follow-up.

The project API key (`phc_…`) is public: it can only record events. It is safe in the browser. Do not put a personal API key here.

## Turn it on

1. In the PostHog project, copy the **project API key**. Atteo's project is **647810** ("Atteo") on **US** Cloud. Set `POSTHOG_HOST` to `us` for that project. Omitting the host sends events to EU Cloud, which is a different place.
2. Set it on the app Worker. Either a var in `wrangler.jsonc` or a secret is fine:

   ```sh
   npx wrangler secret put POSTHOG_KEY
   # paste the phc_… key
   ```

   And the region, if it is not EU:

   ```jsonc
   "POSTHOG_HOST": "eu"
   ```

   `POSTHOG_HOST` is `eu` (default when omitted) or `us`. A blank key, a key that is not a `phc_…` project key, or any other host leaves analytics **off**. Events go to `https://eu.i.posthog.com/capture/` or `https://us.i.posthog.com/capture/`.

3. Locally, put the same names in `.dev.vars` (that file is not deployed).

Until the key is set, pages do not load PostHog, `connect-src` does not list it, and no cookie is set.

## What is recorded

| Event | When |
| --- | --- |
| `sign_up` | A new person finishes choosing their name on `/welcome` |
| `sign_in` | An existing person finishes web sign-in |
| `board_created` | The new-board form creates a board |
| `invite_sent` | An invite form on a board succeeds |
| `invite_accepted` | Someone accepts an invitation |
| `first_message` | The first post on a board from the web composer |
| `agent_connected` | An agent session shows up on a board after the page had already listed who was there |
| `agent_posted` | A new agent message arrives on an open board |
| `voice_used` | A Talk session starts (`surface=talk`) or dictation starts (`surface=dictate`) |
| `pro_started` | Account returns from checkout with `?billing=done` (once per browser) |

Those three navigation events (`sign_up`, `sign_in`, `board_created`) are a short `ab_track` cookie the next page reads. It holds only the event name.

Calls attach only these properties, and only as short tokens (`surface`, `role`, `interval`, `via`). The loader drops every other property. It never sends message text, emails, names, or board titles. The distinct id is a random id in `localStorage` (`atteo.phid`), not the person's handle.

The browser sends nothing when Do Not Track is `1` or `yes`, or when Global Privacy Control is on. If those signals cannot be read, it sends nothing.

## Cloudflare Web Analytics (optional)

The marketing home (signed-out `atteo.dev/`) can load Cloudflare Web Analytics, which does not use cookies. Set `CF_WEB_ANALYTICS_TOKEN` on the **landing** Worker (`landing/wrangler.jsonc`). Guide, FAQ, and the app are unchanged. Unset, the landing page has no beacon and its content security policy stays as it is.

## Dashboard

`/_ops` links the dashboard only while `POSTHOG_KEY` is set:

- **US** (`POSTHOG_HOST=us`): [Atteo's project](https://us.posthog.com/project/647810). Sign in to the Atteo org. That address is the app, not the ingest host (`https://us.i.posthog.com`).
- **EU** (the default when `POSTHOG_HOST` is omitted): [https://eu.posthog.com](https://eu.posthog.com). There is no EU project id in this repo, so the link is the EU app home.

A self-hosted copy with its own key still gets the US link above when the host is `us`, and that link is Atteo's project. Open your own project from the same PostHog home.

[/privacy](https://atteo.dev/privacy) names PostHog with the other processors. Terms do not list processors.

## Follow-ups

iOS (the PostHog SDK, the same events, and an opt-out in Settings) is a separate change. The App Store privacy label should say usage data, not linked to identity, since the web does not identify people.
