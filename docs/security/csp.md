# Content Security Policy

The application CSP is **report-only**. `CSP_ENFORCE` in `src/ui.ts` must remain `false` until an explicit rollout change is reviewed. This document records what is ready and what still needs operational verification before that later flip.

## Enforcement prerequisites

- Every HTML response created by `page` or `rawPage` gets a fresh 128-bit nonce, and every server-rendered script and leftover `<style>` element carries it. Shared CSS is `/app.css`; Guide, Ask, and Docs load their own stylesheets on those pages only (`style-src 'self'`). For you keeps its sheet inline with the page nonce.
- Scripts loaded later (Mermaid, syntax highlighting, bug reporting, and html2canvas) inherit that nonce. The Mermaid file is this origin's pinned `/mermaid.min.js` and protected by its SHA-384 SRI hash.
- Inline event-handler attributes and `javascript:` URLs are not used. `script-src-attr 'none'` makes that restriction explicit.
- OAuth consent adds only the validated redirect origin or custom scheme to `form-action`.
- HTML responses are private and revalidated so a shared cache cannot reuse a nonce.
- The untrusted HTML preview has a separate, enforced sandbox policy and never receives the application page's nonce.
- `/api/csp-report` accepts browser reports with request, rate, and daily-key limits.
- `test/browser/csp-enforced.mjs` rewrites the report-only header to an enforced header in the browser and covers primary pages, OAuth redirects, previews, Mermaid/code rendering, the lazy bug-report capture, and the admin-only `/_ops` page (via `test/browser/lib/admin.mjs`).

## Remaining gaps before enforcement

These are intentional or operational gaps, not reasons to weaken script protection:

1. Observe at least one representative clean day in the CSP report dashboard, including OAuth, voice, Mermaid, previews, and bug reporting. Investigate every application-page violation before rollout.
2. Run the full browser suite in an environment with Chromium and the local Worker. Pull-request CI runs unit/e2e tests but does not run browser checks; nightly/manual CI does. Done on 2026-10-05 against a local Worker with `CSP_ENFORCE = true`: 151 of 156 checks passed and no app page logged a violation (the only refusals were the preview frame's own policy blocking its files, as intended). The other five were the checks, not the app: `csp.mjs` and `csp-enforced.mjs` assumed the report-only header (they now follow `CSP_ENFORCE`), `one-line` and `vote-contrast` injected axe as an inline `<script>` without the nonce (they now evaluate it), and a `notify-levels` timing flake that passes on its own. With those changes the four pass enforced and report-only.
3. `style-src` no longer needs `'unsafe-inline'`: shared styles live in `/app.css`, page-only sheets (`/guide.css`, `/ask.css`, `/docs.css`) load only on those pages, For you’s sheet and the board's `<noscript><style>` carry the page nonce. Mermaid must set a **nonce attribute**, both on its measuring styles and on the sanitized SVG styles before insertion: assigning `.nonce` alone sets the internal slot without the attribute required by CSP's nonceability check. This caused both reported board violations and the preview checks' parent-page violations. The other generated style block is the SVG preview's checkerboard, inside `/preview-frame` under its own policy (gap 5). `style-src-attr 'unsafe-inline'` still explicitly permits `style=""` in server HTML and client HTML templates (spacing, avatar hues, task bars and rail positions); CSSOM property assignments do not need that exception. Dropping attribute inline styles is further hardening and is not required to enforce this policy.
4. Done: the app policy is `img-src 'self' blob:`, `font-src 'self'`, and `media-src 'self' blob:`. Flow check (unit coverage in `test/csp.test.ts`; Chromium confirms `data:` on a CSS image, mask, font, or media element is blocked, and `blob:` image/audio is not):
   - Avatars, board pictures, and posted images are this origin (`/avatar/…`, `/api/boards/…/picture`, `/api/boards/…/image`). They do not use `data:` or `blob:`.
   - Composer upload thumbnails and bug-report pictures are `blob:` object URLs (`URL.createObjectURL`). `img-src` keeps `blob:`.
   - Icons are not `data:` images anymore: the select chevron is a gradient, the feedback mark is an inline SVG, and agent logos are `clip-path` (the generic `</>` is an inline stroke SVG, because a clip cannot draw a stroke). `img-src` does not allow `data:`.
   - Fonts are only `/fonts/*.woff2`. `font-src` does not allow `data:`.
   - Read-aloud (`/ask` and Talk standby), the Display voice sample, and Talk's silent media-key wav are `blob:` object URLs from a same-origin response or a generated wav. `media-src` keeps `blob:` and `'self'`. It does not allow `data:`.
   - Live Talk audio is WebAudio PCM on the socket already in `connect-src` (`wss://api.x.ai`, gap 7). No media host was added.
   - The preview frame's own policy (gap 5) still allows `data:` and `blob:` for images, fonts, and media inside that sandbox, including an SVG preview's `data:` image. That is not this page policy.
5. The preview shell intentionally permits inline script and style inside its opaque, `sandbox allow-scripts` frame. Its enforced policy blocks network, forms, framing, and access to the application origin.
6. Done: Mermaid is self-hosted at `/mermaid.min.js` (the 12.1.0 UMD build) with the same SHA-384 SRI hash. `script-src` no longer lists an external URL.
7. Voice requires `wss://api.x.ai`; confirm that provider endpoint has not changed immediately before rollout.
8. The separately deployed `landing/` Worker is outside `CSP_ENFORCE` and now has its own enforced hash policy (`landing/src/csp.ts`): `script-src` is the SHA-256 of each inline script (the JSON-LD on `/` and `/faq`) or `'none'` on `/guide` and `/support`. Hashes keep the pages publicly cacheable; a per-response nonce would pin one value in a shared cache. `style-src` still needs `'unsafe-inline'` for the marketing CSS and a few style attributes (same remaining work as gap 3). Reports go to the app's `/api/csp-report` through the proxy. This is not the app enforcement flip.
9. Done: the enforced browser simulation covers `/_ops` through a localhost-only operator session (`POST /api/ops/sessions { admin: true }` with `DEV_FAKE_ADMIN=1` in local `.dev.vars`, `test/browser/lib/admin.mjs`). CI still sets no `ADMIN_EMAIL`; production still requires it. The test marker (`workos_id` `ops-admin`) is ignored without the flag or off localhost. `csp-enforced.mjs` and `csp.mjs` walk Overview, Access and Events; server-rendered scripts pass the shared nonce unit checks.
10. Product analytics, when `POSTHOG_KEY` is set, adds that region's PostHog ingest origin (`https://eu.i.posthog.com` or `https://us.i.posthog.com`) to `connect-src` only. The loader is a first-party inline script, so `script-src` does not gain a third-party host. With the key unset, `connect-src` is unchanged. The landing Worker's signed-out home page may also load Cloudflare Web Analytics when `CF_WEB_ANALYTICS_TOKEN` is set; that page's enforced policy then allows `https://static.cloudflareinsights.com` on `script-src` and `https://cloudflareinsights.com` on `connect-src`. Unset, the landing policy is unchanged.

## Later rollout

The enforcement change should be a small, separate pull request that changes only `CSP_ENFORCE` to `true` (plus any rollout notes). Keep reporting enabled during and after the flip, run `test/browser/csp.mjs` and `test/browser/csp-enforced.mjs`, and have a rollback ready. This prerequisites change does **not** enable enforcement.
