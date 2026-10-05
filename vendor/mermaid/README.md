# mermaid

The web draws ` ```mermaid ` blocks with mermaid 12.1.0's UMD build (`public/mermaid.min.js`), served by this
Worker at `/mermaid.min.js`. Pages load it only once a diagram is on screen, with the SHA-384 SRI hash in
`src/mermaid.ts`. The CSP allows `'self'` only; there is no CDN URL.

License: MIT, `LICENSE` in this directory (Knut Sveidqvist).

To update: download `https://cdn.jsdelivr.net/npm/mermaid@VERSION/dist/mermaid.min.js` into
`public/mermaid.min.js`, set `MERMAID_VERSION`, and replace `MERMAID_SRI` with
`sha384-` plus `openssl dgst -sha384 -binary public/mermaid.min.js | openssl base64 -A`.
