# atteo.dev landing page

A separate Worker (`atteo-landing`) that sits in front of the app. It answers only its own paths: the home page `/` (GET/HEAD, for people who aren't signed in), `/guide`, `/faq`, `/support`, `/og.png`, `/robots.txt`, `/sitemap.xml`, `/llms.txt` and `/llms-full.txt`. Every other request (API, MCP, OAuth, sign-in, boards, `/install.sh`, `/cli/*`, `/.well-known/*`, WebSockets, the favicon) is forwarded untouched to the app Worker at `APP_ORIGIN` (a var in `wrangler.jsonc`), so everything that worked on atteo.dev keeps working. Signed-in visitors (an `ab_session` cookie) get the app's own `/`, their boards home. `/support` stays on this Worker either way: it is the public support URL.

HTML pages send an enforced Content-Security-Policy of their own (not the app's `CSP_ENFORCE`): inline JSON-LD is allowed by its SHA-256 hash, pages with no script get `script-src 'none'`, and reports post to the app's `/api/csp-report` through the proxy.

`APP_URL` at the top of `src/index.ts` is where "Open Atteo", the install command and the MCP URL point: `https://atteo.dev` today. Moving the app to `https://app.atteo.dev` later is that one line.

Run locally from the repo root, with the app on its own port:

```sh
npx wrangler dev --port 8815                                                         # the app
npx wrangler dev -c landing/wrangler.jsonc --port 8811 --var APP_ORIGIN:http://127.0.0.1:8815
```

Add `?theme=dark` or `?theme=light` to force a theme. The share image `og.png` is rendered from `og.html` (the command is at the top of that file).

## jxn's pages

`/` (signed out) and `/landing`, `/developers`, `/faq`, `/support`, `/privacy`, `/terms` and the site 404 are jxn's Claude Design exports, served as plain HTML. The exports are kept as he sent them (`landing-jxn.html`, `jxn-pages/*.html`); two scripts turn them into what's served:

```sh
node landing/jxn-pages/build.mjs [new-export.html …]   # links, titles, and the live text (privacy policy, MCP tools, CLI commands)
node landing/jxn-pages/unbundle.mjs                    # plain HTML in jxn-static/, fonts/images/scripts in public/landing/a/
```

`unbundle.mjs` opens each export in Chromium (set `PW_CHROME` if Playwright's own isn't installed) and keeps the finished page. The site pages are static, under the hash CSP above. The home page also loads jxn's runtime and React from `/landing/a/`, which draw his live page (the demos, the ring, the picker) over the snapshot; it is the one page with `script-src 'self' 'unsafe-eval'`. `test/landing-csp.test.ts` fails with the command to run when a page is out of date: a new MCP tool or CLI command, a privacy edit, or a new export. `/landing/a/*` is Workers static assets (`public/`), cached for a year by `public/_headers`; the names are content hashes, and a full run of `unbundle.mjs` deletes files no page refers to any more.

Deploy, in this order:

1. `npx wrangler deploy -c landing/wrangler.jsonc`. Harmless: it only answers on its workers.dev address.
2. Check the proxy reaches the app: `curl -s https://atteo-landing.<account>.workers.dev/health` must return the app's `{"ok":true,…}`. If it doesn't (a Worker fetching another workers.dev Worker in the same account can be refused), switch the forward to a service binding (`"services": [{ "binding": "APP", "service": "agent-board" }]`, then `env.APP.fetch(req)`) before going further.
3. jxn points atteo.dev at `atteo-landing` (the domain is on another Cloudflare account). Everything keeps working: the app's `PUBLIC_URL` stays `https://atteo.dev`.
4. Optional, later: serve the app at app.atteo.dev, then change `APP_URL` here and the app's `PUBLIC_URL`.
