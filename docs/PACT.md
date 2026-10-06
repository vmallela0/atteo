# PACT: a person's agent on Atteo talking to a business's agent

vedu #5364. On 2026-10-01 Decagon announced PACT (Personal Agent Consent & Trust) with its Personal Agent Gateway.
The spec is public: **PACT 1.0**, Apache-2.0, at openpactprotocol.org (github.com/openpactprotocol/openpactprotocol),
with a reference provider, a TypeScript client and a personal-agent guide. Enough to build against.

## What PACT is

A business (a **Brand**) runs its support agent on a **Provider** (Decagon, or anyone implementing the spec). A
person's **personal agent** (PA), here Atteo, talks to it over **A2A 1.0 HTTP+JSON**:

- The Brand publishes an Agent Card at `https://{brandDomain}/.well-known/agent-card.json`. Its `supportedInterfaces`
  entry with `protocolBinding: "HTTP+JSON"`, `protocolVersion: "1.0"` is the interface URL, and the card declares a
  `paJwt` Bearer JWT security scheme.
- The PA sends `POST {interface}/message:send` with `Authorization: Bearer <PA JWT>` and `A2A-Version: 1.0`. The reply
  is a message with a `contextId`, which continues the conversation.

It has two profiles:

| Profile | What it adds | Status here |
| --- | --- | --- |
| **Identity** (§2–4, §6) | The PA signs every request: the Brand knows *which platform* is calling and has a stable id for the person, but not who they are | **Built (pact-1)** |
| **Delegated** (§5) | The person logs in with the Brand (OAuth device code, RFC 8628) and grants scopes. The PA then sends an `X-A2A-User-Delegation` token, the Brand's agent can act on the account (cancel, refund), and every reply carries a signed receipt | Next |

## What PACT needs from the person's side

**The identity the business sees.** This is a PA JWT (§3.2), ES256, valid for 120 s, and Atteo signs it:

- `iss` is Atteo's public origin (`https://atteo.dev`). Our JWKS is already at `/.well-known/jwks.json`: the
  A2A_SIGNING_KEY that signs our own Agent Card, which is set in prod.
- `sub` is an opaque random id (`u_…`), one per person per Provider (`pact_subjects`). It contains no name, email or
  username. Two Providers can't link the same person, and the id survives a key rotation.
- `aud` is whatever that Provider told us to use. It is never derived from the card URL.

Beyond this the Brand learns only what the person's message says. If the Brand wants to know who they are (an order
number, an email), its agent asks in the conversation, and the person decides whether to answer.

**Consent grants.** In Identity, consent is per message: the person approves each exact text before it leaves.
Delegated consent is a scoped grant the person makes on the Brand's own login page; the PA never sees their password.
Scopes are listed on the Brand's card, and the Brand can ask for more mid-conversation (step-up: a task in
`TASK_STATE_AUTH_REQUIRED` with `pact.missingScopes` and a login link). Atteo already reports a step-up to the agent
instead of failing.

**Delegation tokens.** This is the Delegated profile only. The PA starts a device-code flow at the Provider. The person
opens `verification_uri_complete`, logs in and approves. The PA then polls the token endpoint for an access and refresh
token. That token goes in `X-A2A-User-Delegation` beside the PA JWT, and its `sub` must match. Storing it needs the same
care as other OAuth tokens: encrypted at rest, per person per Brand, and revocable from Settings.

**Registration.** Each Provider has its own policy. Most will want our issuer and JWKS URL once, and they hand back the
audience. We record that in `pact_providers`. Atteo refuses to send to an interface whose origin isn't listed there.

## The first slice (branch pact-1)

`agents {action: "call"}`, on the existing `agents` tool, so no new tool lands in every agent's list (#783).

1. `call {card, text}` validates the card address: https only, a public DNS name, no credentials, no redirects, a 10 s
   timeout and a 256 KB cap. It fetches the card, picks the HTTP+JSON 1.0 interface, checks the JWT scheme and that we
   are registered with that Provider, and runs the secret filter on the text. Then it creates an approval
   (`tool: "pact"`) whose command is the exact JSON of `{to, card, interface, text, board}`, and shows it as a card on
   the joined board. **Nothing is sent to the business yet.**
2. Once the person approves, `call {approval}` sends it, using only the record the server stored when it prepared the
   send (`pact_prepared`): the card, the brand's name, the text, and the approval's own board. `request_approval`
   refuses tool `pact` (#5371), so an agent can't make a PACT approval itself, and a record that no longer matches the
   approval's command, title, details or board is refused. Each approval sends once (`pact_sends`). A failed send can
   be retried with the same messageId, at most 3 times and within 24 hours. The send goes to the stored interface
   without fetching the card again, and the JWT is signed per request.
3. The reply is the business's words. The agent gets it fenced as untrusted data. On the board it is posted quoted, as
   "Reply from <brand> (outside agent)", so it never reads as the person's own agent talking, and the board's normal
   screening applies. The `contextId` is kept per person per interface (`pact_contexts`). If a conversation is closed
   or unknown, Atteo starts a new one once. Bodies are read in chunks and dropped past 256 KB.
4. Errors (§6) come back in plain words: a 401 means "not registered or token refused"; a 429 gives the Retry-After;
   a 404 means an unknown Brand; and the envelope reasons are reported.

The code is in `src/pact.ts`, with the tool wiring in `src/mcp.ts` (`agents:call`), `migrations/0073_pact.sql` and
`test/pact.test.ts`. The tests check that the JWT verifies against our JWKS, that nothing is sent before approval,
that replay, forgery and other-person approvals are refused, that context continues, and the error mapping.

### Registering with a provider

For now this is done by hand, after the Provider's onboarding gives us an audience. Send them
`issuer = https://atteo.dev` and `jwks_uri = https://atteo.dev/.well-known/jwks.json`, then add the Provider:

```sh
npx wrangler d1 execute <db> --remote --command \
  "INSERT INTO pact_providers (origin, audience, label, added_at) VALUES ('https://<provider interface origin>', '<audience they gave us>', 'Decagon', unixepoch()*1000)"
```

The reference provider has a self-service registration endpoint, which is good for a local end-to-end try.

## Next

1. **Register with Decagon** (and the reference provider) to get an audience, then try one real Brand end to end.
   This needs a person to do the onboarding.
2. **Delegated profile:** device-code login (show the link to the person in the app), token storage (encrypted,
   revocable), the `X-A2A-User-Delegation` header, step-up re-auth, and verified receipts kept with the approval.
3. **App and web:** a "Talk to a business" entry point, the approval card showing the Brand's name and host, and the
   conversation thread per Brand.
4. A small registry (or `/.well-known` discovery) so people can name a Brand instead of a card URL.
