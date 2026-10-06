// Content-Security-Policy for the landing Worker (docs/security/csp.md #8). Separate from the app's
// nonce-based policy and from CSP_ENFORCE: these pages are static marketing HTML, publicly cached, so each inline script
// (JSON-LD today) is allowed by its SHA-256 hash rather than a per-response nonce (a nonce would pin one value
// in a shared cache). Pages with no script (the guide) get script-src 'none'. Style stays 'unsafe-inline' for
// the page CSS and a few style attributes, the same reason the app has not removed it yet.

/** Cloudflare Web Analytics on the signed-out home page. The token is public in the snippet; unset means no tag. */
export const CF_BEACON_SCRIPT = "https://static.cloudflareinsights.com/beacon.min.js";
export const CF_BEACON_ORIGIN = "https://static.cloudflareinsights.com";
export const CF_BEACON_CONNECT = "https://cloudflareinsights.com";
const BEACON_TOKEN_RE = /^[A-Za-z0-9_-]{8,80}$/;

/** Empty unless the token looks like a Cloudflare Web Analytics token. */
export function beaconSnippet(token: string | undefined): string {
  const t = (token ?? "").trim();
  if (!BEACON_TOKEN_RE.test(t)) return "";
  return `<script defer src="${CF_BEACON_SCRIPT}" data-cf-beacon='{"token":${JSON.stringify(t)}}'></script>`;
}

/** SHA-256 of `s` as a CSP hash source (`'sha256-…'`). */
export async function cspHash(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return `'sha256-${btoa(String.fromCharCode(...new Uint8Array(d)))}'`;
}

/** The text of each inline <script> (JSON-LD today). A tag with src is skipped. */
export function inlineScripts(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
    if (/\ssrc\s*=/i.test(m[1] ?? "")) continue;
    out.push(m[2]);
  }
  return out;
}

/**
 * Enforced policy for one marketing HTML body. `formOrigin` is where the sign-up form goes (APP_URL's origin);
 * only a http(s) origin is accepted, so nothing odd lands in the source list.
 */
export async function landingCsp(html: string, formOrigin: string): Promise<string> {
  const hashes = await Promise.all(inlineScripts(html).map(cspHash));
  // Cloudflare Web Analytics is an external script on the marketing home only, and only when that page includes it.
  const beacon = html.includes(CF_BEACON_SCRIPT);
  const script = [...hashes, ...(beacon ? [CF_BEACON_ORIGIN] : [])].join(" ") || "'none'";
  const connect = beacon ? CF_BEACON_CONNECT : "'none'";
  const form = /^https?:\/\/[a-z0-9.:\[\]-]+$/i.test(formOrigin) ? `'self' ${formOrigin}` : "'self'";
  return `default-src 'none'; script-src ${script}; script-src-attr 'none'; style-src 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src ${connect}; frame-ancestors 'none'; base-uri 'none'; form-action ${form}; object-src 'none'; report-uri /api/csp-report; report-to csp`;
}
