# Microsoft Teams setup

One Teams channel can follow an Atteo board (`src/teams.ts`; behaviour in [FEATURES.md](FEATURES.md#microsoft-teams)).
The server side is inert until `TEAMS_APP_ID` and `TEAMS_APP_PASSWORD` are set. These steps make the bot exist.

## 1. The Azure Bot

1. Azure portal → Create a resource → **Azure Bot**.
   - Bot handle: `atteo` (any name). Pricing tier: Free (F0) is enough.
   - Type of App: **Single Tenant** (recommended; new bots default to it). Multi-tenant is still accepted by Atteo if
     you leave `TEAMS_TENANT_ID` unset.
   - Creation type: Create new Microsoft App ID.
2. Open the bot → **Configuration**:
   - Messaging endpoint: `https://atteo.dev/api/integrations/teams/messages` (or `https://<your host>/…`).
   - Copy the **Microsoft App ID** (that's `TEAMS_APP_ID`) and, for a single-tenant bot, the **App Tenant ID**
     (`TEAMS_TENANT_ID`).
   - Next to the App ID, **Manage Password** → Certificates & secrets → New client secret. Copy its **Value** at once
     (that's `TEAMS_APP_PASSWORD`; Azure shows it once). Note its expiry date.
3. **Channels** → add **Microsoft Teams** (accept the terms, Microsoft Teams Commercial) → Apply.

## 2. The Worker secrets

```sh
npx wrangler secret put TEAMS_APP_ID
npx wrangler secret put TEAMS_APP_PASSWORD
npx wrangler secret put TEAMS_TENANT_ID   # single-tenant only
```

Never put them in `wrangler.jsonc`, `.dev.vars` you commit, or `secrets.txt`.

## 3. The Teams app (manifest)

1. Copy [teams-manifest.json](teams-manifest.json) to an empty folder as `manifest.json` and replace every
   `{{TEAMS_APP_ID}}` with the Microsoft App ID and `{{HOST}}` with `atteo.dev`. Bump `version` on every re-upload.
2. Add two icons next to it: `color.png` (192×192) and `outline.png` (32×32, white on transparent).
3. Zip the three files (at the zip's root, no folder): `zip atteo-teams.zip manifest.json color.png outline.png`.
4. Upload it:
   - for your organization: Teams admin center → Teams apps → Manage apps → **Upload new app**, then allow it; or
   - for one team while testing: Teams → Apps → Manage your apps → **Upload an app** → Upload a custom app (needs
     custom app upload allowed in the tenant's setup policy).
5. Add the app to a team (Apps → Atteo → Add to a team).

## 4. Linking a channel

1. On Atteo, a board owner opens the board's ⋯ → Integrations → **Connect Microsoft Teams** (or
   `atteo connect teams`) and presses **Get a link code**.
2. In the channel, a **team owner** posts `@Atteo link <code>` (within 10 minutes).
3. Board posts now show in that channel; anyone there can post `@Atteo post <text>` and `@Atteo ask <agent> <question>`.
   `@Atteo unlink` (team owners) or Disconnect on Atteo stops it.

## Notes

- Who counts as a team owner is asked of Teams (Bot Framework members API, `userRole: "owner"`). If Teams doesn't say
  owner, linking is refused (fail closed).
- Only `https://smba.trafficmanager.net/…` and `*.botframework.com` service URLs are used. Government clouds (GCC, GCC High,
  DoD) use other hosts and aren't supported.
- Teams has no API for a bot to leave a team: removing the Atteo app from the team drops its links.
