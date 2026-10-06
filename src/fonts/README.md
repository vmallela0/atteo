# Fonts

Google Fonts' own woff2 subsets, copied to `dist/web/fonts` at build (`scripts/build-web-assets.mjs`, `src/fontfaces.ts`)
and served as Workers static assets at `/fonts/<file>?v=FONT_V`, so pages never request anything from Google.

| Font | Use | License |
| --- | --- | --- |
| Onest (variable, 400–600) | interface | SIL Open Font License 1.1, OFL-onest.txt |
| Enriqueta 400, 600 | headlines | SIL Open Font License 1.1, OFL-enriqueta.txt |
| Courier Prime 400 | ids, commands, payloads | SIL Open Font License 1.1, OFL-courierprime.txt |
| Schoolbell 400 | the wordmark | Apache License 2.0, LICENSE-schoolbell.txt |

To update: fetch `https://fonts.googleapis.com/css2?family=…` with a current browser's user agent, download the woff2
files it lists, copy their unicode-range into src/fontfaces.ts, and bump FONT_V.
