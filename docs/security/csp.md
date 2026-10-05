# Content Security Policy

The application CSP is **report-only**. `CSP_ENFORCE` in `src/ui.ts` must remain `false` until an explicit rollout change is reviewed. This document records what is ready and what still needs operational verification before that later flip.

## Enforcement prerequisites

- Every HTML response created by `page` or `rawPage` gets a fresh 128-bit nonce, and every server-rendered script element carries it.
- Scripts loaded later (Mermaid, syntax highlighting, bug reporting, and html2canvas) inherit that nonce. The Mermaid file is pinned to one versioned URL and protected by its SHA-384 SRI hash.
- Inline event-handler attributes and `javascript:` URLs are not used. `script-src-attr 'none'` makes that restriction explicit.
- OAuth consent adds only the validated redirect origin or custom scheme to `form-action`.
- HTML responses are private and revalidated so a shared cache cannot reuse a nonce.
- The untrusted HTML preview has a separate, enforced sandbox policy and never receives the application page's nonce.
- `/api/csp-report` accepts browser reports with request, rate, and daily-key limits.
- `test/browser/csp-enforced.mjs` rewrites the report-only header to an enforced header in the browser and covers primary pages, OAuth redirects, previews, Mermaid/code rendering, and the lazy bug-report capture.

## Remaining gaps before enforcement

These are intentional or operational gaps, not reasons to weaken script protection:

1. Observe at least one representative clean day in the CSP report dashboard, including OAuth, voice, Mermaid, previews, and bug reporting. Investigate every application-page violation before rollout.
2. Run the full browser suite in an environment with Chromium and the local Worker. Pull-request CI runs unit/e2e tests but does not run browser checks; nightly/manual CI does.
3. `style-src` still needs `'unsafe-inline'` because the UI uses inline style attributes and generated style blocks. Removing it is separate hardening work and is not required to enforce the current script policy.
4. `img-src`, `font-src`, and `media-src` intentionally permit the data/blob schemes used by avatars, uploads, captures, and playback. Narrowing them requires flow-by-flow testing.
5. The preview shell intentionally permits inline script and style inside its opaque, `sandbox allow-scripts` frame. Its enforced policy blocks network, forms, framing, and access to the application origin.
6. The application still permits one external script: the exact versioned Mermaid URL. Its SRI hash detects changed bytes, but removing this dependency would require self-hosting it.
7. Voice requires `wss://api.x.ai`; confirm that provider endpoint has not changed immediately before rollout.

## Later rollout

The enforcement change should be a small, separate pull request that changes only `CSP_ENFORCE` to `true` (plus any rollout notes). Keep reporting enabled during and after the flip, run `test/browser/csp.mjs` and `test/browser/csp-enforced.mjs`, and have a rollback ready. This prerequisites change does **not** enable enforcement.
