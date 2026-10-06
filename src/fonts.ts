// Serves the web's font files (fontfaces.ts) at /fonts/<file>. Bundled as Data modules (wrangler.jsonc "rules").

import courier_prime_latin_400 from "./fonts/courier-prime-latin-400.woff2";
import courier_prime_latin_ext_400 from "./fonts/courier-prime-latin-ext-400.woff2";
import enriqueta_latin_400 from "./fonts/enriqueta-latin-400.woff2";
import enriqueta_latin_600 from "./fonts/enriqueta-latin-600.woff2";
import enriqueta_latin_ext_400 from "./fonts/enriqueta-latin-ext-400.woff2";
import enriqueta_latin_ext_600 from "./fonts/enriqueta-latin-ext-600.woff2";
import onest_cyrillic_ext from "./fonts/onest-cyrillic-ext.woff2";
import onest_cyrillic from "./fonts/onest-cyrillic.woff2";
import onest_latin_ext from "./fonts/onest-latin-ext.woff2";
import onest_latin from "./fonts/onest-latin.woff2";
import onest_vietnamese from "./fonts/onest-vietnamese.woff2";
import schoolbell_latin from "./fonts/schoolbell-latin.woff2";
import stix_two_text_latin from "./fonts/stix-two-text-latin.woff2";
import stix_two_text_latin_ext from "./fonts/stix-two-text-latin-ext.woff2";
import { FONT_V } from "./fontfaces";

const FILES: Record<string, ArrayBuffer> = {
  "courier-prime-latin-400.woff2": courier_prime_latin_400,
  "courier-prime-latin-ext-400.woff2": courier_prime_latin_ext_400,
  "enriqueta-latin-400.woff2": enriqueta_latin_400,
  "enriqueta-latin-600.woff2": enriqueta_latin_600,
  "enriqueta-latin-ext-400.woff2": enriqueta_latin_ext_400,
  "enriqueta-latin-ext-600.woff2": enriqueta_latin_ext_600,
  "onest-cyrillic-ext.woff2": onest_cyrillic_ext,
  "onest-cyrillic.woff2": onest_cyrillic,
  "onest-latin-ext.woff2": onest_latin_ext,
  "onest-latin.woff2": onest_latin,
  "onest-vietnamese.woff2": onest_vietnamese,
  "schoolbell-latin.woff2": schoolbell_latin,
  "stix-two-text-latin.woff2": stix_two_text_latin,
  "stix-two-text-latin-ext.woff2": stix_two_text_latin_ext,
};

/** GET /fonts/<file>: the font, cached for good when the URL carries the current version; null for anything else. */
export function fontResponse(path: string, url: URL): Response | null {
  const name = path.slice("/fonts/".length);
  const data = Object.hasOwn(FILES, name) ? FILES[name] : null;
  if (!data) return null;
  const pinned = url.searchParams.get("v") === FONT_V;
  return new Response(data, {
    headers: {
      "content-type": "font/woff2",
      "cache-control": pinned ? "public, max-age=31536000, immutable" : "public, max-age=3600",
      "access-control-allow-origin": "*", // the landing page (its own Worker) uses the same files
      "x-content-type-options": "nosniff",
    },
  });
}
