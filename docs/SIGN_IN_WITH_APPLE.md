# Sign in with Apple (WorkOS `AppleOAuth`)

App Review guideline 4.8 (board decision #4333). The iOS app already has Atteo's own email code and "Continue with
Google, GitHub or SSO". 4.8 requires a login that limits data to name and email, lets people hide their email, and
does not track them. Sign in with Apple is that option. Google and GitHub stay on the web and in the app.

The code is in. Live sign-in is not, until the steps below. No Apple private key, Team ID, Key ID, or Services ID
belongs in this repo or in `wrangler.jsonc` vars.

## What the code does

- iOS `SignInView` shows **Continue with Apple** (`signin.apple`) above **Continue with Google, GitHub or SSO**
  (`signin.web`). Apple uses the same in-app browser sheet as the other button (`ASWebAuthenticationSession` in
  `Auth.swift`). It is not the native Apple ID button, so the app target does not need the Sign in with Apple
  entitlement to compile.
- The sheet opens `/oauth/authorize?...&provider=AppleOAuth`. A signed-out person is sent to
  `/auth/login?provider=AppleOAuth`, which calls WorkOS `GET /user_management/authorize` with `provider=AppleOAuth`
  (`authorizeUrl` in `src/auth.ts`). After WorkOS returns, the existing callback and the "Sign in to the Atteo app as
  you?" screen are unchanged.
- `GET /auth/login` with no provider is still AuthKit, so Google, GitHub, and company SSO are unchanged. Company SSO
  (`organization_id`) still wins over Apple.
- `WORKOS_APPLE_OAUTH` must be exactly `1` or `/auth/login?provider=AppleOAuth` answers **503** ("Sign in with Apple
  isn't set up") and does not redirect to Apple. The button is still on screen; tapping it shows that page until the
  flag is set.

WorkOS holds the Apple credentials. This Worker never sees the `.p8` key.

## What vedu still does

Paid Apple Developer Program membership is required. WorkOS's staging environment can use WorkOS's own Apple
credentials for a test, and those screens show WorkOS's name. Production needs your own credentials. Do the Apple
Developer steps in the [WorkOS Apple guide](https://workos.com/docs/integrations/apple); the short version:

1. **WorkOS dashboard → Authentication → OAuth providers → Sign in with Apple → Enable.** Copy the **Redirect URI**
   and the **Outbound email domains**. Do not paste those secrets into the repo.
2. **Team ID.** Apple Developer → Certificates, Identifiers & Profiles. The Team ID is on the landing page.
3. **App ID.** Identifiers → App IDs. Use the existing app id `com.atteo.app` if it is already registered; otherwise
   register one. Enable the **Sign in with Apple** capability. Nothing in the Edit modal has to change for the web
   flow WorkOS uses.
4. **Services ID** (Apple's portal says Services IDs; WorkOS calls the value a Service ID). Identifiers → Services
   IDs → register one, for example `com.atteo.app.signin`. Enable Sign in with Apple, Configure, pick the App ID
   above. Domains and Subdomains: `api.workos.com`. Return URLs: the Redirect URI from step 1.
5. **Key.** Keys → new key, enable Sign in with Apple, configure it to the App ID. Register, note the **Key ID**, and
   download the `.p8` once. Apple will not show the file again. Keep it out of git, chat, and `wrangler.jsonc`.
6. **WorkOS, same dialog.** Choose "Your app's credentials". Paste Team ID, Service ID, Key ID, and the `.p8`
   contents. Save. Staging may keep WorkOS's default credentials until you do this; production cannot.
7. **Private Email Relay** (Hide My Email). Apple Developer → Services → Sign in with Apple for Email Communication.
   Add the outbound email domains WorkOS showed in step 1. Without this, people who hide their email can sign in, and
   mail to that relay address does not arrive (magic codes and invites).
8. **Turn the Worker path on**, only after step 6 is saved. The value is the digit `1`, not a key:

   ```sh
   npx wrangler secret put WORKOS_APPLE_OAUTH
   ```

   Locally, `WORKOS_APPLE_OAUTH=1` in `.dev.vars` (never commit that file). Unset, the 503 stays.

AuthKit's hosted page also shows Sign in with Apple once the provider is enabled in WorkOS, with no further code.
The iOS button does not wait for that page: it asks for `AppleOAuth` directly.

## Manual checklist

Until step 8, live Apple sign-in is expected to stop on the 503 page. The rest can be checked with tests and the UI.

- [ ] `npm test -- test/appleOAuth.test.ts` — AuthKit is still the default, Apple is `provider=AppleOAuth` only when
      asked, SSO still sets `organization_id` instead, the flag accepts only `1`, and `wrangler.jsonc` has no Apple
      key and no `WORKOS_APPLE_OAUTH` value.
- [ ] iOS sign-in (signed out): **Continue with Apple** is above **Continue with Google, GitHub or SSO**, and email
      Continue is still there. UI test: `NativeSignInUITests` looks for `signin.apple` and `signin.web`.
- [ ] With the flag unset, tap Continue with Apple: the sheet shows "Sign in with Apple isn't set up" (HTTP 503) and
      offers other ways to sign in. Email code and Google/GitHub still work.
- [ ] `GET /auth/login` (no query) still redirects to WorkOS with `provider=authkit`.
- [ ] After steps 6 and 8, tap Continue with Apple: Apple's sheet appears (your app's name, not WorkOS's, once your
      own credentials are saved). A new person lands on the name step; a returning person gets an app token.
- [ ] Hide My Email: the account's address is a `privaterelay.appleid.com` address, and a later magic code to it
      arrives only if step 7 is done.
- [ ] A domain that requires SSO still refuses Apple and sends the person to company sign-in.
