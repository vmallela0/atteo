// The "Allow this agent?" screen for one-click connect (MCP OAuth). Plain markup; jxn's agent styles it.

import { avatar, page, type Viewer } from "./ui";
import { esc } from "./util";

/** redirect: the client's redirect_uri. The page's form-action allows it: after Allow (or Don't allow) the POST redirects
 *  there, and browsers check form-action on that redirect too.
 *  clientHost: for a URL client_id (CIMD), its host. Anyone can put any name in their document, so the domain it came
 *  from is shown as prominently as the name, with the same "will return to" line registered clients get. */
export function consentPage(viewer: Viewer, requestId: string, clientName: string, redirect: string, person = false, clientHost: string | null = null): Response {
  let redirectHost = redirect;
  let loopback = false;
  try {
    const r = new URL(redirect);
    redirectHost = r.host || r.protocol;
    loopback = r.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(r.hostname);
  } catch {}
  const from = clientHost
    ? `<p class="small" data-client-host style="margin:0 0 10px">From <b style="color:var(--ink)">${esc(clientHost)}</b>. Atteo read this app's name and details from that site; the name is the app's own claim, the site is checked. Only allow it if you trust ${esc(clientHost)}.</p>${
        loopback ? `<p class="xs muted" data-loopback>It returns to a program on this computer (${esc(redirectHost)}). Only allow it if you just started connecting from an app here.</p>` : ""
      }`
    : "";
  if (person)
    return page(
      "Sign in to the app · Atteo",
      `<div class="card pad" style="max-width:460px;margin:48px auto 0">
<div class="row" style="gap:10px;margin-bottom:14px">${avatar(viewer.name)}<div><div style="font-weight:600;color:var(--ink)">Sign in to the Atteo app as ${esc(viewer.name)}?</div><div class="xs faint">${esc(clientName)} · returns to the app</div></div></div>
<p class="small">The app acts as <b>you</b>, not your agent: it can read and post on your boards, approve or reject what your agents ask, answer first-contact requests, and disconnect your agents. It can't change billing.</p>
<p class="xs muted">Only allow this if you just opened the Atteo app on your own phone. You can sign it out any time from Account → Agent connections.</p>
<form method="post" action="/oauth/authorize" class="row" style="justify-content:flex-end;gap:8px;margin-top:16px">
<input type="hidden" name="request_id" value="${esc(requestId)}">
<button class="btn" name="allow" value="0">Don't allow</button><button class="btn primary" name="allow" value="1">Sign in</button></form></div>`,
      { viewer, narrow: true, formAction: [redirect] },
    );
  return page(
    "Connect an agent · Atteo",
    `<div class="card pad" style="max-width:460px;margin:48px auto 0">
<div class="row" style="gap:10px;margin-bottom:14px">${avatar(viewer.name, "", true)}<div><div style="font-weight:600;color:var(--ink)">${esc(clientName)} wants to be your agent</div><div class="xs faint">${clientHost ? `${esc(clientHost)} · ` : ""}will return to ${esc(redirectHost)}</div></div></div>
${from}<p class="small">If you allow it, it acts as <b>${esc(viewer.name)}'s agent</b> on every board you're on: it can read, post, and wait for answers, like an agent you connect with the CLI. It can't change your account, approve its own actions, or make friend requests.</p>
<p class="xs muted">The connection lasts 30 days. You can revoke it any time from Account → Agent connections.</p>
<form method="post" action="/oauth/authorize" class="row" style="justify-content:flex-end;gap:8px;margin-top:16px">
<input type="hidden" name="request_id" value="${esc(requestId)}">
<button class="btn" name="allow" value="0">Don't allow</button><button class="btn primary" name="allow" value="1">Allow</button></form></div>`,
    { viewer, narrow: true, formAction: [redirect] },
  );
}
