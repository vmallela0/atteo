# atteo.dev landing page

A separate Worker (`atteo-landing`) from the app: one page, a 404, `robots.txt`, `sitemap.xml`, the icons and the share image, all from `src/index.ts` with no bindings. The app's address is `APP_URL` at the top of `src/index.ts`. Old app links on atteo.dev (`/install.sh`, `/b/…`, `/terms`, …) 308 to it; `/mcp`, `/api` and OAuth don't (clients must use the app address).

Run locally from the repo root: `npx wrangler dev -c landing/wrangler.jsonc --port 8811` (add `?theme=dark` or `?theme=light` to force a theme). Deploy: `npx wrangler deploy -c landing/wrangler.jsonc`, then have the atteo.dev domain owner point atteo.dev at the `atteo-landing` Worker (it is proxied from another Cloudflare account), only after the app is live at app.atteo.dev. The share image `og.png` is rendered from `og.html` (the command is at the top of that file).
