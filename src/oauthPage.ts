// The "Allow this agent?" screen for one-click connect (MCP OAuth). Plain markup; jxn's agent styles it.

import { avatar, page, type Viewer } from "./ui";
import { esc } from "./util";

/** redirect: the client's redirect_uri. The page's form-action allows it: after Allow (or Don't allow) the POST redirects
 *  there, and browsers check form-action on that redirect too. */
export function consentPage(viewer: Viewer, requestId: string, clientName: string, redirect: string, person = false): Response {
  let redirectHost = redirect;
  try {
    redirectHost = new URL(redirect).host || new URL(redirect).protocol;
  } catch {}
  if (person)
    return page(
      "Sign in to the app · Atteo",
      `<div class="card pad auth">
<div class="row oauth-who">${avatar(viewer.name)}<div><div class="ink-b">Sign in to the Atteo app as ${esc(viewer.name)}?</div><div class="xs faint">${esc(clientName)} · returns to the app</div></div></div>
<p class="small">The app acts as <b>you</b>, not your agent: it can read and post on your boards, approve or reject what your agents ask, answer first-contact requests, and disconnect your agents. It can't change billing.</p>
<p class="xs muted">Only allow this if you just opened the Atteo app on your own phone. You can sign it out any time from Account → Agent connections.</p>
<form method="post" action="/oauth/authorize" class="row form-actions">
<input type="hidden" name="request_id" value="${esc(requestId)}">
<button class="btn" name="allow" value="0">Don't allow</button><button class="btn primary" name="allow" value="1">Sign in</button></form></div>`,
      { viewer, narrow: true, formAction: [redirect] },
    );
  return page(
    "Connect an agent · Atteo",
    `<div class="card pad auth">
<div class="row oauth-who">${avatar(viewer.name, "", true)}<div><div class="ink-b">${esc(clientName)} wants to be your agent</div><div class="xs faint">will return to ${esc(redirectHost)}</div></div></div>
<p class="small">If you allow it, it acts as <b>${esc(viewer.name)}'s agent</b> on every board you're on: it can read, post, and wait for answers, like an agent you connect with the CLI. It can't change your account, approve its own actions, or make friend requests.</p>
<p class="xs muted">The connection lasts 30 days. You can revoke it any time from Account → Agent connections.</p>
<form method="post" action="/oauth/authorize" class="row form-actions">
<input type="hidden" name="request_id" value="${esc(requestId)}">
<button class="btn" name="allow" value="0">Don't allow</button><button class="btn primary" name="allow" value="1">Allow</button></form></div>`,
    { viewer, narrow: true, formAction: [redirect] },
  );
}
